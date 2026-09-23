import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest'

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

const ID = {
  task: '00000000-0000-4000-8000-000000000001',
  roundTrip: '00000000-0000-4000-8000-000000000003',
  note: '00000000-0000-4000-8000-000000000002',
  missing: '00000000-0000-4000-8000-000000000099',
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

async function expectSuccess(requestId: number, data: unknown): Promise<unknown> {
  send({ requestId, ...(data as Record<string, unknown>) })
  const response = await waitForResponse()
  expect(response).toMatchObject({ requestId, ok: true })
  return (response as { result: unknown }).result
}

beforeEach(() => {
  responses.length = 0
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('taskPersistence.worker task.archive / task.unarchive routing', () => {
  test('archives a task out of the active list and unarchives it back', async () => {
    await expectSuccess(1, {
      type: 'task.create',
      input: { id: ID.task, title: 'Archivable', createdAtMs: 100 },
    })

    const archived = await expectSuccess(2, {
      type: 'task.archive',
      input: { id: ID.task, updatedAtMs: 200 },
    })
    expect(archived).toMatchObject({
      id: ID.task,
      archivedAtMs: 200,
      deletedAtMs: null,
    })
    expect(
      await expectSuccess(3, { type: 'task.list' }),
    ).toEqual([])

    const unarchived = await expectSuccess(4, {
      type: 'task.unarchive',
      input: { id: ID.task, updatedAtMs: 300 },
    })
    expect(unarchived).toMatchObject({
      id: ID.task,
      archivedAtMs: null,
      updatedAtMs: 300,
    })
    const active = (await expectSuccess(5, { type: 'task.list' })) as unknown[]
    expect(active).toHaveLength(1)
  })

  test('Archive -> Trash -> Restore -> Archive survives the worker round trip', async () => {
    await expectSuccess(10, {
      type: 'task.create',
      input: { id: ID.roundTrip, title: 'Round trip', createdAtMs: 100 },
    })
    await expectSuccess(11, {
      type: 'task.archive',
      input: { id: ID.roundTrip, updatedAtMs: 200 },
    })
    const trashed = await expectSuccess(12, {
      type: 'task.trash',
      input: { id: ID.roundTrip, updatedAtMs: 300 },
    })
    expect(trashed).toMatchObject({ deletedAtMs: 300, archivedAtMs: 200 })

    const restored = await expectSuccess(13, {
      type: 'task.restore',
      input: { id: ID.roundTrip, updatedAtMs: 400 },
    })
    expect(restored).toMatchObject({ deletedAtMs: null, archivedAtMs: 200 })

    const unarchived = await expectSuccess(14, {
      type: 'task.unarchive',
      input: { id: ID.roundTrip, updatedAtMs: 500 },
    })
    expect(unarchived).toMatchObject({ archivedAtMs: null, updatedAtMs: 500 })
  })

  test('task.archive on a missing id returns the Task NOT_FOUND failure envelope', async () => {
    send({
      requestId: 20,
      type: 'task.archive',
      input: { id: ID.missing, updatedAtMs: 100 },
    })
    expect(await waitForResponse()).toMatchObject({
      requestId: 20,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })

  test('malformed task.archive input returns a Task PERSISTENCE_FAILED envelope', async () => {
    send({
      requestId: 21,
      type: 'task.archive',
      input: { id: ID.task, updatedAtMs: -1 },
    })
    expect(await waitForResponse()).toMatchObject({
      requestId: 21,
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    })
  })
})

describe('taskPersistence.worker note.archive / note.unarchive routing', () => {
  test('archives a note out of the active reads and unarchives it back', async () => {
    await expectSuccess(30, {
      type: 'note.create',
      input: {
        id: ID.note,
        title: '  Keep me  ',
        content: 'raw  content\n',
        createdAtMs: 100,
      },
    })

    await expectSuccess(31, {
      type: 'note.archive',
      input: { id: ID.note, updatedAtMs: 200 },
    })
    expect(
      await expectSuccess(32, { type: 'note.getActiveById', id: ID.note }),
    ).toBeNull()
    expect(
      await expectSuccess(33, { type: 'note.listActive' }),
    ).toEqual([])

    await expectSuccess(34, {
      type: 'note.unarchive',
      input: { id: ID.note, updatedAtMs: 300 },
    })
    const note = (await expectSuccess(35, {
      type: 'note.getActiveById',
      id: ID.note,
    })) as Record<string, unknown>
    expect(note).toMatchObject({
      id: ID.note,
      title: '  Keep me  ',
      content: 'raw  content\n',
      updatedAtMs: 300,
      archivedAtMs: null,
      deletedAtMs: null,
    })
  })

  test('note.archive on a missing id returns the Note NOT_FOUND failure envelope', async () => {
    send({
      requestId: 40,
      type: 'note.archive',
      input: { id: ID.missing, updatedAtMs: 100 },
    })
    expect(await waitForResponse()).toMatchObject({
      requestId: 40,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
  })

  test('malformed note.archive never falls through to the Task failure emitter', async () => {
    send({
      requestId: 41,
      type: 'note.archive',
      input: { id: 'not-a-uuid', updatedAtMs: 100 },
    })
    expect(await waitForResponse()).toMatchObject({
      requestId: 41,
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
})
