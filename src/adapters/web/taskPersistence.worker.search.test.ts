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
import type { SearchResult } from '@/search/model'

const ID = {
  note: '00000000-0000-4000-8000-000000000001',
  noteChinese: '00000000-0000-4000-8000-000000000002',
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

describe('taskPersistence.worker search.query direct routing', () => {
  test('search.query routes to the Search path, executes SQL and returns a success envelope', async () => {
    send({
      requestId: 1,
      type: 'note.create',
      input: {
        id: ID.note,
        title: 'Planning note',
        content: 'project planning for q3',
        createdAtMs: 100,
      },
    })
    const noteResponse = await waitForResponse()
    expect(noteResponse).toMatchObject({ requestId: 1, ok: true })

    send({
      requestId: 2,
      type: 'search.query',
      input: { query: 'planning', limit: 50 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 2, ok: true })
    const result = (response as { result: SearchResult[] }).result
    expect(Array.isArray(result)).toBe(true)
    expect(result.map((r) => r.entityId)).toEqual([ID.note])
    expect(result[0]?.entityType).toBe('note')
    expect(result[0]?.snippet.toLowerCase()).toContain('planning')
  })

  test('search.query supports Chinese 2-char LIKE fallback', async () => {
    send({
      requestId: 3,
      type: 'note.create',
      input: {
        id: ID.noteChinese,
        title: '中文计划',
        content: '这是中文计划内容',
        createdAtMs: 100,
      },
    })
    await waitForResponse()

    send({
      requestId: 4,
      type: 'search.query',
      input: { query: '计划', limit: 50 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 4, ok: true })
    const result = (response as { result: SearchResult[] }).result
    expect(result.map((r) => r.entityId)).toEqual([ID.noteChinese])
    expect(result[0]?.snippet).toContain('计划')
  })

  test('search.query with >16 terms returns a Search INVALID_QUERY envelope', async () => {
    send({
      requestId: 5,
      type: 'search.query',
      input: {
        query: Array.from({ length: 17 }, (_, i) => `t${i}`).join(' '),
        limit: 50,
      },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 5,
      ok: false,
      error: { code: 'INVALID_QUERY' },
    })
  })

  test('malformed search.query returns a Search failure envelope with PERSISTENCE_ERROR', async () => {
    send({ requestId: 6, type: 'search.query', input: { query: 'x' } })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 6,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('unknown search.* request returns a Search failure envelope with PERSISTENCE_ERROR', async () => {
    send({ requestId: 7, type: 'search.unknown' })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 7,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('malformed and unknown search.* never fall through to the Task parser', async () => {
    send({ requestId: 8, type: 'search.query', input: { query: 'x' } })
    const malformed = await waitForResponse()
    expect(malformed).toMatchObject({
      requestId: 8,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })

    send({ requestId: 9, type: 'search.unknown' })
    const unknown = await waitForResponse()
    expect(unknown).toMatchObject({
      requestId: 9,
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

  test('task.create still routes to the Task path (regression)', async () => {
    send({
      requestId: 10,
      type: 'task.create',
      input: { id: ID.task, title: 'Routed task', createdAtMs: 100 },
    })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 10, ok: true })
    const result = (response as { result: { id: string } }).result
    expect(result).toMatchObject({ id: ID.task, title: 'Routed task' })
  })
})
