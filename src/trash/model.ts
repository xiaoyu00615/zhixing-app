/**
 * Unified Trash domain read contract (P5B S1 — Native read layer only).
 *
 * This module defines the value types and the structured error contract for
 * the read-only Unified Trash view. It contains NO service, NO runtime, and
 * NO I/O: the contract is transport-agnostic so the Native and future Web
 * repositories can share it.
 *
 * Unified Trash V1 boundary (frozen by P5B S0 audit):
 *   - Entity types covered by the trash view: `task` / `note` / `diary`.
 *   - Canvas (top-level) is OUT of the trash view.
 *   - Canvas nodes / edges are OUT (their `deleted_at_ms` is editor-history
 *     semantics, never a user-facing trash entry).
 *   - No schema change and no migration: the view is a read-only UNION ALL
 *     over the existing `deleted_at_ms` soft-delete columns.
 *
 * Title semantics (frozen for S1):
 *   - `title` is the canonical display string of the owning entity, verbatim.
 *   - An empty title is allowed and preserved as-is; the Native layer never
 *     synthesizes a fallback value.
 */

export type TrashEntityType = 'task' | 'note' | 'diary'

export interface TrashItem {
  /** The domain that owns the trashed row. */
  readonly entityType: TrashEntityType
  /** The primary identifier of the owning entity (UUID for task/note/diary). */
  readonly entityId: string
  /** The canonical display title of the owning entity (verbatim, may be empty). */
  readonly title: string
  /** Soft-delete timestamp of the owning entity, in epoch milliseconds. */
  readonly deletedAtMs: number
}

export type TrashRepositoryOperation = 'list'

export const TRASH_REPOSITORY_ERROR_CODES = ['PERSISTENCE_ERROR'] as const
export type TrashRepositoryErrorCode =
  (typeof TRASH_REPOSITORY_ERROR_CODES)[number]

const SAFE_ERROR_MESSAGES: Record<TrashRepositoryErrorCode, string> = {
  PERSISTENCE_ERROR: 'Unable to read the trash.',
}

export class TrashRepositoryError extends Error {
  readonly code: TrashRepositoryErrorCode
  readonly operation: TrashRepositoryOperation

  constructor(
    code: TrashRepositoryErrorCode,
    operation: TrashRepositoryOperation,
  ) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'TrashRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isTrashRepositoryErrorCode(
  value: unknown,
): value is TrashRepositoryErrorCode {
  return (
    typeof value === 'string' &&
    (TRASH_REPOSITORY_ERROR_CODES as readonly string[]).includes(value)
  )
}
