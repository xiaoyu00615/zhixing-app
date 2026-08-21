//! DB Bootstrap 高层入口：调 open_configured_connection 后立即 drop（Step 8 不进入 State）。

use std::path::{Path, PathBuf};

use super::error::DbError;
use super::policy::open_configured_connection;

/// Step 8 启动入口：
///
/// 打开数据库 → 应用 Connection Policy → read-back → FTS5 → SELECT 1 → 立即 drop。
///
/// 返回：成功时 Ok(db_path 拷贝)；失败时 DbError（setup 必须捕获，转入 Degraded，不 ? 导致 setup 失败）。
pub fn boot_db(database_path: &Path) -> Result<PathBuf, DbError> {
    let conn = open_configured_connection(database_path)?;
    // Step 8 不将 Connection 放入 State。
    // 显式 drop（不必要，但在语义上提醒调用者：连接生命周期在此结束）。
    drop(conn);
    Ok(database_path.to_path_buf())
}
