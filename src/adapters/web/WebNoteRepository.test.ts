import { describe, expect, test } from 'vitest'
import { WebNoteRepository } from './WebNoteRepository'
import { TaskWorkerClient, type TaskWorkerEndpoint } from './taskWorkerClient'
import type {
  TaskWorkerRequest,
  TaskWorkerResponse,
} from './taskWorkerProtocol'
import {
  NOTE_REPOSITORY_ERROR_CODES,
  NoteRepositoryError,
  type ArchiveNoteInput,
  type CreateNoteInput,
  type NoteRepositoryErrorCode,
  type NoteRepositoryOperation,
  type RestoreNoteInput,
  type SoftDeleteNoteInput,
  type UnarchiveNoteInput,
  type UpdateNoteInput,
} from '@/note/repository'
import type { Note } from '@/note/model'

const IDs = {
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
  missing: '00000000-0000-4000-8000-000000000099',
} as const

/** Archive V1 (P5C-S1): Active = not deleted AND not archived. */
function isActiveNote(note: Note): boolean {
  return note.deletedAtMs === null && note.archivedAtMs === null
}


class NoteContractBackendError extends Error {
  readonly code: NoteRepositoryErrorCode
  readonly rawDetails: string
  constructor(code: NoteRepositoryErrorCode, rawDetails: string) {
    super(rawDetails)
    this.name = 'NoteContractBackendError'
    this.code = code
    this.rawDetails = rawDetails
  }
}

class NoteContractBackend {
  readonly #notes = new Map<string, Note>()
  #nextFailure: NoteContractBackendError | null = null

  failNext(code: NoteRepositoryErrorCode, rawDetails: string): void {
    this.#nextFailure = new NoteContractBackendError(code, rawDetails)
  }

  createNote(input: CreateNoteInput): Note {
    this.consumeFailure()
    if (this.#notes.has(input.id)) {
      throw new NoteContractBackendError(
        'PERSISTENCE_ERROR',
        'UNIQUE constraint failed: notes.id SQL=INSERT INTO notes',
      )
    }
    const note: Note = {
      id: input.id,
      title: input.title,
      content: input.content,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      deletedAtMs: null,
      archivedAtMs: null,
    }
    this.#notes.set(note.id, note)
    return { ...note }
  }

  getActiveNote(id: string): Note | null {
    this.consumeFailure()
    const current = this.#notes.get(id)
    if (current === undefined || !isActiveNote(current)) {
      return null
    }
    return { ...current }
  }

  listActiveNotes(): Note[] {
    this.consumeFailure()
    return [...this.#notes.values()]
      .filter((note) => isActiveNote(note))
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))
      .map((note) => ({ ...note }))
  }

  updateNote(input: UpdateNoteInput): Note {
    this.consumeFailure()
    const current = this.#notes.get(input.id)
    if (current === undefined || !isActiveNote(current)) {
      throw new NoteContractBackendError(
        'NOT_FOUND',
        'SELECT note SQL=UPDATE notes',
      )
    }
    const changed: Note = {
      ...current,
      title: input.title,
      content: input.content,
      updatedAtMs: input.updatedAtMs,
    }
    this.#notes.set(input.id, changed)
    return { ...changed }
  }

  softDeleteNote(input: SoftDeleteNoteInput): void {
    this.consumeFailure()
    const current = this.#notes.get(input.id)
    if (current === undefined || current.deletedAtMs !== null) {
      throw new NoteContractBackendError('NOT_FOUND', 'note not active')
    }
    this.#notes.set(input.id, {
      ...current,
      deletedAtMs: input.updatedAtMs,
      updatedAtMs: input.updatedAtMs,
    })
  }

  restoreNote(input: RestoreNoteInput): void {
    this.consumeFailure()
    const current = this.#notes.get(input.id)
    if (current === undefined || current.deletedAtMs === null) {
      throw new NoteContractBackendError('NOT_FOUND', 'note not trashed')
    }
    this.#notes.set(input.id, {
      ...current,
      deletedAtMs: null,
      updatedAtMs: input.updatedAtMs,
    })
  }

  archiveNote(input: ArchiveNoteInput): void {
    this.consumeFailure()
    const current = this.#notes.get(input.id)
    if (current === undefined || !isActiveNote(current)) {
      throw new NoteContractBackendError('NOT_FOUND', 'note not active')
    }
    this.#notes.set(input.id, {
      ...current,
      archivedAtMs: input.updatedAtMs,
      updatedAtMs: input.updatedAtMs,
    })
  }

  unarchiveNote(input: UnarchiveNoteInput): void {
    this.consumeFailure()
    const current = this.#notes.get(input.id)
    if (
      current === undefined ||
      current.deletedAtMs !== null ||
      current.archivedAtMs === null
    ) {
      throw new NoteContractBackendError('NOT_FOUND', 'note not archived')
    }
    this.#notes.set(input.id, {
      ...current,
      archivedAtMs: null,
      updatedAtMs: input.updatedAtMs,
    })
  }

  private consumeFailure(): void {
    if (this.#nextFailure === null) return
    const failure = this.#nextFailure
    this.#nextFailure = null
    throw failure
  }
}

class NoteWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  constructor(readonly backend: NoteContractBackend) {}

  postMessage(request: TaskWorkerRequest): void {
    try {
      let result: unknown
      switch (request.type) {
        case 'note.create':
          result = this.backend.createNote(request.input)
          break
        case 'note.getActiveById':
          result = this.backend.getActiveNote(request.id)
          break
        case 'note.listActive':
          result = this.backend.listActiveNotes()
          break
        case 'note.updateNote':
          result = this.backend.updateNote(request.input)
          break
        case 'note.softDelete':
          this.backend.softDeleteNote(request.input)
          result = null
          break
        case 'note.restore':
          this.backend.restoreNote(request.input)
          result = null
          break
        case 'note.archive':
          this.backend.archiveNote(request.input)
          result = null
          break
        case 'note.unarchive':
          this.backend.unarchiveNote(request.input)
          result = null
          break
        default:
          throw new Error(`Unexpected request ${request.type}`)
      }
      this.respond({ requestId: request.requestId, ok: true, result })
    } catch (error: unknown) {
      if (error instanceof NoteContractBackendError) {
        this.respond({
          requestId: request.requestId,
          ok: false,
          error: { code: error.code },
        })
      } else {
        throw error
      }
    }
  }

  terminate(): void {}

  private respond(response: TaskWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }
}

async function expectSafeError(
  promise: Promise<unknown>,
  code: NoteRepositoryErrorCode,
  operation: NoteRepositoryOperation,
): Promise<void> {
  const error = await promise.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(NoteRepositoryError)
  expect(error).toMatchObject({ code, operation })
  expect((error as Error).message).not.toMatch(
    /SQL|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
  )
}

function createFixture(): {
  repository: WebNoteRepository
  backend: NoteContractBackend
} {
  const backend = new NoteContractBackend()
  return {
    repository: new WebNoteRepository(new TaskWorkerClient(new NoteWorker(backend))),
    backend,
  }
}

describe('WebNoteRepository', () => {
  test('freezes NOTE_REPOSITORY_ERROR_CODES in canonical order', () => {
    expect(NOTE_REPOSITORY_ERROR_CODES).toEqual([
      'INVALID_ID',
      'NOT_FOUND',
      'INVALID_TITLE',
      'PERSISTENCE_ERROR',
    ])
  })

  test('creates a note with updatedAtMs equal to createdAtMs and null deletedAtMs', async () => {
    const { repository } = createFixture()
    const created = await repository.create({
      id: IDs.a,
      title: 'First note',
      content: 'body',
      createdAtMs: 1000,
    })
    expect(created).toEqual({
      id: IDs.a,
      title: 'First note',
      content: 'body',
      createdAtMs: 1000,
      updatedAtMs: 1000,
      deletedAtMs: null,
      archivedAtMs: null,
    })
  })

  test('rejects duplicate create with PERSISTENCE_ERROR', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await expectSafeError(
      repository.create({ id: IDs.a, title: 'again', content: 'again', createdAtMs: 2 }),
      'PERSISTENCE_ERROR',
      'create',
    )
  })

  test('listActive returns notes ordered by updatedAtMs DESC and id ASC', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 100 })
    await repository.create({ id: IDs.b, title: 'b', content: 'b', createdAtMs: 200 })
    await repository.create({ id: IDs.c, title: 'c', content: 'c', createdAtMs: 300 })
    await repository.updateNote({ id: IDs.a, title: 'a2', content: 'a2', updatedAtMs: 400 })
    await repository.softDelete({ id: IDs.c, updatedAtMs: 500 })
    const result = await repository.listActive()
    expect(result.map((note) => note.id)).toEqual([IDs.a, IDs.b])
    expect(result.map((note) => note.updatedAtMs)).toEqual([400, 200])
  })

  test('getActiveById returns null for a missing note', async () => {
    const { repository } = createFixture()
    expect(await repository.getActiveById(IDs.missing)).toBeNull()
  })

  test('getActiveById returns null for a soft-deleted note', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    expect(await repository.getActiveById(IDs.a)).toBeNull()
  })

  test('updateNote persists title, content and updatedAtMs', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    const updated = await repository.updateNote({
      id: IDs.a,
      title: 'a2',
      content: 'a2',
      updatedAtMs: 50,
    })
    expect(updated).toMatchObject({
      id: IDs.a,
      title: 'a2',
      content: 'a2',
      createdAtMs: 1,
      updatedAtMs: 50,
      deletedAtMs: null,
    })
  })

  test('updateNote on a missing note throws NOT_FOUND', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.updateNote({ id: IDs.missing, title: 'x', content: 'x', updatedAtMs: 1 }),
      'NOT_FOUND',
      'updateNote',
    )
  })

  test('updateNote on a soft-deleted note throws NOT_FOUND', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    await expectSafeError(
      repository.updateNote({ id: IDs.a, title: 'x', content: 'x', updatedAtMs: 3 }),
      'NOT_FOUND',
      'updateNote',
    )
  })

  test('softDelete hides the note from active listings and reads', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 10 })
    expect(await repository.getActiveById(IDs.a)).toBeNull()
    expect(await repository.listActive()).toEqual([])
  })

  test('softDelete on a missing or already-deleted note throws NOT_FOUND', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.softDelete({ id: IDs.missing, updatedAtMs: 1 }),
      'NOT_FOUND',
      'softDelete',
    )
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    await expectSafeError(
      repository.softDelete({ id: IDs.a, updatedAtMs: 3 }),
      'NOT_FOUND',
      'softDelete',
    )
  })

  test('restore revives a soft-deleted note', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    await repository.restore({ id: IDs.a, updatedAtMs: 3 })
    const restored = await repository.getActiveById(IDs.a)
    expect(restored).toMatchObject({
      id: IDs.a,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
      updatedAtMs: 3,
      deletedAtMs: null,
    })
  })

  test('archive hides the note from active reads while preserving title and content verbatim', async () => {
    const { repository } = createFixture()
    const content = '  body with   spacing\n\n'
    await repository.create({ id: IDs.a, title: ' Note ', content, createdAtMs: 1 })
    await repository.archive({ id: IDs.a, updatedAtMs: 2 })

    expect(await repository.getActiveById(IDs.a)).toBeNull()
    expect(await repository.listActive()).toEqual([])
    await expectSafeError(
      repository.updateNote({
        id: IDs.a,
        title: 'changed',
        content: 'changed',
        updatedAtMs: 3,
      }),
      'NOT_FOUND',
      'updateNote',
    )
    const restored = await repository.unarchive({ id: IDs.a, updatedAtMs: 4 })
    expect(restored).toBeUndefined()
    const unarchived = await repository.getActiveById(IDs.a)
    expect(unarchived).toMatchObject({
      id: IDs.a,
      title: ' Note ',
      content,
      createdAtMs: 1,
      updatedAtMs: 4,
      deletedAtMs: null,
      archivedAtMs: null,
    })
  })

  test('accepts Archive -> Trash -> Restore -> Archive preserving archivedAtMs', async () => {
    const { repository } = createFixture()
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await repository.archive({ id: IDs.a, updatedAtMs: 2 })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 3 })
    await repository.restore({ id: IDs.a, updatedAtMs: 4 })

    // Restored from Trash it is ARCHIVED again, not active.
    expect(await repository.getActiveById(IDs.a)).toBeNull()
    expect(await repository.listActive()).toEqual([])

    await repository.unarchive({ id: IDs.a, updatedAtMs: 5 })
    const active = await repository.getActiveById(IDs.a)
    expect(active).toMatchObject({
      id: IDs.a,
      updatedAtMs: 5,
      deletedAtMs: null,
      archivedAtMs: null,
    })
  })

  test('fails closed for archive and unarchive on invalid lifecycle targets', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.archive({ id: IDs.missing, updatedAtMs: 1 }),
      'NOT_FOUND',
      'archive',
    )
    await expectSafeError(
      repository.unarchive({ id: IDs.missing, updatedAtMs: 1 }),
      'NOT_FOUND',
      'unarchive',
    )

    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await expectSafeError(
      repository.unarchive({ id: IDs.a, updatedAtMs: 2 }),
      'NOT_FOUND',
      'unarchive',
    )
    await repository.archive({ id: IDs.a, updatedAtMs: 2 })
    await expectSafeError(
      repository.archive({ id: IDs.a, updatedAtMs: 3 }),
      'NOT_FOUND',
      'archive',
    )

    await repository.softDelete({ id: IDs.a, updatedAtMs: 4 })
    await expectSafeError(
      repository.archive({ id: IDs.a, updatedAtMs: 5 }),
      'NOT_FOUND',
      'archive',
    )
    await expectSafeError(
      repository.unarchive({ id: IDs.a, updatedAtMs: 5 }),
      'NOT_FOUND',
      'unarchive',
    )
  })

  test('restore on a missing or active note throws NOT_FOUND', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.restore({ id: IDs.missing, updatedAtMs: 1 }),
      'NOT_FOUND',
      'restore',
    )
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await expectSafeError(
      repository.restore({ id: IDs.a, updatedAtMs: 2 }),
      'NOT_FOUND',
      'restore',
    )
  })

  test('rejects invalid UUIDs before dispatch with INVALID_ID', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.create({ id: 'not-a-uuid', title: 'a', content: 'a', createdAtMs: 1 }),
      'INVALID_ID',
      'create',
    )
    await expectSafeError(repository.getActiveById('not-a-uuid'), 'INVALID_ID', 'getActiveById')
    await expectSafeError(
      repository.updateNote({ id: 'not-a-uuid', title: 'a', content: 'a', updatedAtMs: 1 }),
      'INVALID_ID',
      'updateNote',
    )
    await expectSafeError(
      repository.softDelete({ id: 'not-a-uuid', updatedAtMs: 1 }),
      'INVALID_ID',
      'softDelete',
    )
    await expectSafeError(
      repository.restore({ id: 'not-a-uuid', updatedAtMs: 1 }),
      'INVALID_ID',
      'restore',
    )
  })

  test('allows empty and whitespace-only titles per the frozen Note contract', async () => {
    const { repository } = createFixture()
    const created = await repository.create({
      id: IDs.a,
      title: '   ',
      content: '',
      createdAtMs: 1,
    })
    expect(created.title).toBe('   ')
    expect(created.content).toBe('')
  })

  test('rejects non-string title or content with INVALID_TITLE', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.create({
        id: IDs.a,
        title: 123 as unknown as string,
        content: 'a',
        createdAtMs: 1,
      }),
      'INVALID_TITLE',
      'create',
    )
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await expectSafeError(
      repository.updateNote({
        id: IDs.a,
        title: 'a',
        content: null as unknown as string,
        updatedAtMs: 2,
      }),
      'INVALID_TITLE',
      'updateNote',
    )
  })

  test('rejects invalid timestamps with PERSISTENCE_ERROR', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: -1 }),
      'PERSISTENCE_ERROR',
      'create',
    )
    await repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 })
    await expectSafeError(
      repository.updateNote({ id: IDs.a, title: 'a', content: 'a', updatedAtMs: Number.NaN }),
      'PERSISTENCE_ERROR',
      'updateNote',
    )
    await expectSafeError(
      repository.softDelete({ id: IDs.a, updatedAtMs: -5 }),
      'PERSISTENCE_ERROR',
      'softDelete',
    )
    await expectSafeError(
      repository.restore({ id: IDs.a, updatedAtMs: Number.POSITIVE_INFINITY }),
      'PERSISTENCE_ERROR',
      'restore',
    )
  })

  test('does not leak raw persistence details in error messages', async () => {
    const { repository, backend } = createFixture()
    backend.failNext('PERSISTENCE_ERROR', 'OPFS quota exceeded WASM stack DOMException token secret')
    await expectSafeError(
      repository.create({ id: IDs.a, title: 'a', content: 'a', createdAtMs: 1 }),
      'PERSISTENCE_ERROR',
      'create',
    )
  })

  test('maps STATUS_CONFLICT and persistence failure codes to PERSISTENCE_ERROR', async () => {
    const { repository, backend } = createFixture()
    backend.failNext('PERSISTENCE_ERROR', 'SQL=INSERT conflict')
    await expectSafeError(
      repository.updateNote({ id: IDs.a, title: 'a', content: 'a', updatedAtMs: 1 }),
      'PERSISTENCE_ERROR',
      'updateNote',
    )
  })

  test('fails PERSISTENCE_ERROR when listActive response is malformed', async () => {
    const backend = new NoteContractBackend()
    const worker: TaskWorkerEndpoint = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(request: TaskWorkerRequest): void {
        if (request.type === 'note.listActive') {
          worker.onmessage?.(
            new MessageEvent('message', {
              data: {
                requestId: request.requestId,
                ok: true,
                result: { not: 'an array' },
              } satisfies TaskWorkerResponse,
            }),
          )
        } else {
          void backend.listActiveNotes()
        }
      },
      terminate(): void {},
    }
    const repository = new WebNoteRepository(new TaskWorkerClient(worker))
    await expectSafeError(repository.listActive(), 'PERSISTENCE_ERROR', 'listActive')
  })

  test('rejects malformed Note payloads from worker responses', async () => {
    const worker: TaskWorkerEndpoint = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(request: TaskWorkerRequest): void {
        worker.onmessage?.(
          new MessageEvent('message', {
            data: {
              requestId: request.requestId,
              ok: true,
              result: { id: 'not-a-uuid', title: 'a', content: 'a', createdAtMs: 1, updatedAtMs: 1, deletedAtMs: null },
            } satisfies TaskWorkerResponse,
          }),
        )
      },
      terminate(): void {},
    }
    const repository = new WebNoteRepository(new TaskWorkerClient(worker))
    await expectSafeError(repository.listActive(), 'PERSISTENCE_ERROR', 'listActive')
  })
})
