import type { Note } from '@/note/model'
import { NoteRepositoryError, type NoteRepository } from '@/note/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/shared/validation'

export const NOTE_APPLICATION_ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'UNAVAILABLE',
] as const

export type NoteApplicationErrorCode =
  (typeof NOTE_APPLICATION_ERROR_CODES)[number]

export type NoteApplicationErrorField = 'id' | 'title' | 'content'

const SAFE_ERROR_MESSAGES: Record<NoteApplicationErrorCode, string> = {
  VALIDATION: 'Note input is invalid.',
  NOT_FOUND: 'Note not found.',
  UNAVAILABLE: 'Note service is unavailable.',
}

export class NoteApplicationError extends Error {
  readonly code: NoteApplicationErrorCode
  readonly field?: NoteApplicationErrorField

  constructor(code: NoteApplicationErrorCode, field?: NoteApplicationErrorField) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'NoteApplicationError'
    this.code = code
    this.field = field
  }
}

export type GenerateNoteId = () => string
export type NowMs = () => number

export interface CreateNoteServiceOptions {
  readonly repository: NoteRepository
  readonly generateNoteId?: GenerateNoteId
  readonly nowMs?: NowMs
}

function defaultGenerateNoteId(): string {
  return globalThis.crypto.randomUUID()
}

function defaultNowMs(): number {
  return Date.now()
}

function validateNoteId(id: unknown): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new NoteApplicationError('VALIDATION', 'id')
  }
}

function readText(value: unknown, field: 'title' | 'content'): string {
  if (typeof value !== 'string') {
    throw new NoteApplicationError('VALIDATION', field)
  }
  return value
}

function readGeneratedNoteId(generateNoteId: GenerateNoteId): string {
  try {
    const id = generateNoteId()
    if (!isCanonicalLowercaseUuid(id)) {
      throw new NoteApplicationError('UNAVAILABLE')
    }
    return id
  } catch (error: unknown) {
    if (error instanceof NoteApplicationError) {
      throw error
    }
    throw new NoteApplicationError('UNAVAILABLE')
  }
}

function readNowMs(nowMs: NowMs): number {
  try {
    const value = nowMs()
    if (!isNonNegativeSafeIntegerMilliseconds(value)) {
      throw new NoteApplicationError('UNAVAILABLE')
    }
    return value
  } catch (error: unknown) {
    if (error instanceof NoteApplicationError) {
      throw error
    }
    throw new NoteApplicationError('UNAVAILABLE')
  }
}

function mapRepositoryError(error: unknown): NoteApplicationError {
  if (!(error instanceof NoteRepositoryError)) {
    return new NoteApplicationError('UNAVAILABLE')
  }

  switch (error.code) {
    case 'NOT_FOUND':
      return new NoteApplicationError('NOT_FOUND')
    case 'INVALID_ID':
    case 'INVALID_TITLE':
    case 'PERSISTENCE_ERROR':
      return new NoteApplicationError('UNAVAILABLE')
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw mapRepositoryError(error)
  }
}

export function createNoteService({
  repository,
  generateNoteId = defaultGenerateNoteId,
  nowMs = defaultNowMs,
}: CreateNoteServiceOptions) {
  return {
    async createNote(input: {
      readonly title: string
      readonly content: string
    }): Promise<Note> {
      const title = readText(input.title, 'title')
      const content = readText(input.content, 'content')
      const id = readGeneratedNoteId(generateNoteId)
      const createdAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.create({ id, title, content, createdAtMs }),
      )
    },

    async getActiveById(id: string): Promise<Note | null> {
      validateNoteId(id)
      return callRepository(() => repository.getActiveById(id))
    },

    listActive(): Promise<Note[]> {
      return callRepository(() => repository.listActive())
    },

    async updateNote(input: {
      readonly id: string
      readonly title: string
      readonly content: string
    }): Promise<Note> {
      validateNoteId(input.id)
      const title = readText(input.title, 'title')
      const content = readText(input.content, 'content')
      const updatedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.updateNote({
          id: input.id,
          title,
          content,
          updatedAtMs,
        }),
      )
    },

    async softDelete(id: string): Promise<void> {
      validateNoteId(id)
      const updatedAtMs = readNowMs(nowMs)
      await callRepository(() => repository.softDelete({ id, updatedAtMs }))
    },

    async restore(id: string): Promise<void> {
      validateNoteId(id)
      const updatedAtMs = readNowMs(nowMs)
      await callRepository(() => repository.restore({ id, updatedAtMs }))
    },

    /**
     * Archive V1: move an ACTIVE note into the archived state.
     *
     * Only the identity and the timestamp are forwarded; the canonical Note
     * persistence owns the state transition and preserves title / content
     * verbatim.
     */
    async archive(id: string): Promise<void> {
      validateNoteId(id)
      const updatedAtMs = readNowMs(nowMs)
      await callRepository(() => repository.archive({ id, updatedAtMs }))
    },

    /**
     * Archive V1: return an ARCHIVED note to the active workspace.
     *
     * Deliberately not named `restore`: Trash restore and Archive unarchive are
     * different lifecycle operations.
     */
    async unarchive(id: string): Promise<void> {
      validateNoteId(id)
      const updatedAtMs = readNowMs(nowMs)
      await callRepository(() => repository.unarchive({ id, updatedAtMs }))
    },
  }
}

export type NoteService = ReturnType<typeof createNoteService>