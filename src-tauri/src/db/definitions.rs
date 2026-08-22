//! Step 9 production 迁移定义。
//!
//! 🔒 冻结：Step 9 production MIGRATIONS = []。
//! 不创建任何业务 migration；不写 placeholder/dummy migration；
//! 业务 schema migration 留待后续业务 Phase 引入。
//!
//! 测试使用本地自定义 MigrationDefinition（sandbox 里），绝不进入本 definitions。

use super::migration::MigrationDefinition;

pub const MIGRATIONS: &[MigrationDefinition] = &[];
