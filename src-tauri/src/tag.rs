use rusqlite::{params, Connection, OptionalExtension, Row};
use thiserror::Error;
use uuid::Uuid;

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct TagRecord {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

pub(crate) struct CreateTagInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) created_at_ms: i64,
}

pub(crate) struct RenameTagInput {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) updated_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Error)]
pub(crate) enum TagError {
    #[error("tag not found")]
    NotFound,
    #[error("tag persistence failed")]
    PersistenceFailed,
}

impl TagError {
    pub(crate) const fn code(self) -> &'static str {
        match self {
            Self::NotFound => "NOT_FOUND",
            Self::PersistenceFailed => "PERSISTENCE_FAILED",
        }
    }

    pub(crate) const fn safe_message(self) -> &'static str {
        match self {
            Self::NotFound => "Tag not found.",
            Self::PersistenceFailed => "Tag persistence operation failed.",
        }
    }
}

fn validate_id(id: &str) -> Result<(), TagError> {
    let parsed = Uuid::parse_str(id).map_err(|_| TagError::PersistenceFailed)?;
    if parsed.hyphenated().to_string() == id {
        Ok(())
    } else {
        Err(TagError::PersistenceFailed)
    }
}

fn validate_name(name: &str) -> Result<(), TagError> {
    if name.trim().is_empty() || name.trim() != name {
        Err(TagError::PersistenceFailed)
    } else {
        Ok(())
    }
}

fn validate_timestamp(value: i64) -> Result<(), TagError> {
    if (0..=MAX_SAFE_INTEGER_MILLISECONDS).contains(&value) {
        Ok(())
    } else {
        Err(TagError::PersistenceFailed)
    }
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<TagRecord> {
    Ok(TagRecord {
        id: row.get(0)?,
        name: row.get(1)?,
        created_at_ms: row.get(2)?,
        updated_at_ms: row.get(3)?,
    })
}

fn validate_record(tag: TagRecord) -> Result<TagRecord, TagError> {
    validate_id(&tag.id)?;
    validate_name(&tag.name)?;
    validate_timestamp(tag.created_at_ms)?;
    validate_timestamp(tag.updated_at_ms)?;
    if tag.updated_at_ms < tag.created_at_ms {
        return Err(TagError::PersistenceFailed);
    }
    Ok(tag)
}

pub(crate) struct TagDbService;

impl TagDbService {
    pub(crate) fn create(conn: &Connection, input: CreateTagInput) -> Result<TagRecord, TagError> {
        validate_id(&input.id)?;
        validate_name(&input.name)?;
        validate_timestamp(input.created_at_ms)?;
        conn.query_row(
            "INSERT INTO tags(id, name, created_at_ms, updated_at_ms) \
             VALUES(?1, ?2, ?3, ?3) \
             RETURNING id, name, created_at_ms, updated_at_ms",
            params![input.id, input.name, input.created_at_ms],
            from_row,
        )
        .map_err(|_| TagError::PersistenceFailed)
        .and_then(validate_record)
    }

    pub(crate) fn list(conn: &Connection) -> Result<Vec<TagRecord>, TagError> {
        let mut statement = conn
            .prepare(
                "SELECT id, name, created_at_ms, updated_at_ms \
                 FROM tags ORDER BY updated_at_ms DESC, id ASC",
            )
            .map_err(|_| TagError::PersistenceFailed)?;
        let tags = statement
            .query_map([], from_row)
            .map_err(|_| TagError::PersistenceFailed)?
            .map(|row| {
                row.map_err(|_| TagError::PersistenceFailed)
                    .and_then(validate_record)
            })
            .collect();
        tags
    }

    pub(crate) fn rename(conn: &Connection, input: RenameTagInput) -> Result<TagRecord, TagError> {
        validate_id(&input.id)?;
        validate_name(&input.name)?;
        validate_timestamp(input.updated_at_ms)?;
        conn.query_row(
            "UPDATE tags SET name = ?1, updated_at_ms = ?2 WHERE id = ?3 \
             RETURNING id, name, created_at_ms, updated_at_ms",
            params![input.name, input.updated_at_ms, input.id],
            from_row,
        )
        .optional()
        .map_err(|_| TagError::PersistenceFailed)?
        .ok_or(TagError::NotFound)
        .and_then(validate_record)
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
            .execute_batch(include_str!("../migrations/0004_add_task_tags.sql"))
            .unwrap();
        connection
    }

    fn create_tag(conn: &Connection, id: &str, name: &str) -> Result<TagRecord, TagError> {
        TagDbService::create(
            conn,
            CreateTagInput {
                id: id.into(),
                name: name.into(),
                created_at_ms: 10,
            },
        )
    }

    #[test]
    fn tag_create_list_rename_and_case_sensitive_names() {
        let connection = connection();
        let upper = "00000000-0000-4000-8000-000000000101";
        let lower = "00000000-0000-4000-8000-000000000102";
        create_tag(&connection, upper, "Work").unwrap();
        create_tag(&connection, lower, "work").unwrap();
        assert_eq!(TagDbService::list(&connection).unwrap().len(), 2);

        let renamed = TagDbService::rename(
            &connection,
            RenameTagInput {
                id: lower.into(),
                name: "personal".into(),
                updated_at_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(renamed.name, "personal");
        assert_eq!(renamed.updated_at_ms, 20);
    }

    #[test]
    fn tag_rejects_blank_untrimmed_and_duplicate_exact_names() {
        let connection = connection();
        let first = "00000000-0000-4000-8000-000000000101";
        let second = "00000000-0000-4000-8000-000000000102";
        create_tag(&connection, first, "Work").unwrap();
        assert_eq!(
            create_tag(&connection, second, "Work").unwrap_err(),
            TagError::PersistenceFailed
        );
        assert_eq!(
            create_tag(&connection, second, "  ").unwrap_err(),
            TagError::PersistenceFailed
        );
        assert_eq!(
            create_tag(&connection, second, " Work ").unwrap_err(),
            TagError::PersistenceFailed
        );
    }
}
