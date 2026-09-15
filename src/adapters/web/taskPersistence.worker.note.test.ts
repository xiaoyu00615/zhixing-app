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
import type { Note } from '@/note/model'

const ID = {
  note: '00000000-0000-4000-8000-000000000001',
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

describe('taskPersistence.worker note.* direct routing', () => {
  test('note.create routes to the Note path, executes SQL and returns a success envelope', async () => {
    send({
      requestId: 1,
      type: 'note.create',
      input: {
        id: ID.note,
        title: 'Routed note',
        content: 'body',
        createdAtMs: 100,
      },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 1, ok: true })
    const result = (response as { result: Note }).result
    expect(result).toMatchObject({
      id: ID.note,
      title: 'Routed note',
      content: 'body',
      createdAtMs: 100,
      updatedAtMs: 100,
      deletedAtMs: null,
    })
  })

  test('note.getActiveById routes to the Note path and returns the created note', async () => {
    send({ requestId: 2, type: 'note.getActiveById', id: ID.note })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 2, ok: true })
    const result = (response as { result: Note | null }).result
    expect(result).not.toBeNull()
    expect(result).toMatchObject({ id: ID.note, title: 'Routed note' })
  })

  test('malformed note.create returns a Note failure envelope with PERSISTENCE_ERROR', async () => {
    send({
      requestId: 3,
      type: 'note.create',
      input: { id: 'not-a-uuid', title: '', content: '', createdAtMs: -1 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 3,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('unknown note.* request returns a Note failure envelope with PERSISTENCE_ERROR', async () => {
    send({ requestId: 4, type: 'note.unknown' })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 4,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('malformed and unknown note.* never fall through to the Task parser', async () => {
    send({
      requestId: 5,
      type: 'note.create',
      input: { id: 'bad', title: '', content: '', createdAtMs: -1 },
    })
    const malformed = await waitForResponse()
    expect(malformed).toMatchObject({
      requestId: 5,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })

    send({ requestId: 6, type: 'note.unknown' })
    const unknown = await waitForResponse()
    expect(unknown).toMatchObject({
      requestId: 6,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })

    // No Task-domain PERSISTENCE_FAILED envelope was produced by either request.
    const taskFailure = responses.filter(
      (value) =>
        (value as { error?: { code?: string } }).error?.code ===
        'PERSISTENCE_FAILED',
    )
    expect(taskFailure).toEqual([])
  })

  test('note.updateNote on a missing note returns a Note NOT_FOUND envelope', async () => {
    send({
      requestId: 7,
      type: 'note.updateNote',
      input: {
        id: ID.missing,
        title: 'x',
        content: 'x',
        updatedAtMs: 50,
      },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 7,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    const taskFailure = responses.filter(
      (value) =>
        (value as { error?: { code?: string } }).error?.code ===
        'PERSISTENCE_FAILED',
    )
    expect(taskFailure).toEqual([])
  })

  test('task.create still routes to the Task path (regression)', async () => {
    send({
      requestId: 8,
      type: 'task.create',
      input: { id: ID.task, title: 'Routed task', createdAtMs: 100 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 8, ok: true })
    const result = (response as { result: { id: string } }).result
    expect(result).toMatchObject({ id: ID.task, title: 'Routed task' })
  })
})
