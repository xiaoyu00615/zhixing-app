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
const ADD_TASK_SOFT_DELETE_SQL: &str =
    include_str!("../../migrations/0005_add_task_soft_delete.sql");
const ADD_CANVAS_CORE_SQL: &str = include_str!("../../migrations/0006_add_canvas_core.sql");
const ADD_CANVAS_EDGES_SQL: &str = include_str!("../../migrations/0007_add_canvas_edges.sql");
const ADD_STICKY_CANVAS_NODES_SQL: &str =
    include_str!("../../migrations/0008_add_sticky_canvas_nodes.sql");

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
    MigrationDefinition {
        version: 5,
        id: "0005_add_task_soft_delete",
        sql_up: ADD_TASK_SOFT_DELETE_SQL,
        high_risk: false,
    },
    MigrationDefinition {
        version: 6,
        id: "0006_add_canvas_core",
        sql_up: ADD_CANVAS_CORE_SQL,
        high_risk: false,
    },
    MigrationDefinition {
        version: 7,
        id: "0007_add_canvas_edges",
        sql_up: ADD_CANVAS_EDGES_SQL,
        high_risk: false,
    },
    MigrationDefinition {
        version: 8,
        id: "0008_add_sticky_canvas_nodes",
        sql_up: ADD_STICKY_CANVAS_NODES_SQL,
        high_risk: true,
    },
];
