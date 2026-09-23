import type { Note } from './model'

export interface CreateNoteInput {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly createdAtMs: number
}

export interface UpdateNoteInput {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly updatedAtMs: number
}

export interface SoftDeleteNoteInput {
  readonly id: string
  readonly updatedAtMs: number
}

export interface RestoreNoteInput {
  readonly id: string
  readonly updatedAtMs: number
}

/**
 * Archive V1 (P5C-S1).
 *
 * Target precondition: `deleted_at_ms IS NULL AND archived_at_ms IS NULL`.
 * On success: `archived_at_ms = updatedAtMs` and `updated_at_ms = updatedAtMs`.
 * Title / content are preserved verbatim (never trimmed or normalized).
 */
export interface ArchiveNoteInput {
  readonly id: string
  readonly updatedAtMs: number
}

/**
 * Archive V1 (P5C-S1).
 *
 * Target precondition: `deleted_at_ms IS NULL AND archived_at_ms IS NOT NULL`.
 * On success: `archived_at_ms = NULL` and `updated_at_ms = updatedAtMs`.
 * Title / content are preserved verbatim (never trimmed or normalized).
 */
export interface UnarchiveNoteInput {
  readonly id: string
  readonly updatedAtMs: number
}

/**
 * Read lookup: returns the active record or null. Never throws NOT_FOUND
 * for a plain missing or soft-deleted record.
 */
export interface NoteRepository {
  create(input: CreateNoteInput): Promise<Note>
  /**
   * Returns null when the record is missing, soft-deleted OR archived.
   * Active == `deleted_at_ms IS NULL AND archived_at_ms IS NULL`.
   */
  getActiveById(id: string): Promise<Note | null>
  /**
   * Active notes (`deleted_at_ms IS NULL AND archived_at_ms IS NULL`)
   * ordered by updated_at_ms DESC, id ASC.
   */
  listActive(): Promise<Note[]>
  /** Throws NOT_FOUND when target is missing, soft-deleted or archived. */
  updateNote(input: UpdateNoteInput): Promise<Note>
  /**
   * Lifecycle target is "not deleted" (`deleted_at_ms IS NULL`), NOT "active":
   * an archived note must still be trashable
   * (Archive -> Trash -> Restore -> Archive).
   */
  softDelete(input: SoftDeleteNoteInput): Promise<void>
  /**
   * Clears `deleted_at_ms` and PRESERVES `archived_at_ms`, restoring the note
   * to its previous logical state (active or archived).
   */
  restore(input: RestoreNoteInput): Promise<void>
  /** Throws NOT_FOUND when target is missing, soft-deleted or already archived. */
  archive(input: ArchiveNoteInput): Promise<void>
  /** Throws NOT_FOUND when target is missing, soft-deleted or not archived. */
  unarchive(input: UnarchiveNoteInput): Promise<void>
}

export const NOTE_REPOSITORY_ERROR_CODES = [
  'INVALID_ID',
  'NOT_FOUND',
  'INVALID_TITLE',
  'PERSISTENCE_ERROR',
] as const
export type NoteRepositoryErrorCode = (typeof NOTE_REPOSITORY_ERROR_CODES)[number]
export type NoteRepositoryOperation =
  | 'create'
  | 'getActiveById'
  | 'listActive'
  | 'updateNote'
  | 'softDelete'
  | 'restore'
  | 'archive'
  | 'unarchive'

const SAFE_ERROR_MESSAGES: Record<NoteRepositoryErrorCode, string> = {
  INVALID_ID: 'Invalid note identifier.',
  NOT_FOUND: 'Note not found.',
  INVALID_TITLE: 'Invalid note title.',
  PERSISTENCE_ERROR: 'Unable to persist the note change.',
}

export class NoteRepositoryError extends Error {
  readonly code: NoteRepositoryErrorCode
  readonly operation: NoteRepositoryOperation

  constructor(code: NoteRepositoryErrorCode, operation: NoteRepositoryOperation) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'NoteRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isNoteRepositoryErrorCode(value: unknown): value is NoteRepositoryErrorCode {
  return typeof value === 'string' && (NOTE_REPOSITORY_ERROR_CODES as readonly string[]).includes(value)
}
