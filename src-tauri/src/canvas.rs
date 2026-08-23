//! Canvas Core Slice 1 native persistence.

use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;
use uuid::Uuid;

use crate::bootstrap::{BootstrapService, BootstrapState};
use crate::db::policy::open_existing_configured_connection;
use crate::storage::{DataRootService, InitMode};

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;
const CANVAS_COLUMNS: &str = "id, title, viewport_json, created_at_ms, updated_at_ms";
const NODE_COLUMNS: &str = "id, canvas_id, type, content_json, x, y, created_at_ms, updated_at_ms";

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

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type")]
pub(crate) enum CanvasNodeContent {
    #[serde(rename = "text")]
    Text { text: String },
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct CanvasNodeRecord {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) node_type: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
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

pub(crate) struct CreateTextNodeInput {
    pub(crate) id: String,
    pub(crate) canvas_id: String,
    pub(crate) content: CanvasNodeContent,
    pub(crate) x: f64,
    pub(crate) y: f64,
    pub(crate) created_at_ms: i64,
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum CanvasError {
    #[error("canvas resource not found")]
    NotFound,
    #[error("canvas persistence unavailable")]
    PersistenceUnavailable,
    #[error("canvas persistence failed")]
    PersistenceFailed,
}

impl CanvasError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::PersistenceUnavailable => "PERSISTENCE_UNAVAILABLE",
            Self::PersistenceFailed => "PERSISTENCE_FAILED",
        }
    }

    pub(crate) const fn safe_message(self) -> &'static str {
        match self {
            Self::NotFound => "Canvas resource not found.",
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

fn parse_content(source: &str) -> Result<CanvasNodeContent, CanvasError> {
    let value: Value = serde_json::from_str(source).map_err(|_| CanvasError::PersistenceFailed)?;
    let object = value.as_object().ok_or(CanvasError::PersistenceFailed)?;
    if object.len() != 2 || object.get("type") != Some(&Value::String("text".into())) {
        return Err(CanvasError::PersistenceFailed);
    }
    serde_json::from_value(value).map_err(|_| CanvasError::PersistenceFailed)
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
) -> rusqlite::Result<(String, String, String, String, f64, f64, i64, i64)> {
    Ok((
        row.get(0)?,
        row.get(1)?,
        row.get(2)?,
        row.get(3)?,
        row.get(4)?,
        row.get(5)?,
        row.get(6)?,
        row.get(7)?,
    ))
}

fn validate_node(
    raw: (String, String, String, String, f64, f64, i64, i64),
) -> Result<CanvasNodeRecord, CanvasError> {
    let (id, canvas_id, node_type, content_source, x, y, created_at_ms, updated_at_ms) = raw;
    validate_id(&id)?;
    validate_id(&canvas_id)?;
    validate_position(x, y)?;
    validate_timestamp(created_at_ms)?;
    validate_timestamp(updated_at_ms)?;
    if node_type != "text" || updated_at_ms < created_at_ms {
        return Err(CanvasError::PersistenceFailed);
    }
    Ok(CanvasNodeRecord {
        id,
        canvas_id,
        node_type,
        content: parse_content(&content_source)?,
        x,
        y,
        created_at_ms,
        updated_at_ms,
    })
}

pub(crate) struct CanvasDbService;

impl CanvasDbService {
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

    pub(crate) fn create_text_node(
        connection: &Connection,
        input: CreateTextNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_id(&input.canvas_id)?;
        validate_position(input.x, input.y)?;
        validate_timestamp(input.created_at_ms)?;
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
                 ) VALUES(?1, ?2, 'text', ?3, ?4, ?5, ?6, ?6)",
                params![
                    input.id,
                    input.canvas_id,
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

    pub(crate) fn update_text_node(
        connection: &Connection,
        input: UpdateTextNodeInput,
    ) -> Result<CanvasNodeRecord, CanvasError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;
        let content = content_json(&input.content)?;
        let changed = connection
            .execute(
                "UPDATE canvas_nodes SET content_json = ?1, updated_at_ms = ?2 \
                 WHERE id = ?3 AND type = 'text'",
                params![content, input.updated_at_ms, input.id],
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
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::db::definitions::MIGRATIONS;
    use crate::db::migration::MigrationRunner;
    use crate::db::policy::{open_configured_connection, open_existing_configured_connection};
    use crate::db::snapshot::SqliteBackupSnapshot;

    const CANVAS_ID: &str = "00000000-0000-4000-8000-000000000601";
    const NODE_ID: &str = "00000000-0000-4000-8000-000000000602";

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

    #[test]
    fn migration_six_adds_only_canvas_core_schema_and_contiguous_history() {
        let (_sandbox, _path, connection) = migrated_database();
        let history: Vec<(i64, String)> = connection
            .prepare("SELECT version, id FROM schema_migrations ORDER BY version")
            .unwrap()
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        assert_eq!(history.len(), 6);
        assert_eq!(history[5], (6, "0006_add_canvas_core".into()));
        for table in ["canvases", "canvas_nodes"] {
            let exists: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = ?1",
                    [table],
                    |row| row.get(0),
                )
                .unwrap();
            assert_eq!(exists, 1);
        }
        let edges: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name = 'canvas_edges'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(edges, 0);
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
    fn restart_preserves_canvas_text_position_and_viewport() {
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
        assert_eq!(
            nodes[0].content,
            CanvasNodeContent::Text {
                text: "Persisted".into()
            }
        );
        assert_eq!((nodes[0].x, nodes[0].y), (-40.0, 210.0));
    }
}
