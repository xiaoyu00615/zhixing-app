//! DB 模块：SQLite Bootstrap & Connection Policy（不带 State / Mutex）。
//!
//! 冻结边界（Step 8）：
//! - 仅定义 open_configured_connection(db_path)：打开 → 设 PRAGMA → read-back → FTS5 verify → SELECT 1
//! - 不把 rusqlite::Connection 放入 Tauri State；所有权 / 池化 / 共享 = Step 9。
//! - DB 层禁止创建父目录：validate_database_parent_exists 只验证不 create_dir_all。
//! - 不创建任何业务表；不创建 schema_migrations；Step 9 Migration Runner 复用 open_configured_connection。

pub mod bootstrap;
pub mod error;
pub mod policy;
