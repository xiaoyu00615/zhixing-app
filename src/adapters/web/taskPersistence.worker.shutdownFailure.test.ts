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
import { WebTaskDatabase } from '@/adapters/web/taskDatabase'

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

/**
 * P6-S4A2B2 §3/§12: a CONTROLLED normal-close failure. `shutdown` must turn
 * "the database could not be closed" into an OBSERVABLE outcome instead of a
 * swallowed exception, because `GenerationCloseOutcome` is built on it. The
 * whole file is about that single OPEN-state path, so the throwing
 * implementation is installed once for the module instance.
 */
const closeSpy = vi
  .spyOn(WebTaskDatabase.prototype, 'close')
  .mockImplementation(() => {
    throw new Error('normal close failed')
  })

function send(data: unknown): void {
  expect(workerSelf.onmessage).not.toBeNull()
  workerSelf.onmessage?.(new MessageEvent('message', { data }))
}

async function waitForResponses(count: number): Promise<unknown[]> {
  await vi.waitFor(
    () => {
      expect(responses.length).toBeGreaterThanOrEqual(count)
    },
    { timeout: 20000, interval: 10 },
  )
  return responses
}

function envelopeAt(index: number): {
  requestId: number
  ok: boolean
  error?: { code: string }
  result?: unknown
} {
  const value = responses[index]
  if (value === undefined) {
    throw new Error(`no response at index ${index}`)
  }
  return value as {
    requestId: number
    ok: boolean
    error?: { code: string }
    result?: unknown
  }
}

function expectSuccess(index: number, requestId: number): void {
  expect(envelopeAt(index)).toMatchObject({ requestId, ok: true })
}

function expectFailure(index: number, requestId: number, code: string): void {
  expect(envelopeAt(index)).toEqual({
    requestId,
    ok: false,
    error: { code },
  })
}

beforeEach(() => {
  responses.length = 0
})

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('taskPersistence.worker normal shutdown failure (P6-S4A2B2)', () => {
  test('H12: a throwing normal close becomes an explicit response and the queue survives', async () => {
    send({ requestId: 1, type: 'initialize' })
    await waitForResponses(1)
    expect(envelopeAt(0).result).toEqual({ status: 'AVAILABLE' })

    // The exception must NOT escape `handleRequest`: the serial `requestQueue`
    // has no `.catch()`, so an escaping rejection would silently poison every
    // later request instead of letting the caller observe a failed close.
    send({ requestId: 2, type: 'shutdown' })
    await waitForResponses(2)
    expectFailure(1, 2, 'PERSISTENCE_FAILED')
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // requestQueue alive, and the database was NOT actually closed.
    send({ requestId: 3, type: 'task.list' })
    await waitForResponses(3)
    expectSuccess(2, 3)

    // Normal semantics stay best-effort and caller-driven: a SECOND explicit
    // shutdown is still allowed to try (this is not an automatic retry, and it
    // is not the strict-close path, which never retries) — and it must stay
    // contained just the same.
    send({ requestId: 4, type: 'shutdown' })
    await waitForResponses(4)
    expectFailure(3, 4, 'PERSISTENCE_FAILED')
    expect(closeSpy).toHaveBeenCalledTimes(2)

    // Still alive afterwards.
    send({ requestId: 5, type: 'task.list' })
    await waitForResponses(5)
    expectSuccess(4, 5)
  })
})
