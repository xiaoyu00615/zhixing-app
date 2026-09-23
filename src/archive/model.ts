/**
 * Unified Archive domain read contract (P5C S2 — read infrastructure only).
 *
 * This module defines the value types and the structured error contract for
 * the read-only Unified Archive view. It contains NO service, NO runtime, and
 * NO I/O: the contract is transport-agnostic so the Native and Web
 * repositories can share it.
 *
 * Unified Archive V1 boundary (frozen by P5C S0/S1):
 *   - Entity types covered by the archive view: `task` / `note`.
 *   - Diary is OUT of the archive view.
 *   - Canvas (top-level), canvas nodes and canvas edges are OUT.
 *   - No schema change and no migration: the view is a read-only UNION ALL
 *     over the `archived_at_ms` columns introduced by migration 0014.
 *
 * Read semantics (frozen for S2):
 *   - ARCHIVED:            `archived_at_ms IS NOT NULL AND deleted_at_ms IS NULL`
 *                          → INCLUDED.
 *   - TRASHED_FROM_ARCHIVE: `archived_at_ms IS NOT NULL AND deleted_at_ms IS NOT NULL`
 *                          → EXCLUDED. A trashed row belongs to the Trash
 *                          workspace, so it must never surface in Archive too.
 *   - ACTIVE:              `archived_at_ms IS NULL` → EXCLUDED.
 *
 * Ordering contract (frozen for S2):
 *   `archived_at_ms DESC, entity_type ASC, entity_id ASC`
 * so the most recently archived item appears first, with a stable
 * deterministic tie-break across and within entity types.
 *
 * Title semantics (frozen for S2):
 *   - `title` is the canonical display string of the owning entity, verbatim.
 *   - An empty title is allowed and preserved as-is; the read layer never
 *     synthesizes a fallback value. Display fallback belongs to the UI /
 *     application layer.
 *
 * Ownership: this repository is READ ONLY. Canonical archive writes live on
 * `TaskRepository` / `TaskService` and `NoteRepository` / `NoteService`. The
 * unified Archive layer must never become a second write owner.
 */

export type ArchiveEntityType = 'task' | 'note'

export interface ArchiveItem {
  /** The domain that owns the archived row. */
  readonly entityType: ArchiveEntityType
  /** The primary identifier of the owning entity (UUID for task/note). */
  readonly entityId: string
  /** The canonical display title of the owning entity (verbatim, may be empty). */
  readonly title: string
  /** Archive timestamp of the owning entity, in epoch milliseconds. */
  readonly archivedAtMs: number
}

export type ArchiveRepositoryOperation = 'list'

export const ARCHIVE_REPOSITORY_ERROR_CODES = ['PERSISTENCE_ERROR'] as const
export type ArchiveRepositoryErrorCode =
  (typeof ARCHIVE_REPOSITORY_ERROR_CODES)[number]

const SAFE_ERROR_MESSAGES: Record<ArchiveRepositoryErrorCode, string> = {
  PERSISTENCE_ERROR: 'Unable to read the archive.',
}

export class ArchiveRepositoryError extends Error {
  readonly code: ArchiveRepositoryErrorCode
  readonly operation: ArchiveRepositoryOperation

  constructor(
    code: ArchiveRepositoryErrorCode,
    operation: ArchiveRepositoryOperation,
  ) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'ArchiveRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isArchiveRepositoryErrorCode(
  value: unknown,
): value is ArchiveRepositoryErrorCode {
  return (
    typeof value === 'string' &&
    (ARCHIVE_REPOSITORY_ERROR_CODES as readonly string[]).includes(value)
  )
}
