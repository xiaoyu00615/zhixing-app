//! Native Unified Trash read service (P5B S1 — Native read layer only).
//!
//! Unified Trash V1 boundary (frozen by P5B S0 audit):
//! - Entity types in the trash view: `task` / `note` / `diary`.
//! - Canvas (top-level) is OUT of the trash view.
//! - Canvas nodes / edges are OUT: their `deleted_at_ms` is editor-history
//!   semantics, not a user-facing trash entry, so they are deliberately
//!   excluded from the UNION ALL below.
//!
//! This module performs NO writes. The view is a read-only `UNION ALL` over the
//! existing `deleted_at_ms` soft-delete columns of `tasks`, `notes`, and
//! `diary_entries`. No schema change and no migration are required.
//!
//! Ordering contract (frozen for S1):
//!   `deleted_at_ms DESC, entity_type ASC, entity_id ASC`
//! so the most recently trashed item appears first, with a stable
//! deterministic tie-break across and within entity types.

use rusqlite::{Connection, Row};
use serde::Serialize;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TrashItemRecord {
    pub entity_type: String,
    pub entity_id: String,
    pub title: String,
    pub deleted_at_ms: i64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TrashError {
    PersistenceFailed,
}

impl TrashError {
    pub(crate) fn code(self) -> &'static str {
        match self {
            TrashError::PersistenceFailed => "PERSISTENCE_ERROR",
        }
    }

    pub(crate) fn safe_message(self) -> &'static str {
        match self {
            TrashError::PersistenceFailed => "Unable to read the trash.",
        }
    }
}

impl TrashDbService {
    /// Read the unified trash view as a single `UNION ALL` over the three
    /// soft-deleted domain tables. Returns every row where `deleted_at_ms` is
    /// not null, ordered by most-recently-trashed first.
    pub(crate) fn list(connection: &Connection) -> Result<Vec<TrashItemRecord>, TrashError> {
        const QUERY: &str = "
            SELECT 'task'  AS entity_type, id AS entity_id, title, deleted_at_ms
            FROM tasks
            WHERE deleted_at_ms IS NOT NULL
            UNION ALL
            SELECT 'note'  AS entity_type, id AS entity_id, title, deleted_at_ms
            FROM notes
            WHERE deleted_at_ms IS NOT NULL
            UNION ALL
            SELECT 'diary' AS entity_type, id AS entity_id, title, deleted_at_ms
            FROM diary_entries
            WHERE deleted_at_ms IS NOT NULL
            ORDER BY deleted_at_ms DESC, entity_type ASC, entity_id ASC";

        let mut statement = connection
            .prepare(QUERY)
            .map_err(|_| TrashError::PersistenceFailed)?;
        let rows = statement
            .query_map([], trash_item_from_row)
            .map_err(|_| TrashError::PersistenceFailed)?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row.map_err(|_| TrashError::PersistenceFailed)?);
        }
        Ok(items)
    }
}

fn trash_item_from_row(row: &Row<'_>) -> rusqlite::Result<TrashItemRecord> {
    Ok(TrashItemRecord {
        entity_type: row.get(0)?,
        entity_id: row.get(1)?,
        title: row.get(2)?,
        deleted_at_ms: row.get(3)?,
    })
}

pub struct TrashDbService;

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

    fn trash_task(connection: &Connection, id: &str, deleted_at_ms: i64) {
        connection
            .execute(
                "UPDATE tasks SET deleted_at_ms = ?1 WHERE id = ?2",
                params![deleted_at_ms, id],
            )
            .unwrap();
    }

    fn trash_note(connection: &Connection, id: &str, title: &str, deleted_at_ms: i64) {
        connection
            .execute(
                "UPDATE notes SET title = ?1, deleted_at_ms = ?2 WHERE id = ?3",
                params![title, deleted_at_ms, id],
            )
            .unwrap();
    }

    fn trash_diary(connection: &Connection, id: &str, title: &str, deleted_at_ms: i64) {
        connection
            .execute(
                "UPDATE diary_entries SET title = ?1, deleted_at_ms = ?2 WHERE id = ?3",
                params![title, deleted_at_ms, id],
            )
            .unwrap();
    }

    #[test]
    fn empty_database_returns_no_trash() {
        let (_sandbox, connection) = migrated_database();
        let items = TrashDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn trashed_task_note_and_diary_all_appear() {
        let (_sandbox, connection) = migrated_database();
        // Seed one active row of each type, then soft-delete them.
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) \
                 VALUES('t1', 'Task', 'todo', 0, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES('n1', 'Note', 'c', 0, 0, NULL)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES('d1', 'Diary', 'c', '2026-01-01', 0, 0, NULL)",
                [],
            )
            .unwrap();

        trash_task(&connection, "t1", 300);
        trash_note(&connection, "n1", "Note", 200);
        trash_diary(&connection, "d1", "Diary", 100);

        let items = TrashDbService::list(&connection).unwrap();
        assert_eq!(items.len(), 3);
        let types: Vec<&str> = items.iter().map(|i| i.entity_type.as_str()).collect();
        assert!(types.contains(&"task"));
        assert!(types.contains(&"note"));
        assert!(types.contains(&"diary"));
    }

    #[test]
    fn active_rows_are_excluded() {
        let (_sandbox, connection) = migrated_database();
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) \
                 VALUES('t1', 'Active', 'todo', 0, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES('t2', 'Trashed', 'todo', 0, 0, 50)",
                [],
            )
            .unwrap();

        let items = TrashDbService::list(&connection).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].entity_id, "t2");
    }

    #[test]
    fn empty_title_is_preserved_verbatim() {
        let (_sandbox, connection) = migrated_database();
        connection
            .execute(
                "INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms) \
                 VALUES('n1', '', 'c', 0, 0, 10)",
                [],
            )
            .unwrap();

        let items = TrashDbService::list(&connection).unwrap();
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].title, "");
    }

    #[test]
    fn ordering_follows_deleted_at_ms_desc_then_entity_type_asc_then_entity_id_asc() {
        let (_sandbox, connection) = migrated_database();
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES('a', 'T', 'todo', 0, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES('b', 'T', 'todo', 0, 0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms) VALUES('n1', 'N', 'c', 0, 0, NULL)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms) VALUES('d1', 'D', 'c', '2026-01-01', 0, 0, NULL)",
                [],
            )
            .unwrap();

        // Same deleted_at_ms (100) across types -> entity_type ASC tie-break:
        // diary < note < task. Within a type, entity_id ASC.
        trash_diary(&connection, "d1", "D", 100);
        trash_note(&connection, "n1", "N", 100);
        trash_task(&connection, "b", 100);
        // task 'a' trashed earlier -> must sort after 'b' on the 100 group,
        // but a newer 200 trashed row must appear first overall.
        trash_task(&connection, "a", 200);

        let items = TrashDbService::list(&connection).unwrap();
        // 200 first (task a), then 100 group in entity_type ASC: diary, note, task(b).
        assert_eq!(items.len(), 4);
        assert_eq!(
            items.iter().map(|i| (i.entity_type.as_str(), i.entity_id.as_str())).collect::<Vec<_>>(),
            vec![
                ("task", "a"),
                ("diary", "d1"),
                ("note", "n1"),
                ("task", "b"),
            ],
        );
        for i in &items {
            assert!(i.deleted_at_ms >= 100);
        }
    }

    #[test]
    fn canvas_nodes_and_edges_are_not_in_trash() {
        let (_sandbox, connection) = migrated_database();
        // Canvas top-level has no `deleted_at_ms`; canvas_nodes has no
        // `deleted_at_ms` column at all; canvas_edges has a `deleted_at_ms`
        // column (editor-history semantics, normally NULL). None of these are
        // part of the Unified Trash V1 boundary, so even a non-null edge
        // soft-delete must never surface in the trash view.
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

        let items = TrashDbService::list(&connection).unwrap();
        assert!(items.is_empty());
    }

    #[test]
    fn error_codes_and_safe_messages_are_frozen() {
        assert_eq!(TrashError::PersistenceFailed.code(), "PERSISTENCE_ERROR");
        assert_eq!(
            TrashError::PersistenceFailed.safe_message(),
            "Unable to read the trash."
        );
    }
}
