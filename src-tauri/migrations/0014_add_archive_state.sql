-- Archive V1 state foundation (P5C S1).
--
-- Canonical Archive state for the two Archive V1 entities:
--   tasks -> archived_at_ms
--   notes -> archived_at_ms
--
-- `archived_at_ms` is an ORTHOGONAL lifecycle dimension. It is never an alias
-- of `deleted_at_ms`:
--
--   ACTIVE               deleted_at_ms IS NULL     AND archived_at_ms IS NULL
--   ARCHIVED             deleted_at_ms IS NULL     AND archived_at_ms IS NOT NULL
--   TRASHED_FROM_ACTIVE  deleted_at_ms IS NOT NULL AND archived_at_ms IS NULL
--   TRASHED_FROM_ARCHIVE deleted_at_ms IS NOT NULL AND archived_at_ms IS NOT NULL
--
-- The last combination is a legal state and MUST remain reachable: canonical
-- Trash restore clears `deleted_at_ms` while PRESERVING `archived_at_ms`, so an
-- item returns to its previous logical state without any extra
-- previous_state / restore_target column.
--
-- Archive is NOT a Task status: `tasks.status` stays
-- todo / doing / completed / cancelled.
--
-- Canvas / CanvasNode / CanvasEdge and diary_entries are OUT of Archive V1 and
-- are intentionally untouched by this migration.
--
-- This migration is ADDITIVE ONLY: nullable column, no table rebuild, no data
-- rewrite, no index change, no trigger change. Existing rows keep every
-- original field value and receive `archived_at_ms = NULL`.
--
-- Search note: migration 0013 Search triggers are deliberately NOT modified
-- here. Search / Archive lifecycle integration is a separate risk slice
-- (P5C-S2.5) and requires its own trigger / backfill / FTS regression review.

ALTER TABLE tasks
ADD COLUMN archived_at_ms INTEGER NULL
CHECK (archived_at_ms IS NULL OR archived_at_ms >= 0);

ALTER TABLE notes
ADD COLUMN archived_at_ms INTEGER NULL
CHECK (archived_at_ms IS NULL OR archived_at_ms >= 0);
