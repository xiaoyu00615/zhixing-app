//! DB 错误枚举。

use rusqlite::Error as RusqliteError;
use thiserror::Error;

use super::migration::MigrationError;

#[derive(Debug, Error)]
pub enum DbError {
    #[error("SQLite 打开失败 (code={code}): {path}: {source}")]
    SqliteOpen {
        path: String,
        code: i32,
        #[source]
        source: RusqliteError,
    },

    #[error("数据库父目录不存在: {0}（现有 Data Root 缺失子目录，请走 Degraded 不自动修复）")]
    DatabaseParentMissing(String),

    #[error("数据库父目录条目存在但不是目录: {0}")]
    DatabaseParentIsFile(String),

    #[error("PRAGMA read-back 不匹配: {name}, 期望 ∈ [{expected}], 实际: {actual}")]
    PragmaReadbackMismatch {
        name: String,
        expected: String,
        actual: String,
    },

    #[error("FTS5 未编译进当前 rusqlite。sqlite_compileoption_used('ENABLE_FTS5') ≠ 1")]
    Fts5NotCompiled,

    #[error("PRAGMA 设置失败 ({name}): {source}")]
    PragmaUpdate {
        name: &'static str,
        #[source]
        source: RusqliteError,
    },

    #[error("PRAGMA 读取失败 ({name}): {source}")]
    PragmaRead {
        name: &'static str,
        #[source]
        source: RusqliteError,
    },

    #[error("SELECT 1 sanity check 失败: {source}")]
    SanityCheck {
        #[source]
        source: RusqliteError,
    },

    #[error("SELECT 1 返回值 != 1，实际: {0}")]
    SanityCheckValue(i64),

    /// 收口 5：SnapshotError 只作为 MigrationError::SnapshotFailed.source 存在，不再单独进入 DbError。
    /// 单一链路：MigrationError → DbError::Migration → Issue → DegradedCause::Database。
    #[error("MigrationRunner 执行失败: {0}")]
    Migration(#[from] MigrationError),
}
