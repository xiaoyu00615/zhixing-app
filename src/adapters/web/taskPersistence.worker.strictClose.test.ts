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
import {
  TaskWorkerClient,
  TaskWorkerClientError,
  type TaskWorkerEndpoint,
} from '@/adapters/web/taskWorkerClient'
import type { TaskWorkerRequest } from '@/adapters/web/taskWorkerProtocol'

const responses: unknown[] = []

vi.stubGlobal('crossOriginIsolated', true)
vi.stubGlobal('navigator', {
  storage: { getDirectory: () => Promise.resolve({}) },
})

const workerSelf = globalThis.self as unknown as {
  postMessage: (data: unknown) => void
  onmessage: ((event: MessageEvent<unknown>) => void) | null
}

/** Sinks so a real `TaskWorkerClient` can be bridged onto this worker endpoint. */
const responseSinks = new Set<(data: unknown) => void>()

Object.defineProperty(workerSelf, 'postMessage', {
  configurable: true,
  writable: true,
  value: (data: unknown) => {
    responses.push(data)
    for (const sink of responseSinks) {
      sink(data)
    }
  },
})

function send(data: unknown): void {
  expect(workerSelf.onmessage).not.toBeNull()
  workerSelf.onmessage?.(new MessageEvent('message', { data }))
}

/**
 * Wait until `count` responses have been posted. This is a COMPLETION wait, not
 * a correctness assumption: every ordering claim below is proven by the ORDER
 * and CONTENT of the collected responses, which the worker's serial
 * `requestQueue` makes deterministic. No fixed sleep / no debounce waiting.
 */
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

/** Reads the worker-allocated maintenance lease id from an enter success. */
function leaseIdAt(index: number): string {
  const result = envelopeAt(index).result as { leaseId?: unknown } | undefined
  if (result === null || result === undefined || typeof result.leaseId !== 'string') {
    throw new Error(`no maintenance lease id at index ${index}`)
  }
  return result.leaseId
}

/**
 * Bridge that lets a real `TaskWorkerClient` talk to THIS worker instance
 * without creating a second Worker. Responses are routed by in-flight request
 * id so a second logical client could never be poisoned by this one's traffic.
 */
class BridgedWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  /** Request ids this bridge has posted and not yet answered. */
  readonly inFlight = new Set<number>()

  postMessage(message: TaskWorkerRequest): void {
    this.inFlight.add(message.requestId)
    send(message)
  }
  terminate(): void {
    // The shared worker is owned by the generation, not by this bridge.
  }
}

/**
 * P6-S4A2B1 §25: fault injector for the RELEASE RETRY contract.
 *
 * It answers the next `maintenance.exit` with a control failure WITHOUT letting
 * it reach the worker, i.e. exactly the "control response failed" case. That is
 * a HARNESS concern: the product behaviour under test is that the client handle
 * must stay retry-capable after such a failure, and that the failed attempt did
 * not release anything (which the worker-side assertions then prove).
 */
class FaultInjectingWorker extends BridgedWorker {
  failNextExitResponse = false
  exitAttempts = 0

  override postMessage(message: TaskWorkerRequest): void {
    if (message.type === 'maintenance.exit') {
      this.exitAttempts += 1
      if (this.failNextExitResponse) {
        this.failNextExitResponse = false
        this.inFlight.delete(message.requestId)
        const requestId = message.requestId
        queueMicrotask(() => {
          this.onmessage?.(
            new MessageEvent('message', {
              data: {
                requestId,
                ok: false,
                error: { code: 'PERSISTENCE_FAILED' },
              },
            }),
          )
        })
        return
      }
    }
    super.postMessage(message)
  }
}

function attachClient(
  bridge: BridgedWorker = new BridgedWorker(),
): {
  readonly client: TaskWorkerClient
  readonly detach: () => void
} {
  const client = new TaskWorkerClient(bridge)
  const sink = (data: unknown): void => {
    const requestId = (data as { requestId?: unknown }).requestId
    if (typeof requestId !== 'number' || !bridge.inFlight.has(requestId)) {
      return
    }
    bridge.inFlight.delete(requestId)
    bridge.onmessage?.(new MessageEvent('message', { data }))
  }
  responseSinks.add(sink)
  return { client, detach: () => responseSinks.delete(sink) }
}

/**
 * Lease id of the owner that performed the successful strict close (C-A). Kept
 * outside the per-test response buffer because C-F must prove that even the
 * TRUE owner cannot resume a CLOSED runtime.
 */
let strictCloseOwnerLease: string | null = null

/**
 * The two observables this slice claims about the database itself. Declared at
 * file scope (NOT per test) so their call counts describe the whole module
 * instance: "exactly one close, ever" is a file-level claim, not a per-test one.
 */
const closeSpy = vi.spyOn(WebTaskDatabase.prototype, 'close')
const initializeSpy = vi.spyOn(WebTaskDatabase, 'initialize')

beforeEach(() => {
  responses.length = 0
})

afterAll(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

/**
 * NOTE ON ORDERING: `maintenanceCloseState` is module state shared by every
 * test in this file and CLOSED is TERMINAL for the module instance, so the
 * success family is ordered from the least to the most destructive:
 *   C-E (no database) -> C-C (stale owner) -> C-D (release retry)
 *   -> C-A (real strict close) -> C-F (terminal CLOSED, must be last).
 */
describe('taskPersistence.worker STRICT close control (P6-S4A2B1)', () => {
  test('C-E: strict close without an established AVAILABLE database fails explicitly', async () => {
    // 1. No active barrier at all: owner validation rejects before any work.
    send({ requestId: 1, type: 'maintenance.close', leaseId: 'web-maint-any' })
    // 2. Take the barrier so the next close passes owner validation and can
    //    only be refused by the database requirement.
    send({ requestId: 2, type: 'maintenance.enter' })
    await waitForResponses(2)
    expectFailure(0, 1, 'PERSISTENCE_FAILED')
    expectSuccess(1, 2)

    const lease = leaseIdAt(1)
    send({ requestId: 3, type: 'maintenance.close', leaseId: lease })
    await waitForResponses(3)

    // Explicit failure — never a silent success from an optional no-op close.
    expectFailure(2, 3, 'PERSISTENCE_FAILED')
    // The close must NOT have initialized / opened a database behind the
    // caller's back: no `WebTaskDatabase.initialize`, no `close`.
    expect(initializeSpy).not.toHaveBeenCalled()
    expect(closeSpy).not.toHaveBeenCalled()

    send({ requestId: 4, type: 'maintenance.exit', leaseId: lease })
    await waitForResponses(4)
    expectSuccess(3, 4)
  })

  test('C-C: a stale / foreign lease cannot close the database and does not take ownership', async () => {
    send({ requestId: 10, type: 'initialize' })
    send({ requestId: 11, type: 'maintenance.enter' })
    await waitForResponses(2)
    expect(envelopeAt(0).result).toEqual({ status: 'AVAILABLE' })
    expectSuccess(1, 11)
    const leaseA = leaseIdAt(1)

    send({ requestId: 12, type: 'maintenance.close', leaseId: 'web-maint-stale' })
    await waitForResponses(3)
    expectFailure(2, 12, 'PERSISTENCE_FAILED')
    // The database was never touched and A is still the owner.
    expect(closeSpy).not.toHaveBeenCalled()

    send({ requestId: 13, type: 'maintenance.exit', leaseId: 'web-maint-stale' })
    send({ requestId: 14, type: 'task.list' })
    await waitForResponses(5)
    expectFailure(3, 13, 'PERSISTENCE_FAILED')
    expectFailure(4, 14, 'PERSISTENCE_UNAVAILABLE')

    // Only the real owner releases the barrier, and only afterwards does
    // ordinary traffic work again.
    send({ requestId: 15, type: 'maintenance.exit', leaseId: leaseA })
    send({ requestId: 16, type: 'task.list' })
    await waitForResponses(7)
    expectSuccess(5, 15)
    expectSuccess(6, 16)
    expect(closeSpy).not.toHaveBeenCalled()
  })

  test('C-D: lease.release() really retries after a control failure and only then goes idle', async () => {
    const bridge = new FaultInjectingWorker()
    const { client, detach } = attachClient(bridge)

    try {
      const capability = await client.initialize()
      expect(capability.status).toBe('AVAILABLE')
      const lease = await client.enterMaintenance()

      bridge.failNextExitResponse = true
      const first = await lease.release().then<unknown, unknown>(
        () => null,
        (error: unknown) => error,
      )
      expect(first).toBeInstanceOf(TaskWorkerClientError)
      expect((first as TaskWorkerClientError).code).toBe('PERSISTENCE_FAILED')
      expect(bridge.exitAttempts).toBe(1)

      // The failed release released NOTHING: ordinary traffic is still refused.
      const blocked = await client.listTasks().then<unknown, unknown>(
        () => null,
        (error: unknown) => error,
      )
      expect(blocked).toBeInstanceOf(TaskWorkerClientError)
      expect((blocked as TaskWorkerClientError).code).toBe(
        'PERSISTENCE_UNAVAILABLE',
      )

      // Same handle, retry: it must actually re-send and succeed this time.
      await lease.release()
      expect(bridge.exitAttempts).toBe(2)

      // Only now is the handle locally consumed: a third release is a local
      // idempotent NO-OP that emits no further control request.
      await lease.release()
      expect(bridge.exitAttempts).toBe(2)

      const read = await client.listTasks()
      expect(Array.isArray(read)).toBe(true)
    } finally {
      detach()
    }
  })

  test('C-A: the owner strict-closes the established database exactly once', async () => {
    // Precondition: the database was established by the `initialize` request in
    // C-C, and C-C released the barrier again.
    send({ requestId: 20, type: 'maintenance.enter' })
    await waitForResponses(1)
    expectSuccess(0, 20)
    const lease = leaseIdAt(0)

    send({ requestId: 21, type: 'maintenance.close', leaseId: lease })
    await waitForResponses(2)

    expectSuccess(1, 21)
    expect(envelopeAt(1).result).toBeNull()
    // Exactly once, and it ran under the validated owner: only the current
    // owner's lease id passes the worker-side check (proved by C-C).
    expect(closeSpy).toHaveBeenCalledTimes(1)

    strictCloseOwnerLease = lease
  })

  test('C-F: CLOSED is terminal — the barrier and ordinary traffic cannot be resumed', async () => {
    const ownerLease = strictCloseOwnerLease
    expect(ownerLease).not.toBeNull()
    if (ownerLease === null) {
      throw new Error('C-A must run first')
    }
    // Exactly one successful close happened so far (C-A); everything below must
    // add none.
    const closesBefore = closeSpy.mock.calls.length
    expect(closesBefore).toBe(1)

    send({ requestId: 30, type: 'maintenance.exit', leaseId: ownerLease })
    send({ requestId: 31, type: 'task.list' })
    send({ requestId: 32, type: 'note.listActive' })
    send({ requestId: 33, type: 'initialize' })
    send({ requestId: 34, type: 'maintenance.enter' })
    send({ requestId: 35, type: 'maintenance.close', leaseId: ownerLease })
    await waitForResponses(6)

    // Even the TRUE owner cannot release the barrier any more.
    expectFailure(0, 30, 'PERSISTENCE_FAILED')
    // Ordinary traffic stays rejected across domains, and `initialize` cannot
    // silently re-open the closed runtime.
    expectFailure(1, 31, 'PERSISTENCE_UNAVAILABLE')
    expectFailure(2, 32, 'PERSISTENCE_ERROR')
    expectFailure(3, 33, 'PERSISTENCE_UNAVAILABLE')
    // No new owner on a terminal state, and no automatic retry of the close.
    expectFailure(4, 34, 'PERSISTENCE_FAILED')
    expectFailure(5, 35, 'PERSISTENCE_FAILED')
    expect(closeSpy.mock.calls.length).toBe(closesBefore)

    // The request queue is still alive. SHUTDOWN MATRIX / CLOSED: `shutdown` is
    // a DETERMINISTIC SUCCESS here — the database is really gone and already
    // closed — but `close()` is not idempotent, so it must NOT run again.
    send({ requestId: 36, type: 'shutdown' })
    await waitForResponses(7)
    expectSuccess(6, 36)
    expect(closeSpy.mock.calls.length).toBe(closesBefore)
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // A later ordinary request is still answered (and still refused): the queue
    // processed the shutdown instead of dying on it.
    send({ requestId: 37, type: 'task.list' })
    await waitForResponses(8)
    expectFailure(7, 37, 'PERSISTENCE_UNAVAILABLE')
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})
