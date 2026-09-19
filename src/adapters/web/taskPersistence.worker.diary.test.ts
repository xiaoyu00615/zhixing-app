import { afterAll, describe, expect, test, vi } from 'vitest'

// The worker opens an OpfsDb and checks for the OPFS VFS. In this harness we
// keep the real sqlite-wasm runtime but point OpfsDb at an in-memory database
// and report the OPFS VFS as present, so the worker reaches AVAILABLE and
// executes real SQL against the migration schema.
vi.mock('@sqlite.org/sqlite-wasm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@sqlite.org/sqlite-wasm')>()
  return {
    ...actual,
    default: async () => {
      const sqlite3 = await actual.default()
      const OpfsDbShim = new Proxy(sqlite3.oo1.DB, {
        construct(target, args: unknown[]) {
          void args
          return Reflect.construct(target, [':memory:', 'c'])
        },
      })
      return {
        ...sqlite3,
        capi: {
          ...sqlite3.capi,
          sqlite3_vfs_find: ((name: string | null) =>
            name === 'opfs' ? 1 : null) as typeof sqlite3.capi.sqlite3_vfs_find,
        },
        oo1: {
          ...sqlite3.oo1,
          OpfsDb: OpfsDbShim as unknown as typeof sqlite3.oo1.OpfsDb,
        },
      }
    },
  }
})

// Import after the mock is registered so the worker's top-level statements
// bind the in-memory-backed runtime.
import '@/adapters/web/taskPersistence.worker'
import type { DiaryEntry } from '@/diary/model'

const ID = {
  entry: '00000000-0000-4000-8000-000000000001',
  other: '00000000-0000-4000-8000-000000000002',
  missing: '00000000-0000-4000-8000-000000000099',
  task: '00000000-0000-4000-8000-000000000101',
} as const

const responses: unknown[] = []

vi.stubGlobal('crossOriginIsolated', true)
vi.stubGlobal('navigator', {
  storage: { getDirectory: () => Promise.resolve({}) },
})

const workerSelf = globalThis.self as unknown as {
  postMessage: (data: unknown) => void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}

Object.defineProperty(workerSelf, 'postMessage', {
  configurable: true,
  writable: true,
  value: (data: unknown) => {
    responses.push(data)
  },
})

function send(data: unknown): void {
  expect(workerSelf.onmessage).not.toBeNull()
  workerSelf.onmessage?.(new MessageEvent('message', { data }))
}

async function waitForResponse(): Promise<unknown> {
  await vi.waitFor(
    () => {
      expect(responses).not.toHaveLength(0)
    },
    { timeout: 15000, interval: 50 },
  )
  return responses.shift()
}

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('taskPersistence.worker diary.* direct routing', () => {
  test('diary.create routes to the Diary path, executes SQL and returns a success envelope', async () => {
    send({
      requestId: 1,
      type: 'diary.create',
      input: {
        id: ID.entry,
        diaryDate: '2024-03-15',
        title: 'Routed entry',
        content: 'body',
        createdAtMs: 100,
      },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 1, ok: true })
    const result = (response as { result: DiaryEntry }).result
    expect(result).toMatchObject({
      id: ID.entry,
      diaryDate: '2024-03-15',
      title: 'Routed entry',
      content: 'body',
      createdAtMs: 100,
      updatedAtMs: 100,
      deletedAtMs: null,
    })
  })

  test('diary.getActiveById routes to the Diary path and returns the created entry', async () => {
    send({ requestId: 2, type: 'diary.getActiveById', id: ID.entry })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 2, ok: true })
    const result = (response as { result: DiaryEntry | null }).result
    expect(result).not.toBeNull()
    expect(result).toMatchObject({ id: ID.entry, diaryDate: '2024-03-15' })
  })

  test('diary.listActive routes to the Diary path and returns the active entries', async () => {
    send({ requestId: 3, type: 'diary.listActive' })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 3, ok: true })
    const result = (response as { result: DiaryEntry[] }).result
    expect(Array.isArray(result)).toBe(true)
    expect(result.map((entry) => entry.id)).toContain(ID.entry)
  })

  test('malformed diary.create returns a Diary failure envelope with PERSISTENCE_ERROR', async () => {
    send({
      requestId: 4,
      type: 'diary.create',
      input: { id: 'not-a-uuid', diaryDate: 'bad', title: '', content: '', createdAtMs: -1 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 4,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('unknown diary.* request returns a Diary failure envelope with PERSISTENCE_ERROR', async () => {
    send({ requestId: 5, type: 'diary.unknown' })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 5,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('malformed and unknown diary.* never fall through to the Task parser', async () => {
    send({
      requestId: 6,
      type: 'diary.create',
      input: { id: 'bad', diaryDate: 'x', title: '', content: '', createdAtMs: -1 },
    })
    const malformed = await waitForResponse()
    expect(malformed).toMatchObject({
      requestId: 6,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })

    send({ requestId: 7, type: 'diary.unknown' })
    const unknown = await waitForResponse()
    expect(unknown).toMatchObject({
      requestId: 7,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })

    const taskFailure = responses.filter(
      (value) =>
        (value as { error?: { code?: string } }).error?.code ===
        'PERSISTENCE_FAILED',
    )
    expect(taskFailure).toEqual([])
  })

  test('diary.changeDiaryDate to a date owned by another active entry returns a DIARY_DATE_CONFLICT envelope', async () => {
    send({
      requestId: 8,
      type: 'diary.create',
      input: {
        id: ID.other,
        diaryDate: '2024-04-01',
        title: 'other',
        content: 'b',
        createdAtMs: 200,
      },
    })
    await waitForResponse()
    send({
      requestId: 9,
      type: 'diary.changeDiaryDate',
      input: { id: ID.entry, diaryDate: '2024-04-01', updatedAtMs: 300 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 9,
      ok: false,
      error: { code: 'DIARY_DATE_CONFLICT' },
    })
  })

  test('diary.getActiveById for a missing entry returns a Diary null success envelope', async () => {
    send({ requestId: 10, type: 'diary.getActiveById', id: ID.missing })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 10, ok: true })
    expect((response as { result: DiaryEntry | null }).result).toBeNull()
  })

  test('task.create still routes to the Task path (regression)', async () => {
    send({
      requestId: 11,
      type: 'task.create',
      input: { id: ID.task, title: 'Routed task', createdAtMs: 100 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 11, ok: true })
    const result = (response as { result: { id: string } }).result
    expect(result).toMatchObject({ id: ID.task, title: 'Routed task' })
  })
})
