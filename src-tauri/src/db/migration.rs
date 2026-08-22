//! Migration 文件组织。
//!
//! Step 9 冻结：production MIGRATIONS = []。
//! 不创建任何业务 migration；不写 placeholder/dummy migration；
//! schema_migrations 是 Runner metadata，由 Runner::bootstrap_history_table() 自举，不是 0001 migration。

use super::checksum::sha256_hex;
use super::snapshot::{SnapshotError, SnapshotProvider};

use crate::Issue;
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::Path;
use thiserror::Error;

/// 单 migration 定义（平台无关 SQL + high_risk 标记）。
/// Step 9 Closeout：不保留未使用的 description 字段（cargo check 零 warning 不靠 allow(dead_code)）。
#[derive(Debug, Clone, Copy)]
pub struct MigrationDefinition {
    pub version: u32,
    pub id: &'static str,
    pub sql_up: &'static str,
    pub high_risk: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct MigrationResult {
    pub applied_count: usize,
    pub current_version: u32,
}

// ============================================================
// 15 typed MigrationError（冻结五；Issue.kind 显式 match；零 panic）
// ============================================================
#[derive(Debug, Error)]
pub enum MigrationError {
    // --- Runtime validate（审核三固定优先级 1..6）---
    #[error("duplicate migration version: {0}")]
    DuplicateMigrationVersion(u32),

    #[error("duplicate migration id: {0}")]
    DuplicateMigrationId(String),

    #[error("non-empty MIGRATIONS must start at version 1, got {0}")]
    FirstVersionNotOne(u32),

    #[error("migrations are not strict ascending by version")]
    SortOrder,

    #[error("migration definition gap: expected version {expected}, got {got}")]
    MigrationDefinitionGap { expected: u32, got: u32 },

    // --- History invariant + identity 五类最终（审核二）---
    #[error("history is not a continuous prefix 1..N; missing version {missing} before max {max_applied}")]
    HistoryGap { missing: u32, max_applied: u32 },

    #[error("schema_migrations history corrupt: {0}")]
    HistoryCorrupt(String),

    #[error("future version: db applied max = {db_max} > runner known max = {runner_max}")]
    FutureVersion { db_max: u32, runner_max: u32 },

    #[error("migration id mismatch at version {version}: known={known}, db={db}")]
    MigrationIdMismatch {
        version: u32,
        known: String,
        db: String,
    },

    #[error("migration checksum mismatch at version {version} id={id}: known={known_sha}, db={db_sha}")]
    MigrationHashMismatch {
        version: u32,
        id: String,
        known_sha: String,
        db_sha: String,
    },

    // --- Safety snapshot ---
    #[error("safety snapshot failed for version {version}: {source}")]
    SnapshotFailed {
        version: u32,
        #[source]
        source: SnapshotError,
    },

    // --- Single transaction (audit 1 + 5) ---
    #[error("apply migration SQL failed version={version} id={id}: {source}")]
    ApplyFailed {
        version: u32,
        id: String,
        #[source]
        source: rusqlite::Error,
    },

    #[error("history INSERT failed version={version}: {source}")]
    HistoryInsertFailed {
        version: u32,
        #[source]
        source: rusqlite::Error,
    },

    #[error("transaction commit failed version={version}: {source}")]
    TransactionCommitFailed {
        version: u32,
        #[source]
        source: rusqlite::Error,
    },

    #[error("history invariant violation: {0}")]
    HistoryInvariantViolation(String),

    #[error("transaction begin failed version={version}: {source}")]
    TransactionBeginFailed {
        version: u32,
        #[source]
        source: rusqlite::Error,
    },
}

// 收口 5：单一 authoritative mapping。Issue 转换与 lib.rs 全量复用此 kind()。
impl MigrationError {
    pub const fn kind(&self) -> &'static str {
        use MigrationError::*;
        match self {
            DuplicateMigrationVersion(_) => "DuplicateMigrationVersion",
            DuplicateMigrationId(_) => "DuplicateMigrationId",
            FirstVersionNotOne(_) => "FirstVersionNotOne",
            SortOrder => "SortOrder",
            MigrationDefinitionGap { .. } => "MigrationDefinitionGap",
            HistoryGap { .. } => "HistoryGap",
            HistoryCorrupt(_) => "HistoryCorrupt",
            FutureVersion { .. } => "FutureVersion",
            MigrationIdMismatch { .. } => "MigrationIdMismatch",
            MigrationHashMismatch { .. } => "MigrationHashMismatch",
            SnapshotFailed { .. } => "SnapshotFailed",
            ApplyFailed { .. } => "ApplyFailed",
            HistoryInsertFailed { .. } => "HistoryInsertFailed",
            TransactionCommitFailed { .. } => "TransactionCommitFailed",
            HistoryInvariantViolation(_) => "HistoryInvariantViolation",
            TransactionBeginFailed { .. } => "TransactionBeginFailed",
        }
    }
}

// 收口 5：统一使用 self.kind()。本 Into<Issue> 是 migration 模块内复用；
// lib.rs From<DbError> for Issue 中 Migration 分支也统一调用 .kind()。
impl From<MigrationError> for Issue {
    fn from(e: MigrationError) -> Self {
        Issue {
            subsystem: "migration",
            kind: e.kind().into(),
            path: None,
            message: e.to_string(),
        }
    }
}

pub struct MigrationRunner<'a, S: SnapshotProvider> {
    migrations: &'a [MigrationDefinition],
    snapshot: S,
}

impl<'a, S: SnapshotProvider> MigrationRunner<'a, S> {
    pub fn new(migrations: &'a [MigrationDefinition], snapshot: S) -> Self {
        Self { migrations, snapshot }
    }

    /// 冻结签名：conn = &mut Connection，不用 unchecked_transaction。
    pub fn run(
        &self,
        conn: &mut Connection,
        snapshot_dir: &Path,
    ) -> Result<MigrationResult, MigrationError> {
        use MigrationError::*;

        let ms = self.migrations;

        // ===== [A] Runtime validate 固定顺序（审核三 1→6）=====
        if !ms.is_empty() {
            let vers: Vec<u32> = ms.iter().map(|m| m.version).collect();
            let ids: Vec<&str> = ms.iter().map(|m| m.id).collect();

            // 1. duplicate version（先于 gap/sort 捕获）
            for i in 1..vers.len() {
                if vers[0..i].contains(&vers[i]) {
                    return Err(DuplicateMigrationVersion(vers[i]));
                }
            }
            // 2. duplicate id
            for i in 1..ids.len() {
                if ids[0..i].contains(&ids[i]) {
                    return Err(DuplicateMigrationId(ids[i].to_string()));
                }
            }
            // 3. empty → valid（外层已过滤）
            // 4. first version == 1
            let first = ms.first().unwrap().version;
            if first != 1 {
                return Err(FirstVersionNotOne(first));
            }
            // 5. strict ascending
            for w in ms.windows(2) {
                if w[1].version <= w[0].version {
                    return Err(SortOrder);
                }
            }
            // 6. continuous +1
            for w in ms.windows(2) {
                if w[1].version != w[0].version + 1 {
                    return Err(MigrationDefinitionGap {
                        expected: w[0].version + 1,
                        got: w[1].version,
                    });
                }
            }
        }

        // ===== [B] Runner 自举 schema_migrations（Runner metadata，不是 0001）=====
        bootstrap_history_table(conn)?;
        validate_history_structure(conn)?;

        // ===== [C] Load history + 验证连续前缀 1..N（审核一、二）=====
        let (applied, max_applied) = load_applied_history(conn)?;
        validate_continuous_prefix(&applied, max_applied)?;

        // ===== [D] Identity 校验（五类最终错误）=====
        let runner_max = ms.last().map(|m| m.version).unwrap_or(0);
        if max_applied > runner_max {
            return Err(FutureVersion {
                db_max: max_applied,
                runner_max,
            });
        }
        for m in ms {
            if let Some((db_id, db_sha)) = applied.get(&m.version) {
                if m.id != db_id {
                    return Err(MigrationIdMismatch {
                        version: m.version,
                        known: m.id.to_string(),
                        db: db_id.clone(),
                    });
                }
                let known_sha = sha256_hex(m.sql_up.as_bytes());
                if known_sha != *db_sha {
                    return Err(MigrationHashMismatch {
                        version: m.version,
                        id: m.id.to_string(),
                        known_sha,
                        db_sha: db_sha.clone(),
                    });
                }
            }
        }

        // ===== [E] pending = > current_version 的连续后缀（审核一）=====
        // ms 本身连续 1..runner_max；applied 前缀 1..max_applied
        // pending = ms 中 version > max_applied → 天然连续：max_applied+1..runner_max
        let pending: Vec<_> = ms.iter().filter(|m| m.version > max_applied).collect();

        // ===== [F] 逐个执行：Snapshot(如 high_risk) → Single Immediate Tx（execute_batch + INSERT）→ commit =====
        let mut applied_count = 0usize;
        for m in pending {
            if m.high_risk {
                // Snapshot 在 Tx 之前，只用 &Connection（非 mut）— 通过 conn 借用拆分
                self.snapshot
                    .before_high_risk_migration(conn, snapshot_dir, m)
                    .map_err(|source| SnapshotFailed {
                        version: m.version,
                        source,
                    })?;
            }

            // 冻结一/五：rusqlite::Transaction RAII，Behavior = Immediate；不手写 BEGIN
            let tx = conn
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(|source| MigrationError::TransactionBeginFailed {
                    version: m.version,
                    source,
                })?;

            // 冻结六：不 parser；直接 execute_batch 原文
            tx.execute_batch(m.sql_up).map_err(|source| ApplyFailed {
                version: m.version,
                id: m.id.to_string(),
                source,
            })?;

            let checksum = sha256_hex(m.sql_up.as_bytes());
            let applied_at_ms = unix_ms_now();
            tx.execute(
                "INSERT INTO schema_migrations(version,id,checksum_sha256,applied_at_ms) \
                 VALUES(?1,?2,?3,?4)",
                params![m.version as i64, m.id, &checksum, applied_at_ms],
            )
            .map_err(|source| HistoryInsertFailed {
                version: m.version,
                source,
            })?;

            tx.commit().map_err(|source| TransactionCommitFailed {
                version: m.version,
                source,
            })?;
            applied_count += 1;
        }

        Ok(MigrationResult {
            applied_count,
            current_version: max_applied + applied_count as u32,
        })
    }
}

// ============================================================
// history 内部：bootstrap / validate / load / 连续前缀
// ============================================================

fn bootstrap_history_table(conn: &Connection) -> Result<(), MigrationError> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS schema_migrations (
            version         INTEGER PRIMARY KEY NOT NULL,
            id              TEXT    NOT NULL UNIQUE,
            checksum_sha256 TEXT    NOT NULL,
            applied_at_ms   INTEGER NOT NULL
        )",
    )
    .map_err(|e| MigrationError::HistoryCorrupt(format!("cannot create schema_migrations: {e}")))
}

fn validate_history_structure(conn: &Connection) -> Result<(), MigrationError> {
    use MigrationError::HistoryCorrupt;
    // PRAGMA table_info → 列名 / 类型 必须匹配最小集合
    let mut stmt = conn
        .prepare("PRAGMA table_info('schema_migrations')")
        .map_err(|e| HistoryCorrupt(format!("prepare pragma table_info: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            let cid: i64 = r.get(0)?;
            let name: String = r.get(1)?;
            let type_: String = r.get(2)?;
            let notnull: i64 = r.get(3)?;
            let pk: i64 = r.get(5)?;
            Ok((cid, name, type_, notnull, pk))
        })
        .map_err(|e| HistoryCorrupt(format!("query table_info: {e}")))?;
    let mut cols: Vec<(i64, String, String, i64, i64)> = Vec::new();
    for r in rows {
        cols.push(r.map_err(|e| HistoryCorrupt(format!("row table_info: {e}")))?);
    }
    let have: HashMap<String, (String, i64, i64)> = cols
        .into_iter()
        .map(|(_, n, t, nn, pk)| (n, (t, nn, pk)))
        .collect();
    macro_rules! req {
        ($n:expr, $t:expr, $nn:expr, $pk:expr) => {{
            let col = have
                .get($n)
                .ok_or_else(|| HistoryCorrupt(format!("schema_migrations missing column: {}", $n)))?;
            let (typ, notnull, pk) = col;
            // 类型允许大小写不同 / SQLite 弱类型；以 typ.to_lowercase() contains 为准
            if !typ.eq_ignore_ascii_case($t) {
                return Err(HistoryCorrupt(format!(
                    "schema_migrations column {} type mismatch: expected {}, got {}",
                    $n, $t, typ
                )));
            }
            if *notnull != $nn {
                return Err(HistoryCorrupt(format!(
                    "schema_migrations column {} NOT NULL mismatch: expected {}, got {}",
                    $n, $nn, notnull
                )));
            }
            if *pk != $pk {
                return Err(HistoryCorrupt(format!(
                    "schema_migrations column {} PK mismatch: expected {}, got {}",
                    $n, $pk, pk
                )));
            }
        }};
    }
    req!("version", "INTEGER", 1, 1);
    req!("id", "TEXT", 1, 0);
    req!("checksum_sha256", "TEXT", 1, 0);
    req!("applied_at_ms", "INTEGER", 1, 0);

    // id 必须由单列 UNIQUE index 保证唯一；其它列或复合 UNIQUE 不能替代。
    let mut idx_stmt = conn
        .prepare("PRAGMA index_list('schema_migrations')")
        .map_err(|e| HistoryCorrupt(format!("prepare index_list: {e}")))?;
    // PRAGMA index_list('schema_migrations') 固定列：
    //   0:seq INTEGER, 1:name TEXT, 2:unique INTEGER (0/1), 3:origin TEXT ('u'=UNIQUE 等), 4:partial INTEGER
    let idxs: Vec<(String, i64, i64)> = idx_stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(1)?, // name
                r.get::<_, i64>(2)?,    // unique (0/1)
                r.get::<_, i64>(4)?,    // partial (0/1)
            ))
        })
        .map_err(|e| HistoryCorrupt(format!("query index_list: {e}")))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| HistoryCorrupt(format!("row index_list: {e}")))?;

    let mut id_unique = false;
    for (index_name, unique, partial) in idxs {
        if unique != 1 || partial != 0 {
            continue;
        }

        // Table-valued PRAGMA 等价于 PRAGMA index_info('<index_name>')，并允许安全绑定名称。
        // index_info 只返回 key columns；必须严格为单列 ["id"]。
        let mut info_stmt = conn
            .prepare("SELECT name FROM pragma_index_info(?1) ORDER BY seqno")
            .map_err(|e| HistoryCorrupt(format!("prepare index_info for {index_name}: {e}")))?;
        let key_columns: Vec<Option<String>> = info_stmt
            .query_map([&index_name], |r| r.get::<_, Option<String>>(0))
            .map_err(|e| HistoryCorrupt(format!("query index_info for {index_name}: {e}")))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| HistoryCorrupt(format!("row index_info for {index_name}: {e}")))?;

        if key_columns == [Some("id".to_string())] {
            id_unique = true;
            break;
        }
    }
    if !id_unique {
        return Err(HistoryCorrupt(
            "schema_migrations column id must be UNIQUE".into(),
        ));
    }
    Ok(())
}

/// 返回：(version → (id, checksum))、MAX(version)。
fn load_applied_history(
    conn: &Connection,
) -> Result<(HashMap<u32, (String, String)>, u32), MigrationError> {
    use MigrationError::HistoryCorrupt;
    let mut stmt = conn
        .prepare("SELECT version, id, checksum_sha256, applied_at_ms FROM schema_migrations")
        .map_err(|e| HistoryCorrupt(format!("prepare select history: {e}")))?;
    let rows = stmt
        .query_map([], |r| {
            let vi: i64 = r.get(0)?;
            let id: String = r.get(1)?;
            let sha: String = r.get(2)?;
            let aa: i64 = r.get(3)?;
            Ok((vi, id, sha, aa))
        })
        .map_err(|e| HistoryCorrupt(format!("query history: {e}")))?;
    let mut map: HashMap<u32, (String, String)> = HashMap::new();
    let mut max: u32 = 0;
    for r in rows {
        let (vi, id, sha, applied_at_ms) = r.map_err(|e| HistoryCorrupt(format!("row history: {e}")))?;
        // 审核注意 A：先读为 i64，再验证范围 1..u32::MAX，再转 u32
        if vi <= 0 || vi > u32::MAX as i64 {
            return Err(HistoryCorrupt(format!(
                "schema_migrations.version out of range (must 1..u32::MAX): {vi}"
            )));
        }
        // 收口 2：Step 9 不存在 negative/running；applied_at_ms < 0 → HistoryCorrupt
        if applied_at_ms < 0 {
            return Err(HistoryCorrupt(format!(
                "schema_migrations.applied_at_ms negative at version {vi}: {applied_at_ms}"
            )));
        }
        let v = vi as u32;
        if id.is_empty() || sha.is_empty() {
            return Err(HistoryCorrupt(format!(
                "schema_migrations id/checksum empty at version {v}"
            )));
        }
        if map.insert(v, (id, sha)).is_some() {
            return Err(HistoryCorrupt(format!(
                "schema_migrations duplicate PK version {v} (should be impossible)"
            )));
        }
        if v > max {
            max = v;
        }
    }
    Ok((map, max))
}

/// applied history 必须是严格连续前缀 1..N（审核一）。否则 HistoryGap / HistoryCorrupt。
fn validate_continuous_prefix(
    applied: &HashMap<u32, (String, String)>,
    max_applied: u32,
) -> Result<(), MigrationError> {
    if applied.is_empty() {
        return Ok(()); // [] → valid
    }
    for v in 1..=max_applied {
        if !applied.contains_key(&v) {
            return Err(MigrationError::HistoryGap {
                missing: v,
                max_applied,
            });
        }
    }
    Ok(())
}

fn unix_ms_now() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    match SystemTime::now().duration_since(UNIX_EPOCH) {
        Ok(d) => d.as_millis() as i64,
        Err(_) => 0,
    }
}

// ============================================================
// Step 9 冻结测试矩阵 V2.1（19+ 条，全部 tempfile sandbox，零真实 AppData 触碰）
// ============================================================
#[cfg(test)]
mod tests {
    use super::*;
    use super::super::snapshot::{SnapshotProvider, SnapshotReport, SnapshotError};
    use rusqlite::Connection;
    use std::collections::HashMap;
    use std::fs;
    use std::path::Path;
    use tempfile::tempdir;

    // ---------- 帮助：test-only MigrationDefinition 构造（description 字段已从 struct 移除，收口 6） ----------
    const M1: MigrationDefinition = MigrationDefinition {
        version: 1,
        id: "20250101_create_t1",
        sql_up: "CREATE TABLE t1(id INTEGER PRIMARY KEY NOT NULL);",
        high_risk: false,
    };
    const M2: MigrationDefinition = MigrationDefinition {
        version: 2,
        id: "20250102_create_t2",
        sql_up: "CREATE TABLE t2(v TEXT NOT NULL);",
        high_risk: false,
    };
    const M3: MigrationDefinition = MigrationDefinition {
        version: 3,
        id: "20250103_insert_seed",
        sql_up: "INSERT INTO t1(id) VALUES(42);",
        high_risk: false,
    };
    /// duplicate CREATE TABLE（SQLite execute_batch 将在第二次时 "table t1 already exists" 失败）
    const M_BAD_SQL: MigrationDefinition = MigrationDefinition {
        version: 1,
        id: "bad_dup_t1",
        sql_up: "CREATE TABLE t1(id INTEGER); CREATE TABLE t1(id INTEGER);",
        high_risk: false,
    };
    /// high_risk=true 版本（M1 同构，但触发 Snapshot）
    const M1_RISKY: MigrationDefinition = MigrationDefinition {
        version: 1,
        id: "20250101_create_t1_risky",
        sql_up: "CREATE TABLE t1(id INTEGER PRIMARY KEY NOT NULL);",
        high_risk: true,
    };

    fn new_conn(db_path: &Path) -> Connection {
        let conn = Connection::open(db_path).unwrap();
        conn.execute_batch(
            "PRAGMA journal_mode=WAL;\
             PRAGMA foreign_keys=ON;\
             PRAGMA busy_timeout=5000;\
             PRAGMA synchronous=NORMAL;",
        )
        .unwrap();
        conn
    }

    fn current_version(conn: &Connection) -> u32 {
        let v: Option<i64> = conn
            .query_row(
                "SELECT MAX(version) FROM schema_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        v.map(|x| {
            assert!(x > 0 && x <= u32::MAX as i64);
            x as u32
        })
        .unwrap_or(0)
    }

    fn history_count(conn: &Connection) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM schema_migrations",
            [],
            |r| r.get::<_, i64>(0),
        )
        .unwrap()
    }

    fn table_exists(conn: &Connection, name: &str) -> bool {
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .unwrap();
        cnt > 0
    }

    fn noop_snapshot_dir() -> (tempfile::TempDir, std::path::PathBuf) {
        let t = tempdir().unwrap();
        let d = t.path().join("backup");
        fs::create_dir_all(&d).unwrap();
        (t, d)
    }

    #[test]
    fn metadata_runner_created_id_unique_passes_validation() {
        let t = tempdir().unwrap();
        let conn = new_conn(&t.path().join("x.db"));
        bootstrap_history_table(&conn).unwrap();

        validate_history_structure(&conn).unwrap();
    }

    #[test]
    fn metadata_checksum_unique_does_not_replace_id_unique() {
        let t = tempdir().unwrap();
        let conn = new_conn(&t.path().join("x.db"));
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
                version         INTEGER PRIMARY KEY NOT NULL,
                id              TEXT    NOT NULL,
                checksum_sha256 TEXT    NOT NULL UNIQUE,
                applied_at_ms   INTEGER NOT NULL
            )",
        )
        .unwrap();

        let err = validate_history_structure(&conn).unwrap_err();
        assert!(matches!(err, MigrationError::HistoryCorrupt(_)), "{err:?}");
        assert!(err.to_string().contains("id must be UNIQUE"), "{err}");
    }

    #[test]
    fn metadata_composite_id_unique_does_not_replace_single_id_unique() {
        let t = tempdir().unwrap();
        let conn = new_conn(&t.path().join("x.db"));
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
                version         INTEGER PRIMARY KEY NOT NULL,
                id              TEXT    NOT NULL,
                checksum_sha256 TEXT    NOT NULL,
                applied_at_ms   INTEGER NOT NULL,
                UNIQUE(id, checksum_sha256)
            )",
        )
        .unwrap();

        let err = validate_history_structure(&conn).unwrap_err();
        assert!(matches!(err, MigrationError::HistoryCorrupt(_)), "{err:?}");
        assert!(err.to_string().contains("id must be UNIQUE"), "{err}");
    }

    #[test]
    fn metadata_standalone_single_id_unique_index_passes_validation() {
        let t = tempdir().unwrap();
        let conn = new_conn(&t.path().join("x.db"));
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
                version         INTEGER PRIMARY KEY NOT NULL,
                id              TEXT    NOT NULL,
                checksum_sha256 TEXT    NOT NULL,
                applied_at_ms   INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX schema_migrations_id_unique
                ON schema_migrations(id);",
        )
        .unwrap();

        validate_history_structure(&conn).unwrap();
    }

    #[test]
    fn metadata_missing_id_unique_is_history_corrupt() {
        let t = tempdir().unwrap();
        let conn = new_conn(&t.path().join("x.db"));
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
                version         INTEGER PRIMARY KEY NOT NULL,
                id              TEXT    NOT NULL,
                checksum_sha256 TEXT    NOT NULL,
                applied_at_ms   INTEGER NOT NULL
            )",
        )
        .unwrap();

        let err = validate_history_structure(&conn).unwrap_err();
        assert!(matches!(err, MigrationError::HistoryCorrupt(_)), "{err:?}");
        assert!(err.to_string().contains("id must be UNIQUE"), "{err}");
    }

    // ---------- [1] empty MIGRATIONS → version 0 ----------
    #[test]
    fn t01_empty_migrations_yields_version_0() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let r = runner.run(&mut conn, &snap).unwrap();
        assert_eq!(r.current_version, 0);
        assert_eq!(r.applied_count, 0);
        // schema_migrations 是 Runner metadata，必须存在；但无行
        assert!(table_exists(&conn, "schema_migrations"));
        assert_eq!(history_count(&conn), 0);
    }

    // ---------- [2] one migration ----------
    #[test]
    fn t02_one_migration_applied_v1() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let r = runner.run(&mut conn, &snap).unwrap();
        assert_eq!(r.current_version, 1);
        assert_eq!(r.applied_count, 1);
        assert_eq!(current_version(&conn), 1);
        assert!(table_exists(&conn, "t1"));
        let (id, sha) = applied_at(&conn, 1);
        assert_eq!(id, M1.id);
        assert_eq!(sha, sha256_hex(M1.sql_up.as_bytes()));
    }

    fn applied_at(conn: &Connection, v: u32) -> (String, String) {
        conn.query_row(
            "SELECT id, checksum_sha256 FROM schema_migrations WHERE version=?1",
            [v as i64],
            |r| Ok((r.get::<_, String>(0).unwrap(), r.get::<_, String>(1).unwrap())),
        )
        .unwrap()
    }

    // ---------- [3] multiple sequential migrations ----------
    #[test]
    fn t03_multiple_sequential_migrations() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1, M2, M3],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let r = runner.run(&mut conn, &snap).unwrap();
        assert_eq!(r.current_version, 3);
        assert_eq!(r.applied_count, 3);
        assert!(table_exists(&conn, "t1"));
        assert!(table_exists(&conn, "t2"));
        let n: i64 = conn.query_row("SELECT COUNT(*) FROM t1", [], |r| r.get(0)).unwrap();
        assert_eq!(n, 1);
        let val: i64 = conn.query_row("SELECT id FROM t1 LIMIT 1", [], |r| r.get(0)).unwrap();
        assert_eq!(val, 42);
        // 连续前缀 1,2,3
        assert_eq!(history_count(&conn), 3);
    }

    // ---------- [4] second run idempotent ----------
    #[test]
    fn t04_second_run_idempotent() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1, M2],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let r1 = runner.run(&mut conn, &snap).unwrap();
        assert_eq!(r1.current_version, 2);
        assert_eq!(r1.applied_count, 2);
        let r2 = runner.run(&mut conn, &snap).unwrap();
        assert_eq!(r2.current_version, 2);
        assert_eq!(r2.applied_count, 0, "idempotent 不应重复应用");
        assert_eq!(history_count(&conn), 2);
    }

    // ---------- [5] SQL duplicate table failure → schema + history 同时 rollback ----------
    #[test]
    fn t05_sql_failure_rolls_back_schema_and_history() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M_BAD_SQL],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(matches!(err, MigrationError::ApplyFailed { .. }), "{:?}", err);
        // history 无新增（同事务 rollback）
        assert_eq!(history_count(&conn), 0);
        // schema t1 不应当存在（SQL 中第二个 CREATE 触发 failure → 整 tx rollback，第一个 CREATE 也回滚）
        assert!(!table_exists(&conn, "t1"), "t1 不该存在（整 tx 回滚）");
    }

    // ---------- [6] BEFORE INSERT trigger RAISE(ABORT) → history insert failure → schema 同 tx rollback ----------
    #[test]
    fn t06_history_insert_failure_rolls_back_schema() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        // 先手动造 schema_migrations（使用 Runner 的版本），然后加 RAISE trigger
        bootstrap_history_table(&conn).unwrap();
        conn.execute_batch(
            "CREATE TRIGGER trg_no_history BEFORE INSERT ON schema_migrations \
             BEGIN SELECT RAISE(ABORT, 'simulated_history_insert_blocked'); END;",
        )
        .unwrap();

        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::HistoryInsertFailed { .. }),
            "{:?}",
            err
        );
        // 🔒 关键：t1 不存在（schema 被 rollback）
        assert!(!table_exists(&conn, "t1"));
        // history 保持 0 行
        assert_eq!(history_count(&conn), 0);
    }

    // ---------- [7] duplicate version ----------
    #[test]
    fn t07_definition_duplicate_version() {
        let dup = MigrationDefinition {
            version: 1,
            id: "dup_v1_id2",
            sql_up: "",
            high_risk: false,
        };
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let ms = [M1, dup];
        let runner = MigrationRunner::new(
            &ms,
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::DuplicateMigrationVersion(1)),
            "{:?}",
            err
        );
        // 未触及 DB（错误在 validate 阶段）
        assert!(!table_exists(&conn, "schema_migrations"));
    }

    // ---------- [8] duplicate id ----------
    #[test]
    fn t08_definition_duplicate_id() {
        let dup_id_v2 = MigrationDefinition {
            version: 2,
            id: M1.id,
            sql_up: "",
            high_risk: false,
        };
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let ms = [M1, dup_id_v2];
        let runner = MigrationRunner::new(
            &ms,
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::DuplicateMigrationId(_)),
            "{:?}",
            err
        );
    }

    // ---------- [9] first version != 1 ----------
    #[test]
    fn t09_definition_first_version_not_one() {
        let skip1 = MigrationDefinition {
            version: 2,
            id: "start_at_v2",
            sql_up: "",
            high_risk: false,
        };
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let ms = [skip1];
        let runner = MigrationRunner::new(
            &ms,
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::FirstVersionNotOne(2)),
            "{:?}",
            err
        );
    }

    // ---------- [10] definition gap ----------
    #[test]
    fn t10_definition_gap() {
        let m3only = MigrationDefinition {
            version: 3,
            id: "jump_to_v3",
            sql_up: "",
            high_risk: false,
        };
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let ms = [M1, m3only];
        let runner = MigrationRunner::new(
            &ms,
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::MigrationDefinitionGap { expected: 2, got: 3 }),
            "{:?}",
            err
        );
    }

    // ---------- [11] HistoryGap (applied [1,3]) ----------
    #[test]
    fn t11_history_gap() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        bootstrap_history_table(&conn).unwrap();
        // 手动造 applied 1 和 3（不创建 2）
        insert_history_row(&conn, 1, "m1", "sha_m1", 123);
        insert_history_row(&conn, 3, "m3", "sha_m3", 124);

        let (_td, snap) = noop_snapshot_dir();
        let ms = [];
        let runner = MigrationRunner::new(
            &ms,
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::HistoryGap { missing: 2, max_applied: 3 }),
            "{:?}",
            err
        );
    }

    fn insert_history_row(
        conn: &Connection,
        v: u32,
        id: &str,
        sha: &str,
        ms: i64,
    ) {
        conn.execute(
            "INSERT INTO schema_migrations(version,id,checksum_sha256,applied_at_ms) VALUES(?1,?2,?3,?4)",
            rusqlite::params![v as i64, id, sha, ms],
        )
        .unwrap();
    }

    // ---------- [12] FutureVersion (applied max > runner known max) ----------
    #[test]
    fn t12_future_version() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        // [1,2] applied，runner 只有 [M1]（max=1）
        bootstrap_history_table(&conn).unwrap();
        insert_history_row(&conn, 1, M1.id, &sha256_hex(M1.sql_up.as_bytes()), 100);
        insert_history_row(&conn, 2, "future_m2", "sha_future", 101);

        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::FutureVersion { db_max: 2, runner_max: 1 }),
            "{:?}",
            err
        );
    }

    // ---------- [13] MigrationIdMismatch ----------
    #[test]
    fn t13_migration_id_mismatch() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        bootstrap_history_table(&conn).unwrap();
        // applied 1 的 id 错误（但 checksum 正确，以隔离测试 id mismatch 分支）
        insert_history_row(
            &conn,
            1,
            "WRONG_ID_X",
            &sha256_hex(M1.sql_up.as_bytes()),
            1,
        );
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::MigrationIdMismatch { version: 1, .. }),
            "{:?}",
            err
        );
    }

    // ---------- [14] MigrationHashMismatch ----------
    #[test]
    fn t14_migration_hash_mismatch() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        bootstrap_history_table(&conn).unwrap();
        // id 正确但 hash 错误（模拟未来改了 SQL 却保持 version/id 不变）
        insert_history_row(&conn, 1, M1.id, "WRONG_SHA_000000", 1);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(
            matches!(err, MigrationError::MigrationHashMismatch { version: 1, .. }),
            "{:?}",
            err
        );
    }

    // ---------- [15] snapshot before transaction：M1_RISKY 跑一次，先产生 snapshot 再迁移 ----------
    #[test]
    fn t15_snapshot_created_before_transaction() {
        let (_td, snap_dir) = noop_snapshot_dir();
        // 观察目录：snapshot 执行前 snap_dir 无 .db
        assert_eq!(count_ext(&snap_dir, "db"), 0);
        assert_eq!(count_ext(&snap_dir, "json"), 0);

        let t_db = tempdir().unwrap();
        let db_path = t_db.path().join("live.db");
        let mut conn = new_conn(&db_path);

        let runner = MigrationRunner::new(
            &[M1_RISKY],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let r = runner.run(&mut conn, &snap_dir).unwrap();
        assert_eq!(r.applied_count, 1);
        assert!(table_exists(&conn, "t1"));

        // snapshot 文件应已生成（1 .db + 1 .json）
        assert_eq!(count_ext(&snap_dir, "db"), 1, "expected 1 snapshot .db");
        assert_eq!(count_ext(&snap_dir, "json"), 1, "expected 1 snapshot .json");
        // snapshot 文件名含 version 和 id
        let db_file = first_with_ext(&snap_dir, "db");
        let name = db_file.file_name().unwrap().to_string_lossy().to_string();
        assert!(name.contains("_v1_"), "snapshot name must encode version: {name}");
        assert!(name.contains(M1_RISKY.id), "snapshot name must encode id: {name}");
    }

    fn count_ext(dir: &Path, ext: &str) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter(|e| {
                let e = e.as_ref().unwrap();
                e.path().extension().map(|x| x == ext).unwrap_or(false)
            })
            .count()
    }

    fn first_with_ext(dir: &Path, ext: &str) -> std::path::PathBuf {
        fs::read_dir(dir)
            .unwrap()
            .find_map(|e| {
                let p = e.unwrap().path();
                if p.extension().map(|x| x == ext).unwrap_or(false) {
                    Some(p)
                } else {
                    None
                }
            })
            .unwrap()
    }

    // ---------- [16] snapshot failure → zero migration execution ----------
    // 策略：让 snapshot output_dir 不存在/不可写 → SnapshotFailed → 未执行任何 SQL
    struct AlwaysFailSnapshot;
    impl SnapshotProvider for AlwaysFailSnapshot {
        fn before_high_risk_migration(
            &self,
            _conn: &Connection,
            _output_dir: &Path,
            _m: &MigrationDefinition,
        ) -> Result<SnapshotReport, SnapshotError> {
            Err(SnapshotError::BackupApi("intentional failure for test".into()))
        }
    }

    #[test]
    fn t16_snapshot_failure_blocks_migration_execution() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(&[M1_RISKY], AlwaysFailSnapshot);
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(matches!(err, MigrationError::SnapshotFailed { .. }), "{:?}", err);
        // 🔒 关键：t1 不存在（Tx 未开始，零执行）
        assert!(!table_exists(&conn, "t1"));
        // history 为空
        assert_eq!(history_count(&conn), 0);
    }

    // ---------- [17] SQLite Backup snapshot integrity/data consistency ----------
    #[test]
    fn t17_sqlite_backup_snapshot_integrity_and_consistency() {
        let t_db = tempdir().unwrap();
        let db_path = t_db.path().join("live.db");
        // 初始化数据（非空，以验证数据被 snapshot 复制）
        let conn = new_conn(&db_path);
        conn.execute_batch(
            "CREATE TABLE fruits(name TEXT NOT NULL);\
             INSERT INTO fruits(name) VALUES('apple'),('banana'),('cherry');",
        )
        .unwrap();

        let (_td, snap_dir) = noop_snapshot_dir();
        let snap = super::super::snapshot::SqliteBackupSnapshot;
        let report = snap
            .before_high_risk_migration(&conn, &snap_dir, &M1_RISKY)
            .unwrap();
        // report 完整性
        assert!(report.integrity_check_ok);
        assert!(report.snapshot_db_path.exists());
        assert!(report.report_json_path.exists());
        // 流式哈希路径校验（报告存储的 hash == 再独立计算一次）
        let recomputed =
            super::super::checksum::sha256_file_hex(&report.snapshot_db_path).unwrap();
        assert_eq!(recomputed, report.checksum_sha256);
        // snapshot 内打开：必须能读到 3 条 fruits
        let vconn = Connection::open(&report.snapshot_db_path).unwrap();
        let integrity: String = vconn
            .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
            .unwrap();
        assert_eq!(integrity.to_lowercase(), "ok");
        let cnt: i64 = vconn
            .query_row("SELECT COUNT(*) FROM fruits", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt, 3, "snapshot 必须完整携带 live 数据");
        drop(vconn);
        // json report 可解析（.part 已 rename 为 .json）
        let json_txt = fs::read_to_string(&report.report_json_path).unwrap();
        let parsed: SnapshotReport = serde_json::from_str(&json_txt).unwrap();
        assert_eq!(parsed.id, report.id);
        assert_eq!(parsed.for_version, M1_RISKY.version);
        // id UUID 长度 36（完整 UUID v4，非缩写）
        assert_eq!(parsed.id.len(), 36);
    }

    // ---------- 附：version i64 out-of-range 触发 HistoryCorrupt（注意 A） ----------
    #[test]
    fn t_extra_version_out_of_range_history_corrupt() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        bootstrap_history_table(&conn).unwrap();
        // 直接写非法 negative version（绕过 typed API）
        conn.execute_batch(
            "INSERT INTO schema_migrations(version,id,checksum_sha256,applied_at_ms) \
             VALUES(0,'bad_zero','xxx',111)",
        )
        .unwrap();
        let (_td, snap) = noop_snapshot_dir();
        let ms = [];
        let runner = MigrationRunner::new(
            &ms,
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(matches!(err, MigrationError::HistoryCorrupt(_)), "{:?}", err);
        assert!(err.to_string().contains("out of range"), "{err}");
    }

    // ---------- 收口 2：applied_at_ms 负数必须 HistoryCorrupt（不存在 negative/running 语义） ----------
    #[test]
    fn negative_applied_at_is_history_corrupt() {
        let t = tempdir().unwrap();
        let db_path = t.path().join("x.db");
        let mut conn = new_conn(&db_path);
        bootstrap_history_table(&conn).unwrap();
        // 手工植入 negative applied_at_ms（模拟历史损坏/旧 running 残留）
        insert_history_row(&conn, 1, M1.id, &sha256_hex(M1.sql_up.as_bytes()), -1);
        let (_td, snap) = noop_snapshot_dir();
        let runner = MigrationRunner::new(
            &[M1, M2],
            super::super::snapshot::SqliteBackupSnapshot,
        );
        let err = runner.run(&mut conn, &snap).unwrap_err();
        assert!(matches!(err, MigrationError::HistoryCorrupt(_)), "{:?}", err);
        assert!(
            err.to_string().contains("applied_at_ms negative"),
            "message 必须命中 negative applied_at 分支，实际: {err}"
        );
    }

    // ---------- 附：Issue kind stability（Issue.kind 显式 match，非 Debug 打印） ----------
    #[test]
    fn t_extra_issue_kind_stable_strings() {
        use crate::Issue;
        let cases: Vec<(MigrationError, &'static str)> = vec![
            (MigrationError::DuplicateMigrationVersion(1), "DuplicateMigrationVersion"),
            (
                MigrationError::DuplicateMigrationId("x".into()),
                "DuplicateMigrationId",
            ),
            (MigrationError::FirstVersionNotOne(5), "FirstVersionNotOne"),
            (MigrationError::SortOrder, "SortOrder"),
            (
                MigrationError::MigrationDefinitionGap { expected: 2, got: 4 },
                "MigrationDefinitionGap",
            ),
            (
                MigrationError::HistoryGap { missing: 2, max_applied: 4 },
                "HistoryGap",
            ),
            (
                MigrationError::HistoryCorrupt("x".into()),
                "HistoryCorrupt",
            ),
            (
                MigrationError::FutureVersion { db_max: 10, runner_max: 3 },
                "FutureVersion",
            ),
            (
                MigrationError::MigrationIdMismatch {
                    version: 1,
                    known: "a".into(),
                    db: "b".into(),
                },
                "MigrationIdMismatch",
            ),
            (
                MigrationError::MigrationHashMismatch {
                    version: 1,
                    id: "x".into(),
                    known_sha: "a".into(),
                    db_sha: "b".into(),
                },
                "MigrationHashMismatch",
            ),
            (
                MigrationError::HistoryInsertFailed {
                    version: 1,
                    source: rusqlite::Error::SqliteSingleThreadedMode,
                },
                "HistoryInsertFailed",
            ),
            (
                MigrationError::TransactionCommitFailed {
                    version: 1,
                    source: rusqlite::Error::SqliteSingleThreadedMode,
                },
                "TransactionCommitFailed",
            ),
            (
                MigrationError::HistoryInvariantViolation("z".into()),
                "HistoryInvariantViolation",
            ),
            (
                // 收口 3：事务 begin 阶段独立错误类型
                MigrationError::TransactionBeginFailed {
                    version: 1,
                    source: rusqlite::Error::SqliteSingleThreadedMode,
                },
                "TransactionBeginFailed",
            ),
        ];
        let mut observed_kinds: HashMap<&'static str, ()> = HashMap::new();
        for (e, want) in cases {
            let issue: Issue = e.into();
            assert_eq!(issue.subsystem, "migration");
            assert_eq!(issue.kind, want, "kind mismatch for {}", want);
            observed_kinds.insert(want, ());
        }
        // SnapshotFailed 需要 SnapshotError source（用 AlwaysFail 简化构造）
        let snap_err =
            MigrationError::SnapshotFailed { version: 2, source: SnapshotError::BackupApi("a".into()) };
        let issue: Issue = snap_err.into();
        assert_eq!(issue.kind, "SnapshotFailed");
        observed_kinds.insert("SnapshotFailed", ());
        // ApplyFailed 需要 rusqlite error（用 fake）
        let apply_err = MigrationError::ApplyFailed {
            version: 1,
            id: "x".into(),
            source: rusqlite::Error::SqliteSingleThreadedMode,
        };
        let issue: Issue = apply_err.into();
        assert_eq!(issue.kind, "ApplyFailed");
        observed_kinds.insert("ApplyFailed", ());

        // 收口 3：全部 16 种 typed error 被覆盖（新增 TransactionBeginFailed）
        let expected: &[&str] = &[
            "DuplicateMigrationVersion",
            "DuplicateMigrationId",
            "FirstVersionNotOne",
            "SortOrder",
            "MigrationDefinitionGap",
            "HistoryGap",
            "HistoryCorrupt",
            "FutureVersion",
            "MigrationIdMismatch",
            "MigrationHashMismatch",
            "SnapshotFailed",
            "ApplyFailed",
            "HistoryInsertFailed",
            "TransactionBeginFailed",
            "TransactionCommitFailed",
            "HistoryInvariantViolation",
        ];
        for k in expected {
            assert!(observed_kinds.contains_key(k), "missing stable kind: {k}");
        }
        // 收口 5：kind() 和 Into<Issue> 必须完全一致（单一 authoritative mapping 校验）
        for k in expected {
            // 通过上面每个 case 的 assert_eq!(issue.kind, want) 已经保证 Into<Issue> = want。
            // 现在遍历每种 Error 构造的 .kind() 与 observed 完全对应。
            assert!(observed_kinds.contains_key(k), "kind() 缺少覆盖：{k}");
        }
    }

    // ---------- 附：checksum = raw sql bytes（冻结六，非 canonical） ----------
    #[test]
    fn t_extra_checksum_equals_raw_sql_bytes() {
        let sql_a = "CREATE TABLE a (id INT); \n CREATE TABLE b(x);";
        let sql_b = "CREATE TABLE a (id INT);\r\n CREATE TABLE b(x);";
        // 原始字节不同 → hash 必须不同（禁止 runtime canonicalize）
        assert_ne!(
            sha256_hex(sql_a.as_bytes()),
            sha256_hex(sql_b.as_bytes())
        );
    }
}
