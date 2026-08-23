//! Production migration definitions.
//!
//! Approved business migrations remain in LF-locked SQL files and are
//! included without canonicalization.
//!
//! 测试使用本地自定义 MigrationDefinition（sandbox 里），绝不进入本 definitions。

use super::migration::MigrationDefinition;

const CREATE_TASKS_SQL: &str = include_str!("../../migrations/0001_create_tasks.sql");
const ADD_TASK_PLANNING_FIELDS_SQL: &str =
    include_str!("../../migrations/0002_add_task_planning_fields.sql");
const ADD_TASK_PROJECTS_SQL: &str = include_str!("../../migrations/0003_add_task_projects.sql");
const ADD_TASK_TAGS_SQL: &str = include_str!("../../migrations/0004_add_task_tags.sql");

pub const MIGRATIONS: &[MigrationDefinition] = &[
    MigrationDefinition {
        version: 1,
        id: "0001_create_tasks",
        sql_up: CREATE_TASKS_SQL,
        high_risk: false,
    },
    MigrationDefinition {
        version: 2,
        id: "0002_add_task_planning_fields",
        sql_up: ADD_TASK_PLANNING_FIELDS_SQL,
        high_risk: false,
    },
    MigrationDefinition {
        version: 3,
        id: "0003_add_task_projects",
        sql_up: ADD_TASK_PROJECTS_SQL,
        high_risk: false,
    },
    MigrationDefinition {
        version: 4,
        id: "0004_add_task_tags",
        sql_up: ADD_TASK_TAGS_SQL,
        high_risk: false,
    },
];
