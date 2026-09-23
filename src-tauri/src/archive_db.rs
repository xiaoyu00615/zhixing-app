//! Native Unified Archive read service (P5C S2 — read infrastructure only).
//!
//! Unified Archive V1 boundary (frozen by P5C S0/S1):
//! - Entity types in the archive view: `task` / `note`.
//! - Diary is OUT of the archive view: `diary_entries` carries no
//!   `archived_at_ms` column, so Diary Archive is simply not part of V1.
//! - Canvas (top-level), canvas nodes and canvas edges are OUT.
//!
//! This module performs NO writes. The view is a read-only `UNION ALL` over the
//! `archived_at_ms` columns introduced by migration 0014 on `tasks` and
//! `notes`. No schema change and no migration are required for S2.
//!
//! Read semantics (frozen for S2):
//! - ARCHIVED:             `archived_at_ms IS NOT NULL AND deleted_at_ms IS NULL`
//!                         → INCLUDED.
//! - TRASHED_FROM_ARCHIVE: `archived_at_ms IS NOT NULL AND deleted_at_ms IS NOT NULL`
//!                         → EXCLUDED. After a soft delete the row belongs to
//!                         the Trash workspace, so it must not appear in
//!                         Archive at the same time.
//! - ACTIVE:               `archived_at_ms IS NULL` → EXCLUDED.
//!
//! Ordering contract (frozen for S2):
//!   `archived_at_ms DESC, entity_type ASC, entity_id ASC`
//! so the most recently archived item appears first, with a stable
//! deterministic tie-break across and within entity types.

use rusqlite::{Connection, Row};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ArchiveItemRecord {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub archived_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ArchiveError {
    PersistenceFailed,
}

impl ArchiveError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            ArchiveError::PersistenceFailed => "PERSISTENCE_ERROR",
        }
    }

    pub(crate) fn safe_message(self) -> &'static str {
        match self {
            ArchiveError::PersistenceFailed => "Unable to read the archive.",
        }
    }
}

impl ArchiveDbService {
    /// Read the unified archive view as a single `UNION ALL` over the two
    /// archived domain tables, excluding rows that have since been soft
    /// deleted. Ordered by most-recently-archived first.
    pub(crate) fn list(
        connection: &Connection,
    ) -> Result<Vec<ArchiveItemRecord>, ArchiveError> {
        const QUERY: &str = "
            SELECT 'task' AS entity_type, id AS entity_id, title, archived_at_ms
            FROM tasks
            WHERE archived_at_ms IS NOT NULL
              AND deleted_at_ms IS NULL
            UNION ALL
            SELECT 'note' AS entity_type, id AS entity_id, title, archived_at_ms
            FROM notes
            WHERE archived_at_ms IS NOT NULL
              AND deleted_at_ms IS NULL
            ORDER BY archived_at_ms DESC, entity_type ASC, entity_id ASC";

        let mut statement = connection
            .prepare(QUERY)
            .map_err(|_| ArchiveError::PersistenceFailed)?;
        let rows = statement
            .query_map([], archive_item_from_row)
            .map_err(|_| ArchiveError::PersistenceFailed)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|_| ArchiveError::PersistenceFailed)?);
        }
        Ok(items)
    }
}

fn archive_item_from_row(row: &Row<'_>) -> rusqlite::Result<ArchiveItemRecord> {
    Ok(ArchiveItemRecord {
        entity_type: row.get(0)?,
        entity_id: row.get(1)?,
        title: row.get(2)?,
        archived_at_ms: row.get(3)?,
    })
}

pub struct ArchiveDbService;

#[cfg(test)]
mod tests {
    use std::fs;

    use tempfile::tempdir;

    use super::*;
    use rusqlite::params;
    use crate::db::definitions::MIGRATIONS;
    use crate::db::migration::MigrationRunner;
    use crate::db::policy::open_configured_connection;
    use crate::db::snapshot::SqliteBackupSnapshot;

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

    fn seed_task(connection: &Connection, id: &str, title: &str) {
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) \
                 VALUES(?1, ?2, 'todo', 0, 0)",
                params![id, title],
            )
            .unwrap();
    }

    fn seed_note(connection: &Connection, id: &str, title: &str) {
        connection
            .execute(
                "INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES(?1, ?2, 'c', 0, 0, NULL)",
                params![id, title],
            )
            .unwrap();
    }

    fn archive_task(connection: &Connection, id: &str, archived_at_ms: i64) {
        connection
            .execute(
                "UPDATE tasks SET archived_at_ms = ?1 WHERE id = ?2",
                params![archived_at_ms, id],
            )
            .unwrap();
    }

    fn archive_note(connection: &Connection, id: &str, archived_at_ms: i64) {
        connection
            .execute(
                "UPDATE notes SET archived_at_ms = ?1 WHERE id = ?2",
                params![archived_at_ms, id],
            )
            .unwrap();
    }

    /// Soft delete a row that is already archived: TRASHED_FROM_ARCHIVE state.
    fn trash_task(connection: &Connection, id: &str, deleted_at_ms: i64) {
        connection
            .execute(
                "UPDATE tasks SET deleted_at_ms = ?1 WHERE id = ?2",
                params![deleted_at_ms, id],
            )
            .unwrap();
    }

    fn trash_note(connection: &Connection, id: &str, deleted_at_ms: i64) {
        connection
            .execute(
                "UPDATE notes SET deleted_at_ms = ?1 WHERE id = ?2",
                params![deleted_at_ms, id],
            )
            .unwrap();
    }

    #[test]
    fn empty_database_returns_no_archive() {
        let (_sandbox, connection) = migrated_database();
        let items = ArchiveDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn active_task_and_note_are_excluded() {
        let (_sandbox, connection) = migrated_database();
        seed_task(&connection, "t1", "Active task");
        seed_note(&connection, "n1", "Active note");

        let items = ArchiveDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn archived_task_and_note_are_included() {
        let (_sandbox, connection) = migrated_database();
        seed_task(&connection, "t1", "Archived task");
        seed_note(&connection, "n1", "Archived note");
        archive_task(&connection, "t1", 100);
        archive_note(&connection, "n1", 200);

        let items = ArchiveDbService::list(&connection).unwrap();
        assert_eq!(items.len(), 2);
        let task = items.iter().find(|i| i.entity_type == "task").unwrap();
        assert_eq!(task.entity_id, "t1");
        assert_eq!(task.title, "Archived task");
        assert_eq!(task.archived_at_ms, 100);
        let note = items.iter().find(|i| i.entity_type == "note").unwrap();
        assert_eq!(note.entity_id, "n1");
        assert_eq!(note.title, "Archived note");
        assert_eq!(note.archived_at_ms, 200);
    }

    #[test]
    fn trashed_from_archive_task_is_excluded() {
        let (_sandbox, connection) = migrated_database();
        seed_task(&connection, "t1", "Archived then trashed");
        archive_task(&connection, "t1", 100);
        trash_task(&connection, "t1", 150);

        let items = ArchiveDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn trashed_from_archive_note_is_excluded() {
        let (_sandbox, connection) = migrated_database();
        seed_note(&connection, "n1", "Archived then trashed");
        archive_note(&connection, "n1", 100);
        trash_note(&connection, "n1", 150);

        let items = ArchiveDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn task_and_note_both_included_and_trashed_rows_filtered() {
        let (_sandbox, connection) = migrated_database();
        seed_task(&connection, "t1", "Archived task");
        seed_task(&connection, "t2", "Archived then trashed task");
        seed_note(&connection, "n1", "Archived note");
        seed_note(&connection, "n2", "Archived then trashed note");
        archive_task(&connection, "t1", 100);
        archive_note(&connection, "n1", 100);
        archive_task(&connection, "t2", 120);
        archive_note(&connection, "n2", 120);
        trash_task(&connection, "t2", 130);
        trash_note(&connection, "n2", 130);

        let items = ArchiveDbService::list(&connection).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| (i.entity_type.as_str(), i.entity_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("note", "n1"), ("task", "t1")],
        );
    }

    #[test]
    fn ordering_follows_archived_at_ms_desc_then_entity_type_asc_then_entity_id_asc() {
        let (_sandbox, connection) = migrated_database();
        seed_task(&connection, "a", "T");
        seed_task(&connection, "b", "T");
        seed_task(&connection, "c", "T");
        seed_note(&connection, "n1", "N");

        // Same archived_at_ms (100) for note n1 and tasks a/b: entity_type ASC
        // puts 'note' before 'task'; within a type, entity_id ASC gives a then b.
        archive_task(&connection, "b", 100);
        archive_task(&connection, "a", 100);
        archive_note(&connection, "n1", 100);
        // Newer archive wins the first slot.
        archive_task(&connection, "c", 200);

        let items = ArchiveDbService::list(&connection).unwrap();
        assert_eq!(
            items
                .iter()
                .map(|i| (i.entity_type.as_str(), i.entity_id.as_str()))
                .collect::<Vec<_>>(),
            vec![("task", "c"), ("note", "n1"), ("task", "a"), ("task", "b")],
        );
        assert_eq!(items[0].archived_at_ms, 200);
    }

    #[test]
    fn empty_title_is_preserved_verbatim() {
        let (_sandbox, connection) = migrated_database();
        seed_note(&connection, "n1", "");
        archive_note(&connection, "n1", 10);

        let items = ArchiveDbService::list(&connection).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "");
    }

    #[test]
    fn diary_never_appears_in_archive() {
        let (_sandbox, connection) = migrated_database();
        // Diary Archive is OUT of Archive V1: `diary_entries` has no
        // `archived_at_ms` column at all, so no diary row can ever enter the
        // UNION ALL — active, trashed or otherwise.
        connection
            .execute(
                "INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES('d1', 'Diary', 'c', '2026-01-01', 0, 0, NULL)",
                [],
            )
            .unwrap();

        let items = ArchiveDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn canvas_never_appears_in_archive() {
        let (_sandbox, connection) = migrated_database();
        // Canvas Archive is OUT of Archive V1. Even a soft-deleted canvas edge
        // (editor-history semantics) must never surface in the archive view.
        connection
            .execute_batch(
                "INSERT INTO canvases(id, title, viewport_json, created_at_ms, updated_at_ms) \
                 VALUES('c1', 'Canvas', '{}', 0, 0)",
            )
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO canvas_nodes(id, canvas_id, type, node_name, content_json, x, y, created_at_ms, updated_at_ms) \
                 VALUES('cn1', 'c1', 'text', 'Node', '{}', 0, 0, 0, 0)",
            )
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO canvas_nodes(id, canvas_id, type, node_name, content_json, x, y, created_at_ms, updated_at_ms) \
                 VALUES('cn2', 'c1', 'text', 'Other', '{}', 0, 0, 0, 0)",
            )
            .unwrap();
        connection
            .execute_batch(
                "INSERT INTO canvas_edges(id, canvas_id, source_node_id, target_node_id, relation_type, direction, line_style, membership_position, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES('ce1', 'c1', 'cn1', 'cn2', 'association', 'forward', 'solid', NULL, 0, 0, 999)",
            )
            .unwrap();

        let items = ArchiveDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn error_codes_and_safe_messages_are_frozen() {
        assert_eq!(ArchiveError::PersistenceFailed.code(), "PERSISTENCE_ERROR");
        assert_eq!(
            ArchiveError::PersistenceFailed.safe_message(),
            "Unable to read the archive."
        );
    }
}
