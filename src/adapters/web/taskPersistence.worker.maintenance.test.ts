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
import {
  TaskWorkerClient,
  TaskWorkerClientError,
  type TaskWorkerEndpoint,
} from '@/adapters/web/taskWorkerClient'
import type { TaskWorkerRequest } from '@/adapters/web/taskWorkerProtocol'

const ID = {
  base: '00000000-0000-4000-8000-000000000001',
  a: '00000000-0000-4000-8000-0000000000a1',
  b: '00000000-0000-4000-8000-0000000000b1',
  c: '00000000-0000-4000-8000-0000000000c1',
  afterExit: '00000000-0000-4000-8000-0000000000d1',
  stale: '00000000-0000-4000-8000-0000000000e1',
  note: '00000000-0000-4000-8000-0000000000f1',
  diary: '00000000-0000-4000-8000-0000000000a2',
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

/**
 * Optional sinks so one or more real `TaskWorkerClient`s can be bridged onto
 * this single worker endpoint (P6-S4A1R §14: a foreign client must be unable to
 * release a barrier it does not own, without spinning up a second Worker).
 */
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
 * Adapter that lets a real `TaskWorkerClient` talk to THIS worker instance
 * without creating a second Worker. Several bridges can be attached at once
 * (P6-S4A1R §14): they share one endpoint, one request queue and one
 * authoritative barrier state.
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
 * Bridges a real `TaskWorkerClient` onto this single worker endpoint.
 *
 * Responses are routed by in-flight request id. That is a HARNESS concern, not
 * a product behaviour: in production exactly one client owns the worker, but
 * `TaskWorkerClient` treats any response whose requestId it does not expect as
 * a protocol violation and fails the whole client. Without per-client routing a
 * second logical client would be poisoned by the first one's responses.
 */
function attachClient(): {
  readonly client: TaskWorkerClient
  readonly detach: () => void
} {
  const bridge = new BridgedWorker()
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

function taskIdsAt(index: number): string[] {
  const result = envelopeAt(index).result
  if (!Array.isArray(result)) {
    throw new Error('expected a list result')
  }
  return result.map((row) => (row as { id: string }).id)
}

beforeEach(() => {
  responses.length = 0
})

afterAll(() => {
  vi.unstubAllGlobals()
})

/**
 * NOTE ON ORDERING: the worker's `activeMaintenanceLeaseId` is module state
 * shared by every test in this file. Each test therefore starts from a known
 * state and restores it; the shutdown test is declared LAST because closing the
 * database is permanent for this module instance.
 */
describe('taskPersistence.worker STRONG quiescence (P6-S4A1)', () => {
  test('W-A: request before enter completes, enter is the cutoff, request after enter never touches the DB', async () => {
    send({ requestId: 1, type: 'initialize' })
    send({
      requestId: 2,
      type: 'task.create',
      input: { id: ID.a, title: 'A task', createdAtMs: 100 },
    })
    send({ requestId: 3, type: 'maintenance.enter' })
    // Admitted strictly after `maintenance.enter`: must be rejected.
    send({
      requestId: 4,
      type: 'task.create',
      input: { id: ID.b, title: 'B task', createdAtMs: 200 },
    })

    await waitForResponses(4)

    // 1. A (admitted before enter) executed successfully.
    expect(envelopeAt(0)).toMatchObject({ requestId: 1, ok: true })
    expect(envelopeAt(0).result).toEqual({ status: 'AVAILABLE' })
    expectSuccess(1, 2)
    // 2. enter resolved only after every prior request had completed, and it
    //    hands back the worker-allocated lease id.
    expectSuccess(2, 3)
    const lease = leaseIdAt(2)
    // 3. B was rejected instead of executing DB work.
    expectFailure(3, 4, 'PERSISTENCE_UNAVAILABLE')

    // Positive proof that B never executed: after releasing the barrier the
    // table contains only A.
    send({ requestId: 5, type: 'maintenance.exit', leaseId: lease })
    send({ requestId: 6, type: 'task.list' })
    await waitForResponses(6)
    expectSuccess(4, 5)
    expectSuccess(5, 6)
    expect(taskIdsAt(5)).toEqual([ID.a])
  })

  test('W-B: several pre-enter requests all complete before the enter response (enter is the drain point)', async () => {
    send({
      requestId: 10,
      type: 'task.create',
      input: { id: ID.b, title: 'A2 task', createdAtMs: 300 },
    })
    send({
      requestId: 11,
      type: 'task.create',
      input: { id: ID.c, title: 'C task', createdAtMs: 400 },
    })
    send({ requestId: 12, type: 'maintenance.enter' })

    await waitForResponses(3)
    expectSuccess(0, 10)
    expectSuccess(1, 11)
    expectSuccess(2, 12)

    send({ requestId: 13, type: 'maintenance.exit', leaseId: leaseIdAt(2) })
    send({ requestId: 14, type: 'task.list' })
    await waitForResponses(5)
    expectSuccess(3, 13)
    expectSuccess(4, 14)
    expect(taskIdsAt(4)).toEqual(expect.arrayContaining([ID.b, ID.c]))
  })

  test('W-C: while quiescent both READ and MUTATION are rejected, preserving each domain error contract', async () => {
    send({ requestId: 20, type: 'maintenance.enter' })
    await waitForResponses(1)
    expectSuccess(0, 20)

    send({ requestId: 21, type: 'task.list' }) // READ
    send({ requestId: 22, type: 'task.create', input: { id: ID.base, title: 'x', createdAtMs: 500 } }) // MUTATION
    send({ requestId: 23, type: 'note.listActive' }) // READ
    send({
      requestId: 24,
      type: 'note.create',
      input: { id: ID.note, title: 'n', content: 'c', createdAtMs: 500 },
    }) // MUTATION
    send({ requestId: 25, type: 'diary.listActive' }) // READ
    send({
      requestId: 26,
      type: 'diary.create',
      input: {
        id: ID.diary,
        diaryDate: '2026-01-01',
        title: 'd',
        content: 'c',
        createdAtMs: 500,
      },
    }) // MUTATION
    send({ requestId: 27, type: 'search.query', input: { query: 'a', limit: 10 } }) // READ
    send({ requestId: 28, type: 'trash.list' }) // READ
    send({ requestId: 29, type: 'archive.list' }) // READ
    send({ requestId: 30, type: 'initialize' }) // LIFECYCLE, also blocked

    await waitForResponses(10)

    expectFailure(1, 21, 'PERSISTENCE_UNAVAILABLE')
    expectFailure(2, 22, 'PERSISTENCE_UNAVAILABLE')
    expectFailure(3, 23, 'PERSISTENCE_ERROR')
    expectFailure(4, 24, 'PERSISTENCE_ERROR')
    expectFailure(5, 25, 'PERSISTENCE_ERROR')
    expectFailure(6, 26, 'PERSISTENCE_ERROR')
    expectFailure(7, 27, 'PERSISTENCE_ERROR')
    expectFailure(8, 28, 'PERSISTENCE_ERROR')
    expectFailure(9, 29, 'PERSISTENCE_ERROR')
    expectFailure(10, 30, 'PERSISTENCE_UNAVAILABLE')

    send({ requestId: 31, type: 'maintenance.exit', leaseId: leaseIdAt(0) })
    await waitForResponses(12)
    expectSuccess(11, 31)
  })

  test('W-D: exit restores ordinary traffic and the request queue survives rejections', async () => {
    send({ requestId: 40, type: 'maintenance.enter' })
    await waitForResponses(1)
    expectSuccess(0, 40)

    send({
      requestId: 41,
      type: 'task.create',
      input: { id: ID.afterExit, title: 'blocked', createdAtMs: 600 },
    })
    await waitForResponses(2)
    expectFailure(1, 41, 'PERSISTENCE_UNAVAILABLE')

    send({ requestId: 42, type: 'maintenance.exit', leaseId: leaseIdAt(0) })
    await waitForResponses(3)
    expectSuccess(2, 42)

    send({
      requestId: 43,
      type: 'task.create',
      input: { id: ID.afterExit, title: 'restored', createdAtMs: 700 },
    })
    send({ requestId: 44, type: 'task.list' })
    await waitForResponses(5)
    expectSuccess(3, 43)
    expectSuccess(4, 44)
    expect(taskIdsAt(4)).toContain(ID.afterExit)
  })

  test('W-E: entering twice fails deterministically and the first owner is preserved', async () => {
    send({ requestId: 50, type: 'maintenance.enter' })
    send({ requestId: 51, type: 'maintenance.enter' })
    await waitForResponses(2)
    expectSuccess(0, 50)
    expectFailure(1, 51, 'PERSISTENCE_FAILED')

    const lease = leaseIdAt(0)

    // The rejected enter must NOT have replaced or released the owner: a foreign
    // id still cannot release, and ordinary traffic is still blocked.
    send({ requestId: 52, type: 'maintenance.exit', leaseId: 'web-maint-other' })
    send({ requestId: 53, type: 'task.list' })
    await waitForResponses(4)
    expectFailure(2, 52, 'PERSISTENCE_FAILED')
    expectFailure(3, 53, 'PERSISTENCE_UNAVAILABLE')

    // Only the original lease releases the barrier.
    send({ requestId: 54, type: 'maintenance.exit', leaseId: lease })
    send({ requestId: 55, type: 'task.list' })
    await waitForResponses(6)
    expectSuccess(4, 54)
    expectSuccess(5, 55)
  })

  test('W-F: exit without an active barrier is a deterministic NO-OP', async () => {
    // Precondition: the previous test released the barrier. The request still
    // carries a lease id (the protocol requires one); ownership is only
    // enforced when a barrier is actually active.
    send({ requestId: 60, type: 'maintenance.exit', leaseId: 'web-maint-1' })
    send({ requestId: 61, type: 'maintenance.exit', leaseId: 'web-maint-1' })
    await waitForResponses(2)
    expectSuccess(0, 60)
    expectSuccess(1, 61)
  })

  test('W-G: a stale client / repository reference cannot write or read through the barrier', async () => {
    const { client, detach } = attachClient()

    try {
      const capability = await client.initialize()
      expect(capability.status).toBe('AVAILABLE')

      const lease = await client.enterMaintenance()
      expect(typeof lease.leaseId).toBe('string')

      // The same (now "stale") client keeps being used by every repository that
      // already holds it — both its mutations and its reads must be refused by
      // the worker, not executed and not silently re-opened.
      const mutation = await client
        .createTask({ id: ID.stale, title: 'stale', createdAtMs: 800 })
        .then<unknown, unknown>(
          () => null,
          (error: unknown) => error,
        )
      expect(mutation).toBeInstanceOf(TaskWorkerClientError)
      expect((mutation as TaskWorkerClientError).code).toBe(
        'PERSISTENCE_UNAVAILABLE',
      )

      const read = await client.listTasks().then<unknown, unknown>(
        () => null,
        (error: unknown) => error,
      )
      expect(read).toBeInstanceOf(TaskWorkerClientError)
      expect((read as TaskWorkerClientError).code).toBe('PERSISTENCE_UNAVAILABLE')

      await lease.release()

      const afterExit = await client.listTasks()
      expect(Array.isArray(afterExit)).toBe(true)
      expect(
        (afterExit as Array<{ id: string }>).map((task) => task.id),
      ).not.toContain(ID.stale)
    } finally {
      detach()
    }
  })

  // ---------------------------------------------------------------------------
  // P6-S4A1R: barrier OWNERSHIP. Ordering (W-A/W-B) is unchanged by lease ids;
  // these tests add the proof that only the current owner may release.
  // ---------------------------------------------------------------------------

  test('W-I: a stale exit cannot unlock a newer lease (critical)', async () => {
    send({ requestId: 80, type: 'maintenance.enter' })
    await waitForResponses(1)
    expectSuccess(0, 80)
    const leaseA = leaseIdAt(0)

    send({ requestId: 81, type: 'maintenance.exit', leaseId: leaseA })
    await waitForResponses(2)
    expectSuccess(1, 81)

    // New owner.
    send({ requestId: 82, type: 'maintenance.enter' })
    await waitForResponses(3)
    expectSuccess(2, 82)
    const leaseB = leaseIdAt(2)
    expect(leaseB).not.toBe(leaseA)

    // Stale exit from the PREVIOUS owner must fail and must NOT release B.
    send({ requestId: 83, type: 'maintenance.exit', leaseId: leaseA })
    await waitForResponses(4)
    expectFailure(3, 83, 'PERSISTENCE_FAILED')

    // B's barrier is still active: ordinary traffic remains rejected.
    send({ requestId: 84, type: 'task.list' })
    await waitForResponses(5)
    expectFailure(4, 84, 'PERSISTENCE_UNAVAILABLE')

    // Only B releases its own barrier.
    send({ requestId: 85, type: 'maintenance.exit', leaseId: leaseB })
    send({ requestId: 86, type: 'task.list' })
    await waitForResponses(7)
    expectSuccess(5, 85)
    expectSuccess(6, 86)
  })

  test('W-J: a fabricated lease id cannot release the barrier', async () => {
    send({ requestId: 90, type: 'maintenance.enter' })
    await waitForResponses(1)
    expectSuccess(0, 90)
    const lease = leaseIdAt(0)

    send({ requestId: 91, type: 'maintenance.exit', leaseId: 'web-maint-9999' })
    await waitForResponses(2)
    expectFailure(1, 91, 'PERSISTENCE_FAILED')

    // Still quiescent.
    send({ requestId: 92, type: 'task.list' })
    await waitForResponses(3)
    expectFailure(2, 92, 'PERSISTENCE_UNAVAILABLE')

    send({ requestId: 93, type: 'maintenance.exit', leaseId: lease })
    await waitForResponses(4)
    expectSuccess(3, 93)
  })

  test('W-K: a duplicate exit while inactive does not disturb the next enter', async () => {
    // Precondition: inactive. Both exits are safe NO-OPs.
    send({ requestId: 100, type: 'maintenance.exit', leaseId: 'web-maint-1' })
    send({ requestId: 101, type: 'maintenance.exit', leaseId: 'web-maint-1' })
    await waitForResponses(2)
    expectSuccess(0, 100)
    expectSuccess(1, 101)

    // A later owner is acquired normally and releases normally.
    send({ requestId: 102, type: 'maintenance.enter' })
    await waitForResponses(3)
    expectSuccess(2, 102)
    const lease = leaseIdAt(2)

    send({ requestId: 103, type: 'maintenance.exit', leaseId: lease })
    send({ requestId: 104, type: 'task.list' })
    await waitForResponses(5)
    expectSuccess(3, 103)
    expectSuccess(4, 104)
  })

  test('W-L: a second client holding a foreign lease cannot release the barrier', async () => {
    const owner = attachClient()
    const foreign = attachClient()
    const ownerClient = owner.client
    const foreignClient = foreign.client

    try {
      const lease = await ownerClient.enterMaintenance()

      // The foreign client attempts a release with a lease it does not own.
      const foreignRelease = await foreignClient
        .exitMaintenance('web-maint-foreign')
        .then<unknown, unknown>(
          () => null,
          (error: unknown) => error,
        )
      expect(foreignRelease).toBeInstanceOf(TaskWorkerClientError)
      expect((foreignRelease as TaskWorkerClientError).code).toBe(
        'PERSISTENCE_FAILED',
      )

      // The barrier is still up for everybody, including the foreign client.
      const foreignRead = await foreignClient.listTasks().then<unknown, unknown>(
        () => null,
        (error: unknown) => error,
      )
      expect(foreignRead).toBeInstanceOf(TaskWorkerClientError)
      expect((foreignRead as TaskWorkerClientError).code).toBe(
        'PERSISTENCE_UNAVAILABLE',
      )

      // Only the owner releases.
      await lease.release()

      const foreignReadAfter = await foreignClient.listTasks()
      expect(Array.isArray(foreignReadAfter)).toBe(true)
    } finally {
      owner.detach()
      foreign.detach()
    }
  })

  // MUST remain the last test in this file: shutdown closes the database for
  // the whole module instance, and `initialization` is memoized.
  test('W-H: shutdown stays allowed while quiescent and closes the database', async () => {
    send({ requestId: 70, type: 'maintenance.enter' })
    await waitForResponses(1)
    expectSuccess(0, 70)
    const lease = leaseIdAt(0)

    send({ requestId: 71, type: 'shutdown' })
    await waitForResponses(2)
    expectSuccess(1, 71)

    // After the barrier is released the database is closed, so ordinary work can
    // no longer succeed — proving shutdown really closed it. Note the release is
    // still accepted even though the DB is gone: shutdown does not depend on
    // `maintenance.exit` to be safe.
    send({ requestId: 72, type: 'maintenance.exit', leaseId: lease })
    send({ requestId: 73, type: 'task.list' })
    await waitForResponses(4)
    expectSuccess(2, 72)
    expect(envelopeAt(3)).toMatchObject({ requestId: 73, ok: false })
  })
})
