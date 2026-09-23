import { invoke } from '@tauri-apps/api/core'

import {
  NoteRepositoryError,
  isNoteRepositoryErrorCode,
  type ArchiveNoteInput,
  type CreateNoteInput,
  type NoteRepository,
  type NoteRepositoryOperation,
  type RestoreNoteInput,
  type SoftDeleteNoteInput,
  type UnarchiveNoteInput,
  type UpdateNoteInput,
} from '@/note/repository'
import { type Note } from '@/note/model'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/shared/validation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseNote(
  value: unknown,
  operation: NoteRepositoryOperation,
): Note {
  if (!isRecord(value))
    throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
  const {
    id,
    title,
    content,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
    archivedAtMs,
  } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    typeof title !== 'string' ||
    typeof content !== 'string' ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    (deletedAtMs !== null &&
      !isNonNegativeSafeIntegerMilliseconds(deletedAtMs)) ||
    (archivedAtMs !== null &&
      !isNonNegativeSafeIntegerMilliseconds(archivedAtMs))
  ) {
    throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    id,
    title,
    content,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
    archivedAtMs,
  }
}

function validateId(
  id: string,
  operation: NoteRepositoryOperation,
): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new NoteRepositoryError('INVALID_ID', operation)
  }
}

function validateTimestamp(
  value: number,
  operation: NoteRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(value)) {
    throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

function validateTextFields(
  title: string,
  content: string,
  operation: NoteRepositoryOperation,
): void {
  if (typeof title !== 'string' || typeof content !== 'string') {
    throw new NoteRepositoryError('INVALID_TITLE', operation)
  }
}

async function call(
  command: string,
  operation: NoteRepositoryOperation,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(command, args)
  } catch (error: unknown) {
    if (isRecord(error) && isNoteRepositoryErrorCode(error.code))
      throw new NoteRepositoryError(error.code, operation)
    throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

export class NativeNoteRepository implements NoteRepository {
  async create(input: CreateNoteInput): Promise<Note> {
    const operation = 'create'
    validateId(input.id, operation)
    validateTimestamp(input.createdAtMs, operation)
    validateTextFields(input.title, input.content, operation)
    return parseNote(
      await call('note_create', operation, { input }),
      operation,
    )
  }
  async getActiveById(id: string): Promise<Note | null> {
    const operation = 'getActiveById'
    validateId(id, operation)
    const value = await call('note_get_active_by_id', operation, { id })
    if (value === null) return null
    return parseNote(value, operation)
  }
  async listActive(): Promise<Note[]> {
    const operation = 'listActive'
    const value = await call('note_list_active', operation)
    if (!Array.isArray(value))
      throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
    return value.map((note) => parseNote(note, operation))
  }
  async updateNote(input: UpdateNoteInput): Promise<Note> {
    const operation = 'updateNote'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    validateTextFields(input.title, input.content, operation)
    return parseNote(
      await call('note_update', operation, { input }),
      operation,
    )
  }
  async softDelete(input: SoftDeleteNoteInput): Promise<void> {
    const operation = 'softDelete'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    await call('note_soft_delete', operation, { input })
  }
  async restore(input: RestoreNoteInput): Promise<void> {
    const operation = 'restore'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    await call('note_restore', operation, { input })
  }
  /** Archive V1 (P5C-S1): Active -> Archived. Native parity with Web. */
  async archive(input: ArchiveNoteInput): Promise<void> {
    const operation = 'archive'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    await call('note_archive', operation, { input })
  }
  /** Archive V1 (P5C-S1): Archived -> Active. Native parity with Web. */
  async unarchive(input: UnarchiveNoteInput): Promise<void> {
    const operation = 'unarchive'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    await call('note_unarchive', operation, { input })
  }
}
