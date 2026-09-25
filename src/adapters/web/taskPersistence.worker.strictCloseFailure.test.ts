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
 * P6-S4A2B1 §23: a CONTROLLED close failure. `WebTaskDatabase.close()` is not
 * idempotent and its real-world failure mode is an exception, so the harness
 * makes it throw on demand. Installed at file scope because this whole file is
 * about the failure path and the assertion "the database was attempted exactly
 * once, ever" is a file-level claim.
 */
const closeSpy = vi
  .spyOn(WebTaskDatabase.prototype, 'close')
  .mockImplementation(() => {
    throw new Error('strict close failed')
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

function leaseIdAt(index: number): string {
  const result = envelopeAt(index).result as { leaseId?: unknown } | undefined
  if (result === null || result === undefined || typeof result.leaseId !== 'string') {
    throw new Error(`no maintenance lease id at index ${index}`)
  }
  return result.leaseId
}

beforeEach(() => {
  responses.length = 0
})

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * NOTE ON ORDERING: `maintenanceCloseState` is module state shared by every
 * test in this file, and INDETERMINATE is TERMINAL for the module instance.
 * C-B therefore creates the failure state and C-G — which must observe that
 * exact state — follows it. C-G re-proves the precondition itself so it cannot
 * silently pass against a non-terminal state.
 *
 * C-B also owns the INDETERMINATE row of the frozen SHUTDOWN MATRIX:
 * INDETERMINATE ⇒ shutdown FAILS with PERSISTENCE_FAILED, the database is not
 * closed again, and the failure is a normal response (queue stays alive).
 */
describe('taskPersistence.worker STRICT close failure (P6-S4A2B1)', () => {
  test('C-B: a throwing close becomes an explicit response; INDETERMINATE then fails shutdown and never retries the close', async () => {
    send({ requestId: 1, type: 'initialize' })
    send({ requestId: 2, type: 'maintenance.enter' })
    await waitForResponses(2)
    expect(envelopeAt(0).result).toEqual({ status: 'AVAILABLE' })
    expectSuccess(1, 2)
    const lease = leaseIdAt(1)

    send({ requestId: 3, type: 'maintenance.close', leaseId: lease })
    await waitForResponses(3)
    // The exception did NOT escape `handleRequest`: it came back as an explicit
    // control failure instead of poisoning the request queue.
    expectFailure(2, 3, 'PERSISTENCE_FAILED')
    expect(closeSpy).toHaveBeenCalledTimes(1)

    send({ requestId: 4, type: 'task.list' })
    send({ requestId: 5, type: 'note.listActive' })
    send({ requestId: 6, type: 'maintenance.exit', leaseId: lease })
    send({ requestId: 7, type: 'maintenance.close', leaseId: lease })
    send({ requestId: 8, type: 'shutdown' })
    await waitForResponses(8)

    // Fail-closed: ordinary traffic and the barrier release are both refused.
    expectFailure(3, 4, 'PERSISTENCE_UNAVAILABLE')
    expectFailure(4, 5, 'PERSISTENCE_ERROR')
    expectFailure(5, 6, 'PERSISTENCE_FAILED')
    // A repeat close is refused WITHOUT calling the database close again.
    expectFailure(6, 7, 'PERSISTENCE_FAILED')
    // SHUTDOWN MATRIX / INDETERMINATE: `shutdown` is NOT a success here. The
    // database state is unknown, so a normal shutdown can neither claim to have
    // closed it nor retry the close. This is a NORMAL failure response emitted
    // from `handleRequest()` — if it had been thrown, the serial
    // `requestQueue` (no `.catch()`) would be dead and requests 9/10 below
    // would never be answered.
    expectFailure(7, 8, 'PERSISTENCE_FAILED')
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // requestQueue still alive: a later CONTROL request gets a DETERMINISTIC
    // answer (the same fail-closed one), and the database is still not touched.
    send({ requestId: 9, type: 'shutdown' })
    await waitForResponses(9)
    expectFailure(8, 9, 'PERSISTENCE_FAILED')
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // ...and a later ordinary request is answered too — the queue really
    // processed both, it did not merely stay silent.
    send({ requestId: 10, type: 'task.list' })
    await waitForResponses(10)
    expectFailure(9, 10, 'PERSISTENCE_UNAVAILABLE')
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  test('C-G: INDETERMINATE cannot resume — no exit, no new owner, no close, no traffic', async () => {
    const closesBefore = closeSpy.mock.calls.length

    send({ requestId: 20, type: 'maintenance.enter' })
    send({ requestId: 21, type: 'maintenance.exit', leaseId: 'web-maint-1' })
    send({ requestId: 22, type: 'maintenance.close', leaseId: 'web-maint-1' })
    send({ requestId: 23, type: 'task.list' })
    send({ requestId: 24, type: 'note.listActive' })
    send({ requestId: 25, type: 'shutdown' })
    await waitForResponses(6)

    // Precondition + claim: fail-closed is WORKER-authoritative state, not a
    // caller-side convention — even a fresh enter is refused, so no new owner
    // can ever be established on an indeterminate runtime.
    expectFailure(0, 20, 'PERSISTENCE_FAILED')
    expectFailure(1, 21, 'PERSISTENCE_FAILED')
    expectFailure(2, 22, 'PERSISTENCE_FAILED')
    expectFailure(3, 23, 'PERSISTENCE_UNAVAILABLE')
    expectFailure(4, 24, 'PERSISTENCE_ERROR')
    // SHUTDOWN MATRIX / INDETERMINATE, re-proved against the re-established
    // state: failure, not success — and never a second database close.
    expectFailure(5, 25, 'PERSISTENCE_FAILED')
    expect(closeSpy.mock.calls.length).toBe(closesBefore)
  })
})
