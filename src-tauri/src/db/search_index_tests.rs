//! Search index foundation verification tests (P5 S1).
//!
//! 本文件只承载 Search V1 index foundation 的验证测试，不提供任何生产
//! Search service / repository / command（那些属于后续 slice）。
//!
//! 覆盖范围：
//! - Native SQLite 运行时 FTS5 / trigram 能力实证（P5 S1 §5，先于 0013 落地）
//! - 中文 3+ 字符检索可用、2 字符 MATCH 限制被显式证明
//! - external-content FTS5 + 触发器（projection → FTS）行为
//! - migration 0013 在 Native 侧的行为：backfill / 软删 / 恢复 / 标题更新 / rebuild
//!
//! 所有测试仅使用 tempfile / in-memory 数据库，绝不触碰真实 AppData / Data Root / zhixing.db。

use std::fs;

use rusqlite::Connection;
use tempfile::tempdir;

use crate::db::definitions::MIGRATIONS;
use crate::db::migration::MigrationRunner;
use crate::db::policy::open_configured_connection;
use crate::db::snapshot::SqliteBackupSnapshot;

// ============================================================
// 能力实证辅助
// ============================================================

fn in_memory() -> Connection {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
    conn
}

fn count_matches(conn: &Connection, table: &str, term: &str) -> i64 {
    // 用户输入被转义为 FTS 引用串（与后续 persistence 层策略一致）
    let escaped = format!("\"{}\"", term.replace('"', "\"\""));
    let sql = format!("SELECT COUNT(*) FROM {table} WHERE {table} MATCH ?1");
    conn.query_row(&sql, [escaped], |r| r.get::<_, i64>(0))
        .unwrap()
}

// ============================================================
// §5 Native 运行时能力实证
// ============================================================

#[test]
fn native_fts5_trigram_is_available_at_runtime() {
    let conn = in_memory();
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap();
    assert!(!version.is_empty(), "sqlite_version must be reported");

    conn.execute_batch(
        "CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize = 'trigram');",
    )
    .expect("FTS5 with trigram tokenizer must be compiled into Native SQLite");

    conn.execute("INSERT INTO probe_fts(content) VALUES(?1)", ["今天完成数学作业"])
        .unwrap();
    assert!(
        version.starts_with("3.5") || version.starts_with("3.4"),
        "unexpected bundled sqlite version: {version}"
    );
}

#[test]
fn native_chinese_three_character_query_retrieves() {
    let conn = in_memory();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize = 'trigram');\
         INSERT INTO probe_fts(content) VALUES('今天完成数学作业');",
    )
    .unwrap();

    assert_eq!(count_matches(&conn, "probe_fts", "完成数"), 1);
    assert_eq!(count_matches(&conn, "probe_fts", "数学作"), 1);
}

#[test]
fn native_chinese_two_character_match_is_proven_limited() {
    // 显式证明：<3 字符查询在 trigram 下无法通过 MATCH 命中，
    // 因此后续 slice 必须实现 bounded LIKE fallback。
    let conn = in_memory();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize = 'trigram');\
         INSERT INTO probe_fts(content) VALUES('今天完成数学作业');",
    )
    .unwrap();

    assert_eq!(count_matches(&conn, "probe_fts", "数学"), 0);
    assert_eq!(count_matches(&conn, "probe_fts", "学"), 0);
}

#[test]
fn native_english_and_mixed_text_retrieve() {
    let conn = in_memory();
    conn.execute_batch(
        "CREATE VIRTUAL TABLE probe_fts USING fts5(content, tokenize = 'trigram');\
         INSERT INTO probe_fts(content) VALUES('project planning for q3');\
         INSERT INTO probe_fts(content) VALUES('AI 影视制作流程 2026');",
    )
    .unwrap();

    assert_eq!(count_matches(&conn, "probe_fts", "planning"), 1);
    assert_eq!(count_matches(&conn, "probe_fts", "影视制"), 1);
}

#[test]
fn native_external_content_fts_with_triggers_maintains_index() {
    let conn = in_memory();
    conn.execute_batch(
        "CREATE TABLE docs(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);\
         CREATE VIRTUAL TABLE docs_fts USING fts5(
             title, body, content='docs', content_rowid='id', tokenize='trigram');\
         CREATE TRIGGER docs_ai AFTER INSERT ON docs BEGIN
             INSERT INTO docs_fts(rowid, title, body)
             VALUES(new.id, new.title, new.body);
         END;\
         CREATE TRIGGER docs_ad AFTER DELETE ON docs BEGIN
             INSERT INTO docs_fts(docs_fts, rowid, title, body)
             VALUES('delete', old.id, old.title, old.body);
         END;\
         CREATE TRIGGER docs_au AFTER UPDATE ON docs BEGIN
             INSERT INTO docs_fts(docs_fts, rowid, title, body)
             VALUES('delete', old.id, old.title, old.body);
             INSERT INTO docs_fts(rowid, title, body)
             VALUES(new.id, new.title, new.body);
         END;",
    )
    .unwrap();

    conn.execute(
        "INSERT INTO docs(id, title, body) VALUES(1, '数学', '今天完成数学作业')",
        [],
    )
    .unwrap();
    assert_eq!(count_matches(&conn, "docs_fts", "数学作"), 1, "insert 须入索引");

    // UPDATE：旧文本必须消失，新文本可检索
    conn.execute("UPDATE docs SET body='明天复习物理习题' WHERE id=1", [])
        .unwrap();
    assert_eq!(count_matches(&conn, "docs_fts", "复习物"), 1, "新文本须可检索");
    assert_eq!(count_matches(&conn, "docs_fts", "数学作"), 0, "旧文本必须消失");

    // DELETE：索引必须清空
    conn.execute("DELETE FROM docs WHERE id=1", []).unwrap();
    assert_eq!(count_matches(&conn, "docs_fts", "复习物"), 0, "删除后须不可检索");
}

// ============================================================
// migration 0013 行为验证（Native）
// ============================================================

fn open_sandbox() -> (tempfile::TempDir, std::path::PathBuf, Connection) {
    let sandbox = tempdir().unwrap();
    let database_dir = sandbox.path().join("database");
    let backup_dir = sandbox.path().join("backup");
    fs::create_dir_all(&database_dir).unwrap();
    fs::create_dir_all(&backup_dir).unwrap();
    let connection = open_configured_connection(&database_dir.join("zhixing.db")).unwrap();
    (sandbox, backup_dir, connection)
}

fn object_exists(connection: &Connection, name: &str) -> bool {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
            [name],
            |r| r.get(0),
        )
        .unwrap();
    count > 0
}

fn projection_count(connection: &Connection, entity_type: &str) -> i64 {
    connection
        .query_row(
            "SELECT COUNT(*) FROM search_documents WHERE entity_type = ?1",
            [entity_type],
            |r| r.get(0),
        )
        .unwrap()
}

fn projection_row_exists(connection: &Connection, entity_type: &str, entity_id: &str) -> bool {
    let count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM search_documents
             WHERE entity_type = ?1 AND entity_id = ?2",
            rusqlite::params![entity_type, entity_id],
            |r| r.get(0),
        )
        .unwrap();
    count > 0
}

fn projection_title(connection: &Connection, entity_type: &str, entity_id: &str) -> String {
    connection
        .query_row(
            "SELECT title FROM search_documents
             WHERE entity_type = ?1 AND entity_id = ?2",
            rusqlite::params![entity_type, entity_id],
            |r| r.get(0),
        )
        .unwrap()
}

fn fts_hits(connection: &Connection, term: &str) -> i64 {
    let escaped = format!("\"{}\"", term.replace('"', "\"\""));
    connection
        .query_row(
            "SELECT COUNT(*) FROM search_fts WHERE search_fts MATCH ?1",
            [escaped],
            |r| r.get(0),
        )
        .unwrap()
}

fn insert_task(connection: &Connection, id: &str, title: &str, deleted: Option<i64>) {
    connection
        .execute(
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, deleted_at_ms)
             VALUES(?1, ?2, 'todo', 10, 20, ?3)",
            rusqlite::params![id, title, deleted],
        )
        .unwrap();
}

fn insert_note(connection: &Connection, id: &str, title: &str, content: &str, deleted: Option<i64>) {
    connection
        .execute(
            "INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms)
             VALUES(?1, ?2, ?3, 10, 20, ?4)",
            rusqlite::params![id, title, content, deleted],
        )
        .unwrap();
}

fn insert_diary(
    connection: &Connection,
    id: &str,
    title: &str,
    content: &str,
    diary_date: &str,
    deleted: Option<i64>,
) {
    connection
        .execute(
            "INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms)
             VALUES(?1, ?2, ?3, ?4, 10, 20, ?5)",
            rusqlite::params![id, title, content, diary_date, deleted],
        )
        .unwrap();
}

fn insert_canvas(connection: &Connection, id: &str, title: &str) {
    connection
        .execute(
            "INSERT INTO canvases(id, title, viewport_json, created_at_ms, updated_at_ms)
             VALUES(?1, ?2, '{\"x\":0,\"y\":0,\"zoom\":1}', 10, 20)",
            rusqlite::params![id, title],
        )
        .unwrap();
}

#[test]
fn migration_0013_creates_derived_objects_on_fresh_database() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    let result = MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();
    assert_eq!(result.current_version, 13);

    assert!(object_exists(&connection, "search_documents"));
    assert!(object_exists(&connection, "search_fts"));

    let unique_index: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM sqlite_schema
             WHERE type = 'index' AND name = 'idx_search_documents_entity_unique'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(unique_index, 1, "unique (entity_type, entity_id) 索引必须存在");

    // entity_type 受 CHECK 约束限制为 Search V1 集合
    let invalid = connection.execute(
        "INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
         VALUES('capture_item', 'x', 't', '', 1)",
        [],
    );
    assert!(invalid.is_err(), "entity_type 必须受 CHECK 约束");
}

#[test]
fn migration_0013_backfills_only_active_existing_content() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    // 先停在 0012，写入升级前已存在的数据
    MigrationRunner::new(&MIGRATIONS[..12], SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_task(&connection, "t-active", "活跃任务", None);
    insert_task(&connection, "t-deleted", "删除任务", Some(100));
    insert_note(&connection, "n-active", "活跃笔记", "正文内容", None);
    insert_note(&connection, "n-deleted", "删除笔记", "正文内容", Some(200));
    insert_diary(&connection, "d-active", "活跃日记", "日记正文", "2026-09-01", None);
    insert_diary(&connection, "d-deleted", "删除日记", "日记正文", "2026-09-02", Some(300));
    insert_canvas(&connection, "c-active", "活跃画布");

    // 升级到 0013
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    assert_eq!(projection_count(&connection, "task"), 1);
    assert_eq!(projection_count(&connection, "note"), 1);
    assert_eq!(projection_count(&connection, "diary"), 1);
    assert_eq!(projection_count(&connection, "canvas"), 1);

    assert!(projection_row_exists(&connection, "task", "t-active"));
    assert!(projection_row_exists(&connection, "note", "n-active"));
    assert!(projection_row_exists(&connection, "diary", "d-active"));
    assert!(projection_row_exists(&connection, "canvas", "c-active"));

    // 软删除内容必须被排除
    assert!(!projection_row_exists(&connection, "task", "t-deleted"));
    assert!(!projection_row_exists(&connection, "note", "n-deleted"));
    assert!(!projection_row_exists(&connection, "diary", "d-deleted"));
}

#[test]
fn task_projection_tracks_insert_update_soft_delete_and_restore() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_task(&connection, "task-1", "完成数学作业", None);
    assert!(projection_row_exists(&connection, "task", "task-1"));
    assert_eq!(fts_hits(&connection, "完成数"), 1);

    connection
        .execute("UPDATE tasks SET title='复习物理习题', updated_at_ms=30 WHERE id='task-1'", [])
        .unwrap();
    assert_eq!(projection_title(&connection, "task", "task-1"), "复习物理习题");
    assert_eq!(fts_hits(&connection, "复习物"), 1);
    assert_eq!(fts_hits(&connection, "完成数"), 0, "旧文本必须从索引移除");

    connection
        .execute("UPDATE tasks SET deleted_at_ms=100 WHERE id='task-1'", [])
        .unwrap();
    assert!(!projection_row_exists(&connection, "task", "task-1"), "软删须移除投影");
    assert_eq!(fts_hits(&connection, "复习物"), 0);

    connection
        .execute("UPDATE tasks SET deleted_at_ms=NULL WHERE id='task-1'", [])
        .unwrap();
    assert!(projection_row_exists(&connection, "task", "task-1"), "restore 须重新投影");
    assert_eq!(fts_hits(&connection, "复习物"), 1);
}

#[test]
fn note_projection_tracks_insert_update_soft_delete_and_restore() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_note(&connection, "note-1", "标题", "今天完成数学作业", None);
    assert_eq!(fts_hits(&connection, "数学作"), 1);

    connection
        .execute("UPDATE notes SET content='明天复习物理习题' WHERE id='note-1'", [])
        .unwrap();
    assert_eq!(fts_hits(&connection, "复习物"), 1);
    assert_eq!(fts_hits(&connection, "数学作"), 0);

    connection
        .execute("UPDATE notes SET deleted_at_ms=100 WHERE id='note-1'", [])
        .unwrap();
    assert!(!projection_row_exists(&connection, "note", "note-1"));
    assert_eq!(fts_hits(&connection, "复习物"), 0);

    connection
        .execute("UPDATE notes SET deleted_at_ms=NULL WHERE id='note-1'", [])
        .unwrap();
    assert!(projection_row_exists(&connection, "note", "note-1"));
    assert_eq!(fts_hits(&connection, "复习物"), 1);
}

#[test]
fn diary_projection_tracks_insert_update_soft_delete_and_restore() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_diary(&connection, "diary-1", "日记", "今天完成数学作业", "2026-09-01", None);
    assert_eq!(fts_hits(&connection, "数学作"), 1);

    // changeDiaryDate 单独发生时不改变被索引文本
    connection
        .execute("UPDATE diary_entries SET diary_date='2026-09-03' WHERE id='diary-1'", [])
        .unwrap();
    assert_eq!(fts_hits(&connection, "数学作"), 1, "改日期不得破坏已索引文本");

    connection
        .execute("UPDATE diary_entries SET content='明天复习物理习题' WHERE id='diary-1'", [])
        .unwrap();
    assert_eq!(fts_hits(&connection, "复习物"), 1);
    assert_eq!(fts_hits(&connection, "数学作"), 0);

    connection
        .execute("UPDATE diary_entries SET deleted_at_ms=100 WHERE id='diary-1'", [])
        .unwrap();
    assert!(!projection_row_exists(&connection, "diary", "diary-1"));

    connection
        .execute("UPDATE diary_entries SET deleted_at_ms=NULL WHERE id='diary-1'", [])
        .unwrap();
    assert!(projection_row_exists(&connection, "diary", "diary-1"));
    assert_eq!(fts_hits(&connection, "复习物"), 1);
}

#[test]
fn canvas_projection_tracks_create_and_title_update() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_canvas(&connection, "canvas-1", "架构图");
    assert!(projection_row_exists(&connection, "canvas", "canvas-1"));
    assert_eq!(fts_hits(&connection, "架构图"), 1);

    connection
        .execute("UPDATE canvases SET title='部署拓扑图' WHERE id='canvas-1'", [])
        .unwrap();
    assert_eq!(projection_title(&connection, "canvas", "canvas-1"), "部署拓扑图");
    assert_eq!(fts_hits(&connection, "部署拓"), 1);
    assert_eq!(fts_hits(&connection, "架构图"), 0);
}

#[test]
fn projection_changes_propagate_to_fts_and_rebuild_is_supported() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    // generic projection INSERT -> FTS INSERT
    connection
        .execute(
            "INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
             VALUES('note', 'generic-1', '标题', '今天完成数学作业', 10)",
            [],
        )
        .unwrap();
    assert_eq!(fts_hits(&connection, "数学作"), 1);

    // projection UPDATE -> 旧文本消失、新文本可检索
    connection
        .execute(
            "UPDATE search_documents SET body='明天复习物理习题'
             WHERE entity_type='note' AND entity_id='generic-1'",
            [],
        )
        .unwrap();
    assert_eq!(fts_hits(&connection, "复习物"), 1);
    assert_eq!(fts_hits(&connection, "数学作"), 0);

    // projection DELETE -> FTS 行消失
    connection
        .execute(
            "DELETE FROM search_documents
             WHERE entity_type='note' AND entity_id='generic-1'",
            [],
        )
        .unwrap();
    assert_eq!(fts_hits(&connection, "复习物"), 0);

    // canonical rebuild 在 0013 schema 下可用
    insert_note(&connection, "note-rebuild", "标题", "今天完成数学作业", None);
    connection
        .execute_batch("INSERT INTO search_fts(search_fts) VALUES('rebuild');")
        .unwrap();
    assert_eq!(fts_hits(&connection, "数学作"), 1, "rebuild 后索引仍须一致");
}

#[test]
fn chinese_search_works_and_two_character_limit_holds_after_migration() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_note(&connection, "note-cn", "数学", "今天完成数学作业", None);
    assert_eq!(fts_hits(&connection, "数学作"), 1, "3+ 字符中文必须可检索");
    assert_eq!(fts_hits(&connection, "数学"), 0, "2 字符 MATCH 限制必须成立（后续 LIKE fallback 的前提）");
}

#[test]
fn native_reports_bundled_sqlite_version() {
    let conn = in_memory();
    let version: String = conn
        .query_row("SELECT sqlite_version()", [], |r| r.get(0))
        .unwrap();
    println!("NATIVE SQLITE VERSION: {version}");
    assert!(!version.is_empty());
}

#[test]
fn native_fts_rebuild_command_is_supported() {
    let conn = in_memory();
    conn.execute_batch(
        "CREATE TABLE docs(id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT NOT NULL);\
         CREATE VIRTUAL TABLE docs_fts USING fts5(
             title, body, content='docs', content_rowid='id', tokenize='trigram');\
         INSERT INTO docs(id, title, body) VALUES(1, '数学', '今天完成数学作业');",
    )
    .unwrap();

    // 未触发任何维护逻辑时先 rebuild，验证 canonical rebuild 可用
    conn.execute_batch("INSERT INTO docs_fts(docs_fts) VALUES('rebuild');")
        .expect("FTS5 rebuild must be supported on external-content tables");
    assert_eq!(count_matches(&conn, "docs_fts", "数学作"), 1);
}
