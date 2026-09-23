use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NoteRecord {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
    /// Archive V1 (P5C-S1). Orthogonal to `deleted_at_ms`; preserved by
    /// canonical Trash restore so an archived note returns to the archived state.
    pub archived_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoteError {
    NotFound,
    PersistenceError,
}

impl NoteError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            NoteError::NotFound => "NOT_FOUND",
            NoteError::PersistenceError => "PERSISTENCE_ERROR",
        }
    }

    pub(crate) fn safe_message(self) -> &'static str {
        match self {
            NoteError::NotFound => "Note not found.",
            NoteError::PersistenceError => "Unable to persist the note change.",
        }
    }
}

fn persistence_error() -> NoteError {
    NoteError::PersistenceError
}

fn validate_id(id: &str) -> Result<(), NoteError> {
    let parsed = Uuid::parse_str(id).map_err(|_| persistence_error())?;
    if parsed.hyphenated().to_string() == id {
        Ok(())
    } else {
        Err(persistence_error())
    }
}

fn validate_timestamp(value: i64) -> Result<(), NoteError> {
    if (0..=MAX_SAFE_INTEGER_MILLISECONDS).contains(&value) {
        Ok(())
    } else {
        Err(persistence_error())
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreateNoteInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdateNoteInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SoftDeleteNoteInput {
    pub id: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestoreNoteInput {
    pub id: String,
    pub updated_at_ms: i64,
}

/// Archive V1 (P5C-S1): Active -> Archived.
pub(crate) struct ArchiveNoteInput {
    pub id: String,
    pub updated_at_ms: i64,
}

/// Archive V1 (P5C-S1): Archived -> Active.
pub(crate) struct UnarchiveNoteInput {
    pub id: String,
    pub updated_at_ms: i64,
}

pub struct NoteDbService;

impl NoteDbService {
    pub fn create(
        connection: &Connection,
        input: CreateNoteInput,
    ) -> Result<NoteRecord, NoteError> {
        if input.id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(&input.id)?;
        validate_timestamp(input.created_at_ms)?;

        let note = NoteRecord {
            id: input.id,
            title: input.title,
            content: input.content,
            created_at_ms: input.created_at_ms,
            updated_at_ms: input.created_at_ms,
            deleted_at_ms: None,
            archived_at_ms: None,
        };
        validate_note_record(&note)?;
        Self::persist_create(connection, &note)?;
        Ok(note)
    }

    pub fn get_active_by_id(connection: &Connection, id: &str) -> Result<Option<NoteRecord>, NoteError> {
        if id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(id)?;

        let record = connection
            .query_row(
                "SELECT id, title, content, created_at_ms, updated_at_ms, deleted_at_ms, \
                 archived_at_ms \
                 FROM notes WHERE id = ?1 AND deleted_at_ms IS NULL \
                   AND archived_at_ms IS NULL",
                params![id],
                |row| {
                    let deleted_at_ms: Option<i64> = row.get(5)?;
                    let archived_at_ms: Option<i64> = row.get(6)?;
                    Ok(NoteRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content: row.get(2)?,
                        created_at_ms: row.get(3)?,
                        updated_at_ms: row.get(4)?,
                        deleted_at_ms,
                        archived_at_ms,
                    })
                },
            )
            .optional()
            .map_err(|_| persistence_error())?;
        Ok(record)
    }

    pub fn list_active(connection: &Connection) -> Result<Vec<NoteRecord>, NoteError> {
        let mut rows = connection
            .prepare(
                "SELECT id, title, content, created_at_ms, updated_at_ms, deleted_at_ms, \
                 archived_at_ms \
                 FROM notes WHERE deleted_at_ms IS NULL AND archived_at_ms IS NULL \
                 ORDER BY updated_at_ms DESC, id ASC",
            )
            .map_err(|_| persistence_error())?;

        let record_iter = rows
            .query_map([], |row| {
                let deleted_at_ms: Option<i64> = row.get(5)?;
                let archived_at_ms: Option<i64> = row.get(6)?;
                Ok(NoteRecord {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    content: row.get(2)?,
                    created_at_ms: row.get(3)?,
                    updated_at_ms: row.get(4)?,
                    deleted_at_ms,
                    archived_at_ms,
                })
            })
            .map_err(|_| persistence_error())?;

        let mut records = Vec::new();
        for record in record_iter {
            let note = record.map_err(|_| persistence_error())?;
            validate_note_record(&note)?;
            records.push(note);
        }
        Ok(records)
    }

    pub fn update_note(
        connection: &Connection,
        input: UpdateNoteInput,
    ) -> Result<NoteRecord, NoteError> {
        if input.id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let record = connection
            .query_row(
                "UPDATE notes SET title = ?2, content = ?3, updated_at_ms = ?4 \
                 WHERE id = ?1 AND deleted_at_ms IS NULL AND archived_at_ms IS NULL \
                 RETURNING id, title, content, created_at_ms, updated_at_ms, deleted_at_ms, \
                           archived_at_ms",
                params![input.id, input.title, input.content, input.updated_at_ms],
                |row| {
                    let deleted_at_ms: Option<i64> = row.get(5)?;
                    let archived_at_ms: Option<i64> = row.get(6)?;
                    Ok(NoteRecord {
                        id: row.get(0)?,
                        title: row.get(1)?,
                        content: row.get(2)?,
                        created_at_ms: row.get(3)?,
                        updated_at_ms: row.get(4)?,
                        deleted_at_ms,
                        archived_at_ms,
                    })
                },
            )
            .optional()
            .map_err(|_| persistence_error())?
            .ok_or(NoteError::NotFound)?;
        validate_note_record(&record)?;
        Ok(record)
    }

    pub fn soft_delete(
        connection: &Connection,
        input: SoftDeleteNoteInput,
    ) -> Result<(), NoteError> {
        if input.id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let result = connection.execute(
            "UPDATE notes SET deleted_at_ms = ?2, updated_at_ms = ?3 \
             WHERE id = ?1 AND deleted_at_ms IS NULL",
            params![input.id, input.updated_at_ms, input.updated_at_ms],
        );

        let affected = match result {
            Ok(affected) => affected,
            Err(_) => return Err(persistence_error()),
        };
        if affected == 0 {
            return Err(NoteError::NotFound);
        }
        Ok(())
    }

    pub fn restore(
        connection: &Connection,
        input: RestoreNoteInput,
    ) -> Result<(), NoteError> {
        if input.id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let result = connection.execute(
            "UPDATE notes SET deleted_at_ms = NULL, updated_at_ms = ?2 \
             WHERE id = ?1 AND deleted_at_ms IS NOT NULL",
            params![input.id, input.updated_at_ms],
        );

        let affected = match result {
            Ok(affected) => affected,
            Err(_) => return Err(persistence_error()),
        };
        if affected == 0 {
            return Err(NoteError::NotFound);
        }
        Ok(())
    }

    /// Archive V1 (P5C-S1): Active -> Archived.
    ///
    /// Target precondition is the ACTIVE state
    /// (`deleted_at_ms IS NULL AND archived_at_ms IS NULL`); a deleted or
    /// already archived note fails closed with NOT_FOUND. Title and content are
    /// never touched, so no trimming / normalization can occur here.
    pub fn archive(
        connection: &Connection,
        input: ArchiveNoteInput,
    ) -> Result<(), NoteError> {
        if input.id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let result = connection.execute(
            "UPDATE notes SET archived_at_ms = ?2, updated_at_ms = ?3 \
             WHERE id = ?1 AND deleted_at_ms IS NULL AND archived_at_ms IS NULL",
            params![input.id, input.updated_at_ms, input.updated_at_ms],
        );

        let affected = match result {
            Ok(affected) => affected,
            Err(_) => return Err(persistence_error()),
        };
        if affected == 0 {
            return Err(NoteError::NotFound);
        }
        Ok(())
    }

    /// Archive V1 (P5C-S1): Archived -> Active.
    ///
    /// Target precondition is the ARCHIVED state
    /// (`deleted_at_ms IS NULL AND archived_at_ms IS NOT NULL`); a deleted or
    /// already active note fails closed with NOT_FOUND.
    pub fn unarchive(
        connection: &Connection,
        input: UnarchiveNoteInput,
    ) -> Result<(), NoteError> {
        if input.id.is_empty() {
            return Err(persistence_error());
        }
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let result = connection.execute(
            "UPDATE notes SET archived_at_ms = NULL, updated_at_ms = ?2 \
             WHERE id = ?1 AND deleted_at_ms IS NULL AND archived_at_ms IS NOT NULL",
            params![input.id, input.updated_at_ms],
        );

        let affected = match result {
            Ok(affected) => affected,
            Err(_) => return Err(persistence_error()),
        };
        if affected == 0 {
            return Err(NoteError::NotFound);
        }
        Ok(())
    }

    fn persist_create(connection: &Connection, note: &NoteRecord) -> Result<(), NoteError> {
        connection
            .execute(
                "INSERT INTO notes (id, title, content, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
                params![
                    note.id,
                    note.title,
                    note.content,
                    note.created_at_ms,
                    note.updated_at_ms,
                    note.deleted_at_ms
                ],
            )
            .map(|_| ())
            .map_err(|_| persistence_error())
    }
}

fn validate_note_record(note: &NoteRecord) -> Result<(), NoteError> {
    validate_id(&note.id)?;
    validate_timestamp(note.created_at_ms)?;
    validate_timestamp(note.updated_at_ms)?;
    if let Some(deleted_at_ms) = note.deleted_at_ms {
        validate_timestamp(deleted_at_ms)?;
    }
    if let Some(archived_at_ms) = note.archived_at_ms {
        validate_timestamp(archived_at_ms)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};

    const TEST_MIGRATION_SQL: &str = r#"
        CREATE TABLE notes (
            id            TEXT    NOT NULL PRIMARY KEY,
            title         TEXT    NOT NULL,
            content       TEXT    NOT NULL,
            created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
            updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0),
            deleted_at_ms INTEGER          CHECK (deleted_at_ms IS NULL OR deleted_at_ms >= 0),
            archived_at_ms INTEGER         CHECK (archived_at_ms IS NULL OR archived_at_ms >= 0)
        );
        CREATE INDEX idx_notes_updated_at ON notes(updated_at_ms DESC, id ASC);
    "#;

    fn id_for(index: u32) -> String {
        format!("00000000-0000-0000-0000-{index:012x}")
    }

    fn new_db() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch(TEST_MIGRATION_SQL).unwrap();
        connection
    }

    #[test]
    fn create_inserts_active_note_with_updated_at_equal_to_created_at() {
        let connection = new_db();
        let note = NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: "00000000-0000-0000-0000-000000000001".to_string(),
                title: "Hello world".to_string(),
                content: "body text".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();

        assert_eq!(
            note,
            NoteRecord {
                id: "00000000-0000-0000-0000-000000000001".to_string(),
                title: "Hello world".to_string(),
                content: "body text".to_string(),
                created_at_ms: 1_700_000_000_000,
                updated_at_ms: 1_700_000_000_000,
                deleted_at_ms: None,
                archived_at_ms: None,
            }
        );

        let raw: Value = serde_json::to_value(&note).unwrap();
        assert_eq!(raw.get("deletedAtMs"), Some(&Value::Null));
        assert_eq!(
            raw.get("archivedAtMs"),
            Some(&Value::Null),
            "新建 note 必须是 ACTIVE（archivedAtMs = null）"
        );
        assert_eq!(
            raw.get("createdAtMs").and_then(Value::as_i64),
            Some(1_700_000_000_000)
        );
        assert_eq!(
            raw.get("updatedAtMs").and_then(Value::as_i64),
            Some(1_700_000_000_000)
        );
    }

    #[test]
    fn create_accepts_empty_and_whitespace_title_and_content() {
        let connection = new_db();

        let empty = NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: "00000000-0000-0000-0000-000000000002".to_string(),
                title: String::new(),
                content: String::new(),
                created_at_ms: 1_700_000_000_001,
            },
        )
        .unwrap();
        assert_eq!(empty.title, "");
        assert_eq!(empty.content, "");

        let whitespace = NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: "00000000-0000-0000-0000-000000000003".to_string(),
                title: "   ".to_string(),
                content: "   ".to_string(),
                created_at_ms: 1_700_000_000_002,
            },
        )
        .unwrap();
        assert_eq!(whitespace.title, "   ");
        assert_eq!(whitespace.content, "   ");
    }

    #[test]
    fn get_active_by_id_returns_none_for_missing_and_deleted_ids() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        let missing = NoteDbService::get_active_by_id(&connection, id).unwrap();
        assert!(missing.is_none());

        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "a".to_string(),
                content: "b".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();
        let present = NoteDbService::get_active_by_id(&connection, id).unwrap().unwrap();
        assert_eq!(present.id, id);

        NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_500,
            },
        )
        .unwrap();
        let after_delete = NoteDbService::get_active_by_id(&connection, id).unwrap();
        assert!(after_delete.is_none());
    }

    #[test]
    fn list_active_orders_by_updated_at_desc_and_id_asc_excluding_deleted() {
        let connection = new_db();
        let ids: Vec<String> = (0x1001..=0x1004).map(|n| id_for(n)).collect();
        let timestamps: [i64; 4] = [
            1_700_000_000_100,
            1_700_000_000_200,
            1_700_000_000_300,
            1_700_000_000_400,
        ];
        for (idx, ts) in timestamps.iter().enumerate() {
            NoteDbService::create(
                &connection,
                CreateNoteInput {
                    id: ids[idx].clone(),
                    title: "n".to_string(),
                    content: "x".to_string(),
                    created_at_ms: *ts,
                },
            )
            .unwrap();
        }

        NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: ids[1].clone(),
                updated_at_ms: 1_700_000_000_999,
            },
        )
        .unwrap();

        NoteDbService::update_note(
            &connection,
            UpdateNoteInput {
                id: ids[0].clone(),
                title: "renamed".to_string(),
                content: "renamed".to_string(),
                updated_at_ms: 1_700_000_000_750,
            },
        )
        .unwrap();

        let list = NoteDbService::list_active(&connection).unwrap();
        assert_eq!(list.len(), 3);
        let returned_ids: Vec<String> = list.iter().map(|n| n.id.clone()).collect();
        let expected_ids: Vec<String> = vec![ids[0].clone(), ids[3].clone(), ids[2].clone()];
        assert_eq!(returned_ids, expected_ids);
    }

    #[test]
    fn update_note_requires_active_row_and_returns_updated_record() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "before".to_string(),
                content: "before".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();

        let updated = NoteDbService::update_note(
            &connection,
            UpdateNoteInput {
                id: id.to_string(),
                title: "after".to_string(),
                content: "after".to_string(),
                updated_at_ms: 1_700_000_000_200,
            },
        )
        .unwrap();
        assert_eq!(updated.title, "after");
        assert_eq!(updated.content, "after");
        assert_eq!(updated.created_at_ms, 1_700_000_000_000);
        assert_eq!(updated.updated_at_ms, 1_700_000_000_200);
        assert_eq!(updated.deleted_at_ms, None);

        let missing: Result<_, _> = NoteDbService::update_note(
            &connection,
            UpdateNoteInput {
                id: "00000000-0000-0000-0000-000000000009".to_string(),
                title: "missing".to_string(),
                content: "missing".to_string(),
                updated_at_ms: 1_700_000_000_300,
            },
        );
        assert_eq!(missing.unwrap_err(), NoteError::NotFound);
    }

    #[test]
    fn soft_delete_and_restore_are_symmetric() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "soft".to_string(),
                content: "soft".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();

        NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_100,
            },
        )
        .unwrap();

        assert!(NoteDbService::get_active_by_id(&connection, id)
            .unwrap()
            .is_none());

        let row: (Option<i64>, i64) = connection
            .query_row(
                "SELECT deleted_at_ms, updated_at_ms FROM notes WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (Some(1_700_000_000_100), 1_700_000_000_100));

        let again = NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_150,
            },
        );
        assert_eq!(again.unwrap_err(), NoteError::NotFound);

        NoteDbService::restore(
            &connection,
            RestoreNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_200,
            },
        )
        .unwrap();

        let restored = NoteDbService::get_active_by_id(&connection, id).unwrap().unwrap();
        assert_eq!(restored.deleted_at_ms, None);
        assert_eq!(restored.updated_at_ms, 1_700_000_000_200);

        let again = NoteDbService::restore(
            &connection,
            RestoreNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_250,
            },
        );
        assert_eq!(again.unwrap_err(), NoteError::NotFound);
    }

    #[test]
    fn archive_and_unarchive_move_note_between_archived_and_active_workspace() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        let content = "  raw  content\n\nwith spacing\n";
        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "  Keep me  ".to_string(),
                content: content.to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();

        NoteDbService::archive(
            &connection,
            ArchiveNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_100,
            },
        )
        .unwrap();

        assert!(NoteDbService::get_active_by_id(&connection, id)
            .unwrap()
            .is_none());
        assert!(NoteDbService::list_active(&connection).unwrap().is_empty());

        // active-only 写入必须 fail closed
        assert_eq!(
            NoteDbService::update_note(
                &connection,
                UpdateNoteInput {
                    id: id.to_string(),
                    title: "changed".to_string(),
                    content: "changed".to_string(),
                    updated_at_ms: 1_700_000_000_150,
                },
            )
            .unwrap_err(),
            NoteError::NotFound
        );
        assert_eq!(
            NoteDbService::archive(
                &connection,
                ArchiveNoteInput {
                    id: id.to_string(),
                    updated_at_ms: 1_700_000_000_150,
                },
            )
            .unwrap_err(),
            NoteError::NotFound,
            "重复归档必须 fail closed"
        );

        NoteDbService::unarchive(
            &connection,
            UnarchiveNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_200,
            },
        )
        .unwrap();

        let unarchived = NoteDbService::get_active_by_id(&connection, id).unwrap().unwrap();
        assert_eq!(unarchived.archived_at_ms, None);
        assert_eq!(unarchived.deleted_at_ms, None);
        assert_eq!(unarchived.updated_at_ms, 1_700_000_000_200);
        assert_eq!(unarchived.title, "  Keep me  ", "title 不得被 trim");
        assert_eq!(unarchived.content, content, "content 不得被规范化");

        assert_eq!(
            NoteDbService::unarchive(
                &connection,
                UnarchiveNoteInput {
                    id: id.to_string(),
                    updated_at_ms: 1_700_000_000_250,
                },
            )
            .unwrap_err(),
            NoteError::NotFound,
            "对 active 行取消归档必须 fail closed"
        );
    }

    #[test]
    fn archive_state_survives_note_trash_restore_round_trip() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "round".to_string(),
                content: "round".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();

        NoteDbService::archive(
            &connection,
            ArchiveNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_100,
            },
        )
        .unwrap();

        // Archived -> Trash：保留 archived_at_ms
        NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_200,
            },
        )
        .unwrap();
        let row: (Option<i64>, Option<i64>) = connection
            .query_row(
                "SELECT deleted_at_ms, archived_at_ms FROM notes WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (Some(1_700_000_000_200), Some(1_700_000_000_100)));

        // Trash -> Restore：清 deleted_at_ms，保留 archived_at_ms
        NoteDbService::restore(
            &connection,
            RestoreNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_300,
            },
        )
        .unwrap();
        assert!(
            NoteDbService::get_active_by_id(&connection, id)
                .unwrap()
                .is_none(),
            "恢复后仍是 ARCHIVED，不得出现在 active 读"
        );
        let row: (Option<i64>, Option<i64>) = connection
            .query_row(
                "SELECT deleted_at_ms, archived_at_ms FROM notes WHERE id = ?1",
                params![id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(row, (None, Some(1_700_000_000_100)));

        NoteDbService::unarchive(
            &connection,
            UnarchiveNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_400,
            },
        )
        .unwrap();
        let active = NoteDbService::get_active_by_id(&connection, id).unwrap().unwrap();
        assert_eq!(active.archived_at_ms, None);
        assert_eq!(active.deleted_at_ms, None);
    }

    #[test]
    fn archive_and_unarchive_fail_closed_for_deleted_notes() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "deleted".to_string(),
                content: "deleted".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();
        NoteDbService::archive(
            &connection,
            ArchiveNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_100,
            },
        )
        .unwrap();
        NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_200,
            },
        )
        .unwrap();

        assert_eq!(
            NoteDbService::archive(
                &connection,
                ArchiveNoteInput {
                    id: id.to_string(),
                    updated_at_ms: 1_700_000_000_300,
                },
            )
            .unwrap_err(),
            NoteError::NotFound,
            "对已删除 note 归档必须 fail closed，不得隐式恢复"
        );
        assert_eq!(
            NoteDbService::unarchive(
                &connection,
                UnarchiveNoteInput {
                    id: id.to_string(),
                    updated_at_ms: 1_700_000_000_300,
                },
            )
            .unwrap_err(),
            NoteError::NotFound
        );

        let missing = NoteDbService::archive(
            &connection,
            ArchiveNoteInput {
                id: "00000000-0000-0000-0000-000000000099".to_string(),
                updated_at_ms: 1_700_000_000_300,
            },
        );
        assert_eq!(missing.unwrap_err(), NoteError::NotFound);
    }

    #[test]
    fn update_and_soft_delete_reject_deleted_rows() {
        let connection = new_db();
        let id = "00000000-0000-0000-0000-000000000001";
        NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: id.to_string(),
                title: "d".to_string(),
                content: "d".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();
        NoteDbService::soft_delete(
            &connection,
            SoftDeleteNoteInput {
                id: id.to_string(),
                updated_at_ms: 1_700_000_000_100,
            },
        )
        .unwrap();

        let update = NoteDbService::update_note(
            &connection,
            UpdateNoteInput {
                id: id.to_string(),
                title: "nope".to_string(),
                content: "nope".to_string(),
                updated_at_ms: 1_700_000_000_200,
            },
        );
        assert_eq!(update.unwrap_err(), NoteError::NotFound);
    }

    #[test]
    fn note_error_codes_and_safe_messages_are_frozen() {
        assert_eq!(NoteError::NotFound.code(), "NOT_FOUND");
        assert_eq!(NoteError::PersistenceError.code(), "PERSISTENCE_ERROR");
        assert_eq!(NoteError::NotFound.safe_message(), "Note not found.");
        assert_eq!(
            NoteError::PersistenceError.safe_message(),
            "Unable to persist the note change."
        );
    }

    #[test]
    fn note_record_serialization_is_camel_case_and_matches_js_contract() {
        let note = NoteRecord {
            id: "00000000-0000-0000-0000-000000000001".to_string(),
            title: "t".to_string(),
            content: "c".to_string(),
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_100,
            deleted_at_ms: None,
            archived_at_ms: None,
        };
        let raw: Value = serde_json::to_value(&note).unwrap();
        assert_eq!(
            raw,
            json!({
                "id": "00000000-0000-0000-0000-000000000001",
                "title": "t",
                "content": "c",
                "createdAtMs": 1_700_000_000_000i64,
                "updatedAtMs": 1_700_000_000_100i64,
                "deletedAtMs": Value::Null,
                "archivedAtMs": Value::Null,
            })
        );

        let tombstoned = NoteRecord {
            deleted_at_ms: Some(1_700_000_000_900),
            archived_at_ms: Some(1_700_000_000_800),
            ..note
        };
        let raw: Value = serde_json::to_value(&tombstoned).unwrap();
        assert_eq!(
            raw.get("deletedAtMs").and_then(Value::as_i64),
            Some(1_700_000_000_900)
        );
        assert_eq!(
            raw.get("archivedAtMs").and_then(Value::as_i64),
            Some(1_700_000_000_800)
        );
    }

    #[test]
    fn validation_rejects_bad_ids_and_bad_timestamps() {
        let connection = new_db();
        let bad_id = NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: "not-a-uuid".to_string(),
                title: "t".to_string(),
                content: "c".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        );
        assert_eq!(bad_id.unwrap_err(), NoteError::PersistenceError);

        let bad_ts = NoteDbService::create(
            &connection,
            CreateNoteInput {
                id: "00000000-0000-0000-0000-000000000001".to_string(),
                title: "t".to_string(),
                content: "c".to_string(),
                created_at_ms: -1,
            },
        );
        assert_eq!(bad_ts.unwrap_err(), NoteError::PersistenceError);

        let get_bad = NoteDbService::get_active_by_id(&connection, "not-a-uuid");
        assert_eq!(get_bad.unwrap_err(), NoteError::PersistenceError);

        let empty_id = NoteDbService::get_active_by_id(&connection, "");
        assert_eq!(empty_id.unwrap_err(), NoteError::PersistenceError);

        let bad_update_ts = NoteDbService::update_note(
            &connection,
            UpdateNoteInput {
                id: "00000000-0000-0000-0000-000000000001".to_string(),
                title: "t".to_string(),
                content: "c".to_string(),
                updated_at_ms: -1,
            },
        );
        assert_eq!(bad_update_ts.unwrap_err(), NoteError::PersistenceError);
    }
}
