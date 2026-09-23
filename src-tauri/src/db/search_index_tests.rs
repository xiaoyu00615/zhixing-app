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
use crate::notes_db::{
    ArchiveNoteInput, CreateNoteInput, NoteDbService, RestoreNoteInput, SoftDeleteNoteInput,
    UnarchiveNoteInput,
};
use crate::search_db::{SearchDbService, SearchQueryInput};
use crate::task::{
    ArchiveTaskInput, CreateTaskInput, RestoreTaskInput, TaskDbService, TrashTaskInput,
    UnarchiveTaskInput,
};

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

fn column_exists(connection: &Connection, table: &str, column: &str) -> bool {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table})"))
        .unwrap();
    let names = statement
        .query_map([], |row| row.get::<_, String>(1))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    names.iter().any(|name| name == column)
}

/// 全部 trigger 的 (name, sql) 有序快照，用于证明某个迁移没有改动触发器。
fn trigger_sql(connection: &Connection) -> Vec<(String, String)> {
    let mut statement = connection
        .prepare(
            "SELECT name, COALESCE(sql, '') FROM sqlite_schema \
             WHERE type = 'trigger' ORDER BY name ASC",
        )
        .unwrap();
    statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
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
    // MIGRATIONS 覆盖到最新版本（当前 0015）；0013 的派生对象仍需存在。
    assert_eq!(result.current_version, 15);

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

/// Archive V1 (P5C-S1): 0014 是 additive nullable column 迁移。
/// 升级必须保留既有行、把 `archived_at_ms` 置为 NULL、并保持 0013
/// Search 触发器组不变（Search/Archive 集成属于 P5C-S2.5）。
///
/// P5C-S2.5 注意：本测试必须**只应用到 0014**（`&MIGRATIONS[..14]`）。
/// 若改为应用 `MIGRATIONS` 全量，0015 会同时被应用并改写 Search 触发器，
/// 本测试将失去「证明 0014 自身不动 Search 触发器」的含义。
#[test]
fn migration_0014_adds_archive_state_without_touching_search_triggers() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(&MIGRATIONS[..13], SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    assert!(!column_exists(&connection, "tasks", "archived_at_ms"));
    assert!(!column_exists(&connection, "notes", "archived_at_ms"));

    insert_task(&connection, "t-legacy", "Legacy task", None);
    insert_note(&connection, "n-legacy", "  Legacy note  ", "raw\n\nbody", None);
    let triggers_before = trigger_sql(&connection);

    let result = MigrationRunner::new(&MIGRATIONS[..14], SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();
    assert_eq!(result.current_version, 14, "必须只应用到 0014");

    assert!(column_exists(&connection, "tasks", "archived_at_ms"));
    assert!(column_exists(&connection, "notes", "archived_at_ms"));

    // 既有行完整保留，且归档维度默认为 NULL
    let (title, created_at_ms, archived_at_ms): (String, i64, Option<i64>) = connection
        .query_row(
            "SELECT title, created_at_ms, archived_at_ms FROM tasks WHERE id='t-legacy'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(title, "Legacy task");
    assert_eq!(created_at_ms, 10);
    assert_eq!(archived_at_ms, None);

    let (note_title, note_content, note_archived): (String, String, Option<i64>) = connection
        .query_row(
            "SELECT title, content, archived_at_ms FROM notes WHERE id='n-legacy'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .unwrap();
    assert_eq!(note_title, "  Legacy note  ", "title 不得被 trim");
    assert_eq!(note_content, "raw\n\nbody", "content 不得被规范化");
    assert_eq!(note_archived, None);

    // 非负 CHECK 生效
    let invalid = connection.execute(
        "UPDATE tasks SET archived_at_ms = -1 WHERE id='t-legacy'",
        [],
    );
    assert!(invalid.is_err(), "archived_at_ms 必须受非负 CHECK 约束");

    // TRASHED_FROM_ARCHIVE 是合法状态，不得被禁止
    connection
        .execute(
            "UPDATE tasks SET deleted_at_ms = 500, archived_at_ms = 400 WHERE id='t-legacy'",
            [],
        )
        .unwrap();

    // 0013 Search 触发器必须逐字节不变
    assert_eq!(trigger_sql(&connection), triggers_before);
}

// ============================================================
// migration 0015 Search / Archive lifecycle integration (P5C-S2.5)
// ============================================================

fn set_archived(connection: &Connection, table: &str, id: &str, archived_at_ms: i64) {
    connection
        .execute(
            &format!("UPDATE {table} SET archived_at_ms = ?1 WHERE id = ?2"),
            rusqlite::params![archived_at_ms, id],
        )
        .unwrap();
}

fn set_deleted(connection: &Connection, table: &str, id: &str, deleted_at_ms: i64) {
    connection
        .execute(
            &format!("UPDATE {table} SET deleted_at_ms = ?1 WHERE id = ?2"),
            rusqlite::params![deleted_at_ms, id],
        )
        .unwrap();
}

fn search_hits(connection: &Connection, term: &str) -> usize {
    SearchDbService::query(
        connection,
        SearchQueryInput {
            raw_query: term.to_string(),
            limit: 50,
        },
    )
    .unwrap()
    .len()
}

/// 0015 的投影修复：0014 之后旧 0013 触发器不认识 `archived_at_ms`，
/// ARCHIVED 的 Task / Note 会残留在派生 Search 投影里。0015 必须清掉它们，
/// 且不得触碰 Diary / Canvas 投影。
#[test]
fn migration_0015_removes_archived_task_and_note_from_search_projection() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(&MIGRATIONS[..14], SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    insert_task(&connection, "t-active", "活跃任务标题", None);
    insert_task(&connection, "t-archived", "归档任务标题", None);
    insert_task(&connection, "t-trashed", "回收任务标题", Some(200));
    insert_task(&connection, "t-trashed-archived", "归档回收任务", None);
    set_archived(&connection, "tasks", "t-archived", 100);
    set_archived(&connection, "tasks", "t-trashed-archived", 100);
    set_deleted(&connection, "tasks", "t-trashed-archived", 200);

    insert_note(
        &connection,
        "n-active",
        "活跃笔记",
        "活跃笔记正文内容",
        None,
    );
    insert_note(
        &connection,
        "n-archived",
        "归档笔记",
        "归档笔记正文内容",
        None,
    );
    insert_note(
        &connection,
        "n-trashed",
        "回收笔记",
        "回收笔记正文内容",
        Some(200),
    );
    insert_note(
        &connection,
        "n-trashed-archived",
        "归档回收笔记",
        "归档回收笔记正文",
        None,
    );
    set_archived(&connection, "notes", "n-archived", 100);
    set_archived(&connection, "notes", "n-trashed-archived", 100);
    set_deleted(&connection, "notes", "n-trashed-archived", 200);

    insert_diary(
        &connection,
        "d-active",
        "活跃日记",
        "日记正文内容",
        "2026-09-01",
        None,
    );
    insert_canvas(&connection, "c-active", "活跃画布");

    // BEFORE 0015：ARCHIVED 行仍留在派生投影里（旧触发器只认识 deleted_at_ms）。
    assert!(projection_row_exists(&connection, "task", "t-active"));
    assert!(
        projection_row_exists(&connection, "task", "t-archived"),
        "0014 之后 ARCHIVED Task 仍留在投影中，这正是 0015 要修复的问题"
    );
    assert!(projection_row_exists(&connection, "note", "n-archived"));
    assert_eq!(fts_hits(&connection, "归档任"), 1);
    assert_eq!(fts_hits(&connection, "档笔记"), 1);
    let diary_before = projection_title(&connection, "diary", "d-active");
    let canvas_before = projection_title(&connection, "canvas", "c-active");

    let result = MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();
    assert_eq!(result.current_version, 15, "0015 必须被应用");

    // Task：只有 ACTIVE 可检索
    assert!(projection_row_exists(&connection, "task", "t-active"));
    assert!(!projection_row_exists(&connection, "task", "t-archived"));
    assert!(!projection_row_exists(&connection, "task", "t-trashed"));
    assert!(!projection_row_exists(&connection, "task", "t-trashed-archived"));

    // Note：只有 ACTIVE 可检索
    assert!(projection_row_exists(&connection, "note", "n-active"));
    assert!(!projection_row_exists(&connection, "note", "n-archived"));
    assert!(!projection_row_exists(&connection, "note", "n-trashed"));
    assert!(!projection_row_exists(&connection, "note", "n-trashed-archived"));

    // FTS：归档 token 必须消失，活跃 token 必须仍在
    assert_eq!(fts_hits(&connection, "活跃任"), 1);
    assert_eq!(fts_hits(&connection, "归档任"), 0);
    assert_eq!(fts_hits(&connection, "档笔记"), 0);
    assert_eq!(fts_hits(&connection, "笔记正"), 1);

    // Diary / Canvas 投影不受影响
    assert_eq!(projection_count(&connection, "diary"), 1);
    assert_eq!(projection_count(&connection, "canvas"), 1);
    assert!(projection_row_exists(&connection, "diary", "d-active"));
    assert!(projection_row_exists(&connection, "canvas", "c-active"));
    assert_eq!(projection_title(&connection, "diary", "d-active"), diary_before);
    assert_eq!(
        projection_title(&connection, "canvas", "c-active"),
        canvas_before
    );
}

/// Task 生命周期（走 canonical TaskDbService，不直接 UPDATE）：
/// create → 可检索；archive → 不可检索；unarchive → 可检索；
/// archive → trash → restore → 仍 ARCHIVED，仍不可检索；unarchive → 可检索。
#[test]
fn task_search_lifecycle_follows_archive_state_through_canonical_services() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    TaskDbService::create(
        &connection,
        CreateTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            title: "生命周期任务".into(),
            created_at_ms: 10,
            is_important: false,
            is_urgent: false,
            due_date: None,
            project_id: None,
            tag_ids: Vec::new(),
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 1);

    TaskDbService::archive(
        &connection,
        ArchiveTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            updated_at_ms: 20,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 0, "archive 须移出 Search");

    TaskDbService::unarchive(
        &connection,
        UnarchiveTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            updated_at_ms: 30,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 1, "unarchive 须重新纳入");

    TaskDbService::archive(
        &connection,
        ArchiveTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            updated_at_ms: 40,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 0);

    TaskDbService::trash(
        &connection,
        TrashTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            updated_at_ms: 50,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 0);

    TaskDbService::restore(
        &connection,
        RestoreTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            updated_at_ms: 60,
        },
    )
    .unwrap();
    assert_eq!(
        search_hits(&connection, "生命周期"),
        0,
        "Trash restore 保留 archived_at_ms，回到 ARCHIVED 仍须不可检索"
    );

    TaskDbService::unarchive(
        &connection,
        UnarchiveTaskInput {
            id: "00000000-0000-4000-8000-000000000101".into(),
            updated_at_ms: 70,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 1);
}

/// Note 生命周期与 Task 完全一致，且归档 Note 的正文 token 也不得残留在 FTS。
#[test]
fn note_search_lifecycle_follows_archive_state_through_canonical_services() {
    let (_sandbox, backup, mut connection) = open_sandbox();
    MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
        .run(&mut connection, &backup)
        .unwrap();

    NoteDbService::create(
        &connection,
        CreateNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            title: "生命周期笔记".into(),
            content: "生命周期正文内容".into(),
            created_at_ms: 10,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 1);
    assert_eq!(search_hits(&connection, "周期正"), 1, "正文 token 须可检索");

    NoteDbService::archive(
        &connection,
        ArchiveNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            updated_at_ms: 20,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "生命周期"), 0);
    assert_eq!(search_hits(&connection, "周期正"), 0, "归档 Note 正文不得残留");

    NoteDbService::unarchive(
        &connection,
        UnarchiveNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            updated_at_ms: 30,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "周期正"), 1);

    NoteDbService::archive(
        &connection,
        ArchiveNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            updated_at_ms: 40,
        },
    )
    .unwrap();
    NoteDbService::soft_delete(
        &connection,
        SoftDeleteNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            updated_at_ms: 50,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "周期正"), 0);

    NoteDbService::restore(
        &connection,
        RestoreNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            updated_at_ms: 60,
        },
    )
    .unwrap();
    assert_eq!(
        search_hits(&connection, "周期正"),
        0,
        "Trash restore 保留 archived_at_ms，回到 ARCHIVED 仍须不可检索"
    );

    NoteDbService::unarchive(
        &connection,
        UnarchiveNoteInput {
            id: "00000000-0000-4000-8000-000000000102".into(),
            updated_at_ms: 70,
        },
    )
    .unwrap();
    assert_eq!(search_hits(&connection, "周期正"), 1);
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
