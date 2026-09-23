import type { Note } from '@/note/model'
import {
  NoteRepositoryError,
  type ArchiveNoteInput,
  type CreateNoteInput,
  type NoteRepository,
  type NoteRepositoryOperation,
  type RestoreNoteInput,
  type SoftDeleteNoteInput,
  type UnarchiveNoteInput,
  type UpdateNoteInput,
} from '@/note/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/shared/validation'
import { NoteWorkerClientError, type TaskWorkerClient } from '@/adapters/web/taskWorkerClient'
import { isRecord } from '@/adapters/web/taskWorkerProtocol'

function parseNote(value: unknown, operation: NoteRepositoryOperation): Note {
  if (!isRecord(value)) {
    throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
  }

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

function validateId(id: string, operation: NoteRepositoryOperation): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new NoteRepositoryError('INVALID_ID', operation)
  }
}

function validateTimestamp(
  timestamp: number,
  operation: NoteRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(timestamp)) {
    throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

function validateTextFields(
  title: unknown,
  content: unknown,
  operation: NoteRepositoryOperation,
): void {
  if (typeof title !== 'string' || typeof content !== 'string') {
    throw new NoteRepositoryError('INVALID_TITLE', operation)
  }
}

function mapClientError(
  error: unknown,
  operation: NoteRepositoryOperation,
): NoteRepositoryError {
  if (error instanceof NoteRepositoryError) {
    return error
  }
  if (error instanceof NoteWorkerClientError) {
    switch (error.code) {
      case 'INVALID_ID':
      case 'NOT_FOUND':
      case 'INVALID_TITLE':
      case 'PERSISTENCE_ERROR':
        return new NoteRepositoryError(error.code, operation)
    }
  }
  return new NoteRepositoryError('PERSISTENCE_ERROR', operation)
}

export class WebNoteRepository implements NoteRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async create(input: CreateNoteInput): Promise<Note> {
    const operation = 'create'
    validateId(input.id, operation)
    validateTimestamp(input.createdAtMs, operation)
    validateTextFields(input.title, input.content, operation)
    try {
      return parseNote(await this.#client.createNote(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async getActiveById(id: string): Promise<Note | null> {
    const operation = 'getActiveById'
    validateId(id, operation)
    try {
      const value = await this.#client.getActiveNoteById(id)
      if (value === null) return null
      return parseNote(value, operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async listActive(): Promise<Note[]> {
    const operation = 'listActive'
    try {
      const value = await this.#client.listActiveNotes()
      if (!Array.isArray(value)) {
        throw new NoteRepositoryError('PERSISTENCE_ERROR', operation)
      }
      return value.map((note) => parseNote(note, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async updateNote(input: UpdateNoteInput): Promise<Note> {
    const operation = 'updateNote'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    validateTextFields(input.title, input.content, operation)
    try {
      return parseNote(await this.#client.updateNote(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async softDelete(input: SoftDeleteNoteInput): Promise<void> {
    const operation = 'softDelete'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.softDeleteNote(input)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async restore(input: RestoreNoteInput): Promise<void> {
    const operation = 'restore'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.restoreNote(input)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  /** Archive V1 (P5C-S1): Active -> Archived. */
  async archive(input: ArchiveNoteInput): Promise<void> {
    const operation = 'archive'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.archiveNote(input)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  /** Archive V1 (P5C-S1): Archived -> Active. */
  async unarchive(input: UnarchiveNoteInput): Promise<void> {
    const operation = 'unarchive'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.unarchiveNote(input)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }
}
