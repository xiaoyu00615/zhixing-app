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
import type { TrashItem } from '@/trash/model'

const ID = {
  note: '00000000-0000-4000-8000-000000000001',
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

beforeEach(() => {
  responses.length = 0
})

afterAll(() => {
  vi.unstubAllGlobals()
})

describe('taskPersistence.worker trash.list direct routing', () => {
  test('trash.list on an empty database returns a success envelope with an empty array', async () => {
    send({ requestId: 1, type: 'trash.list' })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 1, ok: true, result: [] })
  })

  test('trash.list returns a trashed note as a TrashItem', async () => {
    send({
      requestId: 2,
      type: 'note.create',
      input: { id: ID.note, title: 'Trashed note', content: 'body', createdAtMs: 100 },
    })
    const createResponse = await waitForResponse()
    expect(createResponse).toMatchObject({ requestId: 2, ok: true })

    send({ requestId: 3, type: 'note.softDelete', input: { id: ID.note, updatedAtMs: 200 } })
    const deleteResponse = await waitForResponse()
    expect(deleteResponse).toMatchObject({ requestId: 3, ok: true })

    send({ requestId: 4, type: 'trash.list' })
    const response = await waitForResponse()
    expect(response).toMatchObject({ requestId: 4, ok: true })
    const result = (response as { result: TrashItem[] }).result
    expect(Array.isArray(result)).toBe(true)
    expect(result).toHaveLength(1)
    expect(result[0]?.entityType).toBe('note')
    expect(result[0]?.entityId).toBe(ID.note)
    expect(result[0]?.title).toBe('Trashed note')
    expect(result[0]?.deletedAtMs).toBe(200)
  })

  test('unknown trash.* request returns a trash failure envelope with PERSISTENCE_ERROR', async () => {
    send({ requestId: 5, type: 'trash.unknown' })
    const response = await waitForResponse()
    expect(response).toMatchObject({
      requestId: 5,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('malformed and unknown trash.* never fall through to the Task parser', async () => {
    send({ requestId: 6, type: 'trash.unknown' })
    const unknown = await waitForResponse()
    expect(unknown).toMatchObject({
      requestId: 6,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })

    // No Task-domain PERSISTENCE_FAILED envelope was produced by the request.
    const taskFailure = responses.filter(
      (value) => (value as { error?: { code?: string } }).error?.code === 'PERSISTENCE_FAILED',
    )
    expect(taskFailure).toEqual([])
  })
})
