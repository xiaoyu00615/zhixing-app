//! Task Planning Slice 2 native persistence.
//!
//! This module owns only the approved Task fields and capability-specific
//! operations. Business schema changes remain exclusively in migrations.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row, Transaction, TransactionBehavior};
use thiserror::Error;
use uuid::Uuid;

use crate::bootstrap::{BootstrapService, BootstrapState};
use crate::db::policy::open_existing_configured_connection;
use crate::storage::{DataRootService, InitMode};

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskStatus {
    Todo,
    Doing,
    Completed,
    Cancelled,
}

impl TaskStatus {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::Todo => "todo",
            Self::Doing => "doing",
            Self::Completed => "completed",
            Self::Cancelled => "cancelled",
        }
    }
}

impl TryFrom<&str> for TaskStatus {
    type Error = TaskError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "todo" => Ok(Self::Todo),
            "doing" => Ok(Self::Doing),
            "completed" => Ok(Self::Completed),
            "cancelled" => Ok(Self::Cancelled),
            _ => Err(TaskError::PersistenceFailed),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TaskStatusOperation {
    Start,
    Complete,
    Cancel,
    Reopen,
}

impl TryFrom<&str> for TaskStatusOperation {
    type Error = TaskError;

    fn try_from(value: &str) -> Result<Self, Self::Error> {
        match value {
            "start" => Ok(Self::Start),
            "complete" => Ok(Self::Complete),
            "cancel" => Ok(Self::Cancel),
            "reopen" => Ok(Self::Reopen),
            _ => Err(TaskError::PersistenceFailed),
        }
    }
}

pub(crate) const fn resolve_status_transition(
    current: TaskStatus,
    operation: TaskStatusOperation,
) -> Option<TaskStatus> {
    match (current, operation) {
        (TaskStatus::Todo, TaskStatusOperation::Start) => Some(TaskStatus::Doing),
        (TaskStatus::Todo | TaskStatus::Doing, TaskStatusOperation::Complete) => {
            Some(TaskStatus::Completed)
        }
        (TaskStatus::Todo | TaskStatus::Doing, TaskStatusOperation::Cancel) => {
            Some(TaskStatus::Cancelled)
        }
        (TaskStatus::Completed | TaskStatus::Cancelled, TaskStatusOperation::Reopen) => {
            Some(TaskStatus::Todo)
        }
        _ => None,
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TaskRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: TaskStatus,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    pub(crate) is_important: bool,
    pub(crate) is_urgent: bool,
    pub(crate) due_date: Option<String>,
}

pub(crate) struct CreateTaskInput {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) created_at_ms: i64,
    pub(crate) is_important: bool,
    pub(crate) is_urgent: bool,
    pub(crate) due_date: Option<String>,
}

pub(crate) struct RenameTaskInput {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct ChangeTaskStatusInput {
    pub(crate) id: String,
    pub(crate) operation: TaskStatusOperation,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct SetTaskImportanceInput {
    pub(crate) id: String,
    pub(crate) is_important: bool,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct SetTaskUrgencyInput {
    pub(crate) id: String,
    pub(crate) is_urgent: bool,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct SetTaskDeadlineInput {
    pub(crate) id: String,
    pub(crate) due_date: String,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct ClearTaskDeadlineInput {
    pub(crate) id: String,
    pub(crate) updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum TaskError {
    #[error("task not found")]
    NotFound,
    #[error("task status conflict")]
    StatusConflict,
    #[error("task persistence unavailable")]
    PersistenceUnavailable,
    #[error("task persistence failed")]
    PersistenceFailed,
}

impl TaskError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::StatusConflict => "STATUS_CONFLICT",
            Self::PersistenceUnavailable => "PERSISTENCE_UNAVAILABLE",
            Self::PersistenceFailed => "PERSISTENCE_FAILED",
        }
    }

    pub(crate) const fn safe_message(self) -> &'static str {
        match self {
            Self::NotFound => "Task not found.",
            Self::StatusConflict => "Task status conflict.",
            Self::PersistenceUnavailable => "Task persistence is unavailable.",
            Self::PersistenceFailed => "Task persistence operation failed.",
        }
    }
}

struct RawTaskRecord {
    id: String,
    title: String,
    status: String,
    created_at_ms: i64,
    updated_at_ms: i64,
    is_important: i64,
    is_urgent: i64,
    due_date: Option<String>,
}

impl RawTaskRecord {
    fn into_task(self) -> Result<TaskRecord, TaskError> {
        validate_timestamp(self.created_at_ms)?;
        validate_timestamp(self.updated_at_ms)?;
        if self.updated_at_ms < self.created_at_ms
            || !matches!(self.is_important, 0 | 1)
            || !matches!(self.is_urgent, 0 | 1)
            || self
                .due_date
                .as_deref()
                .is_some_and(|date| !is_valid_local_date(date))
        {
            return Err(TaskError::PersistenceFailed);
        }
        Ok(TaskRecord {
            id: self.id,
            title: self.title,
            status: TaskStatus::try_from(self.status.as_str())?,
            created_at_ms: self.created_at_ms,
            updated_at_ms: self.updated_at_ms,
            is_important: self.is_important == 1,
            is_urgent: self.is_urgent == 1,
            due_date: self.due_date,
        })
    }
}

fn raw_task_from_row(row: &Row<'_>) -> rusqlite::Result<RawTaskRecord> {
    Ok(RawTaskRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        status: row.get(2)?,
        created_at_ms: row.get(3)?,
        updated_at_ms: row.get(4)?,
        is_important: row.get(5)?,
        is_urgent: row.get(6)?,
        due_date: row.get(7)?,
    })
}

fn validate_id(id: &str) -> Result<(), TaskError> {
    let parsed = Uuid::parse_str(id).map_err(|_| TaskError::PersistenceFailed)?;
    if parsed.hyphenated().to_string() == id {
        Ok(())
    } else {
        Err(TaskError::PersistenceFailed)
    }
}

fn validate_title(title: &str) -> Result<(), TaskError> {
    if title.trim().is_empty() {
        Err(TaskError::PersistenceFailed)
    } else {
        Ok(())
    }
}

fn validate_timestamp(timestamp: i64) -> Result<(), TaskError> {
    if !(0..=MAX_SAFE_INTEGER_MILLISECONDS).contains(&timestamp) {
        Err(TaskError::PersistenceFailed)
    } else {
        Ok(())
    }
}

fn is_valid_local_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes
            .iter()
            .enumerate()
            .any(|(index, byte)| index != 4 && index != 7 && !byte.is_ascii_digit())
    {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u16>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u8>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u8>() else {
        return false;
    };
    if year == 0 || !(1..=12).contains(&month) || day == 0 {
        return false;
    }
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days = [
        31,
        if leap { 29 } else { 28 },
        31,
        30,
        31,
        30,
        31,
        31,
        30,
        31,
        30,
        31,
    ];
    day <= days[usize::from(month - 1)]
}

fn validate_due_date(due_date: &str) -> Result<(), TaskError> {
    if is_valid_local_date(due_date) {
        Ok(())
    } else {
        Err(TaskError::PersistenceFailed)
    }
}

pub(crate) struct TaskDbService;

impl TaskDbService {
    /// Resolve only an already-valid bootstrap/Data Root and open only an
    /// already-existing database. This path never performs FirstBoot work.
    pub(crate) fn open_existing(app_config_dir: &Path) -> Result<Connection, TaskError> {
        let bootstrap_path = BootstrapService::bootstrap_path(app_config_dir);
        let loaded = match BootstrapService::load(&bootstrap_path) {
            BootstrapState::Valid(loaded) => loaded,
            BootstrapState::Missing { .. } | BootstrapState::Degraded(_) => {
                return Err(TaskError::PersistenceUnavailable)
            }
        };

        let (data_root, manifest) =
            DataRootService::get_and_ensure(&loaded.data_root, InitMode::Existing)
                .map_err(|_| TaskError::PersistenceUnavailable)?;
        let database_path = DataRootService::resolve_database_path(&data_root, &manifest);
        open_existing_configured_connection(database_path)
            .map_err(|_| TaskError::PersistenceUnavailable)
    }

    pub(crate) fn create(
        conn: &Connection,
        input: CreateTaskInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_title(&input.title)?;
        validate_timestamp(input.created_at_ms)?;
        if let Some(due_date) = input.due_date.as_deref() {
            validate_due_date(due_date)?;
        }

        conn.query_row(
            "INSERT INTO tasks( \
                 id, title, created_at_ms, updated_at_ms, is_important, is_urgent, due_date \
             ) VALUES(?1, ?2, ?3, ?3, ?4, ?5, ?6) \
             RETURNING id, title, status, created_at_ms, updated_at_ms, \
                       is_important, is_urgent, due_date",
            params![
                input.id,
                input.title,
                input.created_at_ms,
                input.is_important,
                input.is_urgent,
                input.due_date
            ],
            raw_task_from_row,
        )
        .map_err(|_| TaskError::PersistenceFailed)?
        .into_task()
    }

    pub(crate) fn list(conn: &Connection) -> Result<Vec<TaskRecord>, TaskError> {
        let mut statement = conn
            .prepare(
                "SELECT id, title, status, created_at_ms, updated_at_ms, \
                        is_important, is_urgent, due_date \
                 FROM tasks ORDER BY updated_at_ms DESC, id ASC",
            )
            .map_err(|_| TaskError::PersistenceFailed)?;
        let rows = statement
            .query_map([], raw_task_from_row)
            .map_err(|_| TaskError::PersistenceFailed)?;

        let mut tasks = Vec::new();
        for row in rows {
            tasks.push(row.map_err(|_| TaskError::PersistenceFailed)?.into_task()?);
        }
        Ok(tasks)
    }

    pub(crate) fn rename(
        conn: &Connection,
        input: RenameTaskInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_title(&input.title)?;
        validate_timestamp(input.updated_at_ms)?;

        let task = conn
            .query_row(
                "UPDATE tasks SET title = ?1, updated_at_ms = ?2 WHERE id = ?3 \
                 RETURNING id, title, status, created_at_ms, updated_at_ms, \
                           is_important, is_urgent, due_date",
                params![input.title, input.updated_at_ms, input.id],
                raw_task_from_row,
            )
            .optional()
            .map_err(|_| TaskError::PersistenceFailed)?;

        task.ok_or(TaskError::NotFound)?.into_task()
    }

    pub(crate) fn change_status(
        conn: &mut Connection,
        input: ChangeTaskStatusInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let transaction = conn
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|_| TaskError::PersistenceFailed)?;
        let current_raw = transaction
            .query_row(
                "SELECT status FROM tasks WHERE id = ?1",
                [&input.id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| TaskError::PersistenceFailed)?
            .ok_or(TaskError::NotFound)?;
        let current = TaskStatus::try_from(current_raw.as_str())?;
        let target =
            resolve_status_transition(current, input.operation).ok_or(TaskError::StatusConflict)?;

        let task = compare_and_set_status(
            &transaction,
            &input.id,
            current,
            target,
            input.updated_at_ms,
        )?;
        transaction
            .commit()
            .map_err(|_| TaskError::PersistenceFailed)?;
        Ok(task)
    }

    pub(crate) fn set_importance(
        conn: &Connection,
        input: SetTaskImportanceInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        update_planning_value(
            conn,
            "UPDATE tasks SET is_important = ?1, updated_at_ms = ?2 WHERE id = ?3 \
             RETURNING id, title, status, created_at_ms, updated_at_ms, \
                       is_important, is_urgent, due_date",
            input.is_important,
            input.updated_at_ms,
            &input.id,
        )
    }

    pub(crate) fn set_urgency(
        conn: &Connection,
        input: SetTaskUrgencyInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        update_planning_value(
            conn,
            "UPDATE tasks SET is_urgent = ?1, updated_at_ms = ?2 WHERE id = ?3 \
             RETURNING id, title, status, created_at_ms, updated_at_ms, \
                       is_important, is_urgent, due_date",
            input.is_urgent,
            input.updated_at_ms,
            &input.id,
        )
    }

    pub(crate) fn set_deadline(
        conn: &Connection,
        input: SetTaskDeadlineInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        validate_due_date(&input.due_date)?;
        update_planning_value(
            conn,
            "UPDATE tasks SET due_date = ?1, updated_at_ms = ?2 WHERE id = ?3 \
             RETURNING id, title, status, created_at_ms, updated_at_ms, \
                       is_important, is_urgent, due_date",
            input.due_date,
            input.updated_at_ms,
            &input.id,
        )
    }

    pub(crate) fn clear_deadline(
        conn: &Connection,
        input: ClearTaskDeadlineInput,
    ) -> Result<TaskRecord, TaskError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        let task = conn
            .query_row(
                "UPDATE tasks SET due_date = NULL, updated_at_ms = ?1 WHERE id = ?2 \
                 RETURNING id, title, status, created_at_ms, updated_at_ms, \
                           is_important, is_urgent, due_date",
                params![input.updated_at_ms, input.id],
                raw_task_from_row,
            )
            .optional()
            .map_err(|_| TaskError::PersistenceFailed)?;
        task.ok_or(TaskError::NotFound)?.into_task()
    }
}

fn update_planning_value<T: rusqlite::ToSql>(
    conn: &Connection,
    sql: &str,
    value: T,
    updated_at_ms: i64,
    id: &str,
) -> Result<TaskRecord, TaskError> {
    let task = conn
        .query_row(sql, params![value, updated_at_ms, id], raw_task_from_row)
        .optional()
        .map_err(|_| TaskError::PersistenceFailed)?;
    task.ok_or(TaskError::NotFound)?.into_task()
}

fn compare_and_set_status(
    transaction: &Transaction<'_>,
    id: &str,
    previous: TaskStatus,
    target: TaskStatus,
    updated_at_ms: i64,
) -> Result<TaskRecord, TaskError> {
    let task = transaction
        .query_row(
            "UPDATE tasks SET status = ?1, updated_at_ms = ?2 \
             WHERE id = ?3 AND status = ?4 \
             RETURNING id, title, status, created_at_ms, updated_at_ms, \
                       is_important, is_urgent, due_date",
            params![target.as_str(), updated_at_ms, id, previous.as_str()],
            raw_task_from_row,
        )
        .optional()
        .map_err(|_| TaskError::PersistenceFailed)?;

    task.ok_or(TaskError::StatusConflict)?.into_task()
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::PathBuf;

    use rusqlite::Connection;
    use tempfile::{tempdir, TempDir};

    use super::*;
    use crate::bootstrap::BootstrapService;
    use crate::db::definitions::MIGRATIONS;
    use crate::db::migration::MigrationRunner;
    use crate::db::policy::{open_configured_connection, open_existing_configured_connection};
    use crate::db::snapshot::SqliteBackupSnapshot;

    const ID_A: &str = "00000000-0000-4000-8000-000000000001";
    const ID_B: &str = "00000000-0000-4000-8000-000000000002";
    const ID_C: &str = "00000000-0000-4000-8000-000000000003";

    fn migrated_database() -> (TempDir, PathBuf, Connection) {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        (sandbox, database_path, connection)
    }

    fn create_task(conn: &Connection, id: &str, title: &str, created_at_ms: i64) -> TaskRecord {
        TaskDbService::create(
            conn,
            CreateTaskInput {
                id: id.to_string(),
                title: title.to_string(),
                created_at_ms,
                is_important: false,
                is_urgent: false,
                due_date: None,
            },
        )
        .unwrap()
    }

    #[test]
    fn migrations_apply_exact_task_planning_schema_and_history() {
        let (_sandbox, _database_path, connection) = migrated_database();

        let mut history_statement = connection
            .prepare("SELECT version, id FROM schema_migrations ORDER BY version")
            .unwrap();
        let history = history_statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            history,
            [
                (1, "0001_create_tasks".to_string()),
                (2, "0002_add_task_planning_fields".to_string()),
            ]
        );

        let mut statement = connection.prepare("PRAGMA table_info('tasks')").unwrap();
        let columns: Vec<(String, String, i64, Option<String>, i64)> = statement
            .query_map([], |row| {
                Ok((
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns,
            vec![
                ("id".into(), "TEXT".into(), 1, None, 1),
                ("title".into(), "TEXT".into(), 1, None, 0),
                ("status".into(), "TEXT".into(), 1, Some("'todo'".into()), 0),
                ("created_at_ms".into(), "INTEGER".into(), 1, None, 0),
                ("updated_at_ms".into(), "INTEGER".into(), 1, None, 0),
                (
                    "is_important".into(),
                    "INTEGER".into(),
                    1,
                    Some("0".into()),
                    0
                ),
                ("is_urgent".into(), "INTEGER".into(), 1, Some("0".into()), 0),
                ("due_date".into(), "TEXT".into(), 0, None, 0),
            ]
        );

        for migration in MIGRATIONS {
            assert!(!migration.sql_up.starts_with('\u{feff}'));
            assert!(!migration.sql_up.contains('\r'));
            assert!(!migration.sql_up.contains("IF NOT EXISTS"));
        }
    }

    #[test]
    fn existing_v1_database_migrates_old_rows_to_planning_defaults() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();

        MigrationRunner::new(&MIGRATIONS[..1], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) \
                 VALUES(?1, 'Existing', 'doing', 10, 20)",
                [ID_A],
            )
            .unwrap();

        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();

        assert_eq!(
            TaskDbService::list(&connection).unwrap(),
            [TaskRecord {
                id: ID_A.into(),
                title: "Existing".into(),
                status: TaskStatus::Doing,
                created_at_ms: 10,
                updated_at_ms: 20,
                is_important: false,
                is_urgent: false,
                due_date: None,
            }]
        );
        let history: Vec<i64> = connection
            .prepare("SELECT version FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(history, [1, 2]);
    }

    #[test]
    fn migration_two_rolls_back_schema_when_history_insert_fails() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();

        MigrationRunner::new(&MIGRATIONS[..1], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_migration_two \
                 BEFORE INSERT ON schema_migrations \
                 WHEN NEW.version = 2 \
                 BEGIN SELECT RAISE(ABORT, 'injected'); END;",
            )
            .unwrap();

        assert!(MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .is_err());

        let columns: Vec<String> = connection
            .prepare("PRAGMA table_info('tasks')")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns,
            ["id", "title", "status", "created_at_ms", "updated_at_ms"]
        );
        assert_eq!(
            connection
                .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            1
        );
    }

    #[test]
    fn tasks_schema_rejects_invalid_values() {
        let (_sandbox, _database_path, connection) = migrated_database();
        for sql in [
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES('a', '   ', 'todo', 0, 0)",
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES('b', 'Task', 'archived', 0, 0)",
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES('c', 'Task', 'todo', -1, 0)",
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES('d', 'Task', 'todo', 10, 9)",
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, is_important) VALUES('e', 'Task', 'todo', 0, 0, 2)",
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, is_urgent) VALUES('f', 'Task', 'todo', 0, 0, -1)",
            "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, due_date) VALUES('g', 'Task', 'todo', 0, 0, '2026/08/23')",
        ] {
            assert!(connection.execute_batch(sql).is_err(), "accepted: {sql}");
        }
    }

    #[test]
    fn local_date_validation_uses_the_gregorian_calendar() {
        for valid in ["0001-01-01", "2024-02-29", "2026-08-23", "9999-12-31"] {
            assert!(is_valid_local_date(valid), "rejected: {valid}");
        }
        for invalid in [
            "0000-01-01",
            "2026-00-01",
            "2026-13-01",
            "2026-02-30",
            "2025-02-29",
            "2026-8-23",
            "2026/08/23",
        ] {
            assert!(!is_valid_local_date(invalid), "accepted: {invalid}");
        }
    }

    #[test]
    fn create_uses_todo_and_copies_created_timestamp() {
        let (_sandbox, _database_path, connection) = migrated_database();
        let task = create_task(&connection, ID_A, "Task", 123);

        assert_eq!(task.status, TaskStatus::Todo);
        assert_eq!(task.created_at_ms, 123);
        assert_eq!(task.updated_at_ms, 123);
        assert!(!task.is_important);
        assert!(!task.is_urgent);
        assert_eq!(task.due_date, None);

        let planned = TaskDbService::create(
            &connection,
            CreateTaskInput {
                id: ID_B.into(),
                title: "Planned".into(),
                created_at_ms: 200,
                is_important: true,
                is_urgent: true,
                due_date: Some("2024-02-29".into()),
            },
        )
        .unwrap();
        assert!(planned.is_important);
        assert!(planned.is_urgent);
        assert_eq!(planned.due_date.as_deref(), Some("2024-02-29"));

        let duplicate = TaskDbService::create(
            &connection,
            CreateTaskInput {
                id: ID_A.into(),
                title: "Duplicate".into(),
                created_at_ms: 456,
                is_important: false,
                is_urgent: false,
                due_date: None,
            },
        )
        .unwrap_err();
        assert_eq!(duplicate, TaskError::PersistenceFailed);

        let unsafe_timestamp = TaskDbService::create(
            &connection,
            CreateTaskInput {
                id: ID_C.into(),
                title: "Task".into(),
                created_at_ms: MAX_SAFE_INTEGER_MILLISECONDS + 1,
                is_important: false,
                is_urgent: false,
                due_date: None,
            },
        )
        .unwrap_err();
        assert_eq!(unsafe_timestamp, TaskError::PersistenceFailed);
    }

    #[test]
    fn planning_operations_update_only_the_requested_field_and_timestamp() {
        let (_sandbox, _database_path, connection) = migrated_database();
        let created = create_task(&connection, ID_A, "Task", 10);

        let important = TaskDbService::set_importance(
            &connection,
            SetTaskImportanceInput {
                id: ID_A.into(),
                is_important: true,
                updated_at_ms: 20,
            },
        )
        .unwrap();
        assert!(important.is_important);
        assert!(!important.is_urgent);
        assert_eq!(important.due_date, None);
        assert_eq!(important.status, created.status);
        assert_eq!(important.created_at_ms, created.created_at_ms);

        let urgent = TaskDbService::set_urgency(
            &connection,
            SetTaskUrgencyInput {
                id: ID_A.into(),
                is_urgent: true,
                updated_at_ms: 30,
            },
        )
        .unwrap();
        assert!(urgent.is_important);
        assert!(urgent.is_urgent);
        assert_eq!(urgent.due_date, None);

        let deadline = TaskDbService::set_deadline(
            &connection,
            SetTaskDeadlineInput {
                id: ID_A.into(),
                due_date: "2024-02-29".into(),
                updated_at_ms: 40,
            },
        )
        .unwrap();
        assert!(deadline.is_important);
        assert!(deadline.is_urgent);
        assert_eq!(deadline.due_date.as_deref(), Some("2024-02-29"));

        let cleared = TaskDbService::clear_deadline(
            &connection,
            ClearTaskDeadlineInput {
                id: ID_A.into(),
                updated_at_ms: 50,
            },
        )
        .unwrap();
        assert!(cleared.is_important);
        assert!(cleared.is_urgent);
        assert_eq!(cleared.due_date, None);
        assert_eq!(cleared.updated_at_ms, 50);
    }

    #[test]
    fn planning_operations_validate_dates_and_report_missing_tasks() {
        let (_sandbox, _database_path, connection) = migrated_database();
        let invalid = TaskDbService::set_deadline(
            &connection,
            SetTaskDeadlineInput {
                id: ID_A.into(),
                due_date: "2025-02-29".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap_err();
        assert_eq!(invalid, TaskError::PersistenceFailed);

        assert_eq!(
            TaskDbService::set_importance(
                &connection,
                SetTaskImportanceInput {
                    id: ID_A.into(),
                    is_important: true,
                    updated_at_ms: 20,
                },
            )
            .unwrap_err(),
            TaskError::NotFound
        );
        assert_eq!(
            TaskDbService::clear_deadline(
                &connection,
                ClearTaskDeadlineInput {
                    id: ID_A.into(),
                    updated_at_ms: 20,
                },
            )
            .unwrap_err(),
            TaskError::NotFound
        );
    }

    #[test]
    fn list_orders_by_updated_desc_then_id_asc() {
        let (_sandbox, _database_path, connection) = migrated_database();
        create_task(&connection, ID_C, "C", 30);
        create_task(&connection, ID_B, "B", 20);
        create_task(&connection, ID_A, "A", 10);
        TaskDbService::rename(
            &connection,
            RenameTaskInput {
                id: ID_B.into(),
                title: "B2".into(),
                updated_at_ms: 100,
            },
        )
        .unwrap();
        TaskDbService::rename(
            &connection,
            RenameTaskInput {
                id: ID_A.into(),
                title: "A2".into(),
                updated_at_ms: 100,
            },
        )
        .unwrap();

        let ids: Vec<String> = TaskDbService::list(&connection)
            .unwrap()
            .into_iter()
            .map(|task| task.id)
            .collect();
        assert_eq!(ids, [ID_A, ID_B, ID_C]);
    }

    #[test]
    fn rename_updates_only_title_and_timestamp_and_reports_not_found() {
        let (_sandbox, _database_path, connection) = migrated_database();
        let before = create_task(&connection, ID_A, "Before", 10);
        let after = TaskDbService::rename(
            &connection,
            RenameTaskInput {
                id: ID_A.into(),
                title: "  After  ".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap();

        assert_eq!(after.title, "  After  ");
        assert_eq!(after.status, before.status);
        assert_eq!(after.created_at_ms, before.created_at_ms);
        assert_eq!(after.updated_at_ms, 20);
        assert_eq!(TaskDbService::list(&connection).unwrap(), [after]);

        let error = TaskDbService::rename(
            &connection,
            RenameTaskInput {
                id: ID_B.into(),
                title: "Missing".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap_err();
        assert_eq!(error, TaskError::NotFound);
    }

    #[test]
    fn status_rule_matches_the_complete_frozen_matrix() {
        let statuses = [
            TaskStatus::Todo,
            TaskStatus::Doing,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
        ];
        let operations = [
            TaskStatusOperation::Start,
            TaskStatusOperation::Complete,
            TaskStatusOperation::Cancel,
            TaskStatusOperation::Reopen,
        ];
        let legal = [
            (
                TaskStatus::Todo,
                TaskStatusOperation::Start,
                TaskStatus::Doing,
            ),
            (
                TaskStatus::Todo,
                TaskStatusOperation::Complete,
                TaskStatus::Completed,
            ),
            (
                TaskStatus::Doing,
                TaskStatusOperation::Complete,
                TaskStatus::Completed,
            ),
            (
                TaskStatus::Todo,
                TaskStatusOperation::Cancel,
                TaskStatus::Cancelled,
            ),
            (
                TaskStatus::Doing,
                TaskStatusOperation::Cancel,
                TaskStatus::Cancelled,
            ),
            (
                TaskStatus::Completed,
                TaskStatusOperation::Reopen,
                TaskStatus::Todo,
            ),
            (
                TaskStatus::Cancelled,
                TaskStatusOperation::Reopen,
                TaskStatus::Todo,
            ),
        ];

        for current in statuses {
            for operation in operations {
                let expected = legal
                    .iter()
                    .find(|(from, op, _)| *from == current && *op == operation)
                    .map(|(_, _, target)| *target);
                assert_eq!(resolve_status_transition(current, operation), expected);
            }
        }
    }

    #[test]
    fn persistence_accepts_all_seven_legal_transitions() {
        let (_sandbox, _database_path, mut connection) = migrated_database();
        let cases = [
            (
                TaskStatus::Todo,
                TaskStatusOperation::Start,
                TaskStatus::Doing,
            ),
            (
                TaskStatus::Todo,
                TaskStatusOperation::Complete,
                TaskStatus::Completed,
            ),
            (
                TaskStatus::Doing,
                TaskStatusOperation::Complete,
                TaskStatus::Completed,
            ),
            (
                TaskStatus::Todo,
                TaskStatusOperation::Cancel,
                TaskStatus::Cancelled,
            ),
            (
                TaskStatus::Doing,
                TaskStatusOperation::Cancel,
                TaskStatus::Cancelled,
            ),
            (
                TaskStatus::Completed,
                TaskStatusOperation::Reopen,
                TaskStatus::Todo,
            ),
            (
                TaskStatus::Cancelled,
                TaskStatusOperation::Reopen,
                TaskStatus::Todo,
            ),
        ];

        for (index, (from, operation, target)) in cases.into_iter().enumerate() {
            let id = format!("00000000-0000-4000-8000-{index:012}");
            create_task(&connection, &id, "Task", 1);
            connection
                .execute(
                    "UPDATE tasks SET status = ?1 WHERE id = ?2",
                    params![from.as_str(), id],
                )
                .unwrap();
            let changed = TaskDbService::change_status(
                &mut connection,
                ChangeTaskStatusInput {
                    id: id.clone(),
                    operation,
                    updated_at_ms: 2,
                },
            )
            .unwrap();
            assert_eq!(changed.status, target);
            assert_eq!(changed.created_at_ms, 1);
            assert_eq!(changed.updated_at_ms, 2);
            let persisted = TaskDbService::list(&connection)
                .unwrap()
                .into_iter()
                .find(|task| task.id == id)
                .unwrap();
            assert_eq!(persisted, changed);
        }
    }

    #[test]
    fn persistence_rejects_every_illegal_transition() {
        let (_sandbox, _database_path, mut connection) = migrated_database();
        let statuses = [
            TaskStatus::Todo,
            TaskStatus::Doing,
            TaskStatus::Completed,
            TaskStatus::Cancelled,
        ];
        let operations = [
            TaskStatusOperation::Start,
            TaskStatusOperation::Complete,
            TaskStatusOperation::Cancel,
            TaskStatusOperation::Reopen,
        ];
        let mut index = 100;

        for current in statuses {
            for operation in operations {
                if resolve_status_transition(current, operation).is_some() {
                    continue;
                }
                let id = format!("00000000-0000-4000-8000-{index:012}");
                index += 1;
                create_task(&connection, &id, "Task", 1);
                connection
                    .execute(
                        "UPDATE tasks SET status = ?1 WHERE id = ?2",
                        params![current.as_str(), id],
                    )
                    .unwrap();
                let error = TaskDbService::change_status(
                    &mut connection,
                    ChangeTaskStatusInput {
                        id,
                        operation,
                        updated_at_ms: 2,
                    },
                )
                .unwrap_err();
                assert_eq!(error, TaskError::StatusConflict);
            }
        }
    }

    #[test]
    fn status_change_reports_not_found_and_compare_and_set_conflict() {
        let (_sandbox, _database_path, mut connection) = migrated_database();
        let missing = TaskDbService::change_status(
            &mut connection,
            ChangeTaskStatusInput {
                id: ID_A.into(),
                operation: TaskStatusOperation::Start,
                updated_at_ms: 2,
            },
        )
        .unwrap_err();
        assert_eq!(missing, TaskError::NotFound);

        create_task(&connection, ID_A, "Task", 1);
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let conflict = compare_and_set_status(
            &transaction,
            ID_A,
            TaskStatus::Doing,
            TaskStatus::Completed,
            2,
        )
        .unwrap_err();
        assert_eq!(conflict, TaskError::StatusConflict);
    }

    #[test]
    fn task_persists_after_connection_close_and_reopen() {
        let (_sandbox, database_path, mut connection) = migrated_database();
        create_task(&connection, ID_A, "Persistent", 10);
        TaskDbService::rename(
            &connection,
            RenameTaskInput {
                id: ID_A.into(),
                title: "Persistent renamed".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap();
        TaskDbService::change_status(
            &mut connection,
            ChangeTaskStatusInput {
                id: ID_A.into(),
                operation: TaskStatusOperation::Start,
                updated_at_ms: 30,
            },
        )
        .unwrap();
        TaskDbService::set_importance(
            &connection,
            SetTaskImportanceInput {
                id: ID_A.into(),
                is_important: true,
                updated_at_ms: 40,
            },
        )
        .unwrap();
        TaskDbService::set_urgency(
            &connection,
            SetTaskUrgencyInput {
                id: ID_A.into(),
                is_urgent: true,
                updated_at_ms: 50,
            },
        )
        .unwrap();
        TaskDbService::set_deadline(
            &connection,
            SetTaskDeadlineInput {
                id: ID_A.into(),
                due_date: "2026-08-23".into(),
                updated_at_ms: 60,
            },
        )
        .unwrap();
        drop(connection);

        let reopened = open_existing_configured_connection(&database_path).unwrap();
        let tasks = TaskDbService::list(&reopened).unwrap();
        assert_eq!(
            tasks,
            [TaskRecord {
                id: ID_A.into(),
                title: "Persistent renamed".into(),
                status: TaskStatus::Doing,
                created_at_ms: 10,
                updated_at_ms: 60,
                is_important: true,
                is_urgent: true,
                due_date: Some("2026-08-23".into()),
            }]
        );
    }

    #[test]
    fn existing_only_open_fails_without_creating_database() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        fs::create_dir_all(&database_dir).unwrap();
        let database_path = database_dir.join("missing.db");

        assert!(open_existing_configured_connection(&database_path).is_err());
        assert!(!database_path.exists());
    }

    #[test]
    fn runtime_open_uses_only_valid_existing_bootstrap_and_data_root() {
        let sandbox = tempdir().unwrap();
        let config_dir = sandbox.path().join("config");
        let data_root = sandbox.path().join("data");
        fs::create_dir_all(&config_dir).unwrap();
        let (_, manifest) =
            DataRootService::get_and_ensure(&data_root, InitMode::FirstBoot).unwrap();
        let database_path = DataRootService::resolve_database_path(&data_root, &manifest);
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &data_root.join("backup"))
            .unwrap();
        create_task(&connection, ID_A, "Task", 1);
        drop(connection);

        BootstrapService::new_candidate(
            BootstrapService::bootstrap_path(&config_dir),
            data_root.clone(),
        )
        .commit()
        .unwrap();

        let connection = TaskDbService::open_existing(&config_dir).unwrap();
        assert_eq!(TaskDbService::list(&connection).unwrap().len(), 1);
        drop(connection);

        fs::remove_file(&database_path).unwrap();
        assert_eq!(
            TaskDbService::open_existing(&config_dir).unwrap_err(),
            TaskError::PersistenceUnavailable
        );
        assert!(!database_path.exists());
    }
}
