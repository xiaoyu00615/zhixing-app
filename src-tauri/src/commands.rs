//! Native capability commands.

use serde::{Deserialize, Serialize};
use tauri::Manager;

use crate::canvas::{
    AddCanvasNodeBoxMemberInput, CanvasDbService, CanvasEdgeDirection, CanvasEdgeLineStyle,
    CanvasEdgeRecord, CanvasError, CanvasNodeContent, CanvasNodePositionMove, CanvasNodeRecord,
    CanvasRecord, CanvasViewport, CreateCanvasEdgeInput, CreateCanvasInput, CreateCanvasNodeInput,
    DeleteCanvasEdgeInput, MoveCanvasNodeInput, MoveCanvasNodesInput, RenameCanvasInput,
    RenameCanvasNodeInput, UpdateCanvasEdgeDirectionInput, UpdateCanvasEdgeLineStyleInput,
    UpdateCanvasNodeContentInput, UpdateCanvasViewportInput,
};
use crate::project::{
    CreateProjectInput, ProjectDbService, ProjectError, ProjectRecord, RenameProjectInput,
};
use crate::tag::{CreateTagInput, RenameTagInput, TagDbService, TagError, TagRecord};
use crate::task::{
    AddTaskTagInput, ChangeTaskStatusInput, ClearTaskDeadlineInput, ClearTaskProjectInput,
    CreateTaskInput, RemoveTaskTagInput, RenameTaskInput, RestoreTaskInput, SetTaskDeadlineInput,
    SetTaskImportanceInput, SetTaskProjectInput, SetTaskUrgencyInput, TaskDbService, TaskError,
    TaskRecord, TaskStatusOperation, TrashTaskInput,
};
use crate::RuntimeStatus;

/// 最小健康检查命令：前端 → Tauri invoke → Rust 返回 "pong"。
///
/// 用途仅用于验证 React↔Tauri↔Rust 链路，不作为正式业务 API。
#[tauri::command]
pub fn native_ping() -> &'static str {
    "pong"
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTaskDto {
    id: String,
    title: String,
    created_at_ms: i64,
    #[serde(default)]
    is_important: bool,
    #[serde(default)]
    is_urgent: bool,
    #[serde(default)]
    due_date: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    tag_ids: Vec<String>,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskImportanceDto {
    id: String,
    is_important: bool,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskUrgencyDto {
    id: String,
    is_urgent: bool,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskDeadlineDto {
    id: String,
    due_date: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearTaskDeadlineDto {
    id: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SetTaskProjectDto {
    id: String,
    project_id: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearTaskProjectDto {
    id: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskTagDto {
    id: String,
    tag_id: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TaskLifecycleDto {
    id: String,
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
    is_important: bool,
    is_urgent: bool,
    due_date: Option<String>,
    project_id: Option<String>,
    tag_ids: Vec<String>,
    deleted_at_ms: Option<i64>,
}

impl From<TaskRecord> for TaskDto {
    fn from(task: TaskRecord) -> Self {
        Self {
            id: task.id,
            title: task.title,
            status: task.status.as_str().to_string(),
            created_at_ms: task.created_at_ms,
            updated_at_ms: task.updated_at_ms,
            is_important: task.is_important,
            is_urgent: task.is_urgent,
            due_date: task.due_date,
            project_id: task.project_id,
            tag_ids: task.tag_ids,
            deleted_at_ms: task.deleted_at_ms,
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
            is_important: input.is_important,
            is_urgent: input.is_urgent,
            due_date: input.due_date,
            project_id: input.project_id,
            tag_ids: input.tag_ids,
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
pub(crate) fn task_list_trashed(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
) -> Result<Vec<TaskDto>, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::list_trashed(&connection)
        .map(|tasks| tasks.into_iter().map(TaskDto::from).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_trash(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: TaskLifecycleDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::trash(
        &connection,
        TrashTaskInput {
            id: input.id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_restore(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: TaskLifecycleDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::restore(
        &connection,
        RestoreTaskInput {
            id: input.id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
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

#[tauri::command]
pub(crate) fn task_set_importance(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: SetTaskImportanceDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::set_importance(
        &connection,
        SetTaskImportanceInput {
            id: input.id,
            is_important: input.is_important,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_set_urgency(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: SetTaskUrgencyDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::set_urgency(
        &connection,
        SetTaskUrgencyInput {
            id: input.id,
            is_urgent: input.is_urgent,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_set_deadline(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: SetTaskDeadlineDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::set_deadline(
        &connection,
        SetTaskDeadlineInput {
            id: input.id,
            due_date: input.due_date,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_clear_deadline(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: ClearTaskDeadlineDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::clear_deadline(
        &connection,
        ClearTaskDeadlineInput {
            id: input.id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_set_project(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: SetTaskProjectDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::set_project(
        &connection,
        SetTaskProjectInput {
            id: input.id,
            project_id: input.project_id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_clear_project(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: ClearTaskProjectDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::clear_project(
        &connection,
        ClearTaskProjectInput {
            id: input.id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_add_tag(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: TaskTagDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::add_tag(
        &connection,
        AddTaskTagInput {
            id: input.id,
            tag_id: input.tag_id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn task_remove_tag(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: TaskTagDto,
) -> Result<TaskDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TaskDbService::remove_tag(
        &connection,
        RemoveTaskTagInput {
            id: input.id,
            tag_id: input.tag_id,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TaskDto::from)
    .map_err(Into::into)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateProjectDto {
    id: String,
    name: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameProjectDto {
    id: String,
    name: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ProjectDto {
    id: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}
impl From<ProjectRecord> for ProjectDto {
    fn from(project: ProjectRecord) -> Self {
        Self {
            id: project.id,
            name: project.name,
            created_at_ms: project.created_at_ms,
            updated_at_ms: project.updated_at_ms,
        }
    }
}

fn project_error(error: ProjectError) -> TaskCommandErrorDto {
    TaskCommandErrorDto {
        code: error.code(),
        message: error.safe_message(),
    }
}

#[tauri::command]
pub(crate) fn project_create(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CreateProjectDto,
) -> Result<ProjectDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    ProjectDbService::create(
        &connection,
        CreateProjectInput {
            id: input.id,
            name: input.name,
            created_at_ms: input.created_at_ms,
        },
    )
    .map(ProjectDto::from)
    .map_err(project_error)
}

#[tauri::command]
pub(crate) fn project_list(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
) -> Result<Vec<ProjectDto>, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    ProjectDbService::list(&connection)
        .map(|projects| projects.into_iter().map(ProjectDto::from).collect())
        .map_err(project_error)
}

#[tauri::command]
pub(crate) fn project_rename(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: RenameProjectDto,
) -> Result<ProjectDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    ProjectDbService::rename(
        &connection,
        RenameProjectInput {
            id: input.id,
            name: input.name,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(ProjectDto::from)
    .map_err(project_error)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateTagDto {
    id: String,
    name: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameTagDto {
    id: String,
    name: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagDto {
    id: String,
    name: String,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl From<TagRecord> for TagDto {
    fn from(tag: TagRecord) -> Self {
        Self {
            id: tag.id,
            name: tag.name,
            created_at_ms: tag.created_at_ms,
            updated_at_ms: tag.updated_at_ms,
        }
    }
}

fn tag_error(error: TagError) -> TaskCommandErrorDto {
    TaskCommandErrorDto {
        code: error.code(),
        message: error.safe_message(),
    }
}

#[tauri::command]
pub(crate) fn tag_create(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CreateTagDto,
) -> Result<TagDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TagDbService::create(
        &connection,
        CreateTagInput {
            id: input.id,
            name: input.name,
            created_at_ms: input.created_at_ms,
        },
    )
    .map(TagDto::from)
    .map_err(tag_error)
}

#[tauri::command]
pub(crate) fn tag_list(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
) -> Result<Vec<TagDto>, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TagDbService::list(&connection)
        .map(|tags| tags.into_iter().map(TagDto::from).collect())
        .map_err(tag_error)
}

#[tauri::command]
pub(crate) fn tag_rename(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: RenameTagDto,
) -> Result<TagDto, TaskCommandErrorDto> {
    let connection = task_connection(&app, &runtime_status)?;
    TagDbService::rename(
        &connection,
        RenameTagInput {
            id: input.id,
            name: input.name,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(TagDto::from)
    .map_err(tag_error)
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasViewportDto {
    x: f64,
    y: f64,
    zoom: f64,
}

impl From<CanvasViewport> for CanvasViewportDto {
    fn from(viewport: CanvasViewport) -> Self {
        Self {
            x: viewport.x,
            y: viewport.y,
            zoom: viewport.zoom,
        }
    }
}

impl From<CanvasViewportDto> for CanvasViewport {
    fn from(viewport: CanvasViewportDto) -> Self {
        Self {
            x: viewport.x,
            y: viewport.y,
            zoom: viewport.zoom,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCanvasDto {
    id: String,
    title: String,
    viewport: CanvasViewportDto,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameCanvasDto {
    id: String,
    title: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCanvasViewportDto {
    id: String,
    viewport: CanvasViewportDto,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct CanvasIdDto {
    id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasDto {
    id: String,
    title: String,
    viewport: CanvasViewportDto,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl From<CanvasRecord> for CanvasDto {
    fn from(canvas: CanvasRecord) -> Self {
        Self {
            id: canvas.id,
            title: canvas.title,
            viewport: canvas.viewport.into(),
            created_at_ms: canvas.created_at_ms,
            updated_at_ms: canvas.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCanvasNodeDto {
    id: String,
    canvas_id: String,
    #[serde(rename = "type")]
    node_type: String,
    content: CanvasNodeContent,
    x: f64,
    y: f64,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCanvasNodeContentDto {
    id: String,
    #[serde(rename = "type")]
    node_type: String,
    content: CanvasNodeContent,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RenameCanvasNodeDto {
    canvas_id: String,
    id: String,
    node_name: String,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveCanvasNodeDto {
    id: String,
    x: f64,
    y: f64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasNodePositionMoveDto {
    node_id: String,
    x: f64,
    y: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MoveCanvasNodesDto {
    canvas_id: String,
    moves: Vec<CanvasNodePositionMoveDto>,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasNodeDto {
    id: String,
    canvas_id: String,
    #[serde(rename = "type")]
    node_type: String,
    node_name: String,
    content: CanvasNodeContent,
    x: f64,
    y: f64,
    created_at_ms: i64,
    updated_at_ms: i64,
}

impl From<CanvasNodeRecord> for CanvasNodeDto {
    fn from(node: CanvasNodeRecord) -> Self {
        Self {
            id: node.id,
            canvas_id: node.canvas_id,
            node_type: node.node_type,
            node_name: node.node_name,
            content: node.content,
            x: node.x,
            y: node.y,
            created_at_ms: node.created_at_ms,
            updated_at_ms: node.updated_at_ms,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CreateCanvasEdgeDto {
    id: String,
    canvas_id: String,
    source_node_id: String,
    target_node_id: String,
    relation_type: String,
    direction: CanvasEdgeDirection,
    line_style: CanvasEdgeLineStyle,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AddCanvasNodeBoxMemberDto {
    id: String,
    canvas_id: String,
    source_node_id: String,
    target_node_id: String,
    relation_type: String,
    created_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCanvasEdgeDirectionDto {
    id: String,
    direction: CanvasEdgeDirection,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCanvasEdgeLineStyleDto {
    id: String,
    line_style: CanvasEdgeLineStyle,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateCanvasEdgeRelationTypeDto {
    id: String,
    relation_type: String,
    direction: CanvasEdgeDirection,
    line_style: CanvasEdgeLineStyle,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct DeleteCanvasEdgeDto {
    id: String,
    deleted_at_ms: i64,
    updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CanvasEdgeDto {
    id: String,
    canvas_id: String,
    source_node_id: String,
    target_node_id: String,
    relation_type: String,
    direction: CanvasEdgeDirection,
    line_style: CanvasEdgeLineStyle,
    membership_position: Option<i64>,
    created_at_ms: i64,
    updated_at_ms: i64,
    deleted_at_ms: Option<i64>,
}

impl From<CanvasEdgeRecord> for CanvasEdgeDto {
    fn from(edge: CanvasEdgeRecord) -> Self {
        Self {
            id: edge.id,
            canvas_id: edge.canvas_id,
            source_node_id: edge.source_node_id,
            target_node_id: edge.target_node_id,
            relation_type: edge.relation_type,
            direction: edge.direction,
            line_style: edge.line_style,
            membership_position: edge.membership_position,
            created_at_ms: edge.created_at_ms,
            updated_at_ms: edge.updated_at_ms,
            deleted_at_ms: edge.deleted_at_ms,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct CanvasCommandErrorDto {
    code: &'static str,
    message: &'static str,
}

impl From<CanvasError> for CanvasCommandErrorDto {
    fn from(error: CanvasError) -> Self {
        Self {
            code: error.code(),
            message: error.safe_message(),
        }
    }
}

fn canvas_connection(
    app: &tauri::AppHandle,
    runtime_status: &RuntimeStatus,
) -> Result<rusqlite::Connection, CanvasCommandErrorDto> {
    if !matches!(runtime_status, RuntimeStatus::Healthy) {
        return Err(CanvasError::PersistenceUnavailable.into());
    }
    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| CanvasCommandErrorDto::from(CanvasError::PersistenceUnavailable))?;
    CanvasDbService::open_existing(&app_config_dir).map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_create(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CreateCanvasDto,
) -> Result<CanvasDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::create_canvas(
        &connection,
        CreateCanvasInput {
            id: input.id,
            title: input.title,
            viewport: input.viewport.into(),
            created_at_ms: input.created_at_ms,
        },
    )
    .map(CanvasDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_list(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
) -> Result<Vec<CanvasDto>, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::list_canvases(&connection)
        .map(|canvases| canvases.into_iter().map(CanvasDto::from).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_get(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CanvasIdDto,
) -> Result<CanvasDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::get_canvas(&connection, &input.id)
        .map(CanvasDto::from)
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_rename(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: RenameCanvasDto,
) -> Result<CanvasDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::rename_canvas(
        &connection,
        RenameCanvasInput {
            id: input.id,
            title: input.title,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_update_viewport(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: UpdateCanvasViewportDto,
) -> Result<CanvasDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::update_viewport(
        &connection,
        UpdateCanvasViewportInput {
            id: input.id,
            viewport: input.viewport.into(),
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_node_create(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CreateCanvasNodeDto,
) -> Result<CanvasNodeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::create_node(
        &connection,
        CreateCanvasNodeInput {
            id: input.id,
            canvas_id: input.canvas_id,
            node_type: input.node_type,
            content: input.content,
            x: input.x,
            y: input.y,
            created_at_ms: input.created_at_ms,
        },
    )
    .map(CanvasNodeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_node_list(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CanvasIdDto,
) -> Result<Vec<CanvasNodeDto>, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::list_nodes(&connection, &input.id)
        .map(|nodes| nodes.into_iter().map(CanvasNodeDto::from).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_node_update_content(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: UpdateCanvasNodeContentDto,
) -> Result<CanvasNodeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::update_node_content(
        &connection,
        UpdateCanvasNodeContentInput {
            id: input.id,
            node_type: input.node_type,
            content: input.content,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasNodeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_node_rename(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: RenameCanvasNodeDto,
) -> Result<CanvasNodeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::rename_node(
        &connection,
        RenameCanvasNodeInput {
            canvas_id: input.canvas_id,
            id: input.id,
            node_name: input.node_name,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasNodeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_node_move(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: MoveCanvasNodeDto,
) -> Result<CanvasNodeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::move_node(
        &connection,
        MoveCanvasNodeInput {
            id: input.id,
            x: input.x,
            y: input.y,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasNodeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_nodes_move(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: MoveCanvasNodesDto,
) -> Result<Vec<CanvasNodeDto>, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::move_nodes(
        &connection,
        MoveCanvasNodesInput {
            canvas_id: input.canvas_id,
            moves: input
                .moves
                .into_iter()
                .map(|node_move| CanvasNodePositionMove {
                    node_id: node_move.node_id,
                    x: node_move.x,
                    y: node_move.y,
                })
                .collect(),
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(|nodes| nodes.into_iter().map(CanvasNodeDto::from).collect())
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_edge_create(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CreateCanvasEdgeDto,
) -> Result<CanvasEdgeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::create_edge(
        &connection,
        CreateCanvasEdgeInput {
            id: input.id,
            canvas_id: input.canvas_id,
            source_node_id: input.source_node_id,
            target_node_id: input.target_node_id,
            relation_type: input.relation_type,
            direction: input.direction,
            line_style: input.line_style,
            created_at_ms: input.created_at_ms,
        },
    )
    .map(CanvasEdgeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_node_box_add_member(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: AddCanvasNodeBoxMemberDto,
) -> Result<CanvasEdgeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::add_node_box_member(
        &connection,
        AddCanvasNodeBoxMemberInput {
            id: input.id,
            canvas_id: input.canvas_id,
            source_node_id: input.source_node_id,
            target_node_id: input.target_node_id,
            relation_type: input.relation_type,
            created_at_ms: input.created_at_ms,
        },
    )
    .map(CanvasEdgeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_edge_list(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: CanvasIdDto,
) -> Result<Vec<CanvasEdgeDto>, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::list_edges(&connection, &input.id)
        .map(|edges| edges.into_iter().map(CanvasEdgeDto::from).collect())
        .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_edge_set_direction(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: UpdateCanvasEdgeDirectionDto,
) -> Result<CanvasEdgeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::update_edge_direction(
        &connection,
        UpdateCanvasEdgeDirectionInput {
            id: input.id,
            direction: input.direction,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasEdgeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_edge_set_line_style(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: UpdateCanvasEdgeLineStyleDto,
) -> Result<CanvasEdgeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::update_edge_line_style(
        &connection,
        UpdateCanvasEdgeLineStyleInput {
            id: input.id,
            line_style: input.line_style,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasEdgeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_edge_set_relation_type(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: UpdateCanvasEdgeRelationTypeDto,
) -> Result<CanvasEdgeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::update_edge_relation_type(
        &connection,
        crate::canvas::UpdateCanvasEdgeRelationTypeInput {
            id: input.id,
            relation_type: input.relation_type,
            direction: input.direction,
            line_style: input.line_style,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasEdgeDto::from)
    .map_err(Into::into)
}

#[tauri::command]
pub(crate) fn canvas_edge_delete(
    app: tauri::AppHandle,
    runtime_status: tauri::State<'_, RuntimeStatus>,
    input: DeleteCanvasEdgeDto,
) -> Result<CanvasEdgeDto, CanvasCommandErrorDto> {
    let connection = canvas_connection(&app, &runtime_status)?;
    CanvasDbService::delete_edge(
        &connection,
        DeleteCanvasEdgeInput {
            id: input.id,
            deleted_at_ms: input.deleted_at_ms,
            updated_at_ms: input.updated_at_ms,
        },
    )
    .map(CanvasEdgeDto::from)
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
            is_important: true,
            is_urgent: false,
            due_date: Some("2026-08-23".into()),
            project_id: None,
            tag_ids: vec![],
        };
        assert_eq!(
            serde_json::to_value(input).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000001",
                "title": "Task",
                "createdAtMs": 10,
                "isImportant": true,
                "isUrgent": false,
                "dueDate": "2026-08-23",
                "projectId": null,
                "tagIds": []
            })
        );

        let output = TaskDto::from(TaskRecord {
            id: "00000000-0000-4000-8000-000000000001".into(),
            title: "Task".into(),
            status: TaskStatus::Todo,
            created_at_ms: 10,
            updated_at_ms: 10,
            is_important: true,
            is_urgent: false,
            due_date: Some("2026-08-23".into()),
            project_id: None,
            tag_ids: vec![],
            deleted_at_ms: None,
        });
        assert_eq!(
            serde_json::to_value(output).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000001",
                "title": "Task",
                "status": "todo",
                "createdAtMs": 10,
                "updatedAtMs": 10,
                "isImportant": true,
                "isUrgent": false,
                "dueDate": "2026-08-23",
                "projectId": null,
                "tagIds": [],
                "deletedAtMs": null
            })
        );

        let lifecycle = TaskLifecycleDto {
            id: "00000000-0000-4000-8000-000000000001".into(),
            updated_at_ms: 20,
        };
        assert_eq!(
            serde_json::to_value(lifecycle).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000001",
                "updatedAtMs": 20
            })
        );

        let canvas = CanvasDto::from(CanvasRecord {
            id: "00000000-0000-4000-8000-000000000601".into(),
            title: "Canvas".into(),
            viewport: CanvasViewport {
                x: 12.0,
                y: -8.0,
                zoom: 1.25,
            },
            created_at_ms: 30,
            updated_at_ms: 40,
        });
        assert_eq!(
            serde_json::to_value(canvas).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000601",
                "title": "Canvas",
                "viewport": { "x": 12.0, "y": -8.0, "zoom": 1.25 },
                "createdAtMs": 30,
                "updatedAtMs": 40
            })
        );

        let node = CanvasNodeDto::from(CanvasNodeRecord {
            id: "00000000-0000-4000-8000-000000000602".into(),
            canvas_id: "00000000-0000-4000-8000-000000000601".into(),
            node_type: "text".into(),
            node_name: "Product idea".into(),
            content: CanvasNodeContent::Text {
                text: "Idea".into(),
            },
            x: 50.0,
            y: 80.0,
            created_at_ms: 30,
            updated_at_ms: 40,
        });
        assert_eq!(
            serde_json::to_value(node).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000602",
                "canvasId": "00000000-0000-4000-8000-000000000601",
                "type": "text",
                "nodeName": "Product idea",
                "content": { "type": "text", "text": "Idea" },
                "x": 50.0,
                "y": 80.0,
                "createdAtMs": 30,
                "updatedAtMs": 40
            })
        );

        let edge = CanvasEdgeDto::from(CanvasEdgeRecord {
            id: "00000000-0000-4000-8000-000000000604".into(),
            canvas_id: "00000000-0000-4000-8000-000000000601".into(),
            source_node_id: "00000000-0000-4000-8000-000000000602".into(),
            target_node_id: "00000000-0000-4000-8000-000000000603".into(),
            relation_type: "default".into(),
            direction: CanvasEdgeDirection::Bidirectional,
            line_style: CanvasEdgeLineStyle::Dashed,
            membership_position: None,
            created_at_ms: 50,
            updated_at_ms: 60,
            deleted_at_ms: None,
        });
        assert_eq!(
            serde_json::to_value(edge).unwrap(),
            serde_json::json!({
                "id": "00000000-0000-4000-8000-000000000604",
                "canvasId": "00000000-0000-4000-8000-000000000601",
                "sourceNodeId": "00000000-0000-4000-8000-000000000602",
                "targetNodeId": "00000000-0000-4000-8000-000000000603",
                "relationType": "default",
                "direction": "bidirectional",
                "lineStyle": "dashed",
                "membershipPosition": null,
                "createdAtMs": 50,
                "updatedAtMs": 60,
                "deletedAtMs": null
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
