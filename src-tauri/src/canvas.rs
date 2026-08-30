//! Canvas native persistence.

use std::{collections::HashSet, path::Path};

use rusqlite::{params, Connection, ErrorCode, OptionalExtension, Row};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::bootstrap::{BootstrapService, BootstrapState};
use crate::db::policy::open_existing_configured_connection;
use crate::storage::{DataRootService, InitMode};

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;
const CANVAS_NODE_NAME_MAX_LENGTH: usize = 120;
const CANVAS_COLUMNS: &str = "id, title, viewport_json, created_at_ms, updated_at_ms";
const NODE_COLUMNS: &str =
    "id, canvas_id, type, node_name, content_json, x, y, created_at_ms, updated_at_ms";
const EDGE_COLUMNS: &str = "id, canvas_id, source_node_id, target_node_id, relation_type, direction, line_style, created_at_ms, updated_at_ms, deleted_at_ms";

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
pub(crate) struct CanvasViewport {
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) zoom: f64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanvasRecord {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) viewport: CanvasViewport,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum CanvasNodeContent {
    Text { text: String },
    Sticky { text: String },
    Unknown(Value),
}

impl CanvasNodeContent {
    fn node_type(&self) -> &'static str {
        match self {
            Self::Text { .. } => "text",
            Self::Sticky { .. } => "sticky",
            Self::Unknown(_) => "",
        }
    }
}

impl Serialize for CanvasNodeContent {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        match self {
            Self::Text { text } => {
                serde_json::json!({ "type": "text", "text": text }).serialize(serializer)
            }
            Self::Sticky { text } => {
                serde_json::json!({ "type": "sticky", "text": text }).serialize(serializer)
            }
            Self::Unknown(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for CanvasNodeContent {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let value = Value::deserialize(deserializer)?;
        let object = value.as_object();
        if let Some(object) = object {
            if object.len() == 2 {
                if let (Some(Value::String(node_type)), Some(Value::String(text))) =
                    (object.get("type"), object.get("text"))
                {
                    return Ok(match node_type.as_str() {
                        "text" => Self::Text { text: text.clone() },
                        "sticky" => Self::Sticky { text: text.clone() },
                        _ => Self::Unknown(value),
                    });
                }
            }
        }
        Ok(Self::Unknown(value))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanvasNodeRecord {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) node_type: String,
    pub(crate) node_name: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CanvasEdgeDirection {
    Forward,
    Bidirectional,
    None,
}

impl CanvasEdgeDirection {
    fn as_str(self) -> &'static str {
        match self {
            Self::Forward => "forward",
            Self::Bidirectional => "bidirectional",
            Self::None => "none",
        }
    }

    fn parse(value: &str) -> Result<Self, CanvasError> {
        match value {
            "forward" => Ok(Self::Forward),
            "bidirectional" => Ok(Self::Bidirectional),
            "none" => Ok(Self::None),
            _ => Err(CanvasError::PersistenceFailed),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum CanvasEdgeLineStyle {
    Solid,
    Dashed,
    Dotted,
}

impl CanvasEdgeLineStyle {
    fn as_str(self) -> &'static str {
        match self {
            Self::Solid => "solid",
            Self::Dashed => "dashed",
            Self::Dotted => "dotted",
        }
    }

    fn parse(value: &str) -> Result<Self, CanvasError> {
        match value {
            "solid" => Ok(Self::Solid),
            "dashed" => Ok(Self::Dashed),
            "dotted" => Ok(Self::Dotted),
            _ => Err(CanvasError::PersistenceFailed),
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanvasEdgeRecord {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) source_node_id: String,
    pub(crate) target_node_id: String,
    pub(crate) relation_type: String,
    pub(crate) direction: CanvasEdgeDirection,
    pub(crate) line_style: CanvasEdgeLineStyle,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
    pub(crate) deleted_at_ms: Option<i64>,
}

pub(crate) struct CreateCanvasInput {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) viewport: CanvasViewport,
    pub(crate) created_at_ms: i64,
}

pub(crate) struct RenameCanvasInput {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct UpdateCanvasViewportInput {
    pub(crate) id: String,
    pub(crate) viewport: CanvasViewport,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct CreateCanvasNodeInput {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) node_type: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) created_at_ms: i64,
}

pub(crate) struct UpdateCanvasNodeContentInput {
    pub(crate) id: String,
    pub(crate) node_type: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct RenameCanvasNodeInput {
    pub(crate) canvas_id: String,
    pub(crate) id: String,
    pub(crate) node_name: String,
    pub(crate) updated_at_ms: i64,
}

#[cfg(test)]
pub(crate) struct CreateTextNodeInput {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) created_at_ms: i64,
}

#[cfg(test)]
pub(crate) struct UpdateTextNodeInput {
    pub(crate) id: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct MoveCanvasNodeInput {
    pub(crate) id: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct CanvasNodePositionMove {
    pub(crate) node_id: String,
    pub(crate) x: f64,
    pub(crate) y: f64,
}

pub(crate) struct MoveCanvasNodesInput {
    pub(crate) canvas_id: String,
    pub(crate) moves: Vec<CanvasNodePositionMove>,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct CreateCanvasEdgeInput {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) source_node_id: String,
    pub(crate) target_node_id: String,
    pub(crate) relation_type: String,
    pub(crate) direction: CanvasEdgeDirection,
    pub(crate) line_style: CanvasEdgeLineStyle,
    pub(crate) created_at_ms: i64,
}

pub(crate) struct UpdateCanvasEdgeDirectionInput {
    pub(crate) id: String,
    pub(crate) direction: CanvasEdgeDirection,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct UpdateCanvasEdgeLineStyleInput {
    pub(crate) id: String,
    pub(crate) line_style: CanvasEdgeLineStyle,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct UpdateCanvasEdgeRelationTypeInput {
    pub(crate) id: String,
    pub(crate) relation_type: String,
    pub(crate) direction: CanvasEdgeDirection,
    pub(crate) line_style: CanvasEdgeLineStyle,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct DeleteCanvasEdgeInput {
    pub(crate) id: String,
    pub(crate) deleted_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum CanvasError {
    #[error("canvas resource not found")]
    NotFound,
    #[error("canvas relation already exists")]
    Duplicate,
    #[error("canvas persistence unavailable")]
    PersistenceUnavailable,
    #[error("canvas persistence failed")]
    PersistenceFailed,
}

impl CanvasError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::Duplicate => "DUPLICATE",
            Self::PersistenceUnavailable => "PERSISTENCE_UNAVAILABLE",
            Self::PersistenceFailed => "PERSISTENCE_FAILED",
        }
    }

    pub(crate) const fn safe_message(self) -> &'static str {
        match self {
            Self::NotFound => "Canvas resource not found.",
            Self::Duplicate => "Canvas relation already exists.",
            Self::PersistenceUnavailable => "Canvas persistence is unavailable.",
            Self::PersistenceFailed => "Canvas persistence operation failed.",
        }
    }
}

fn validate_id(id: &str) -> Result<(), CanvasError> {
    if Uuid::parse_str(id)
        .is_ok_and(|uuid| uuid.hyphenated().to_string() == id && id == id.to_ascii_lowercase())
    {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn validate_title(title: &str) -> Result<(), CanvasError> {
    if !title.is_empty() && title.trim() == title {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn validate_node_name(node_name: &str) -> Result<(), CanvasError> {
    if node_name.trim() == node_name && node_name.chars().count() <= CANVAS_NODE_NAME_MAX_LENGTH {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn validate_relation_type(relation_type: &str) -> Result<(), CanvasError> {
    if matches!(relation_type, "default" | "hierarchy" | "peer") {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn validate_persisted_relation_type(relation_type: &str) -> Result<(), CanvasError> {
    if !relation_type.is_empty() && relation_type.trim() == relation_type {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn validate_timestamp(value: i64) -> Result<(), CanvasError> {
    if (0..=MAX_SAFE_INTEGER_MILLISECONDS).contains(&value) {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn validate_position(x: f64, y: f64) -> Result<(), CanvasError> {
    if x.is_finite() && y.is_finite() {
        Ok(())
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn viewport_json(viewport: CanvasViewport) -> Result<String, CanvasError> {
    if !viewport.x.is_finite()
        || !viewport.y.is_finite()
        || !viewport.zoom.is_finite()
        || viewport.zoom <= 0.0
    {
        return Err(CanvasError::PersistenceFailed);
    }
    serde_json::to_string(&viewport).map_err(|_| CanvasError::PersistenceFailed)
}

fn parse_viewport(source: &str) -> Result<CanvasViewport, CanvasError> {
    let value: Value = serde_json::from_str(source).map_err(|_| CanvasError::PersistenceFailed)?;
    let object = value.as_object().ok_or(CanvasError::PersistenceFailed)?;
    if object.len() != 3
        || !object.contains_key("x")
        || !object.contains_key("y")
        || !object.contains_key("zoom")
    {
        return Err(CanvasError::PersistenceFailed);
    }
    let viewport: CanvasViewport =
        serde_json::from_value(value).map_err(|_| CanvasError::PersistenceFailed)?;
    viewport_json(viewport)?;
    Ok(viewport)
}

fn content_json(content: &CanvasNodeContent) -> Result<String, CanvasError> {
    serde_json::to_string(content).map_err(|_| CanvasError::PersistenceFailed)
}

fn parse_content(node_type: &str, source: &str) -> Result<CanvasNodeContent, CanvasError> {
    let value: Value = serde_json::from_str(source).map_err(|_| CanvasError::PersistenceFailed)?;
    if !matches!(node_type, "text" | "sticky") {
        return Ok(CanvasNodeContent::Unknown(value));
    }
    let object = value.as_object().ok_or(CanvasError::PersistenceFailed)?;
    if object.len() != 2 || object.get("type") != Some(&Value::String(node_type.into())) {
        return Err(CanvasError::PersistenceFailed);
    }
    let content: CanvasNodeContent =
        serde_json::from_value(value).map_err(|_| CanvasError::PersistenceFailed)?;
    if content.node_type() == node_type {
        Ok(content)
    } else {
        Err(CanvasError::PersistenceFailed)
    }
}

fn canvas_from_row(row: &Row<'_>) -> rusqlite::Result<(String, String, String, i64, i64)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
    ))
}

fn validate_canvas(raw: (String, String, String, i64, i64)) -> Result<CanvasRecord, CanvasError> {
    let (id, title, viewport_source, created_at_ms, updated_at_ms) = raw;
    validate_id(&id)?;
    validate_title(&title)?;
    validate_timestamp(created_at_ms)?;
    validate_timestamp(updated_at_ms)?;
    if updated_at_ms < created_at_ms {
        return Err(CanvasError::PersistenceFailed);
    }
    Ok(CanvasRecord {
        id,
        title,
        viewport: parse_viewport(&viewport_source)?,
        created_at_ms,
        updated_at_ms,
    })
}

fn node_from_row(
    row: &Row<'_>,
) -> rusqlite::Result<(String, String, String, String, String, f64, f64, i64, i64)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
    ))
}

fn validate_node(
    raw: (String, String, String, String, String, f64, f64, i64, i64),
) -> Result<CanvasNodeRecord, CanvasError> {
    let (id, canvas_id, node_type, node_name, content_source, x, y, created_at_ms, updated_at_ms) =
        raw;
    validate_id(&id)?;
    validate_id(&canvas_id)?;
    validate_node_name(&node_name)?;
    validate_position(x, y)?;
    validate_timestamp(created_at_ms)?;
    validate_timestamp(updated_at_ms)?;
    if !matches!(node_type.as_str(), "text" | "sticky") || updated_at_ms < created_at_ms {
        return Err(CanvasError::PersistenceFailed);
    }
    let content = parse_content(&node_type, &content_source)?;
    Ok(CanvasNodeRecord {
        id,
        canvas_id,
        node_type,
        node_name,
        content,
        x,
        y,
        created_at_ms,
        updated_at_ms,
    })
}

type EdgeRow = (
    String,
    String,
    String,
    String,
    String,
    String,
    String,
    i64,
    i64,
    Option<i64>,
);

fn edge_from_row(row: &Row<'_>) -> rusqlite::Result<EdgeRow> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
        row.get(8)?,
        row.get(9)?,
    ))
}

fn validate_edge(raw: EdgeRow) -> Result<CanvasEdgeRecord, CanvasError> {
    let (
        id,
        canvas_id,
        source_node_id,
        target_node_id,
        relation_type,
        direction,
        line_style,
        created_at_ms,
        updated_at_ms,
        deleted_at_ms,
    ) = raw;
    validate_id(&id)?;
    validate_id(&canvas_id)?;
    validate_id(&source_node_id)?;
    validate_id(&target_node_id)?;
    validate_persisted_relation_type(&relation_type)?;
    validate_timestamp(created_at_ms)?;
    validate_timestamp(updated_at_ms)?;
    if let Some(value) = deleted_at_ms {
        validate_timestamp(value)?;
    }
    if source_node_id == target_node_id || updated_at_ms < created_at_ms {
        return Err(CanvasError::PersistenceFailed);
    }
    Ok(CanvasEdgeRecord {
        id,
        canvas_id,
        source_node_id,
        target_node_id,
        relation_type,
        direction: CanvasEdgeDirection::parse(&direction)?,
        line_style: CanvasEdgeLineStyle::parse(&line_style)?,
        created_at_ms,
        updated_at_ms,
        deleted_at_ms,
    })
}

fn map_edge_write_error(error: rusqlite::Error) -> CanvasError {
    match error {
        rusqlite::Error::SqliteFailure(failure, _)
            if failure.code == ErrorCode::ConstraintViolation =>
        {
            CanvasError::Duplicate
        }
        _ => CanvasError::PersistenceFailed,
    }
}

pub(crate) struct CanvasDbService;

impl CanvasDbService {
    #[cfg(test)]
    pub(crate) fn create_text_node(
        connection: &Connection,
        input: CreateTextNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        let node_type = input.content.node_type().to_string();
        Self::create_node(
            connection,
            CreateCanvasNodeInput {
                id: input.id,
                canvas_id: input.canvas_id,
                node_type,
                content: input.content,
                x: input.x,
                y: input.y,
                created_at_ms: input.created_at_ms,
            },
        )
    }

    #[cfg(test)]
    pub(crate) fn update_text_node(
        connection: &Connection,
        input: UpdateTextNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        let node_type = input.content.node_type().to_string();
        Self::update_node_content(
            connection,
            UpdateCanvasNodeContentInput {
                id: input.id,
                node_type,
                content: input.content,
                updated_at_ms: input.updated_at_ms,
            },
        )
    }
    pub(crate) fn open_existing(app_config_dir: &Path) -> Result<Connection, CanvasError> {
        let bootstrap_path = BootstrapService::bootstrap_path(app_config_dir);
        let loaded = match BootstrapService::load(&bootstrap_path) {
            BootstrapState::Valid(loaded) => loaded,
            BootstrapState::Missing { .. } | BootstrapState::Degraded(_) => {
                return Err(CanvasError::PersistenceUnavailable)
            }
        };
        let (data_root, manifest) =
            DataRootService::get_and_ensure(&loaded.data_root, InitMode::Existing)
                .map_err(|_| CanvasError::PersistenceUnavailable)?;
        let database_path = DataRootService::resolve_database_path(&data_root, &manifest);
        open_existing_configured_connection(database_path)
            .map_err(|_| CanvasError::PersistenceUnavailable)
    }

    pub(crate) fn create_canvas(
        connection: &Connection,
        input: CreateCanvasInput,
    ) -> Result<CanvasRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_title(&input.title)?;
        validate_timestamp(input.created_at_ms)?;
        let viewport = viewport_json(input.viewport)?;
        connection
            .execute(
                "INSERT INTO canvases(id, title, viewport_json, created_at_ms, updated_at_ms) \
                 VALUES(?1, ?2, ?3, ?4, ?4)",
                params![input.id, input.title, viewport, input.created_at_ms],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        Self::get_canvas(connection, &input.id)
    }

    pub(crate) fn list_canvases(connection: &Connection) -> Result<Vec<CanvasRecord>, CanvasError> {
        let mut statement = connection
            .prepare(&format!(
                "SELECT {CANVAS_COLUMNS} FROM canvases ORDER BY updated_at_ms DESC, id ASC"
            ))
            .map_err(|_| CanvasError::PersistenceFailed)?;
        let canvases = statement
            .query_map([], canvas_from_row)
            .map_err(|_| CanvasError::PersistenceFailed)?
            .map(|row| validate_canvas(row.map_err(|_| CanvasError::PersistenceFailed)?))
            .collect();
        canvases
    }

    pub(crate) fn get_canvas(
        connection: &Connection,
        id: &str,
    ) -> Result<CanvasRecord, CanvasError> {
        validate_id(id)?;
        let raw = connection
            .query_row(
                &format!("SELECT {CANVAS_COLUMNS} FROM canvases WHERE id = ?1"),
                [id],
                canvas_from_row,
            )
            .optional()
            .map_err(|_| CanvasError::PersistenceFailed)?
            .ok_or(CanvasError::NotFound)?;
        validate_canvas(raw)
    }

    pub(crate) fn rename_canvas(
        connection: &Connection,
        input: RenameCanvasInput,
    ) -> Result<CanvasRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_title(&input.title)?;
        validate_timestamp(input.updated_at_ms)?;
        let changed = connection
            .execute(
                "UPDATE canvases SET title = ?1, updated_at_ms = ?2 WHERE id = ?3",
                params![input.title, input.updated_at_ms, input.id],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_canvas(connection, &input.id)
    }

    pub(crate) fn update_viewport(
        connection: &Connection,
        input: UpdateCanvasViewportInput,
    ) -> Result<CanvasRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        let viewport = viewport_json(input.viewport)?;
        let changed = connection
            .execute(
                "UPDATE canvases SET viewport_json = ?1, updated_at_ms = ?2 WHERE id = ?3",
                params![viewport, input.updated_at_ms, input.id],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_canvas(connection, &input.id)
    }

    pub(crate) fn create_node(
        connection: &Connection,
        input: CreateCanvasNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_id(&input.canvas_id)?;
        validate_position(input.x, input.y)?;
        validate_timestamp(input.created_at_ms)?;
        if input.node_type != input.content.node_type() {
            return Err(CanvasError::PersistenceFailed);
        }
        if !connection
            .query_row(
                "SELECT 1 FROM canvases WHERE id = ?1",
                [&input.canvas_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| CanvasError::PersistenceFailed)?
            .is_some()
        {
            return Err(CanvasError::NotFound);
        }
        let content = content_json(&input.content)?;
        connection
            .execute(
                "INSERT INTO canvas_nodes(\
                    id, canvas_id, type, content_json, x, y, created_at_ms, updated_at_ms\
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?7)",
                params![
                    input.id,
                    input.canvas_id,
                    input.node_type,
                    content,
                    input.x,
                    input.y,
                    input.created_at_ms
                ],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        Self::get_node(connection, &input.id)
    }

    pub(crate) fn list_nodes(
        connection: &Connection,
        canvas_id: &str,
    ) -> Result<Vec<CanvasNodeRecord>, CanvasError> {
        Self::get_canvas(connection, canvas_id)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {NODE_COLUMNS} FROM canvas_nodes \
                 WHERE canvas_id = ?1 ORDER BY created_at_ms ASC, id ASC"
            ))
            .map_err(|_| CanvasError::PersistenceFailed)?;
        let nodes = statement
            .query_map([canvas_id], node_from_row)
            .map_err(|_| CanvasError::PersistenceFailed)?
            .map(|row| validate_node(row.map_err(|_| CanvasError::PersistenceFailed)?))
            .collect();
        nodes
    }

    pub(crate) fn update_node_content(
        connection: &Connection,
        input: UpdateCanvasNodeContentInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        if input.node_type != input.content.node_type() {
            return Err(CanvasError::PersistenceFailed);
        }
        let content = content_json(&input.content)?;
        let changed = connection
            .execute(
                "UPDATE canvas_nodes SET content_json = ?1, updated_at_ms = ?2 \
                 WHERE id = ?3 AND type = ?4",
                params![content, input.updated_at_ms, input.id, input.node_type],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_node(connection, &input.id)
    }

    pub(crate) fn rename_node(
        connection: &Connection,
        input: RenameCanvasNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        validate_id(&input.canvas_id)?;
        validate_id(&input.id)?;
        validate_node_name(&input.node_name)?;
        validate_timestamp(input.updated_at_ms)?;
        let changed = connection
            .execute(
                "UPDATE canvas_nodes SET node_name = ?1, updated_at_ms = ?2 \
                 WHERE canvas_id = ?3 AND id = ?4 AND type IN ('text', 'sticky')",
                params![
                    input.node_name,
                    input.updated_at_ms,
                    input.canvas_id,
                    input.id
                ],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_node(connection, &input.id)
    }

    pub(crate) fn move_node(
        connection: &Connection,
        input: MoveCanvasNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_position(input.x, input.y)?;
        validate_timestamp(input.updated_at_ms)?;
        let changed = connection
            .execute(
                "UPDATE canvas_nodes SET x = ?1, y = ?2, updated_at_ms = ?3 WHERE id = ?4",
                params![input.x, input.y, input.updated_at_ms, input.id],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_node(connection, &input.id)
    }

    pub(crate) fn move_nodes(
        connection: &Connection,
        input: MoveCanvasNodesInput,
    ) -> Result<Vec<CanvasNodeRecord>, CanvasError> {
        validate_id(&input.canvas_id)?;
        validate_timestamp(input.updated_at_ms)?;
        if input.moves.is_empty() {
            return Err(CanvasError::PersistenceFailed);
        }
        let mut node_ids = HashSet::with_capacity(input.moves.len());
        for node_move in &input.moves {
            validate_id(&node_move.node_id)?;
            validate_position(node_move.x, node_move.y)?;
            if !node_ids.insert(node_move.node_id.as_str()) {
                return Err(CanvasError::PersistenceFailed);
            }
        }

        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| CanvasError::PersistenceFailed)?;
        Self::get_canvas(&transaction, &input.canvas_id)?;
        for node_move in &input.moves {
            Self::require_node_in_canvas(&transaction, &input.canvas_id, &node_move.node_id)?;
        }
        for node_move in &input.moves {
            let changed = transaction
                .execute(
                    "UPDATE canvas_nodes SET x = ?1, y = ?2, updated_at_ms = ?3 \
                     WHERE canvas_id = ?4 AND id = ?5",
                    params![
                        node_move.x,
                        node_move.y,
                        input.updated_at_ms,
                        input.canvas_id,
                        node_move.node_id
                    ],
                )
                .map_err(|_| CanvasError::PersistenceFailed)?;
            if changed != 1 {
                return Err(CanvasError::NotFound);
            }
        }
        let moved_nodes = input
            .moves
            .iter()
            .map(|node_move| Self::get_node(&transaction, &node_move.node_id))
            .collect::<Result<Vec<_>, _>>()?;
        transaction
            .commit()
            .map_err(|_| CanvasError::PersistenceFailed)?;
        Ok(moved_nodes)
    }

    pub(crate) fn create_edge(
        connection: &Connection,
        input: CreateCanvasEdgeInput,
    ) -> Result<CanvasEdgeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_id(&input.canvas_id)?;
        validate_id(&input.source_node_id)?;
        validate_id(&input.target_node_id)?;
        validate_relation_type(&input.relation_type)?;
        validate_timestamp(input.created_at_ms)?;
        if input.source_node_id == input.target_node_id {
            return Err(CanvasError::PersistenceFailed);
        }
        Self::get_canvas(connection, &input.canvas_id)?;
        Self::require_node_in_canvas(connection, &input.canvas_id, &input.source_node_id)?;
        Self::require_node_in_canvas(connection, &input.canvas_id, &input.target_node_id)?;
        connection
            .execute(
                "INSERT INTO canvas_edges(\
                    id, canvas_id, source_node_id, target_node_id, relation_type, direction, \
                    line_style, created_at_ms, updated_at_ms, deleted_at_ms\
                 ) VALUES(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, NULL)",
                params![
                    input.id,
                    input.canvas_id,
                    input.source_node_id,
                    input.target_node_id,
                    input.relation_type,
                    input.direction.as_str(),
                    input.line_style.as_str(),
                    input.created_at_ms,
                ],
            )
            .map_err(map_edge_write_error)?;
        Self::get_active_edge(connection, &input.id)
    }

    pub(crate) fn list_edges(
        connection: &Connection,
        canvas_id: &str,
    ) -> Result<Vec<CanvasEdgeRecord>, CanvasError> {
        Self::get_canvas(connection, canvas_id)?;
        let mut statement = connection
            .prepare(&format!(
                "SELECT {EDGE_COLUMNS} FROM canvas_edges \
                 WHERE canvas_id = ?1 AND deleted_at_ms IS NULL \
                 ORDER BY created_at_ms ASC, id ASC"
            ))
            .map_err(|_| CanvasError::PersistenceFailed)?;
        let edges = statement
            .query_map([canvas_id], edge_from_row)
            .map_err(|_| CanvasError::PersistenceFailed)?
            .map(|row| validate_edge(row.map_err(|_| CanvasError::PersistenceFailed)?))
            .collect();
        edges
    }

    pub(crate) fn update_edge_direction(
        connection: &Connection,
        input: UpdateCanvasEdgeDirectionInput,
    ) -> Result<CanvasEdgeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        Self::get_active_edge(connection, &input.id)?;
        connection
            .execute(
                "UPDATE canvas_edges SET direction = ?1, updated_at_ms = ?2 \
                 WHERE id = ?3 AND deleted_at_ms IS NULL",
                params![input.direction.as_str(), input.updated_at_ms, input.id],
            )
            .map_err(map_edge_write_error)?;
        Self::get_active_edge(connection, &input.id)
    }

    pub(crate) fn update_edge_line_style(
        connection: &Connection,
        input: UpdateCanvasEdgeLineStyleInput,
    ) -> Result<CanvasEdgeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        let changed = connection
            .execute(
                "UPDATE canvas_edges SET line_style = ?1, updated_at_ms = ?2 \
                 WHERE id = ?3 AND deleted_at_ms IS NULL",
                params![input.line_style.as_str(), input.updated_at_ms, input.id],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_active_edge(connection, &input.id)
    }

    pub(crate) fn update_edge_relation_type(
        connection: &Connection,
        input: UpdateCanvasEdgeRelationTypeInput,
    ) -> Result<CanvasEdgeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_relation_type(&input.relation_type)?;
        validate_timestamp(input.updated_at_ms)?;
        let current = Self::get_active_edge(connection, &input.id)?;
        validate_relation_type(&current.relation_type)?;
        let changed = connection
            .execute(
                "UPDATE canvas_edges \
                 SET relation_type = ?1, direction = ?2, line_style = ?3, updated_at_ms = ?4 \
                 WHERE id = ?5 AND deleted_at_ms IS NULL",
                params![
                    input.relation_type,
                    input.direction.as_str(),
                    input.line_style.as_str(),
                    input.updated_at_ms,
                    input.id
                ],
            )
            .map_err(map_edge_write_error)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_active_edge(connection, &input.id)
    }

    pub(crate) fn delete_edge(
        connection: &Connection,
        input: DeleteCanvasEdgeInput,
    ) -> Result<CanvasEdgeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_timestamp(input.deleted_at_ms)?;
        validate_timestamp(input.updated_at_ms)?;
        let changed = connection
            .execute(
                "UPDATE canvas_edges SET deleted_at_ms = ?1, updated_at_ms = ?2 \
                 WHERE id = ?3 AND deleted_at_ms IS NULL",
                params![input.deleted_at_ms, input.updated_at_ms, input.id],
            )
            .map_err(|_| CanvasError::PersistenceFailed)?;
        if changed != 1 {
            return Err(CanvasError::NotFound);
        }
        Self::get_edge(connection, &input.id)
    }

    fn get_node(connection: &Connection, id: &str) -> Result<CanvasNodeRecord, CanvasError> {
        let raw = connection
            .query_row(
                &format!("SELECT {NODE_COLUMNS} FROM canvas_nodes WHERE id = ?1"),
                [id],
                node_from_row,
            )
            .optional()
            .map_err(|_| CanvasError::PersistenceFailed)?
            .ok_or(CanvasError::NotFound)?;
        validate_node(raw)
    }

    fn require_node_in_canvas(
        connection: &Connection,
        canvas_id: &str,
        node_id: &str,
    ) -> Result<(), CanvasError> {
        connection
            .query_row(
                "SELECT 1 FROM canvas_nodes WHERE canvas_id = ?1 AND id = ?2",
                params![canvas_id, node_id],
                |_| Ok(()),
            )
            .optional()
            .map_err(|_| CanvasError::PersistenceFailed)?
            .ok_or(CanvasError::NotFound)
    }

    fn get_active_edge(connection: &Connection, id: &str) -> Result<CanvasEdgeRecord, CanvasError> {
        let edge = Self::get_edge(connection, id)?;
        if edge.deleted_at_ms.is_some() {
            return Err(CanvasError::NotFound);
        }
        Ok(edge)
    }

    fn get_edge(connection: &Connection, id: &str) -> Result<CanvasEdgeRecord, CanvasError> {
        let raw = connection
            .query_row(
                &format!("SELECT {EDGE_COLUMNS} FROM canvas_edges WHERE id = ?1"),
                [id],
                edge_from_row,
            )
            .optional()
            .map_err(|_| CanvasError::PersistenceFailed)?
            .ok_or(CanvasError::NotFound)?;
        validate_edge(raw)
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::db::definitions::MIGRATIONS;
    use crate::db::migration::{MigrationDefinition, MigrationRunner};
    use crate::db::policy::{open_configured_connection, open_existing_configured_connection};
    use crate::db::snapshot::SqliteBackupSnapshot;

    const CANVAS_ID: &str = "00000000-0000-4000-8000-000000000601";
    const NODE_ID: &str = "00000000-0000-4000-8000-000000000602";
    const TARGET_NODE_ID: &str = "00000000-0000-4000-8000-000000000603";
    const EDGE_ID: &str = "00000000-0000-4000-8000-000000000604";

    fn migrated_database() -> (tempfile::TempDir, std::path::PathBuf, Connection) {
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

    fn create_canvas(connection: &Connection) -> CanvasRecord {
        CanvasDbService::create_canvas(
            connection,
            CreateCanvasInput {
                id: CANVAS_ID.into(),
                title: "Project map".into(),
                viewport: CanvasViewport {
                    x: 0.0,
                    y: 0.0,
                    zoom: 1.0,
                },
                created_at_ms: 10,
            },
        )
        .unwrap()
    }

    fn create_node(connection: &Connection, id: &str, canvas_id: &str, text: &str) {
        connection
            .execute(
                "INSERT INTO canvas_nodes(\
                   id, canvas_id, type, content_json, x, y, created_at_ms, updated_at_ms\
                 ) VALUES(?1, ?2, 'text', json_object('type', 'text', 'text', ?3), 10.0, 20.0, 20, 20)",
                rusqlite::params![id, canvas_id, text],
            )
            .unwrap();
    }

    fn edge_input(
        id: &str,
        source_node_id: &str,
        target_node_id: &str,
        direction: CanvasEdgeDirection,
    ) -> CreateCanvasEdgeInput {
        CreateCanvasEdgeInput {
            id: id.into(),
            canvas_id: CANVAS_ID.into(),
            source_node_id: source_node_id.into(),
            target_node_id: target_node_id.into(),
            relation_type: "default".into(),
            direction,
            line_style: CanvasEdgeLineStyle::Solid,
            created_at_ms: 30,
        }
    }

    #[test]
    fn migration_seven_adds_canvas_edges_schema_and_contiguous_history() {
        let (_sandbox, _path, connection) = migrated_database();
        let history: Vec<(i64, String)> = connection
            .prepare("SELECT version, id FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(history.len(), 9);
        assert_eq!(history[5], (6, "0006_add_canvas_core".into()));
        assert_eq!(history[6], (7, "0007_add_canvas_edges".into()));
        assert_eq!(history[7], (8, "0008_add_sticky_canvas_nodes".into()));
        assert_eq!(history[8], (9, "0009_add_canvas_node_name".into()));
        for table in ["canvases", "canvas_nodes", "canvas_edges"] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1);
        }
        let columns: Vec<String> = connection
            .prepare("PRAGMA table_info('canvas_edges')")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(
            columns,
            [
                "id",
                "canvas_id",
                "source_node_id",
                "target_node_id",
                "relation_type",
                "direction",
                "line_style",
                "created_at_ms",
                "updated_at_ms",
                "deleted_at_ms",
            ]
        );
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_key_check", [], |_| Ok(1))
                .optional()
                .unwrap(),
            None
        );
    }

    #[test]
    fn existing_v6_database_migrates_to_canvas_edges() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(&MIGRATIONS[..6], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "Existing");

        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();

        assert!(CanvasDbService::list_edges(&connection, CANVAS_ID)
            .unwrap()
            .is_empty());
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "Target");
        assert!(CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward
            ),
        )
        .is_ok());
    }

    #[test]
    fn migration_eight_preserves_existing_text_nodes_and_edges() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(&MIGRATIONS[..7], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "Existing");
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "Target");
        connection
            .execute(
                "UPDATE canvas_nodes SET content_json = json_object('type', 'text', 'text', 'Existing updated'), updated_at_ms = 41 WHERE id = ?1",
                [NODE_ID],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE canvas_nodes SET x = -44.5, y = 208.25, updated_at_ms = 42 WHERE id = ?1",
                [NODE_ID],
            )
            .unwrap();
        CanvasDbService::update_viewport(
            &connection,
            UpdateCanvasViewportInput {
                id: CANVAS_ID.into(),
                viewport: CanvasViewport {
                    x: 75.0,
                    y: -30.0,
                    zoom: 1.25,
                },
                updated_at_ms: 43,
            },
        )
        .unwrap();
        CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();
        CanvasDbService::update_edge_direction(
            &connection,
            UpdateCanvasEdgeDirectionInput {
                id: EDGE_ID.into(),
                direction: CanvasEdgeDirection::Bidirectional,
                updated_at_ms: 44,
            },
        )
        .unwrap();
        CanvasDbService::update_edge_line_style(
            &connection,
            UpdateCanvasEdgeLineStyleInput {
                id: EDGE_ID.into(),
                line_style: CanvasEdgeLineStyle::Dotted,
                updated_at_ms: 45,
            },
        )
        .unwrap();

        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();

        let node_columns: Vec<String> = connection
            .prepare("PRAGMA table_info('canvas_nodes')")
            .unwrap()
            .query_map([], |row| row.get(1))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert!(node_columns.iter().any(|column| column == "node_name"));
        let nodes = CanvasDbService::list_nodes(&connection, CANVAS_ID).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(
            nodes[0].content,
            CanvasNodeContent::Text {
                text: "Existing updated".into()
            }
        );
        assert_eq!(
            (
                nodes[0].x,
                nodes[0].y,
                nodes[0].created_at_ms,
                nodes[0].updated_at_ms
            ),
            (-44.5, 208.25, 20, 42)
        );
        assert!(nodes.iter().all(|node| node.node_name.is_empty()));
        assert_eq!(
            CanvasDbService::get_canvas(&connection, CANVAS_ID)
                .unwrap()
                .viewport,
            CanvasViewport {
                x: 75.0,
                y: -30.0,
                zoom: 1.25
            }
        );
        let edges = CanvasDbService::list_edges(&connection, CANVAS_ID).unwrap();
        assert_eq!(edges.len(), 1);
        assert_eq!(
            (
                &edges[0].source_node_id,
                &edges[0].target_node_id,
                &edges[0].relation_type
            ),
            (
                &NODE_ID.to_string(),
                &TARGET_NODE_ID.to_string(),
                &"default".to_string()
            )
        );
        assert_eq!(
            (
                edges[0].direction,
                edges[0].line_style,
                edges[0].deleted_at_ms
            ),
            (
                CanvasEdgeDirection::Bidirectional,
                CanvasEdgeLineStyle::Dotted,
                None
            )
        );
        assert!(connection
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .unwrap()
            .is_none());
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            9
        );

        CanvasDbService::create_text_node(
            &connection,
            CreateTextNodeInput {
                id: "00000000-0000-4000-8000-000000000615".into(),
                canvas_id: CANVAS_ID.into(),
                content: CanvasNodeContent::Sticky {
                    text: "After upgrade".into(),
                },
                x: 300.0,
                y: 140.0,
                created_at_ms: 50,
            },
        )
        .unwrap();
        drop(connection);
        let reopened = open_existing_configured_connection(&database_path).unwrap();
        let reopened_nodes = CanvasDbService::list_nodes(&reopened, CANVAS_ID).unwrap();
        assert_eq!(reopened_nodes.len(), 3);
        assert!(reopened_nodes.iter().any(|node| node.content
            == CanvasNodeContent::Sticky {
                text: "After upgrade".into()
            }));
        assert_eq!(
            CanvasDbService::list_edges(&reopened, CANVAS_ID)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn migration_eight_failure_rolls_back_the_entire_table_rebuild() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(&MIGRATIONS[..7], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "Existing");
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "Target");
        CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();
        let mut definitions = MIGRATIONS[..7].to_vec();
        definitions.push(MigrationDefinition { version: 8, id: "0008_broken_rebuild", sql_up: "ALTER TABLE canvas_edges RENAME TO canvas_edges_v7; ALTER TABLE canvas_nodes RENAME TO canvas_nodes_v6; SELECT * FROM missing_table;", high_risk: true });
        assert!(MigrationRunner::new(&definitions, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .is_err());
        for table in ["canvas_nodes", "canvas_edges"] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                        [table],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                1
            );
        }
        for temporary in ["canvas_nodes_v6", "canvas_edges_v7"] {
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                        [temporary],
                        |row| row.get::<_, i64>(0)
                    )
                    .unwrap(),
                0
            );
        }
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM canvas_nodes WHERE canvas_id = ?1",
                    [CANVAS_ID],
                    |row| row.get::<_, i64>(0)
                )
                .unwrap(),
            2
        );
        assert_eq!(
            CanvasDbService::list_edges(&connection, CANVAS_ID)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM schema_migrations", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            7
        );
    }

    #[test]
    fn migration_nine_backfills_names_without_changing_existing_canvas_data() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(&MIGRATIONS[..8], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        create_canvas(&connection);
        CanvasDbService::update_viewport(
            &connection,
            UpdateCanvasViewportInput {
                id: CANVAS_ID.into(),
                viewport: CanvasViewport {
                    x: 45.0,
                    y: -30.0,
                    zoom: 1.25,
                },
                updated_at_ms: 15,
            },
        )
        .unwrap();
        create_node(&connection, NODE_ID, CANVAS_ID, "Existing text");
        connection
            .execute(
                "INSERT INTO canvas_nodes(\
                   id, canvas_id, type, content_json, x, y, created_at_ms, updated_at_ms\
                 ) VALUES(?1, ?2, 'sticky', json_object('type', 'sticky', 'text', 'Existing sticky'), 80.0, -25.0, 21, 21)",
                rusqlite::params![TARGET_NODE_ID, CANVAS_ID],
            )
            .unwrap();
        CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();
        let checksums_before: Vec<(i64, String)> = connection
            .prepare("SELECT version, checksum_sha256 FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();

        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();

        let nodes = CanvasDbService::list_nodes(&connection, CANVAS_ID).unwrap();
        assert_eq!(nodes.len(), 2);
        assert_eq!(nodes[0].node_name, "");
        assert_eq!(
            nodes[0].content,
            CanvasNodeContent::Text {
                text: "Existing text".into()
            }
        );
        assert_eq!(
            (
                nodes[0].x,
                nodes[0].y,
                nodes[0].created_at_ms,
                nodes[0].updated_at_ms
            ),
            (10.0, 20.0, 20, 20)
        );
        assert_eq!(nodes[1].node_name, "");
        assert_eq!(
            nodes[1].content,
            CanvasNodeContent::Sticky {
                text: "Existing sticky".into()
            }
        );
        assert_eq!(
            (
                nodes[1].x,
                nodes[1].y,
                nodes[1].created_at_ms,
                nodes[1].updated_at_ms
            ),
            (80.0, -25.0, 21, 21)
        );
        assert_eq!(
            CanvasDbService::list_edges(&connection, CANVAS_ID)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            CanvasDbService::get_canvas(&connection, CANVAS_ID)
                .unwrap()
                .viewport,
            CanvasViewport {
                x: 45.0,
                y: -30.0,
                zoom: 1.25
            }
        );
        let checksums_after: Vec<(i64, String)> = connection
            .prepare("SELECT version, checksum_sha256 FROM schema_migrations WHERE version <= 8 ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(checksums_after, checksums_before);
        assert_eq!(
            connection
                .query_row(
                    "SELECT id FROM schema_migrations WHERE version = 9",
                    [],
                    |row| row.get::<_, String>(0)
                )
                .unwrap(),
            "0009_add_canvas_node_name"
        );
    }

    #[test]
    fn existing_v5_database_migrates_to_canvas_core_without_task_changes() {
        let sandbox = tempdir().unwrap();
        let database_dir = sandbox.path().join("database");
        let backup_dir = sandbox.path().join("backup");
        fs::create_dir_all(&database_dir).unwrap();
        fs::create_dir_all(&backup_dir).unwrap();
        let database_path = database_dir.join("zhixing.db");
        let mut connection = open_configured_connection(&database_path).unwrap();
        MigrationRunner::new(&MIGRATIONS[..5], SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) \
                 VALUES(?1, 'Existing', 'todo', 1, 1)",
                [NODE_ID],
            )
            .unwrap();
        MigrationRunner::new(MIGRATIONS, SqliteBackupSnapshot)
            .run(&mut connection, &backup_dir)
            .unwrap();
        assert_eq!(
            connection
                .query_row("SELECT title FROM tasks WHERE id = ?1", [NODE_ID], |row| {
                    row.get::<_, String>(0)
                })
                .unwrap(),
            "Existing"
        );
        assert!(CanvasDbService::list_canvases(&connection)
            .unwrap()
            .is_empty());
    }

    #[test]
    fn canvas_and_text_node_capabilities_validate_and_report_missing() {
        let (_sandbox, _path, connection) = migrated_database();
        let created = create_canvas(&connection);
        assert_eq!(
            CanvasDbService::list_canvases(&connection).unwrap(),
            [created.clone()]
        );
        let renamed = CanvasDbService::rename_canvas(
            &connection,
            RenameCanvasInput {
                id: CANVAS_ID.into(),
                title: "Renamed".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(renamed.title, "Renamed");
        let viewport = CanvasDbService::update_viewport(
            &connection,
            UpdateCanvasViewportInput {
                id: CANVAS_ID.into(),
                viewport: CanvasViewport {
                    x: -120.5,
                    y: 48.0,
                    zoom: 1.4,
                },
                updated_at_ms: 30,
            },
        )
        .unwrap();
        assert_eq!(viewport.viewport.zoom, 1.4);

        let created_node = CanvasDbService::create_text_node(
            &connection,
            CreateTextNodeInput {
                id: NODE_ID.into(),
                canvas_id: CANVAS_ID.into(),
                content: CanvasNodeContent::Text {
                    text: "First".into(),
                },
                x: 10.0,
                y: 20.0,
                created_at_ms: 40,
            },
        )
        .unwrap();
        assert_eq!(created_node.node_name, "");
        assert_eq!(
            CanvasDbService::list_nodes(&connection, CANVAS_ID).unwrap(),
            [created_node]
        );
        let edited = CanvasDbService::update_text_node(
            &connection,
            UpdateTextNodeInput {
                id: NODE_ID.into(),
                content: CanvasNodeContent::Text {
                    text: "Updated".into(),
                },
                updated_at_ms: 50,
            },
        )
        .unwrap();
        assert_eq!(
            edited.content,
            CanvasNodeContent::Text {
                text: "Updated".into()
            }
        );
        let moved = CanvasDbService::move_node(
            &connection,
            MoveCanvasNodeInput {
                id: NODE_ID.into(),
                x: -30.0,
                y: 75.5,
                updated_at_ms: 60,
            },
        )
        .unwrap();
        assert_eq!((moved.x, moved.y), (-30.0, 75.5));

        assert_eq!(
            CanvasDbService::get_canvas(&connection, "00000000-0000-4000-8000-000000000699"),
            Err(CanvasError::NotFound)
        );
        assert_eq!(
            CanvasDbService::move_node(
                &connection,
                MoveCanvasNodeInput {
                    id: "00000000-0000-4000-8000-000000000699".into(),
                    x: 0.0,
                    y: 0.0,
                    updated_at_ms: 70,
                }
            ),
            Err(CanvasError::NotFound)
        );
    }

    #[test]
    fn node_rename_preserves_content_position_edges_and_survives_restart() {
        let (_sandbox, database_path, connection) = migrated_database();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "Text body");
        CanvasDbService::create_node(
            &connection,
            CreateCanvasNodeInput {
                id: TARGET_NODE_ID.into(),
                canvas_id: CANVAS_ID.into(),
                node_type: "sticky".into(),
                content: CanvasNodeContent::Sticky {
                    text: "Sticky body".into(),
                },
                x: 80.0,
                y: 90.0,
                created_at_ms: 21,
            },
        )
        .unwrap();
        CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();

        let renamed_text = CanvasDbService::rename_node(
            &connection,
            RenameCanvasNodeInput {
                canvas_id: CANVAS_ID.into(),
                id: NODE_ID.into(),
                node_name: "产品构思".into(),
                updated_at_ms: 50,
            },
        )
        .unwrap();
        assert_eq!(renamed_text.node_name, "产品构思");
        assert_eq!(
            renamed_text.content,
            CanvasNodeContent::Text {
                text: "Text body".into()
            }
        );
        assert_eq!(
            (renamed_text.x, renamed_text.y, renamed_text.updated_at_ms),
            (10.0, 20.0, 50)
        );

        let renamed_sticky = CanvasDbService::rename_node(
            &connection,
            RenameCanvasNodeInput {
                canvas_id: CANVAS_ID.into(),
                id: TARGET_NODE_ID.into(),
                node_name: "".into(),
                updated_at_ms: 51,
            },
        )
        .unwrap();
        assert_eq!(renamed_sticky.node_name, "");
        assert_eq!(
            renamed_sticky.content,
            CanvasNodeContent::Sticky {
                text: "Sticky body".into()
            }
        );
        assert_eq!(
            (
                renamed_sticky.x,
                renamed_sticky.y,
                renamed_sticky.updated_at_ms
            ),
            (80.0, 90.0, 51)
        );
        let edge = CanvasDbService::list_edges(&connection, CANVAS_ID)
            .unwrap()
            .remove(0);
        assert_eq!(
            (
                edge.source_node_id.as_str(),
                edge.target_node_id.as_str(),
                edge.relation_type.as_str(),
                edge.direction,
                edge.line_style
            ),
            (
                NODE_ID,
                TARGET_NODE_ID,
                "default",
                CanvasEdgeDirection::Forward,
                CanvasEdgeLineStyle::Solid
            )
        );

        let max_unicode = "😀".repeat(CANVAS_NODE_NAME_MAX_LENGTH);
        assert!(CanvasDbService::rename_node(
            &connection,
            RenameCanvasNodeInput {
                canvas_id: CANVAS_ID.into(),
                id: NODE_ID.into(),
                node_name: max_unicode.clone(),
                updated_at_ms: 52
            }
        )
        .is_ok());
        assert_eq!(
            CanvasDbService::rename_node(
                &connection,
                RenameCanvasNodeInput {
                    canvas_id: CANVAS_ID.into(),
                    id: NODE_ID.into(),
                    node_name: "😀".repeat(CANVAS_NODE_NAME_MAX_LENGTH + 1),
                    updated_at_ms: 53
                }
            ),
            Err(CanvasError::PersistenceFailed)
        );
        assert_eq!(
            CanvasDbService::rename_node(
                &connection,
                RenameCanvasNodeInput {
                    canvas_id: CANVAS_ID.into(),
                    id: NODE_ID.into(),
                    node_name: " untrimmed ".into(),
                    updated_at_ms: 53
                }
            ),
            Err(CanvasError::PersistenceFailed)
        );
        assert_eq!(
            CanvasDbService::rename_node(
                &connection,
                RenameCanvasNodeInput {
                    canvas_id: "00000000-0000-4000-8000-000000000699".into(),
                    id: NODE_ID.into(),
                    node_name: "Other".into(),
                    updated_at_ms: 53
                }
            ),
            Err(CanvasError::NotFound)
        );
        assert_eq!(
            CanvasDbService::rename_node(
                &connection,
                RenameCanvasNodeInput {
                    canvas_id: CANVAS_ID.into(),
                    id: "00000000-0000-4000-8000-000000000699".into(),
                    node_name: "Missing".into(),
                    updated_at_ms: 53
                }
            ),
            Err(CanvasError::NotFound)
        );

        drop(connection);
        let reopened = open_existing_configured_connection(&database_path).unwrap();
        let restored = CanvasDbService::get_node(&reopened, NODE_ID).unwrap();
        assert_eq!(restored.node_name, max_unicode);
        assert_eq!(
            restored.content,
            CanvasNodeContent::Text {
                text: "Text body".into()
            }
        );
        assert_eq!((restored.x, restored.y), (10.0, 20.0));
        assert_eq!(
            CanvasDbService::list_edges(&reopened, CANVAS_ID)
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn batch_move_is_atomic_across_missing_and_cross_canvas_nodes_and_restarts() {
        let (_sandbox, database_path, connection) = migrated_database();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "A");
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "B");

        assert_eq!(
            CanvasDbService::move_nodes(
                &connection,
                MoveCanvasNodesInput {
                    canvas_id: CANVAS_ID.into(),
                    moves: vec![
                        CanvasNodePositionMove {
                            node_id: NODE_ID.into(),
                            x: 30.0,
                            y: 40.0,
                        },
                        CanvasNodePositionMove {
                            node_id: NODE_ID.into(),
                            x: 50.0,
                            y: 60.0,
                        },
                    ],
                    updated_at_ms: 30,
                },
            ),
            Err(CanvasError::PersistenceFailed)
        );

        let moved = CanvasDbService::move_nodes(
            &connection,
            MoveCanvasNodesInput {
                canvas_id: CANVAS_ID.into(),
                moves: vec![
                    CanvasNodePositionMove {
                        node_id: NODE_ID.into(),
                        x: 110.0,
                        y: 120.0,
                    },
                    CanvasNodePositionMove {
                        node_id: TARGET_NODE_ID.into(),
                        x: 210.0,
                        y: 220.0,
                    },
                ],
                updated_at_ms: 50,
            },
        )
        .unwrap();
        assert_eq!(moved.len(), 2);
        assert!(moved.iter().all(|node| node.updated_at_ms == 50));

        assert_eq!(
            CanvasDbService::move_nodes(
                &connection,
                MoveCanvasNodesInput {
                    canvas_id: CANVAS_ID.into(),
                    moves: vec![
                        CanvasNodePositionMove {
                            node_id: NODE_ID.into(),
                            x: 310.0,
                            y: 320.0,
                        },
                        CanvasNodePositionMove {
                            node_id: "00000000-0000-4000-8000-000000000699".into(),
                            x: 410.0,
                            y: 420.0,
                        },
                    ],
                    updated_at_ms: 60,
                },
            ),
            Err(CanvasError::NotFound)
        );
        assert_eq!(
            CanvasDbService::get_node(&connection, NODE_ID).unwrap().x,
            110.0
        );

        let other_canvas_id = "00000000-0000-4000-8000-000000000610";
        let other_node_id = "00000000-0000-4000-8000-000000000611";
        CanvasDbService::create_canvas(
            &connection,
            CreateCanvasInput {
                id: other_canvas_id.into(),
                title: "Other".into(),
                viewport: CanvasViewport {
                    x: 0.0,
                    y: 0.0,
                    zoom: 1.0,
                },
                created_at_ms: 10,
            },
        )
        .unwrap();
        create_node(&connection, other_node_id, other_canvas_id, "Other");
        assert_eq!(
            CanvasDbService::move_nodes(
                &connection,
                MoveCanvasNodesInput {
                    canvas_id: CANVAS_ID.into(),
                    moves: vec![
                        CanvasNodePositionMove {
                            node_id: NODE_ID.into(),
                            x: 510.0,
                            y: 520.0,
                        },
                        CanvasNodePositionMove {
                            node_id: other_node_id.into(),
                            x: 610.0,
                            y: 620.0,
                        },
                    ],
                    updated_at_ms: 70,
                },
            ),
            Err(CanvasError::NotFound)
        );
        assert_eq!(
            CanvasDbService::get_node(&connection, NODE_ID).unwrap().x,
            110.0
        );

        drop(connection);
        let reopened = open_existing_configured_connection(&database_path).unwrap();
        let restored = CanvasDbService::list_nodes(&reopened, CANVAS_ID).unwrap();
        assert_eq!(
            restored.iter().find(|node| node.id == NODE_ID).unwrap().x,
            110.0
        );
        assert_eq!(
            restored
                .iter()
                .find(|node| node.id == TARGET_NODE_ID)
                .unwrap()
                .y,
            220.0
        );
    }

    #[test]
    fn edge_capabilities_enforce_identity_updates_and_soft_delete() {
        let (_sandbox, _path, connection) = migrated_database();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "A");
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "B");

        let created = CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();
        assert_eq!(created.relation_type, "default");
        assert_eq!(created.line_style, CanvasEdgeLineStyle::Solid);
        assert_eq!(
            CanvasDbService::create_edge(
                &connection,
                edge_input(
                    "00000000-0000-4000-8000-000000000605",
                    NODE_ID,
                    TARGET_NODE_ID,
                    CanvasEdgeDirection::Forward,
                ),
            ),
            Err(CanvasError::Duplicate)
        );
        assert!(CanvasDbService::create_edge(
            &connection,
            edge_input(
                "00000000-0000-4000-8000-000000000606",
                TARGET_NODE_ID,
                NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .is_ok());

        let symmetric_id = "00000000-0000-4000-8000-000000000607";
        assert!(CanvasDbService::create_edge(
            &connection,
            edge_input(
                symmetric_id,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::None,
            ),
        )
        .is_ok());
        assert_eq!(
            CanvasDbService::create_edge(
                &connection,
                edge_input(
                    "00000000-0000-4000-8000-000000000608",
                    TARGET_NODE_ID,
                    NODE_ID,
                    CanvasEdgeDirection::None,
                ),
            ),
            Err(CanvasError::Duplicate)
        );
        assert_eq!(
            CanvasDbService::update_edge_direction(
                &connection,
                UpdateCanvasEdgeDirectionInput {
                    id: symmetric_id.into(),
                    direction: CanvasEdgeDirection::Forward,
                    updated_at_ms: 40,
                },
            ),
            Err(CanvasError::Duplicate)
        );
        assert_eq!(
            CanvasDbService::list_edges(&connection, CANVAS_ID)
                .unwrap()
                .iter()
                .find(|edge| edge.id == symmetric_id)
                .unwrap()
                .direction,
            CanvasEdgeDirection::None
        );

        let styled = CanvasDbService::update_edge_line_style(
            &connection,
            UpdateCanvasEdgeLineStyleInput {
                id: EDGE_ID.into(),
                line_style: CanvasEdgeLineStyle::Dotted,
                updated_at_ms: 50,
            },
        )
        .unwrap();
        assert_eq!(styled.line_style, CanvasEdgeLineStyle::Dotted);
        let deleted = CanvasDbService::delete_edge(
            &connection,
            DeleteCanvasEdgeInput {
                id: EDGE_ID.into(),
                deleted_at_ms: 60,
                updated_at_ms: 60,
            },
        )
        .unwrap();
        assert_eq!(deleted.deleted_at_ms, Some(60));
        assert!(!CanvasDbService::list_edges(&connection, CANVAS_ID)
            .unwrap()
            .iter()
            .any(|edge| edge.id == EDGE_ID));
        assert!(CanvasDbService::create_edge(
            &connection,
            edge_input(
                "00000000-0000-4000-8000-000000000609",
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .is_ok());
    }

    #[test]
    fn edge_database_rejects_self_loops_and_cross_canvas_nodes() {
        let (_sandbox, _path, connection) = migrated_database();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "A");
        assert_eq!(
            CanvasDbService::create_edge(
                &connection,
                edge_input(EDGE_ID, NODE_ID, NODE_ID, CanvasEdgeDirection::Forward),
            ),
            Err(CanvasError::PersistenceFailed)
        );

        let other_canvas_id = "00000000-0000-4000-8000-000000000610";
        CanvasDbService::create_canvas(
            &connection,
            CreateCanvasInput {
                id: other_canvas_id.into(),
                title: "Other".into(),
                viewport: CanvasViewport {
                    x: 0.0,
                    y: 0.0,
                    zoom: 1.0,
                },
                created_at_ms: 10,
            },
        )
        .unwrap();
        create_node(&connection, TARGET_NODE_ID, other_canvas_id, "B");
        assert_eq!(
            CanvasDbService::create_edge(
                &connection,
                edge_input(
                    EDGE_ID,
                    NODE_ID,
                    TARGET_NODE_ID,
                    CanvasEdgeDirection::Forward
                ),
            ),
            Err(CanvasError::NotFound)
        );
        let raw_insert = connection.execute(
            "INSERT INTO canvas_edges(\
                id, canvas_id, source_node_id, target_node_id, relation_type, direction, \
                line_style, created_at_ms, updated_at_ms, deleted_at_ms\
             ) VALUES(?1, ?2, ?3, ?4, 'default', 'forward', 'solid', 30, 30, NULL)",
            params![EDGE_ID, CANVAS_ID, NODE_ID, TARGET_NODE_ID],
        );
        assert!(raw_insert.is_err());
        assert!(raw_insert
            .unwrap_err()
            .to_string()
            .contains("FOREIGN KEY constraint failed"));
    }

    #[test]
    fn restart_preserves_canvas_text_position_viewport_and_edge() {
        let (_sandbox, database_path, connection) = migrated_database();
        create_canvas(&connection);
        CanvasDbService::update_viewport(
            &connection,
            UpdateCanvasViewportInput {
                id: CANVAS_ID.into(),
                viewport: CanvasViewport {
                    x: 125.0,
                    y: -80.0,
                    zoom: 0.75,
                },
                updated_at_ms: 20,
            },
        )
        .unwrap();
        CanvasDbService::create_text_node(
            &connection,
            CreateTextNodeInput {
                id: NODE_ID.into(),
                canvas_id: CANVAS_ID.into(),
                content: CanvasNodeContent::Text {
                    text: "Persisted".into(),
                },
                x: -40.0,
                y: 210.0,
                created_at_ms: 30,
            },
        )
        .unwrap();
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "Target");
        CanvasDbService::create_edge(
            &connection,
            edge_input(
                EDGE_ID,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();
        CanvasDbService::update_edge_direction(
            &connection,
            UpdateCanvasEdgeDirectionInput {
                id: EDGE_ID.into(),
                direction: CanvasEdgeDirection::Bidirectional,
                updated_at_ms: 40,
            },
        )
        .unwrap();
        CanvasDbService::update_edge_line_style(
            &connection,
            UpdateCanvasEdgeLineStyleInput {
                id: EDGE_ID.into(),
                line_style: CanvasEdgeLineStyle::Dashed,
                updated_at_ms: 50,
            },
        )
        .unwrap();
        drop(connection);

        let reopened = open_existing_configured_connection(database_path).unwrap();
        assert_eq!(
            CanvasDbService::get_canvas(&reopened, CANVAS_ID)
                .unwrap()
                .viewport,
            CanvasViewport {
                x: 125.0,
                y: -80.0,
                zoom: 0.75,
            }
        );
        let nodes = CanvasDbService::list_nodes(&reopened, CANVAS_ID).unwrap();
        let persisted_node = nodes.iter().find(|node| node.id == NODE_ID).unwrap();
        assert_eq!(
            persisted_node.content,
            CanvasNodeContent::Text {
                text: "Persisted".into()
            }
        );
        assert_eq!((persisted_node.x, persisted_node.y), (-40.0, 210.0));
        assert_eq!(
            CanvasDbService::list_edges(&reopened, CANVAS_ID).unwrap(),
            [CanvasEdgeRecord {
                id: EDGE_ID.into(),
                canvas_id: CANVAS_ID.into(),
                source_node_id: NODE_ID.into(),
                target_node_id: TARGET_NODE_ID.into(),
                relation_type: "default".into(),
                direction: CanvasEdgeDirection::Bidirectional,
                line_style: CanvasEdgeLineStyle::Dashed,
                created_at_ms: 30,
                updated_at_ms: 50,
                deleted_at_ms: None,
            }]
        );
    }

    #[test]
    fn sticky_node_is_typed_persisted_and_schema_rejects_unregistered_types() {
        let (_sandbox, database_path, connection) = migrated_database();
        create_canvas(&connection);
        let sticky = CanvasDbService::create_text_node(
            &connection,
            CreateTextNodeInput {
                id: NODE_ID.into(),
                canvas_id: CANVAS_ID.into(),
                content: CanvasNodeContent::Sticky {
                    text: "Remember".into(),
                },
                x: 24.0,
                y: -12.0,
                created_at_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(sticky.node_type, "sticky");
        assert_eq!(sticky.node_name, "");
        assert_eq!(
            sticky.content,
            CanvasNodeContent::Sticky {
                text: "Remember".into()
            }
        );
        assert!(connection.execute(
            "INSERT INTO canvas_nodes(id, canvas_id, type, content_json, x, y, created_at_ms, updated_at_ms) VALUES(?1, ?2, 'image', '{\"type\":\"image\"}', 0, 0, 30, 30)",
            params![TARGET_NODE_ID, CANVAS_ID],
        ).is_err());
        drop(connection);
        let reopened = open_existing_configured_connection(&database_path).unwrap();
        assert_eq!(
            CanvasDbService::list_nodes(&reopened, CANVAS_ID).unwrap()[0].content,
            CanvasNodeContent::Sticky {
                text: "Remember".into()
            }
        );
    }

    #[test]
    fn semantic_edge_types_update_atomically_preserve_unknowns_and_restart() {
        let (_sandbox, database_path, connection) = migrated_database();
        create_canvas(&connection);
        create_node(&connection, NODE_ID, CANVAS_ID, "Source");
        create_node(&connection, TARGET_NODE_ID, CANVAS_ID, "Target");

        let mut hierarchy = edge_input(
            EDGE_ID,
            NODE_ID,
            TARGET_NODE_ID,
            CanvasEdgeDirection::Forward,
        );
        hierarchy.relation_type = "hierarchy".into();
        let created = CanvasDbService::create_edge(&connection, hierarchy).unwrap();
        assert_eq!(created.relation_type, "hierarchy");

        let default_id = "00000000-0000-4000-8000-000000000605";
        CanvasDbService::create_edge(
            &connection,
            edge_input(
                default_id,
                NODE_ID,
                TARGET_NODE_ID,
                CanvasEdgeDirection::Forward,
            ),
        )
        .unwrap();
        assert_eq!(
            CanvasDbService::update_edge_relation_type(
                &connection,
                UpdateCanvasEdgeRelationTypeInput {
                    id: default_id.into(),
                    relation_type: "hierarchy".into(),
                    direction: CanvasEdgeDirection::Forward,
                    line_style: CanvasEdgeLineStyle::Solid,
                    updated_at_ms: 40,
                },
            ),
            Err(CanvasError::Duplicate)
        );
        let unchanged = CanvasDbService::get_active_edge(&connection, default_id).unwrap();
        assert_eq!(
            (
                unchanged.relation_type.as_str(),
                unchanged.direction,
                unchanged.line_style,
                unchanged.updated_at_ms,
            ),
            (
                "default",
                CanvasEdgeDirection::Forward,
                CanvasEdgeLineStyle::Solid,
                30,
            )
        );

        CanvasDbService::delete_edge(
            &connection,
            DeleteCanvasEdgeInput {
                id: EDGE_ID.into(),
                deleted_at_ms: 50,
                updated_at_ms: 50,
            },
        )
        .unwrap();
        let hierarchy = CanvasDbService::update_edge_relation_type(
            &connection,
            UpdateCanvasEdgeRelationTypeInput {
                id: default_id.into(),
                relation_type: "hierarchy".into(),
                direction: CanvasEdgeDirection::Forward,
                line_style: CanvasEdgeLineStyle::Solid,
                updated_at_ms: 60,
            },
        )
        .unwrap();
        assert_eq!(hierarchy.relation_type, "hierarchy");
        let peer = CanvasDbService::update_edge_relation_type(
            &connection,
            UpdateCanvasEdgeRelationTypeInput {
                id: default_id.into(),
                relation_type: "peer".into(),
                direction: CanvasEdgeDirection::None,
                line_style: CanvasEdgeLineStyle::Solid,
                updated_at_ms: 70,
            },
        )
        .unwrap();
        assert_eq!(
            (peer.relation_type.as_str(), peer.direction, peer.line_style,),
            (
                "peer",
                CanvasEdgeDirection::None,
                CanvasEdgeLineStyle::Solid,
            )
        );

        let unknown_id = "00000000-0000-4000-8000-000000000606";
        connection
            .execute(
                "INSERT INTO canvas_edges(
                    id, canvas_id, source_node_id, target_node_id, relation_type,
                    direction, line_style, created_at_ms, updated_at_ms, deleted_at_ms
                 ) VALUES(?1, ?2, ?3, ?4, 'future_relation', 'bidirectional', 'dotted', 80, 80, NULL)",
                params![unknown_id, CANVAS_ID, NODE_ID, TARGET_NODE_ID],
            )
            .unwrap();
        let unknown = CanvasDbService::get_active_edge(&connection, unknown_id).unwrap();
        assert_eq!(unknown.relation_type, "future_relation");
        assert_eq!(unknown.direction, CanvasEdgeDirection::Bidirectional);
        assert_eq!(unknown.line_style, CanvasEdgeLineStyle::Dotted);
        assert_eq!(
            CanvasDbService::update_edge_relation_type(
                &connection,
                UpdateCanvasEdgeRelationTypeInput {
                    id: unknown_id.into(),
                    relation_type: "peer".into(),
                    direction: CanvasEdgeDirection::None,
                    line_style: CanvasEdgeLineStyle::Solid,
                    updated_at_ms: 90,
                },
            ),
            Err(CanvasError::PersistenceFailed)
        );

        drop(connection);
        let reopened = open_existing_configured_connection(database_path).unwrap();
        let edges = CanvasDbService::list_edges(&reopened, CANVAS_ID).unwrap();
        assert!(edges.iter().any(|edge| {
            edge.id == default_id
                && edge.relation_type == "peer"
                && edge.direction == CanvasEdgeDirection::None
                && edge.line_style == CanvasEdgeLineStyle::Solid
        }));
        assert!(edges.iter().any(|edge| {
            edge.id == unknown_id
                && edge.relation_type == "future_relation"
                && edge.direction == CanvasEdgeDirection::Bidirectional
                && edge.line_style == CanvasEdgeLineStyle::Dotted
        }));
    }
}
