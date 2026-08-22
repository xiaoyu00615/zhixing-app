//! Native capability commands.

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::task::{
    ChangeTaskStatusInput, CreateTaskInput, RenameTaskInput, TaskDbService, TaskError, TaskRecord,
    TaskStatusOperation,
};
use crate::RuntimeStatus;

/// 最小健康检查命令：前端 → Tauri invoke → Rust 返回 "pong"。
///
/// 用途仅用于验证 React↔Tauri↔Rust 链路，不作为正式业务 API。
#[tauri::command]
pub fn native_ping() -> &'static str {
    "pong"
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskDto {
    id: String,
    title: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameTaskDto {
    id: String,
    title: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ChangeTaskStatusDto {
    id: String,
    operation: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskDto {
    id: String,
    title: String,
    status: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl From<TaskRecord> for TaskDto {
    fn from(task: TaskRecord) -> Self {
        Self {
            id: task.id,
            title: task.title,
            status: task.status.as_str().to_string(),
            created_at_ms: task.created_at_ms,
            updated_at_ms: task.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct TaskCommandErrorDto {
    code: &'static str,
    message: &'static str,
}

impl From<TaskError> for TaskCommandErrorDto {
    fn from(error: TaskError) -> Self {
        Self {
            code: error.code(),
            message: error.safe_message(),
        }
    }
}

fn task_connection(
    app: &tauri::AppHandle,
    runtime_status: &RuntimeStatus,
) -> Result<rusqlite::Connection, TaskCommandErrorDto> {
    if !matches!(runtime_status, RuntimeStatus::Healthy) {
        return Err(TaskError::PersistenceUnavailable.into());
    }
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| TaskCommandErrorDto::from(TaskError::PersistenceUnavailable))?;
    TaskDbService::open_existing(&app_config_dir).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_create(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CreateTaskDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::create(
        &connection,
        CreateTaskInput {
            id: input.id,
            title: input.title,
            created_at_ms: input.created_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_list(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
) -> Result<Vec<TaskDto>, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::list(&connection)
        .map(|tasks| tasks.into_iter().map(TaskDto::from).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_rename(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: RenameTaskDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::rename(
        &connection,
        RenameTaskInput {
            id: input.id,
            title: input.title,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_change_status(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: ChangeTaskStatusDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let mut connection = task_connection(&app, &runtime_status)?;
    let operation = TaskStatusOperation::try_from(input.operation.as_str())
        .map_err(TaskCommandErrorDto::from)?;
    TaskDbService::change_status(
        &mut connection,
        ChangeTaskStatusInput {
            id: input.id,
            operation,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::task::TaskStatus;

    #[test]
    fn transport_dtos_use_camel_case() {
        let input = CreateTaskDto {
            id: "00000000-0000-4000-8000-000000000001".into(),
            title: "Task".into(),
            created_at_ms: 10,
        };
        assert_eq!(
            serde_json::to_value(input).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000001",
                "title": "Task",
                "createdAtMs": 10
            })
        );

        let output = TaskDto::from(TaskRecord {
            id: "00000000-0000-4000-8000-000000000001".into(),
            title: "Task".into(),
            status: TaskStatus::Todo,
            created_at_ms: 10,
            updated_at_ms: 10,
        });
        assert_eq!(
            serde_json::to_value(output).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000001",
                "title": "Task",
                "status": "todo",
                "createdAtMs": 10,
                "updatedAtMs": 10
            })
        );
    }

    #[test]
    fn command_errors_are_safe_and_stable() {
        let cases = [
            (TaskError::NotFound, "NOT_FOUND", "Task not found."),
            (
                TaskError::StatusConflict,
                "STATUS_CONFLICT",
                "Task status conflict.",
            ),
            (
                TaskError::PersistenceUnavailable,
                "PERSISTENCE_UNAVAILABLE",
                "Task persistence is unavailable.",
            ),
            (
                TaskError::PersistenceFailed,
                "PERSISTENCE_FAILED",
                "Task persistence operation failed.",
            ),
        ];

        for (error, code, message) in cases {
            let value = serde_json::to_value(TaskCommandErrorDto::from(error)).unwrap();
            assert_eq!(
                value,
                serde_json::json!({ "code": code, "message": message })
            );
            let encoded = value.to_string();
            assert!(!encoded.contains("SQL"));
            assert!(!encoded.contains("zhixing.db"));
        }
    }

    #[test]
    fn unknown_status_operation_maps_to_safe_persistence_error() {
        let error = TaskStatusOperation::try_from("pause")
            .map_err(TaskCommandErrorDto::from)
            .unwrap_err();
        assert_eq!(error.code, "PERSISTENCE_FAILED");
        assert_eq!(error.message, "Task persistence operation failed.");
    }
}
