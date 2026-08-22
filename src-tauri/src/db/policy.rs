//! Connection Policy：所有连接必须通过 open_configured_connection()。
//!
//! PRAGMA 是连接级设置；除 journal_mode=WAL 有持久标记外，每次新连接都必须重设并 read-back。
//!
//! 冻结 §4：validate_database_parent_exists 纯验证，不得 create_dir_all。

use rusqlite::{Connection, OpenFlags, ToSql};
use std::path::{Path, PathBuf};

use super::error::DbError;

/// 纯验证：数据库父目录必须存在且为目录。
///
/// 🔒 禁止创建。Data Root / database 目录的创建只能在
/// FirstBoot → DataRootService::initialize()。
/// Existing Valid bootstrap 下缺目录必须 Degraded。
pub fn validate_database_parent_exists(database_path: &Path) -> Result<PathBuf, DbError> {
    let parent = database_path
        .parent()
        .expect("database_path 应有父目录 (database/)");
    let meta = std::fs::metadata(parent).map_err(|_| {
        DbError::DatabaseParentMissing(parent.display().to_string())
    })?;
    if !meta.is_dir() {
        return Err(DbError::DatabaseParentIsFile(
            parent.display().to_string(),
        ));
    }
    Ok(parent.to_path_buf())
}

/// 打开 SQLite，应用 Connection Policy，read-back 校验，FTS5 校验，SELECT 1。
///
/// 不放入 State。Step 8 调用方在 boot_db() 中立即 drop。Step 9 Migration Runner 重调本函数。
pub fn open_configured_connection<P: AsRef<Path>>(database_path: P) -> Result<Connection, DbError> {
    let database_path = database_path.as_ref();

    // 1. 先纯验证（禁止自动创建父目录）
    let _parent = validate_database_parent_exists(database_path)?;

    // 2. open（flags 默认 = READWRITE | CREATE，符合 Step 8 允许 open/create）
    let conn = Connection::open(database_path).map_err(|source| DbError::SqliteOpen {
        path: database_path.display().to_string(),
        code: sqlite_code(&source),
        source,
    })?;

    configure_connection(conn)
}

/// 打开已经存在的 SQLite 主库，严格禁止 CREATE。
///
/// Runtime business commands must use this entry point after validating an
/// existing bootstrap and Data Root. A missing database fails closed and must
/// not create a replacement file.
pub fn open_existing_configured_connection<P: AsRef<Path>>(
    database_path: P,
) -> Result<Connection, DbError> {
    let database_path = database_path.as_ref();

    let _parent = validate_database_parent_exists(database_path)?;
    let conn = Connection::open_with_flags(database_path, OpenFlags::SQLITE_OPEN_READ_WRITE)
        .map_err(|source| DbError::SqliteOpen {
            path: database_path.display().to_string(),
            code: sqlite_code(&source),
            source,
        })?;

    configure_connection(conn)
}

fn configure_connection(conn: Connection) -> Result<Connection, DbError> {
    // 3. PRAGMA 写入 + read-back（严格 Policy）
    apply_pragma(&conn, "journal_mode", "WAL", &["wal"])?;
    apply_pragma(&conn, "synchronous", "NORMAL", &["1", "normal"])?;
    apply_pragma(&conn, "foreign_keys", "ON", &["1"])?;
    apply_pragma(&conn, "busy_timeout", "5000", &["5000"])?;

    // 4. FTS5 编译验证（冻结 §11：sqlite_compileoption_used('ENABLE_FTS5')）
    verify_fts5_enabled(&conn)?;

    // 5. 基本 I/O sanity
    let one: i64 = conn
        .query_row("SELECT 1", [], |r| r.get(0))
        .map_err(|source| DbError::SanityCheck { source })?;
    if one != 1 {
        return Err(DbError::SanityCheckValue(one));
    }

    Ok(conn)
}

// -------- 内部工具 --------

fn apply_pragma(
    conn: &Connection,
    name: &'static str,
    set_value: &str,
    accepted: &[&str],
) -> Result<(), DbError> {
    // PRAGMA busy_timeout 接受数字字符串（"5000"）直接 pragma_update
    conn.pragma_update(None, name, set_value)
        .map_err(|source| DbError::PragmaUpdate { name, source })?;
    let actual = read_scalar_as_string(conn, &format!("PRAGMA {}", name))
        .map_err(|source| DbError::PragmaRead { name, source })?;
    let actual_lower = actual.to_lowercase();
    let ok = accepted.iter().any(|a| a.to_lowercase() == actual_lower);
    if !ok {
        return Err(DbError::PragmaReadbackMismatch {
            name: name.to_string(),
            expected: accepted.join("|"),
            actual,
        });
    }
    Ok(())
}

/// 读取 1 列 1 行标量；兼容 TEXT / INTEGER（转字符串）。
/// 用于 PRAGMA 返回值类型不稳定的场景（如 synchronous 在某些 SQLite 构建里返回 INTEGER）。
fn read_scalar_as_string(conn: &Connection, sql: &str) -> Result<String, rusqlite::Error> {
    use rusqlite::types::Value;
    conn.query_row(sql, [], |r| {
        let v: Value = r.get(0)?;
        Ok(match v {
            Value::Text(s) => s,
            Value::Integer(i) => i.to_string(),
            Value::Real(f) => f.to_string(),
            Value::Blob(b) => String::from_utf8_lossy(&b).into_owned(),
            Value::Null => String::new(),
        })
    })
}

fn verify_fts5_enabled(conn: &Connection) -> Result<(), DbError> {
    // 冻结 §11：sqlite_compileoption_used('ENABLE_FTS5'); 必须为 1
    let query = "SELECT sqlite_compileoption_used('ENABLE_FTS5');";
    let val: i64 = conn
        .query_row(query, [], |r| r.get(0))
        .map_err(|source| DbError::PragmaRead {
            name: "sqlite_compileoption_used('ENABLE_FTS5')",
            source,
        })?;
    if val == 1 {
        Ok(())
    } else {
        Err(DbError::Fts5NotCompiled)
    }
}

fn sqlite_code(e: &rusqlite::Error) -> i32 {
    match e {
        rusqlite::Error::SqliteFailure(ec, _) => ec.extended_code,
        _ => 0,
    }
}

#[allow(dead_code)]
fn _dummy_to_sql(_: &dyn ToSql) {} // 防止 unused import
