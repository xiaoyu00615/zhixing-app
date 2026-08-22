//! DB 模块：SQLite Bootstrap & Connection Policy & Migration Runner & Safety Snapshot。
//!
//! Step 8 冻结：open_configured_connection、validate_database_parent_exists 不创建父目录、无业务表、schema_migrations metadata 不写 0001 migration。
//! Step 9 新增：MigrationRunner（单事务 Immediate + history INSERT），Safety Snapshot（SQLite Backup API + tmp→integrity→rename 原子）。

pub mod bootstrap;
pub mod checksum;
pub mod definitions;
pub mod error;
pub mod migration;
pub mod policy;
pub mod snapshot;
