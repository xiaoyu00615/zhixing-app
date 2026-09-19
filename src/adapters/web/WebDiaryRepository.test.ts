import { describe, expect, test } from 'vitest'
import { WebDiaryRepository } from './WebDiaryRepository'
import { TaskWorkerClient, type TaskWorkerEndpoint } from './taskWorkerClient'
import type {
  TaskWorkerRequest,
  TaskWorkerResponse,
} from './taskWorkerProtocol'
import {
  DIARY_REPOSITORY_ERROR_CODES,
  DiaryRepositoryError,
  type ChangeDiaryDateInput,
  type CreateDiaryEntryInput,
  type DiaryRepositoryErrorCode,
  type DiaryRepositoryOperation,
  type RestoreDiaryEntryInput,
  type SoftDeleteDiaryEntryInput,
  type UpdateDiaryEntryInput,
} from '@/diary/repository'
import type { DiaryEntry } from '@/diary/model'

const IDs = {
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
  missing: '00000000-0000-4000-8000-000000000099',
} as const

const DATE = {
  d1: '2024-03-15',
  d2: '2024-04-01',
  d3: '2024-04-02',
} as const

class DiaryContractBackendError extends Error {
  readonly code: DiaryRepositoryErrorCode
  readonly rawDetails: string
  constructor(code: DiaryRepositoryErrorCode, rawDetails: string) {
    super(rawDetails)
    this.name = 'DiaryContractBackendError'
    this.code = code
    this.rawDetails = rawDetails
  }
}

class DiaryContractBackend {
  readonly #entries = new Map<string, DiaryEntry>()
  #nextFailure: DiaryContractBackendError | null = null
  callCount = 0

  failNext(code: DiaryRepositoryErrorCode, rawDetails: string): void {
    this.#nextFailure = new DiaryContractBackendError(code, rawDetails)
  }

  private requireActive(id: string): DiaryEntry {
    const current = this.#entries.get(id)
    if (current === undefined || current.deletedAtMs !== null) {
      throw new DiaryContractBackendError('NOT_FOUND', `entry ${id} not active`)
    }
    return current
  }

  private activeOwnsDate(
    diaryDate: string,
    excludeId: string | null,
  ): boolean {
    for (const entry of this.#entries.values()) {
      if (entry.deletedAtMs !== null) continue
      if (entry.diaryDate !== diaryDate) continue
      if (excludeId !== null && entry.id === excludeId) continue
      return true
    }
    return false
  }

  createDiaryEntry(input: CreateDiaryEntryInput): DiaryEntry {
    this.callCount += 1
    this.consumeFailure()
    if (this.#entries.has(input.id)) {
      throw new DiaryContractBackendError(
        'PERSISTENCE_ERROR',
        'UNIQUE constraint failed: diary_entries.id SQL=INSERT INTO diary_entries',
      )
    }
    if (this.activeOwnsDate(input.diaryDate, null)) {
      throw new DiaryContractBackendError(
        'DIARY_DATE_CONFLICT',
        'UNIQUE constraint failed: diary_entries.diary_date',
      )
    }
    const entry: DiaryEntry = {
      id: input.id,
      title: input.title,
      content: input.content,
      diaryDate: input.diaryDate,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      deletedAtMs: null,
    }
    this.#entries.set(entry.id, entry)
    return { ...entry }
  }

  getActiveDiaryEntry(id: string): DiaryEntry | null {
    this.callCount += 1
    this.consumeFailure()
    const current = this.#entries.get(id)
    if (current === undefined || current.deletedAtMs !== null) return null
    return { ...current }
  }

  getActiveDiaryEntryByDate(diaryDate: string): DiaryEntry | null {
    this.callCount += 1
    this.consumeFailure()
    for (const entry of this.#entries.values()) {
      if (entry.deletedAtMs === null && entry.diaryDate === diaryDate) {
        return { ...entry }
      }
    }
    return null
  }

  listActiveDiaryEntries(): DiaryEntry[] {
    this.callCount += 1
    this.consumeFailure()
    return [...this.#entries.values()]
      .filter((entry) => entry.deletedAtMs === null)
      .sort(
        (a, b) =>
          b.diaryDate.localeCompare(a.diaryDate) ||
          b.updatedAtMs - a.updatedAtMs ||
          a.id.localeCompare(b.id),
      )
      .map((entry) => ({ ...entry }))
  }

  updateDiaryEntry(input: UpdateDiaryEntryInput): DiaryEntry {
    this.callCount += 1
    this.consumeFailure()
    const current = this.requireActive(input.id)
    const changed: DiaryEntry = {
      ...current,
      title: input.title,
      content: input.content,
      updatedAtMs: input.updatedAtMs,
    }
    this.#entries.set(input.id, changed)
    return { ...changed }
  }

  changeDiaryDate(input: ChangeDiaryDateInput): DiaryEntry {
    this.callCount += 1
    this.consumeFailure()
    const current = this.requireActive(input.id)
    if (this.activeOwnsDate(input.diaryDate, input.id)) {
      throw new DiaryContractBackendError(
        'DIARY_DATE_CONFLICT',
        'UNIQUE constraint failed: diary_entries.diary_date',
      )
    }
    const changed: DiaryEntry = {
      ...current,
      diaryDate: input.diaryDate,
      updatedAtMs: input.updatedAtMs,
    }
    this.#entries.set(input.id, changed)
    return { ...changed }
  }

  softDeleteDiaryEntry(input: SoftDeleteDiaryEntryInput): void {
    this.callCount += 1
    this.consumeFailure()
    const current = this.requireActive(input.id)
    this.#entries.set(input.id, {
      ...current,
      deletedAtMs: input.updatedAtMs,
      updatedAtMs: input.updatedAtMs,
    })
  }

  restoreDiaryEntry(input: RestoreDiaryEntryInput): void {
    this.callCount += 1
    this.consumeFailure()
    const current = this.#entries.get(input.id)
    if (current === undefined || current.deletedAtMs === null) {
      throw new DiaryContractBackendError('NOT_FOUND', 'entry not trashed')
    }
    if (this.activeOwnsDate(current.diaryDate, null)) {
      throw new DiaryContractBackendError(
        'DIARY_DATE_CONFLICT',
        'UNIQUE constraint failed: diary_entries.diary_date',
      )
    }
    this.#entries.set(input.id, {
      ...current,
      deletedAtMs: null,
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

class DiaryWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  constructor(readonly backend: DiaryContractBackend) {}

  postMessage(request: TaskWorkerRequest): void {
    try {
      let result: unknown
      switch (request.type) {
        case 'diary.create':
          result = this.backend.createDiaryEntry(request.input)
          break
        case 'diary.getActiveById':
          result = this.backend.getActiveDiaryEntry(request.id)
          break
        case 'diary.getActiveByDiaryDate':
          result = this.backend.getActiveDiaryEntryByDate(request.diaryDate)
          break
        case 'diary.listActive':
          result = this.backend.listActiveDiaryEntries()
          break
        case 'diary.updateDiaryEntry':
          result = this.backend.updateDiaryEntry(request.input)
          break
        case 'diary.changeDiaryDate':
          result = this.backend.changeDiaryDate(request.input)
          break
        case 'diary.softDelete':
          this.backend.softDeleteDiaryEntry(request.input)
          result = null
          break
        case 'diary.restore':
          this.backend.restoreDiaryEntry(request.input)
          result = null
          break
        default:
          throw new Error(`Unexpected request ${request.type}`)
      }
      this.respond({ requestId: request.requestId, ok: true, result })
    } catch (error: unknown) {
      if (error instanceof DiaryContractBackendError) {
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
  code: DiaryRepositoryErrorCode,
  operation: DiaryRepositoryOperation,
): Promise<void> {
  const error = await promise.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(DiaryRepositoryError)
  expect(error).toMatchObject({ code, operation })
  expect((error as Error).message).not.toMatch(
    /SQL|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
  )
}

function createFixture(): {
  repository: WebDiaryRepository
  backend: DiaryContractBackend
} {
  const backend = new DiaryContractBackend()
  return {
    repository: new WebDiaryRepository(new TaskWorkerClient(new DiaryWorker(backend))),
    backend,
  }
}

describe('WebDiaryRepository', () => {
  test('freezes DIARY_REPOSITORY_ERROR_CODES in canonical order', () => {
    expect(DIARY_REPOSITORY_ERROR_CODES).toEqual([
      'INVALID_ID',
      'NOT_FOUND',
      'INVALID_TITLE',
      'INVALID_DIARY_DATE',
      'DIARY_DATE_CONFLICT',
      'PERSISTENCE_ERROR',
    ])
  })

  test('creates a diary entry with updatedAtMs equal to createdAtMs and null deletedAtMs', async () => {
    const { repository } = createFixture()
    const created = await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'First entry',
      content: 'body',
      createdAtMs: 1000,
    })
    expect(created).toEqual({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'First entry',
      content: 'body',
      createdAtMs: 1000,
      updatedAtMs: 1000,
      deletedAtMs: null,
    })
  })

  test('rejects duplicate create with PERSISTENCE_ERROR and never maps it to DIARY_DATE_CONFLICT', async () => {
    const { repository } = createFixture()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await expectSafeError(
      repository.create({
        id: IDs.a,
        diaryDate: DATE.d2,
        title: 'again',
        content: 'again',
        createdAtMs: 2,
      }),
      'PERSISTENCE_ERROR',
      'create',
    )
  })

  test('changeDiaryDate moves to a free date and keeps id/title/content/createdAtMs', async () => {
    const { repository } = createFixture()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    const moved = await repository.changeDiaryDate({
      id: IDs.a,
      diaryDate: DATE.d2,
      updatedAtMs: 50,
    })
    expect(moved).toMatchObject({
      id: IDs.a,
      diaryDate: DATE.d2,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
      updatedAtMs: 50,
    })
  })

  test('changeDiaryDate to a date owned by another active entry maps DIARY_DATE_CONFLICT', async () => {
    const { repository } = createFixture()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await repository.create({
      id: IDs.b,
      diaryDate: DATE.d2,
      title: 'b',
      content: 'b',
      createdAtMs: 2,
    })
    await expectSafeError(
      repository.changeDiaryDate({ id: IDs.a, diaryDate: DATE.d2, updatedAtMs: 3 }),
      'DIARY_DATE_CONFLICT',
      'changeDiaryDate',
    )
  })

  test('changeDiaryDate to its own current date does not self-conflict', async () => {
    const { repository } = createFixture()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    const moved = await repository.changeDiaryDate({
      id: IDs.a,
      diaryDate: DATE.d1,
      updatedAtMs: 5,
    })
    expect(moved.diaryDate).toBe(DATE.d1)
  })

  test('getActiveById returns null for a missing or soft-deleted entry', async () => {
    const { repository } = createFixture()
    expect(await repository.getActiveById(IDs.missing)).toBeNull()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    expect(await repository.getActiveById(IDs.a)).toBeNull()
  })

  test('getActiveByDiaryDate returns the active entry or null', async () => {
    const { repository } = createFixture()
    expect(await repository.getActiveByDiaryDate(DATE.d1)).toBeNull()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    const byDate = await repository.getActiveByDiaryDate(DATE.d1)
    expect(byDate?.id).toBe(IDs.a)
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    expect(await repository.getActiveByDiaryDate(DATE.d1)).toBeNull()
  })

  test('updateDiaryEntry preserves diaryDate and createdAtMs', async () => {
    const { repository } = createFixture()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'before',
      content: 'before',
      createdAtMs: 100,
    })
    const updated = await repository.updateDiaryEntry({
      id: IDs.a,
      title: 'after',
      content: 'after',
      updatedAtMs: 500,
    })
    expect(updated).toMatchObject({
      id: IDs.a,
      diaryDate: DATE.d1,
      createdAtMs: 100,
      title: 'after',
      content: 'after',
      updatedAtMs: 500,
    })
  })

  test('updateDiaryEntry / softDelete / restore map NOT_FOUND for missing or precondition violations', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.updateDiaryEntry({
        id: IDs.missing,
        title: 'x',
        content: 'x',
        updatedAtMs: 1,
      }),
      'NOT_FOUND',
      'updateDiaryEntry',
    )
    await expectSafeError(
      repository.softDelete({ id: IDs.missing, updatedAtMs: 1 }),
      'NOT_FOUND',
      'softDelete',
    )
    await expectSafeError(
      repository.restore({ id: IDs.missing, updatedAtMs: 1 }),
      'NOT_FOUND',
      'restore',
    )
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    // Restoring a soft-deleted entry succeeds and revives it.
    await repository.restore({ id: IDs.a, updatedAtMs: 3 })
    expect(await repository.getActiveById(IDs.a)).not.toBeNull()
    // Restoring an already-active entry throws NOT_FOUND.
    await expectSafeError(
      repository.restore({ id: IDs.a, updatedAtMs: 4 }),
      'NOT_FOUND',
      'restore',
    )
  })

  test('restore revives a soft-deleted entry', async () => {
    const { repository } = createFixture()
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await repository.softDelete({ id: IDs.a, updatedAtMs: 2 })
    await repository.restore({ id: IDs.a, updatedAtMs: 3 })
    const restored = await repository.getActiveById(IDs.a)
    expect(restored).toMatchObject({
      id: IDs.a,
      diaryDate: DATE.d1,
      deletedAtMs: null,
      updatedAtMs: 3,
    })
  })

  test('rejects invalid UUIDs before dispatch with INVALID_ID', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.create({
        id: 'not-a-uuid',
        diaryDate: DATE.d1,
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      }),
      'INVALID_ID',
      'create',
    )
    await expectSafeError(
      repository.getActiveById('not-a-uuid'),
      'INVALID_ID',
      'getActiveById',
    )
    await expectSafeError(
      repository.changeDiaryDate({ id: 'not-a-uuid', diaryDate: DATE.d2, updatedAtMs: 1 }),
      'INVALID_ID',
      'changeDiaryDate',
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

  test('rejects invalid diary dates before dispatch with INVALID_DIARY_DATE', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.create({
        id: IDs.a,
        diaryDate: 'not-a-date',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      }),
      'INVALID_DIARY_DATE',
      'create',
    )
    await expectSafeError(
      repository.getActiveByDiaryDate('2024-13-99'),
      'INVALID_DIARY_DATE',
      'getActiveByDiaryDate',
    )
    await expectSafeError(
      repository.changeDiaryDate({ id: IDs.a, diaryDate: 'bad', updatedAtMs: 1 }),
      'INVALID_DIARY_DATE',
      'changeDiaryDate',
    )
  })

  test('allows empty and whitespace-only titles per the frozen Diary contract', async () => {
    const { repository } = createFixture()
    const created = await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
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
        diaryDate: DATE.d1,
        title: 123 as unknown as string,
        content: 'a',
        createdAtMs: 1,
      }),
      'INVALID_TITLE',
      'create',
    )
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await expectSafeError(
      repository.updateDiaryEntry({
        id: IDs.a,
        title: 'a',
        content: null as unknown as string,
        updatedAtMs: 2,
      }),
      'INVALID_TITLE',
      'updateDiaryEntry',
    )
  })

  test('rejects invalid timestamps with PERSISTENCE_ERROR', async () => {
    const { repository } = createFixture()
    await expectSafeError(
      repository.create({
        id: IDs.a,
        diaryDate: DATE.d1,
        title: 'a',
        content: 'a',
        createdAtMs: -1,
      }),
      'PERSISTENCE_ERROR',
      'create',
    )
    await repository.create({
      id: IDs.a,
      diaryDate: DATE.d1,
      title: 'a',
      content: 'a',
      createdAtMs: 1,
    })
    await expectSafeError(
      repository.updateDiaryEntry({
        id: IDs.a,
        title: 'a',
        content: 'a',
        updatedAtMs: Number.NaN,
      }),
      'PERSISTENCE_ERROR',
      'updateDiaryEntry',
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

  test('does not invoke the client when local validation rejects', async () => {
    const { repository, backend } = createFixture()
    const before = backend.callCount
    await expectSafeError(
      repository.create({
        id: 'not-a-uuid',
        diaryDate: DATE.d1,
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      }),
      'INVALID_ID',
      'create',
    )
    await expectSafeError(
      repository.getActiveByDiaryDate('bad-date'),
      'INVALID_DIARY_DATE',
      'getActiveByDiaryDate',
    )
    expect(backend.callCount).toBe(before)
  })

  test('does not leak raw persistence details in error messages', async () => {
    const { repository, backend } = createFixture()
    backend.failNext('PERSISTENCE_ERROR', 'OPFS quota exceeded WASM stack DOMException token secret')
    await expectSafeError(
      repository.create({
        id: IDs.a,
        diaryDate: DATE.d1,
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      }),
      'PERSISTENCE_ERROR',
      'create',
    )
  })

  test('maps any non-Diary client error to PERSISTENCE_ERROR', async () => {
    const { repository, backend } = createFixture()
    backend.failNext('PERSISTENCE_ERROR', 'SQL=INSERT conflict')
    await expectSafeError(
      repository.updateDiaryEntry({
        id: IDs.a,
        title: 'a',
        content: 'a',
        updatedAtMs: 1,
      }),
      'PERSISTENCE_ERROR',
      'updateDiaryEntry',
    )
  })

  test('fails PERSISTENCE_ERROR when listActive response is malformed', async () => {
    const backend = new DiaryContractBackend()
    const worker: TaskWorkerEndpoint = {
      onmessage: null,
      onerror: null,
      onmessageerror: null,
      postMessage(request: TaskWorkerRequest): void {
        if (request.type === 'diary.listActive') {
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
          void backend.listActiveDiaryEntries()
        }
      },
      terminate(): void {},
    }
    const repository = new WebDiaryRepository(new TaskWorkerClient(worker))
    await expectSafeError(repository.listActive(), 'PERSISTENCE_ERROR', 'listActive')
  })

  test('rejects malformed Diary payloads from worker responses', async () => {
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
              result: {
                id: 'not-a-uuid',
                diaryDate: '2024-03-15',
                title: 'a',
                content: 'a',
                createdAtMs: 1,
                updatedAtMs: 1,
                deletedAtMs: null,
              },
            } satisfies TaskWorkerResponse,
          }),
        )
      },
      terminate(): void {},
    }
    const repository = new WebDiaryRepository(new TaskWorkerClient(worker))
    await expectSafeError(
      repository.listActive(),
      'PERSISTENCE_ERROR',
      'listActive',
    )
  })
})
