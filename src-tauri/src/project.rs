use rusqlite::{params, Connection, OptionalExtension, Row};
use thiserror::Error;
use uuid::Uuid;

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ProjectRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct CreateProjectInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at_ms: i64,
}

pub(crate) struct RenameProjectInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum ProjectError {
    #[error("project not found")]
    NotFound,
    #[error("project persistence failed")]
    PersistenceFailed,
}

impl ProjectError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::PersistenceFailed => "PERSISTENCE_FAILED",
        }
    }
    pub(crate) const fn safe_message(self) -> &'static str {
        match self {
            Self::NotFound => "Project not found.",
            Self::PersistenceFailed => "Project persistence operation failed.",
        }
    }
}

fn validate_id(id: &str) -> Result<(), ProjectError> {
    let parsed = Uuid::parse_str(id).map_err(|_| ProjectError::PersistenceFailed)?;
    if parsed.hyphenated().to_string() == id {
        Ok(())
    } else {
        Err(ProjectError::PersistenceFailed)
    }
}
fn validate_name(name: &str) -> Result<(), ProjectError> {
    if name.trim().is_empty() {
        Err(ProjectError::PersistenceFailed)
    } else {
        Ok(())
    }
}
fn validate_timestamp(value: i64) -> Result<(), ProjectError> {
    if (0..=MAX_SAFE_INTEGER_MILLISECONDS).contains(&value) {
        Ok(())
    } else {
        Err(ProjectError::PersistenceFailed)
    }
}
fn from_row(row: &Row<'_>) -> rusqlite::Result<ProjectRecord> {
    Ok(ProjectRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at_ms: row.get(2)?,
        updated_at_ms: row.get(3)?,
    })
}
fn validate_record(project: ProjectRecord) -> Result<ProjectRecord, ProjectError> {
    validate_id(&project.id)?;
    validate_name(&project.name)?;
    validate_timestamp(project.created_at_ms)?;
    validate_timestamp(project.updated_at_ms)?;
    if project.updated_at_ms < project.created_at_ms {
        return Err(ProjectError::PersistenceFailed);
    }
    Ok(project)
}

pub(crate) struct ProjectDbService;
impl ProjectDbService {
    pub(crate) fn create(
        conn: &Connection,
        input: CreateProjectInput,
    ) -> Result<ProjectRecord, ProjectError> {
        validate_id(&input.id)?;
        validate_name(&input.name)?;
        validate_timestamp(input.created_at_ms)?;
        conn.query_row(
            "INSERT INTO projects(id, name, created_at_ms, updated_at_ms) VALUES(?1, ?2, ?3, ?3) RETURNING id, name, created_at_ms, updated_at_ms",
            params![input.id, input.name, input.created_at_ms], from_row,
        ).map_err(|_| ProjectError::PersistenceFailed).and_then(validate_record)
    }
    pub(crate) fn list(conn: &Connection) -> Result<Vec<ProjectRecord>, ProjectError> {
        let mut statement = conn.prepare("SELECT id, name, created_at_ms, updated_at_ms FROM projects ORDER BY updated_at_ms DESC, id ASC").map_err(|_| ProjectError::PersistenceFailed)?;
        let rows = statement
            .query_map([], from_row)
            .map_err(|_| ProjectError::PersistenceFailed)?;
        rows.map(|row| {
            row.map_err(|_| ProjectError::PersistenceFailed)
                .and_then(validate_record)
        })
        .collect()
    }
    pub(crate) fn rename(
        conn: &Connection,
        input: RenameProjectInput,
    ) -> Result<ProjectRecord, ProjectError> {
        validate_id(&input.id)?;
        validate_name(&input.name)?;
        validate_timestamp(input.updated_at_ms)?;
        conn.query_row(
            "UPDATE projects SET name = ?1, updated_at_ms = ?2 WHERE id = ?3 RETURNING id, name, created_at_ms, updated_at_ms",
            params![input.name, input.updated_at_ms, input.id], from_row,
        ).optional().map_err(|_| ProjectError::PersistenceFailed)?.ok_or(ProjectError::NotFound).and_then(validate_record)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(include_str!("../migrations/0001_create_tasks.sql"))
            .unwrap();
        connection
            .execute_batch(include_str!(
                "../migrations/0002_add_task_planning_fields.sql"
            ))
            .unwrap();
        connection
            .execute_batch(include_str!("../migrations/0003_add_task_projects.sql"))
            .unwrap();
        connection
    }

    #[test]
    fn project_create_list_and_rename_are_capability_specific() {
        let connection = connection();
        let id = "123e4567-e89b-12d3-a456-426614174000";
        ProjectDbService::create(
            &connection,
            CreateProjectInput {
                id: id.into(),
                name: "Work".into(),
                created_at_ms: 10,
            },
        )
        .unwrap();
        assert_eq!(ProjectDbService::list(&connection).unwrap().len(), 1);
        let renamed = ProjectDbService::rename(
            &connection,
            RenameProjectInput {
                id: id.into(),
                name: "工作".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "工作");
    }

    #[test]
    fn project_rejects_blank_name_and_missing_rename() {
        let connection = connection();
        assert_eq!(
            ProjectDbService::create(
                &connection,
                CreateProjectInput {
                    id: "123e4567-e89b-12d3-a456-426614174000".into(),
                    name: "  ".into(),
                    created_at_ms: 10
                }
            )
            .unwrap_err(),
            ProjectError::PersistenceFailed
        );
        assert_eq!(
            ProjectDbService::rename(
                &connection,
                RenameProjectInput {
                    id: "123e4567-e89b-12d3-a456-426614174000".into(),
                    name: "Work".into(),
                    updated_at_ms: 20
                }
            )
            .unwrap_err(),
            ProjectError::NotFound
        );
    }
}
