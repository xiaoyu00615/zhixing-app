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
 * Read lookup: returns the active record or null. Never throws NOT_FOUND
 * for a plain missing or soft-deleted record.
 */
export interface NoteRepository {
  create(input: CreateNoteInput): Promise<Note>
  /** Returns null when the record is missing or soft-deleted. */
  getActiveById(id: string): Promise<Note | null>
  /** Active notes ordered by updated_at_ms DESC, id ASC. */
  listActive(): Promise<Note[]>
  /** Throws NOT_FOUND when target is missing or not active. */
  updateNote(input: UpdateNoteInput): Promise<Note>
  /** Throws NOT_FOUND when target is missing or not active. */
  softDelete(input: SoftDeleteNoteInput): Promise<void>
  /** Throws NOT_FOUND when target is missing or not soft-deleted. */
  restore(input: RestoreNoteInput): Promise<void>
}

export const NOTE_REPOSITORY_ERROR_CODES = [
  'INVALID_ID',
  'NOT_FOUND',
  'INVALID_TITLE',
  'PERSISTENCE_ERROR',
] as const
export type NoteRepositoryErrorCode = (typeof NOTE_REPOSITORY_ERROR_CODES)[number]
export type NoteRepositoryOperation = 'create' | 'getActiveById' | 'listActive' | 'updateNote' | 'softDelete' | 'restore'

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
