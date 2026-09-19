use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use uuid::Uuid;

const MAX_SAFE_INTEGER_MILLISECONDS: i64 = 9_007_199_254_740_991;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct DiaryEntryRecord {
    pub id: String,
    pub title: String,
    pub content: String,
    pub diary_date: String,
    pub created_at_ms: i64,
    pub updated_at_ms: i64,
    pub deleted_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DiaryError {
    InvalidId,
    InvalidDiaryDate,
    NotFound,
    DiaryDateConflict,
    PersistenceError,
}

impl DiaryError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            DiaryError::InvalidId => "INVALID_ID",
            DiaryError::InvalidDiaryDate => "INVALID_DIARY_DATE",
            DiaryError::NotFound => "NOT_FOUND",
            DiaryError::DiaryDateConflict => "DIARY_DATE_CONFLICT",
            DiaryError::PersistenceError => "PERSISTENCE_ERROR",
        }
    }

    pub(crate) fn safe_message(self) -> &'static str {
        match self {
            DiaryError::InvalidId => "Invalid diary entry identifier.",
            DiaryError::InvalidDiaryDate => "Invalid diary date.",
            DiaryError::NotFound => "Diary entry not found.",
            DiaryError::DiaryDateConflict => "A diary entry already exists for this date.",
            DiaryError::PersistenceError => "Unable to persist the diary entry change.",
        }
    }
}

fn validate_id(id: &str) -> Result<(), DiaryError> {
    let parsed = Uuid::parse_str(id).map_err(|_| DiaryError::InvalidId)?;
    if parsed.hyphenated().to_string() == id {
        Ok(())
    } else {
        Err(DiaryError::InvalidId)
    }
}

fn validate_timestamp(value: i64) -> Result<(), DiaryError> {
    if (0..=MAX_SAFE_INTEGER_MILLISECONDS).contains(&value) {
        Ok(())
    } else {
        Err(DiaryError::PersistenceError)
    }
}

/// Canonical `YYYY-MM-DD` local calendar date. This is a format check only:
/// the Repository has no injected `today`, so future-date rejection is a
/// Service-layer business rule and is deliberately NOT applied here.
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

fn validate_diary_date(diary_date: &str) -> Result<(), DiaryError> {
    if is_valid_local_date(diary_date) {
        Ok(())
    } else {
        Err(DiaryError::InvalidDiaryDate)
    }
}

fn parse_diary_row(row: &Row<'_>) -> rusqlite::Result<DiaryEntryRecord> {
    Ok(DiaryEntryRecord {
        id: row.get(0)?,
        title: row.get(1)?,
        content: row.get(2)?,
        diary_date: row.get(3)?,
        created_at_ms: row.get(4)?,
        updated_at_ms: row.get(5)?,
        deleted_at_ms: row.get(6)?,
    })
}

fn validate_diary_record(record: &DiaryEntryRecord) -> Result<(), DiaryError> {
    validate_id(&record.id)?;
    validate_diary_date(&record.diary_date)?;
    validate_timestamp(record.created_at_ms)?;
    validate_timestamp(record.updated_at_ms)?;
    if let Some(deleted_at_ms) = record.deleted_at_ms {
        validate_timestamp(deleted_at_ms)?;
    }
    Ok(())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct CreateDiaryEntryInput {
    pub id: String,
    pub diary_date: String,
    pub title: String,
    pub content: String,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct UpdateDiaryEntryInput {
    pub id: String,
    pub title: String,
    pub content: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct ChangeDiaryDateInput {
    pub id: String,
    pub diary_date: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SoftDeleteDiaryEntryInput {
    pub id: String,
    pub updated_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestoreDiaryEntryInput {
    pub id: String,
    pub updated_at_ms: i64,
}

pub struct DiaryDbService;

impl DiaryDbService {
    /// Explicit active-date occupancy probe. `exclude_id` prevents an entry
    /// from conflicting with itself when its own date is the target.
    ///
    /// A `true` result means the diary-date partial unique index is known to
    /// be occupied. Any other integrity failure observed later during the
    /// write is unclassified and stays `PersistenceError`.
    fn active_date_occupied(
        connection: &Connection,
        diary_date: &str,
        exclude_id: Option<&str>,
    ) -> Result<bool, DiaryError> {
        match exclude_id {
            Some(id) => connection
                .query_row(
                    "SELECT EXISTS(\
                        SELECT 1 FROM diary_entries \
                        WHERE diary_date = ?1 AND deleted_at_ms IS NULL AND id <> ?2\
                     )",
                    params![diary_date, id],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| DiaryError::PersistenceError),
            None => connection
                .query_row(
                    "SELECT EXISTS(\
                        SELECT 1 FROM diary_entries \
                        WHERE diary_date = ?1 AND deleted_at_ms IS NULL\
                     )",
                    params![diary_date],
                    |row| row.get::<_, bool>(0),
                )
                .map_err(|_| DiaryError::PersistenceError),
        }
    }

    pub fn create(
        connection: &Connection,
        input: CreateDiaryEntryInput,
    ) -> Result<DiaryEntryRecord, DiaryError> {
        validate_id(&input.id)?;
        validate_diary_date(&input.diary_date)?;
        validate_timestamp(input.created_at_ms)?;

        let record = DiaryEntryRecord {
            id: input.id,
            title: input.title,
            content: input.content,
            diary_date: input.diary_date,
            created_at_ms: input.created_at_ms,
            updated_at_ms: input.created_at_ms,
            deleted_at_ms: None,
        };
        validate_diary_record(&record)?;

        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| DiaryError::PersistenceError)?;
        if Self::active_date_occupied(&transaction, &record.diary_date, None)? {
            return Err(DiaryError::DiaryDateConflict);
        }
        transaction
            .execute(
                "INSERT INTO diary_entries \
                 (id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    record.id,
                    record.title,
                    record.content,
                    record.diary_date,
                    record.created_at_ms,
                    record.updated_at_ms,
                    record.deleted_at_ms
                ],
            )
            .map_err(|_| DiaryError::PersistenceError)?;
        transaction
            .commit()
            .map_err(|_| DiaryError::PersistenceError)?;

        Ok(record)
    }

    pub fn get_active_by_id(
        connection: &Connection,
        id: &str,
    ) -> Result<Option<DiaryEntryRecord>, DiaryError> {
        validate_id(id)?;

        let record = connection
            .query_row(
                "SELECT id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms \
                 FROM diary_entries WHERE id = ?1 AND deleted_at_ms IS NULL",
                params![id],
                parse_diary_row,
            )
            .optional()
            .map_err(|_| DiaryError::PersistenceError)?;

        match record {
            Some(record) => {
                validate_diary_record(&record)?;
                Ok(Some(record))
            }
            None => Ok(None),
        }
    }

    pub fn get_active_by_diary_date(
        connection: &Connection,
        diary_date: &str,
    ) -> Result<Option<DiaryEntryRecord>, DiaryError> {
        validate_diary_date(diary_date)?;

        let record = connection
            .query_row(
                "SELECT id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms \
                 FROM diary_entries WHERE diary_date = ?1 AND deleted_at_ms IS NULL",
                params![diary_date],
                parse_diary_row,
            )
            .optional()
            .map_err(|_| DiaryError::PersistenceError)?;

        match record {
            Some(record) => {
                validate_diary_record(&record)?;
                Ok(Some(record))
            }
            None => Ok(None),
        }
    }

    pub fn list_active(connection: &Connection) -> Result<Vec<DiaryEntryRecord>, DiaryError> {
        let mut rows = connection
            .prepare(
                "SELECT id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms \
                 FROM diary_entries WHERE deleted_at_ms IS NULL \
                 ORDER BY diary_date DESC, updated_at_ms DESC, id ASC",
            )
            .map_err(|_| DiaryError::PersistenceError)?;

        let record_iter = rows
            .query_map([], parse_diary_row)
            .map_err(|_| DiaryError::PersistenceError)?;

        let mut records = Vec::new();
        for record in record_iter {
            let record = record.map_err(|_| DiaryError::PersistenceError)?;
            validate_diary_record(&record)?;
            records.push(record);
        }
        Ok(records)
    }

    pub fn update_diary_entry(
        connection: &Connection,
        input: UpdateDiaryEntryInput,
    ) -> Result<DiaryEntryRecord, DiaryError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let record = connection
            .query_row(
                "UPDATE diary_entries SET title = ?2, content = ?3, updated_at_ms = ?4 \
                 WHERE id = ?1 AND deleted_at_ms IS NULL \
                 RETURNING id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms",
                params![input.id, input.title, input.content, input.updated_at_ms],
                parse_diary_row,
            )
            .optional()
            .map_err(|_| DiaryError::PersistenceError)?
            .ok_or(DiaryError::NotFound)?;
        validate_diary_record(&record)?;
        Ok(record)
    }

    pub fn change_diary_date(
        connection: &Connection,
        input: ChangeDiaryDateInput,
    ) -> Result<DiaryEntryRecord, DiaryError> {
        validate_id(&input.id)?;
        validate_diary_date(&input.diary_date)?;
        validate_timestamp(input.updated_at_ms)?;

        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| DiaryError::PersistenceError)?;

        let exists = transaction
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM diary_entries WHERE id = ?1 AND deleted_at_ms IS NULL)",
                params![input.id],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|_| DiaryError::PersistenceError)?;
        if !exists {
            return Err(DiaryError::NotFound);
        }

        if Self::active_date_occupied(&transaction, &input.diary_date, Some(&input.id))? {
            return Err(DiaryError::DiaryDateConflict);
        }

        let record = transaction
            .query_row(
                "UPDATE diary_entries SET diary_date = ?2, updated_at_ms = ?3 \
                 WHERE id = ?1 AND deleted_at_ms IS NULL \
                 RETURNING id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms",
                params![input.id, input.diary_date, input.updated_at_ms],
                parse_diary_row,
            )
            .optional()
            .map_err(|_| DiaryError::PersistenceError)?
            .ok_or(DiaryError::NotFound)?;
        validate_diary_record(&record)?;

        transaction
            .commit()
            .map_err(|_| DiaryError::PersistenceError)?;
        Ok(record)
    }

    pub fn soft_delete(
        connection: &Connection,
        input: SoftDeleteDiaryEntryInput,
    ) -> Result<(), DiaryError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let affected = connection
            .execute(
                "UPDATE diary_entries SET deleted_at_ms = ?2, updated_at_ms = ?3 \
                 WHERE id = ?1 AND deleted_at_ms IS NULL",
                params![input.id, input.updated_at_ms, input.updated_at_ms],
            )
            .map_err(|_| DiaryError::PersistenceError)?;
        if affected == 0 {
            return Err(DiaryError::NotFound);
        }
        Ok(())
    }

    pub fn restore(
        connection: &Connection,
        input: RestoreDiaryEntryInput,
    ) -> Result<(), DiaryError> {
        validate_id(&input.id)?;
        validate_timestamp(input.updated_at_ms)?;

        let transaction = connection
            .unchecked_transaction()
            .map_err(|_| DiaryError::PersistenceError)?;

        let diary_date: String = transaction
            .query_row(
                "SELECT diary_date FROM diary_entries WHERE id = ?1 AND deleted_at_ms IS NOT NULL",
                params![input.id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| DiaryError::PersistenceError)?
            .ok_or(DiaryError::NotFound)?;

        if Self::active_date_occupied(&transaction, &diary_date, None)? {
            return Err(DiaryError::DiaryDateConflict);
        }

        let affected = transaction
            .execute(
                "UPDATE diary_entries SET deleted_at_ms = NULL, updated_at_ms = ?2 \
                 WHERE id = ?1 AND deleted_at_ms IS NOT NULL",
                params![input.id, input.updated_at_ms],
            )
            .map_err(|_| DiaryError::PersistenceError)?;
        if affected == 0 {
            return Err(DiaryError::NotFound);
        }

        transaction
            .commit()
            .map_err(|_| DiaryError::PersistenceError)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use crate::db::definitions::MIGRATIONS;
    use crate::db::migration::MigrationRunner;
    use crate::db::policy::open_configured_connection;
    use crate::db::snapshot::SqliteBackupSnapshot;

    fn id_for(index: u32) -> String {
        format!("00000000-0000-4000-8000-{index:012x}")
    }

    /// Isolated temp sandbox DB carrying the real frozen migration history,
    /// so the diary-date partial unique index is exercised as committed.
    fn migrated_database() -> (tempfile::TempDir, Connection) {
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
        (sandbox, connection)
    }

    fn create_entry(
        connection: &Connection,
        index: u32,
        diary_date: &str,
        created_at_ms: i64,
    ) -> DiaryEntryRecord {
        DiaryDbService::create(
            connection,
            CreateDiaryEntryInput {
                id: id_for(index),
                diary_date: diary_date.to_string(),
                title: format!("entry {index}"),
                content: "body".to_string(),
                created_at_ms,
            },
        )
        .unwrap()
    }

    #[test]
    fn create_inserts_active_row_with_updated_at_equal_to_created_at() {
        let (_sandbox, connection) = migrated_database();

        let record = DiaryDbService::create(
            &connection,
            CreateDiaryEntryInput {
                id: id_for(0x001),
                diary_date: "2026-09-18".to_string(),
                title: "Today".to_string(),
                content: "content".to_string(),
                created_at_ms: 1_700_000_000_000,
            },
        )
        .unwrap();

        assert_eq!(
            record,
            DiaryEntryRecord {
                id: id_for(0x001),
                title: "Today".to_string(),
                content: "content".to_string(),
                diary_date: "2026-09-18".to_string(),
                created_at_ms: 1_700_000_000_000,
                updated_at_ms: 1_700_000_000_000,
                deleted_at_ms: None,
            }
        );
    }

    #[test]
    fn create_rejects_occupied_active_date_with_diary_date_conflict() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        let conflict = DiaryDbService::create(
            &connection,
            CreateDiaryEntryInput {
                id: id_for(0x002),
                diary_date: "2026-09-18".to_string(),
                title: "second".to_string(),
                content: "body".to_string(),
                created_at_ms: 200,
            },
        );

        assert_eq!(conflict.unwrap_err(), DiaryError::DiaryDateConflict);
        // no partial row survived the rejected transaction
        assert_eq!(DiaryDbService::list_active(&connection).unwrap().len(), 1);
    }

    #[test]
    fn create_maps_unexpected_integrity_failure_to_persistence_error_not_conflict() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        // Different free date, but a duplicate PRIMARY KEY: this is NOT
        // provable diary-date occupation, so it must not become a conflict.
        let duplicate_id = DiaryDbService::create(
            &connection,
            CreateDiaryEntryInput {
                id: id_for(0x001),
                diary_date: "2026-09-19".to_string(),
                title: "dup".to_string(),
                content: "body".to_string(),
                created_at_ms: 200,
            },
        );

        assert_eq!(duplicate_id.unwrap_err(), DiaryError::PersistenceError);
    }

    #[test]
    fn get_active_by_id_returns_none_for_missing_and_soft_deleted() {
        let (_sandbox, connection) = migrated_database();
        let id = id_for(0x001);

        assert!(DiaryDbService::get_active_by_id(&connection, &id)
            .unwrap()
            .is_none());

        create_entry(&connection, 0x001, "2026-09-18", 100);
        assert_eq!(
            DiaryDbService::get_active_by_id(&connection, &id)
                .unwrap()
                .unwrap()
                .id,
            id
        );

        DiaryDbService::soft_delete(
            &connection,
            SoftDeleteDiaryEntryInput {
                id: id.clone(),
                updated_at_ms: 300,
            },
        )
        .unwrap();

        assert!(DiaryDbService::get_active_by_id(&connection, &id)
            .unwrap()
            .is_none());
    }

    #[test]
    fn get_active_by_diary_date_behaviour_and_future_reads() {
        let (_sandbox, connection) = migrated_database();

        assert!(DiaryDbService::get_active_by_diary_date(&connection, "2026-09-18")
            .unwrap()
            .is_none());

        create_entry(&connection, 0x001, "2026-09-18", 100);
        assert_eq!(
            DiaryDbService::get_active_by_diary_date(&connection, "2026-09-18")
                .unwrap()
                .unwrap()
                .id,
            id_for(0x001)
        );

        DiaryDbService::soft_delete(
            &connection,
            SoftDeleteDiaryEntryInput {
                id: id_for(0x001),
                updated_at_ms: 200,
            },
        )
        .unwrap();
        assert!(
            DiaryDbService::get_active_by_diary_date(&connection, "2026-09-18")
                .unwrap()
                .is_none(),
            "soft-deleted-only must read as null"
        );

        // A syntactically valid future date is a legal query.
        assert!(DiaryDbService::get_active_by_diary_date(&connection, "2099-01-01")
            .unwrap()
            .is_none());

        assert_eq!(
            DiaryDbService::get_active_by_diary_date(&connection, "2026-02-30").unwrap_err(),
            DiaryError::InvalidDiaryDate
        );
    }

    #[test]
    fn list_active_orders_by_diary_date_desc_and_excludes_deleted() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-01", 100);
        create_entry(&connection, 0x002, "2026-09-20", 200);
        create_entry(&connection, 0x003, "2026-09-10", 300);

        DiaryDbService::soft_delete(
            &connection,
            SoftDeleteDiaryEntryInput {
                id: id_for(0x002),
                updated_at_ms: 400,
            },
        )
        .unwrap();

        let list = DiaryDbService::list_active(&connection).unwrap();
        let dates: Vec<String> = list.iter().map(|r| r.diary_date.clone()).collect();
        assert_eq!(dates, vec!["2026-09-10", "2026-09-01"]);
    }

    #[test]
    fn empty_and_whitespace_title_and_content_are_legal() {
        let (_sandbox, connection) = migrated_database();

        let empty = DiaryDbService::create(
            &connection,
            CreateDiaryEntryInput {
                id: id_for(0x001),
                diary_date: "2026-09-18".to_string(),
                title: String::new(),
                content: String::new(),
                created_at_ms: 100,
            },
        )
        .unwrap();
        assert_eq!(empty.title, "");
        assert_eq!(empty.content, "");
    }

    #[test]
    fn raw_markdown_and_unicode_round_trip_exactly() {
        let (_sandbox, connection) = migrated_database();
        let raw = "  leading\n\n\n\t```\nconst x = \"你好 · 世界 — 📅\"\n```\n\n   trailing  ";

        let created = DiaryDbService::create(
            &connection,
            CreateDiaryEntryInput {
                id: id_for(0x001),
                diary_date: "2026-09-18".to_string(),
                title: "  Title  ".to_string(),
                content: raw.to_string(),
                created_at_ms: 100,
            },
        )
        .unwrap();
        assert_eq!(created.title, "  Title  ");
        assert_eq!(created.content, raw);

        let read = DiaryDbService::get_active_by_id(&connection, &id_for(0x001))
            .unwrap()
            .unwrap();
        assert_eq!(read.title, "  Title  ");
        assert_eq!(read.content, raw);
    }

    #[test]
    fn update_entry_preserves_diary_date_and_created_at() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        let updated = DiaryDbService::update_diary_entry(
            &connection,
            UpdateDiaryEntryInput {
                id: id_for(0x001),
                title: "renamed".to_string(),
                content: "rewritten".to_string(),
                updated_at_ms: 500,
            },
        )
        .unwrap();

        assert_eq!(updated.title, "renamed");
        assert_eq!(updated.content, "rewritten");
        assert_eq!(updated.diary_date, "2026-09-18");
        assert_eq!(updated.created_at_ms, 100);
        assert_eq!(updated.updated_at_ms, 500);

        assert_eq!(
            DiaryDbService::update_diary_entry(
                &connection,
                UpdateDiaryEntryInput {
                    id: id_for(0x099),
                    title: "x".to_string(),
                    content: "x".to_string(),
                    updated_at_ms: 600,
                },
            )
            .unwrap_err(),
            DiaryError::NotFound
        );
    }

    #[test]
    fn change_diary_date_succeeds_and_does_not_self_conflict() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        let moved = DiaryDbService::change_diary_date(
            &connection,
            ChangeDiaryDateInput {
                id: id_for(0x001),
                diary_date: "2026-09-19".to_string(),
                updated_at_ms: 500,
            },
        )
        .unwrap();
        assert_eq!(moved.diary_date, "2026-09-19");
        assert_eq!(moved.created_at_ms, 100);
        assert_eq!(moved.updated_at_ms, 500);

        // Same date as currently owned: must not conflict with itself.
        let same = DiaryDbService::change_diary_date(
            &connection,
            ChangeDiaryDateInput {
                id: id_for(0x001),
                diary_date: "2026-09-19".to_string(),
                updated_at_ms: 600,
            },
        )
        .unwrap();
        assert_eq!(same.diary_date, "2026-09-19");
        assert_eq!(same.updated_at_ms, 600);
    }

    #[test]
    fn change_diary_date_to_occupied_date_conflicts_and_leaves_row_unchanged() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);
        create_entry(&connection, 0x002, "2026-09-19", 200);

        let conflict = DiaryDbService::change_diary_date(
            &connection,
            ChangeDiaryDateInput {
                id: id_for(0x001),
                diary_date: "2026-09-19".to_string(),
                updated_at_ms: 700,
            },
        );
        assert_eq!(conflict.unwrap_err(), DiaryError::DiaryDateConflict);

        let unchanged = DiaryDbService::get_active_by_id(&connection, &id_for(0x001))
            .unwrap()
            .unwrap();
        assert_eq!(unchanged.diary_date, "2026-09-18");
        assert_eq!(unchanged.updated_at_ms, 100);
    }

    #[test]
    fn soft_delete_hides_from_active_queries_and_permits_same_date_recreate() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        DiaryDbService::soft_delete(
            &connection,
            SoftDeleteDiaryEntryInput {
                id: id_for(0x001),
                updated_at_ms: 300,
            },
        )
        .unwrap();

        let (deleted_at_ms, updated_at_ms): (Option<i64>, i64) = connection
            .query_row(
                "SELECT deleted_at_ms, updated_at_ms FROM diary_entries WHERE id = ?1",
                params![id_for(0x001)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted_at_ms, Some(300));
        assert_eq!(updated_at_ms, 300);

        assert!(DiaryDbService::get_active_by_id(&connection, &id_for(0x001))
            .unwrap()
            .is_none());
        assert!(DiaryDbService::get_active_by_diary_date(&connection, "2026-09-18")
            .unwrap()
            .is_none());
        assert!(DiaryDbService::list_active(&connection).unwrap().is_empty());

        let recreated = DiaryDbService::create(
            &connection,
            CreateDiaryEntryInput {
                id: id_for(0x002),
                diary_date: "2026-09-18".to_string(),
                title: "again".to_string(),
                content: "body".to_string(),
                created_at_ms: 400,
            },
        );
        assert!(recreated.is_ok());

        assert_eq!(
            DiaryDbService::soft_delete(
                &connection,
                SoftDeleteDiaryEntryInput {
                    id: id_for(0x001),
                    updated_at_ms: 500,
                },
            )
            .unwrap_err(),
            DiaryError::NotFound
        );
    }

    #[test]
    fn restore_succeeds_and_conflicts_when_date_is_now_occupied() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        DiaryDbService::soft_delete(
            &connection,
            SoftDeleteDiaryEntryInput {
                id: id_for(0x001),
                updated_at_ms: 200,
            },
        )
        .unwrap();

        DiaryDbService::restore(
            &connection,
            RestoreDiaryEntryInput {
                id: id_for(0x001),
                updated_at_ms: 300,
            },
        )
        .unwrap();

        let restored = DiaryDbService::get_active_by_id(&connection, &id_for(0x001))
            .unwrap()
            .unwrap();
        assert_eq!(restored.deleted_at_ms, None);
        assert_eq!(restored.updated_at_ms, 300);
        assert_eq!(restored.created_at_ms, 100);
        assert_eq!(restored.diary_date, "2026-09-18");

        assert_eq!(
            DiaryDbService::restore(
                &connection,
                RestoreDiaryEntryInput {
                    id: id_for(0x001),
                    updated_at_ms: 400,
                },
            )
            .unwrap_err(),
            DiaryError::NotFound
        );
    }

    #[test]
    fn restore_rejected_by_occupied_date_remains_deleted() {
        let (_sandbox, connection) = migrated_database();
        create_entry(&connection, 0x001, "2026-09-18", 100);

        DiaryDbService::soft_delete(
            &connection,
            SoftDeleteDiaryEntryInput {
                id: id_for(0x001),
                updated_at_ms: 200,
            },
        )
        .unwrap();
        create_entry(&connection, 0x002, "2026-09-18", 300);

        let conflict = DiaryDbService::restore(
            &connection,
            RestoreDiaryEntryInput {
                id: id_for(0x001),
                updated_at_ms: 400,
            },
        );
        assert_eq!(conflict.unwrap_err(), DiaryError::DiaryDateConflict);

        let (deleted_at_ms, updated_at_ms): (Option<i64>, i64) = connection
            .query_row(
                "SELECT deleted_at_ms, updated_at_ms FROM diary_entries WHERE id = ?1",
                params![id_for(0x001)],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(deleted_at_ms, Some(200), "failed restore must stay deleted");
        assert_eq!(updated_at_ms, 200, "rejected mutation must not bump updated_at_ms");
        assert!(DiaryDbService::get_active_by_id(&connection, &id_for(0x001))
            .unwrap()
            .is_none());
    }

    #[test]
    fn validation_boundaries_map_to_repository_error_codes() {
        let (_sandbox, connection) = migrated_database();

        assert_eq!(
            DiaryDbService::create(
                &connection,
                CreateDiaryEntryInput {
                    id: "not-a-uuid".to_string(),
                    diary_date: "2026-09-18".to_string(),
                    title: "t".to_string(),
                    content: "c".to_string(),
                    created_at_ms: 100,
                },
            )
            .unwrap_err(),
            DiaryError::InvalidId
        );

        assert_eq!(
            DiaryDbService::create(
                &connection,
                CreateDiaryEntryInput {
                    id: id_for(0x001),
                    diary_date: "2026-02-30".to_string(),
                    title: "t".to_string(),
                    content: "c".to_string(),
                    created_at_ms: 100,
                },
            )
            .unwrap_err(),
            DiaryError::InvalidDiaryDate
        );

        assert_eq!(
            DiaryDbService::create(
                &connection,
                CreateDiaryEntryInput {
                    id: id_for(0x001),
                    diary_date: "2026-09-18".to_string(),
                    title: "t".to_string(),
                    content: "c".to_string(),
                    created_at_ms: -1,
                },
            )
            .unwrap_err(),
            DiaryError::PersistenceError
        );

        assert_eq!(
            DiaryDbService::get_active_by_id(&connection, "not-a-uuid").unwrap_err(),
            DiaryError::InvalidId
        );
        assert_eq!(
            DiaryDbService::get_active_by_diary_date(&connection, "18-09-2026").unwrap_err(),
            DiaryError::InvalidDiaryDate
        );

        assert_eq!(
            DiaryDbService::change_diary_date(
                &connection,
                ChangeDiaryDateInput {
                    id: id_for(0x001),
                    diary_date: "2026-09-18".to_string(),
                    updated_at_ms: -5,
                },
            )
            .unwrap_err(),
            DiaryError::PersistenceError
        );

        assert_eq!(
            DiaryDbService::change_diary_date(
                &connection,
                ChangeDiaryDateInput {
                    id: id_for(0x001),
                    diary_date: "2026-09-18".to_string(),
                    updated_at_ms: 100,
                },
            )
            .unwrap_err(),
            DiaryError::NotFound
        );
    }

    #[test]
    fn diary_error_codes_and_safe_messages_are_frozen() {
        assert_eq!(DiaryError::InvalidId.code(), "INVALID_ID");
        assert_eq!(DiaryError::InvalidDiaryDate.code(), "INVALID_DIARY_DATE");
        assert_eq!(DiaryError::NotFound.code(), "NOT_FOUND");
        assert_eq!(DiaryError::DiaryDateConflict.code(), "DIARY_DATE_CONFLICT");
        assert_eq!(DiaryError::PersistenceError.code(), "PERSISTENCE_ERROR");

        assert_eq!(
            DiaryError::DiaryDateConflict.safe_message(),
            "A diary entry already exists for this date."
        );
        assert_eq!(
            DiaryError::PersistenceError.safe_message(),
            "Unable to persist the diary entry change."
        );
    }
}
