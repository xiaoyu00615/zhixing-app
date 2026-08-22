//! Production migration definitions.
//!
//! Phase 1B activates the first approved business migration. SQL remains in
//! one LF-locked file and is included without canonicalization.
//!
//! 测试使用本地自定义 MigrationDefinition（sandbox 里），绝不进入本 definitions。

use super::migration::MigrationDefinition;

const CREATE_TASKS_SQL: &str = include_str!("../../migrations/0001_create_tasks.sql");

pub const MIGRATIONS: &[MigrationDefinition] = &[MigrationDefinition {
    version: 1,
    id: "0001_create_tasks",
    sql_up: CREATE_TASKS_SQL,
    high_risk: false,
}];
