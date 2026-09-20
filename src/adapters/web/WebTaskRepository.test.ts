import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  openWebTaskRepository,
  WebTaskRepository,
  type OpenWebTaskRepositoryResult,
} from '@/adapters/web/WebTaskRepository'
import {
  TaskWorkerClient,
  TaskWorkerClientError,
  type TaskWorkerEndpoint,
} from '@/adapters/web/taskWorkerClient'
import type {
  TaskWorkerRequest,
  TaskWorkerResponse,
} from '@/adapters/web/taskWorkerProtocol'
import { parseTaskWorkerRequest } from '@/adapters/web/taskWorkerProtocol'
import {
  runWebMigrations,
  sha256Hex,
  WEB_MIGRATIONS,
  WebMigrationError,
  type WebMigrationHistoryRow,
  type WebMigrationStore,
} from '@/adapters/web/webMigrations'
import {
  defineTaskRepositoryContract,
  TaskContractBackendError,
  TaskRepositoryContractBackend,
  type TaskRepositoryContractFixture,
} from '@/test/taskRepositoryContract'

const ID = '12345678-1234-4321-8000-0123456789ab'
const SECOND_ID = '00000000-0000-4000-8000-000000000002'
const TASK = {
  id: ID,
  title: 'Task',
  status: 'todo',
  createdAtMs: 100,
  updatedAtMs: 100,
  isImportant: false,
  isUrgent: false,
  dueDate: null,
  projectId: null,
  tagIds: [],
  deletedAtMs: null,
} as const

class FakeWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  readonly messages: TaskWorkerRequest[] = []
  terminated = false

  postMessage(message: TaskWorkerRequest): void {
    this.messages.push(message)
  }

  terminate(): void {
    this.terminated = true
  }

  respond(response: TaskWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }

  respondToLast(result: unknown): void {
    const request = this.messages.at(-1)
    if (request === undefined) {
      throw new Error('No worker request to answer.')
    }
    this.respond({ requestId: request.requestId, ok: true, result })
  }

  rejectLast(code: 'NOT_FOUND' | 'STATUS_CONFLICT'): void {
    const request = this.messages.at(-1)
    if (request === undefined) {
      throw new Error('No worker request to reject.')
    }
    this.respond({ requestId: request.requestId, ok: false, error: { code } })
  }

  emitError(): void {
    this.onerror?.(new ErrorEvent('error'))
  }
}

class ContractWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  readonly backend: TaskRepositoryContractBackend
  terminated = false

  constructor(backend: TaskRepositoryContractBackend) {
    this.backend = backend
  }

  postMessage(request: TaskWorkerRequest): void {
    try {
      let result: unknown
      switch (request.type) {
        case 'initialize':
          result = { status: 'AVAILABLE' }
          break
        case 'task.create':
          result = this.backend.createTask(request.input)
          break
        case 'task.list':
          result = this.backend.listTasks()
          break
        case 'task.listTrashed':
          result = this.backend.listTrashedTasks()
          break
        case 'task.trash':
          result = this.backend.trashTask(request.input)
          break
        case 'task.restore':
          result = this.backend.restoreTask(request.input)
          break
        case 'task.rename':
          result = this.backend.renameTask(request.input)
          break
        case 'task.changeStatus':
          result = this.backend.changeTaskStatus(request.input)
          break
        case 'task.setImportance':
          result = this.backend.setTaskImportance(request.input)
          break
        case 'task.setUrgency':
          result = this.backend.setTaskUrgency(request.input)
          break
        case 'task.setDeadline':
          result = this.backend.setTaskDeadline(request.input)
          break
        case 'task.clearDeadline':
          result = this.backend.clearTaskDeadline(request.input)
          break
        case 'task.setProject':
          result = this.backend.setTaskProject(request.input)
          break
        case 'task.clearProject':
          result = this.backend.clearTaskProject(request.input)
          break
        case 'task.addTag':
          result = this.backend.addTaskTag(request.input)
          break
        case 'task.removeTag':
          result = this.backend.removeTaskTag(request.input)
          break
        case 'shutdown':
          result = null
          break
      }
      this.respond({ requestId: request.requestId, ok: true, result })
    } catch (error: unknown) {
      if (error instanceof TaskContractBackendError) {
        this.respond({
          requestId: request.requestId,
          ok: false,
          error: { code: error.code },
        })
        return
      }
      throw error
    }
  }

  terminate(): void {
    this.terminated = true
  }

  private respond(response: TaskWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }
}

function createWebContractFixture(): TaskRepositoryContractFixture {
  const backend = new TaskRepositoryContractBackend()
  const worker = new ContractWorker(backend)
  return {
    repository: new WebTaskRepository(new TaskWorkerClient(worker)),
    backend,
  }
}

class FakeMigrationStore implements WebMigrationStore {
  metadataEnsured = false
  metadataValidated = false
  readonly executedSql: string[] = []
  history: WebMigrationHistoryRow[] = []
  failHistoryInsert = false

  ensureMetadataTable(): void {
    this.metadataEnsured = true
  }

  validateMetadataStructure(): void {
    this.metadataValidated = true
  }

  readHistory(): readonly WebMigrationHistoryRow[] {
    return [...this.history]
  }

  transaction<T>(operation: () => T): T {
    const sqlSnapshot = [...this.executedSql]
    const historySnapshot = [...this.history]
    try {
      return operation()
    } catch (error: unknown) {
      this.executedSql.splice(0, this.executedSql.length, ...sqlSnapshot)
      this.history = historySnapshot
      throw error
    }
  }

  executeMigration(sql: string): void {
    this.executedSql.push(sql)
  }

  insertHistory(row: WebMigrationHistoryRow): void {
    if (this.failHistoryInsert) {
      throw new Error('injected history failure')
    }
    this.history.push(row)
  }
}

describe('TaskWorkerClient', () => {
  test('caches initialization and uses increasing request ids', async () => {
    const worker = new FakeWorker()
    const client = new TaskWorkerClient(worker)

    const first = client.initialize()
    const second = client.initialize()
    expect(first).toBe(second)
    expect(worker.messages).toEqual([{ requestId: 1, type: 'initialize' }])
    worker.respondToLast({ status: 'AVAILABLE' })
    await expect(first).resolves.toEqual({ status: 'AVAILABLE' })

    const list = client.listTasks()
    expect(worker.messages.at(-1)).toEqual({ requestId: 2, type: 'task.list' })
    worker.respondToLast([])
    await expect(list).resolves.toEqual([])
  })

  test('rejects every pending request and terminates on worker failure', async () => {
    const worker = new FakeWorker()
    const client = new TaskWorkerClient(worker)
    const first = client.listTasks()
    const second = client.createTask({
      id: ID,
      title: 'Task',
      createdAtMs: 100,
    })

    worker.emitError()

    await expect(first).rejects.toEqual(
      new TaskWorkerClientError('PERSISTENCE_UNAVAILABLE'),
    )
    await expect(second).rejects.toEqual(
      new TaskWorkerClientError('PERSISTENCE_UNAVAILABLE'),
    )
    expect(worker.terminated).toBe(true)
  })

  test('rejects unknown response payload without exposing it', async () => {
    const worker = new FakeWorker()
    const client = new TaskWorkerClient(worker)
    const pending = client.listTasks()

    worker.onmessage?.(
      new MessageEvent('message', {
        data: { requestId: 1, ok: true, rawSql: 'SELECT secret' },
      }),
    )

    await expect(pending).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
      message: 'Task persistence worker request failed.',
    })
    await expect(pending).rejects.not.toThrow(/SELECT secret/)
    expect(worker.terminated).toBe(true)
  })

  test('notifies the worker before terminating during shutdown', async () => {
    const worker = new FakeWorker()
    const client = new TaskWorkerClient(worker)
    const shutdown = client.shutdown()

    expect(worker.terminated).toBe(false)
    expect(worker.messages).toEqual([{ requestId: 1, type: 'shutdown' }])
    worker.respondToLast(null)
    await shutdown
    expect(worker.terminated).toBe(true)
  })
})

describe('WebTaskRepository', () => {
  test('maps all methods to capability-specific worker messages', async () => {
    const worker = new FakeWorker()
    const repository = new WebTaskRepository(new TaskWorkerClient(worker))

    const created = repository.createTask({
      id: ID,
      title: 'Task',
      createdAtMs: 100,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.create' })
    worker.respondToLast(TASK)
    await expect(created).resolves.toEqual(TASK)

    const listed = repository.listTasks()
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.list' })
    worker.respondToLast([TASK])
    await expect(listed).resolves.toEqual([TASK])

    const renamed = repository.renameTask({
      id: ID,
      title: 'Renamed',
      updatedAtMs: 200,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.rename' })
    worker.respondToLast({ ...TASK, title: 'Renamed', updatedAtMs: 200 })
    await expect(renamed).resolves.toMatchObject({ title: 'Renamed' })

    const changed = repository.changeTaskStatus({
      id: ID,
      operation: 'start',
      updatedAtMs: 300,
    })
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'task.changeStatus',
    })
    worker.respondToLast({ ...TASK, status: 'doing', updatedAtMs: 300 })
    await expect(changed).resolves.toMatchObject({ status: 'doing' })

    const important = repository.setTaskImportance({
      id: ID,
      isImportant: true,
      updatedAtMs: 400,
    })
    expect(worker.messages.at(-1)).toMatchObject({
      type: 'task.setImportance',
    })
    worker.respondToLast({ ...TASK, isImportant: true, updatedAtMs: 400 })
    await expect(important).resolves.toMatchObject({ isImportant: true })

    const urgent = repository.setTaskUrgency({
      id: ID,
      isUrgent: true,
      updatedAtMs: 500,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.setUrgency' })
    worker.respondToLast({ ...TASK, isUrgent: true, updatedAtMs: 500 })
    await expect(urgent).resolves.toMatchObject({ isUrgent: true })

    const deadline = repository.setTaskDeadline({
      id: ID,
      dueDate: '2026-08-23',
      updatedAtMs: 600,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.setDeadline' })
    worker.respondToLast({
      ...TASK,
      dueDate: '2026-08-23',
      updatedAtMs: 600,
    })
    await expect(deadline).resolves.toMatchObject({ dueDate: '2026-08-23' })

    const cleared = repository.clearTaskDeadline({
      id: ID,
      updatedAtMs: 700,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.clearDeadline' })
    worker.respondToLast({ ...TASK, updatedAtMs: 700 })
    await expect(cleared).resolves.toMatchObject({ dueDate: null })

    const tagId = '00000000-0000-4000-8000-000000000101'
    const tagged = repository.addTaskTag({ id: ID, tagId, updatedAtMs: 800 })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.addTag' })
    worker.respondToLast({ ...TASK, tagIds: [tagId], updatedAtMs: 800 })
    await expect(tagged).resolves.toMatchObject({ tagIds: [tagId] })

    const untagged = repository.removeTaskTag({
      id: ID,
      tagId,
      updatedAtMs: 900,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.removeTag' })
    worker.respondToLast({ ...TASK, tagIds: [], updatedAtMs: 900 })
    await expect(untagged).resolves.toMatchObject({ tagIds: [] })
  })

  test('preserves database list ordering', async () => {
    const worker = new FakeWorker()
    const repository = new WebTaskRepository(new TaskWorkerClient(worker))
    const first = { ...TASK, id: SECOND_ID, updatedAtMs: 200 }
    const second = { ...TASK, id: ID, updatedAtMs: 100 }
    const list = repository.listTasks()
    worker.respondToLast([first, second])
    await expect(list).resolves.toEqual([first, second])
  })

  test('maps safe errors and rejects malformed task payloads', async () => {
    const worker = new FakeWorker()
    const repository = new WebTaskRepository(new TaskWorkerClient(worker))
    const missing = repository.renameTask({
      id: ID,
      title: 'Renamed',
      updatedAtMs: 200,
    })
    worker.rejectLast('NOT_FOUND')
    await expect(missing).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Task not found.',
    })

    const malformed = repository.listTasks()
    worker.respondToLast([{ ...TASK, updatedAtMs: -1 }])
    await expect(malformed).rejects.toMatchObject({
      code: 'PERSISTENCE_FAILED',
    })

    for (const payload of [
      { ...TASK, isImportant: 1 },
      { ...TASK, isUrgent: 'true' },
      { ...TASK, dueDate: '2025-02-29' },
    ]) {
      const invalidPlanning = repository.listTasks()
      worker.respondToLast([payload])
      await expect(invalidPlanning).rejects.toMatchObject({
        code: 'PERSISTENCE_FAILED',
      })
    }
  })

  test('returns no repository when Worker or isolation capability is absent', async () => {
    await expect(
      openWebTaskRepository({ workerSupported: false }),
    ).resolves.toEqual({
      capability: { status: 'UNAVAILABLE', reason: 'WORKER_UNSUPPORTED' },
    })
    await expect(
      openWebTaskRepository({
        workerSupported: true,
        crossOriginIsolated: false,
      }),
    ).resolves.toEqual({
      capability: {
        status: 'RESTRICTED',
        reason: 'CROSS_ORIGIN_ISOLATION_REQUIRED',
      },
    })
  })

  test('returns a repository only after AVAILABLE initialization', async () => {
    const worker = new FakeWorker()
    const opened = openWebTaskRepository({
      workerSupported: true,
      crossOriginIsolated: true,
      workerFactory: () => worker,
    })
    worker.respondToLast({ status: 'AVAILABLE' })
    const result = await opened

    expect(result.capability).toEqual({ status: 'AVAILABLE' })
    expect('repository' in result).toBe(true)
    if ('dispose' in result) {
      const disposed = result.dispose()
      worker.respondToLast(null)
      await disposed
    }
    expect(worker.terminated).toBe(true)
  })

  test('does not return a transient repository after initialization rejection', async () => {
    const worker = new FakeWorker()
    const opened = openWebTaskRepository({
      workerSupported: true,
      crossOriginIsolated: true,
      workerFactory: () => worker,
    })
    worker.respondToLast({ status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' })

    await expect(opened).resolves.toEqual({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })
    expect(worker.terminated).toBe(true)
  })
})

const createdWorkers: SharedPersistenceFakeWorker[] = []

class SharedPersistenceFakeWorker extends FakeWorker {
  constructor() {
    super()
    createdWorkers.push(this)
  }
}

type SharedLease = Extract<
  OpenWebTaskRepositoryResult,
  { readonly dispose: () => Promise<void> }
>

function requireLease(result: OpenWebTaskRepositoryResult): SharedLease {
  if (!('dispose' in result)) {
    throw new Error('Expected an available shared lease.')
  }
  return result
}

function requireCreatedWorker(index: number): SharedPersistenceFakeWorker {
  const worker = createdWorkers[index]
  if (worker === undefined) {
    throw new Error('Expected a default persistence Worker.')
  }
  return worker
}

function stubDefaultOpenEnvironment(): void {
  createdWorkers.length = 0
  vi.stubGlobal('Worker', SharedPersistenceFakeWorker)
  vi.stubGlobal('crossOriginIsolated', true)
}

async function openSharedPair(): Promise<readonly [SharedLease, SharedLease]> {
  const first = openWebTaskRepository()
  const second = openWebTaskRepository()
  requireCreatedWorker(0).respondToLast({ status: 'AVAILABLE' })
  return [requireLease(await first), requireLease(await second)]
}

async function releaseFinalLease(
  lease: SharedLease,
  worker: SharedPersistenceFakeWorker,
): Promise<void> {
  const closing = lease.dispose()
  worker.respondToLast(null)
  await closing
}

describe('shared default persistence core', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    createdWorkers.length = 0
  })

  test('A: two concurrent default opens share one Worker and one initialization', async () => {
    stubDefaultOpenEnvironment()

    const first = openWebTaskRepository()
    const second = openWebTaskRepository()

    expect(createdWorkers).toHaveLength(1)
    const worker = requireCreatedWorker(0)
    expect(worker.messages).toEqual([{ requestId: 1, type: 'initialize' }])

    worker.respondToLast({ status: 'AVAILABLE' })
    const firstLease = requireLease(await first)
    const secondLease = requireLease(await second)
    expect(createdWorkers).toHaveLength(1)
    expect(worker.messages).toHaveLength(1)

    const listed = secondLease.repository.listTasks()
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.list' })
    worker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await firstLease.dispose()
    expect(worker.terminated).toBe(false)
    await releaseFinalLease(secondLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('B: releasing the first lease keeps the shared core alive', async () => {
    stubDefaultOpenEnvironment()
    const [firstLease, secondLease] = await openSharedPair()
    const worker = requireCreatedWorker(0)

    await firstLease.dispose()

    expect(worker.terminated).toBe(false)
    expect(worker.messages.map((message) => message.type)).not.toContain(
      'shutdown',
    )

    const listed = secondLease.repository.listTasks()
    worker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(secondLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('C: final release shuts the core down once and a later default open starts a new generation', async () => {
    stubDefaultOpenEnvironment()
    const [firstLease, secondLease] = await openSharedPair()
    const firstWorker = requireCreatedWorker(0)

    await firstLease.dispose()
    const closing = secondLease.dispose()

    expect(createdWorkers).toHaveLength(1)
    expect(firstWorker.messages.at(-1)).toMatchObject({ type: 'shutdown' })
    expect(
      firstWorker.messages.filter((message) => message.type === 'shutdown'),
    ).toHaveLength(1)

    firstWorker.respondToLast(null)
    await closing
    expect(firstWorker.terminated).toBe(true)

    const reopened = openWebTaskRepository()
    expect(createdWorkers).toHaveLength(2)
    const secondWorker = requireCreatedWorker(1)
    secondWorker.respondToLast({ status: 'AVAILABLE' })
    const thirdLease = requireLease(await reopened)
    expect(thirdLease.capability).toEqual({ status: 'AVAILABLE' })

    const listed = thirdLease.repository.listTasks()
    secondWorker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(thirdLease, secondWorker)
    expect(secondWorker.terminated).toBe(true)
  })

  test('D: disposing one lease twice releases its ownership once', async () => {
    stubDefaultOpenEnvironment()
    const [firstLease, secondLease] = await openSharedPair()
    const worker = requireCreatedWorker(0)

    await firstLease.dispose()
    await firstLease.dispose()

    expect(worker.terminated).toBe(false)
    expect(worker.messages.map((message) => message.type)).not.toContain(
      'shutdown',
    )

    const listed = secondLease.repository.listTasks()
    worker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(secondLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('E: a stale lease release does not invalidate the live lease', async () => {
    stubDefaultOpenEnvironment()

    const first = openWebTaskRepository()
    const second = openWebTaskRepository()
    const worker = requireCreatedWorker(0)
    expect(worker.messages).toEqual([{ requestId: 1, type: 'initialize' }])

    worker.respondToLast({ status: 'AVAILABLE' })
    const staleLease = requireLease(await first)
    const liveLease = requireLease(await second)

    await staleLease.dispose()
    expect(worker.terminated).toBe(false)

    const created = liveLease.repository.createTask({
      id: ID,
      title: 'Task',
      createdAtMs: 100,
    })
    expect(worker.messages.at(-1)).toMatchObject({ type: 'task.create' })
    worker.respondToLast(TASK)
    await expect(created).resolves.toEqual(TASK)

    await releaseFinalLease(liveLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('F: a failed default generation never poisons the shared slot', async () => {
    stubDefaultOpenEnvironment()

    const first = openWebTaskRepository()
    const second = openWebTaskRepository()
    const failedWorker = requireCreatedWorker(0)
    failedWorker.respondToLast({
      status: 'UNAVAILABLE',
      reason: 'OPFS_UNSUPPORTED',
    })

    const unavailable = {
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    }
    await expect(first).resolves.toEqual(unavailable)
    await expect(second).resolves.toEqual(unavailable)
    expect(createdWorkers).toHaveLength(1)
    expect(failedWorker.terminated).toBe(true)

    const broken = openWebTaskRepository()
    const brokenWorker = requireCreatedWorker(1)
    brokenWorker.emitError()
    await expect(broken).resolves.toEqual({
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    })
    expect(brokenWorker.terminated).toBe(true)

    const retried = openWebTaskRepository()
    expect(createdWorkers).toHaveLength(3)
    const retryWorker = requireCreatedWorker(2)
    retryWorker.respondToLast({ status: 'AVAILABLE' })
    const lease = requireLease(await retried)

    const listed = lease.repository.listTasks()
    retryWorker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(lease, retryWorker)
    expect(retryWorker.terminated).toBe(true)
  })

  test('G: explicit option opens stay isolated from the shared core', async () => {
    stubDefaultOpenEnvironment()

    const sharedOpen = openWebTaskRepository()
    const sharedWorker = requireCreatedWorker(0)
    sharedWorker.respondToLast({ status: 'AVAILABLE' })
    const sharedLease = requireLease(await sharedOpen)

    const customWorker = new FakeWorker()
    const customOpen = openWebTaskRepository({
      workerSupported: true,
      crossOriginIsolated: true,
      workerFactory: () => customWorker,
    })
    customWorker.respondToLast({ status: 'AVAILABLE' })
    const customLease = requireLease(await customOpen)

    expect(createdWorkers).toHaveLength(1)
    expect(customWorker).not.toBe(sharedWorker)

    const customClosing = customLease.dispose()
    customWorker.respondToLast(null)
    await customClosing
    expect(customWorker.terminated).toBe(true)
    expect(sharedWorker.terminated).toBe(false)

    const listed = sharedLease.repository.listTasks()
    sharedWorker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(sharedLease, sharedWorker)
    expect(sharedWorker.terminated).toBe(true)
  })

  test('H: a new default generation waits for the previous shutdown to finish', async () => {
    stubDefaultOpenEnvironment()

    const opened = openWebTaskRepository()
    const firstWorker = requireCreatedWorker(0)
    firstWorker.respondToLast({ status: 'AVAILABLE' })
    const lease = requireLease(await opened)

    const closing = lease.dispose()
    expect(firstWorker.messages.at(-1)).toMatchObject({ type: 'shutdown' })

    const reopened = openWebTaskRepository()
    expect(createdWorkers).toHaveLength(1)

    firstWorker.respondToLast(null)
    await closing
    expect(firstWorker.terminated).toBe(true)
    expect(createdWorkers).toHaveLength(2)

    const secondWorker = requireCreatedWorker(1)
    secondWorker.respondToLast({ status: 'AVAILABLE' })
    const reopenedLease = requireLease(await reopened)

    const listed = reopenedLease.repository.listTasks()
    secondWorker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(reopenedLease, secondWorker)
    expect(secondWorker.terminated).toBe(true)
  })
})

describe('shared default persistence exposes Diary', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    createdWorkers.length = 0
  })

  test('default shared lease exposes a working diaryRepository', async () => {
    stubDefaultOpenEnvironment()

    const first = openWebTaskRepository()
    const second = openWebTaskRepository()
    const worker = requireCreatedWorker(0)
    worker.respondToLast({ status: 'AVAILABLE' })
    const firstLease = requireLease(await first)
    const secondLease = requireLease(await second)

    expect('diaryRepository' in firstLease).toBe(true)
    expect('diaryRepository' in secondLease).toBe(true)
    expect(createdWorkers).toHaveLength(1)

    const listed = secondLease.diaryRepository.listActive()
    expect(worker.messages.at(-1)).toMatchObject({ type: 'diary.listActive' })
    worker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await firstLease.dispose()
    expect(worker.terminated).toBe(false)
    await releaseFinalLease(secondLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('two concurrent default opens share one Worker and both expose diaryRepository', async () => {
    stubDefaultOpenEnvironment()

    const first = openWebTaskRepository()
    const second = openWebTaskRepository()
    expect(createdWorkers).toHaveLength(1)
    const worker = requireCreatedWorker(0)

    worker.respondToLast({ status: 'AVAILABLE' })
    const firstLease = requireLease(await first)
    const secondLease = requireLease(await second)

    expect(createdWorkers).toHaveLength(1)
    expect(worker.messages).toHaveLength(1)
    expect(firstLease.diaryRepository).toBeDefined()
    expect(secondLease.diaryRepository).toBeDefined()

    await firstLease.dispose()
    await releaseFinalLease(secondLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('releasing one lease keeps the diaryRepository usable on the remaining lease', async () => {
    stubDefaultOpenEnvironment()
    const [firstLease, secondLease] = await openSharedPair()
    const worker = requireCreatedWorker(0)

    await firstLease.dispose()
    expect(worker.terminated).toBe(false)

    const listed = secondLease.diaryRepository.listActive()
    worker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(secondLease, worker)
    expect(worker.terminated).toBe(true)
  })

  test('explicit unshared option still exposes diaryRepository and stays isolated', async () => {
    stubDefaultOpenEnvironment()

    const sharedOpen = openWebTaskRepository()
    const sharedWorker = requireCreatedWorker(0)
    sharedWorker.respondToLast({ status: 'AVAILABLE' })
    const sharedLease = requireLease(await sharedOpen)
    expect(sharedLease.diaryRepository).toBeDefined()

    const customWorker = new FakeWorker()
    const customOpen = openWebTaskRepository({
      workerSupported: true,
      crossOriginIsolated: true,
      workerFactory: () => customWorker,
    })
    customWorker.respondToLast({ status: 'AVAILABLE' })
    const customLease = requireLease(await customOpen)

    expect(createdWorkers).toHaveLength(1)
    expect(customWorker).not.toBe(sharedWorker)
    expect(customLease.diaryRepository).toBeDefined()

    const customClosing = customLease.dispose()
    customWorker.respondToLast(null)
    await customClosing
    expect(customWorker.terminated).toBe(true)
    expect(sharedWorker.terminated).toBe(false)

    const listed = sharedLease.diaryRepository.listActive()
    sharedWorker.respondToLast([])
    await expect(listed).resolves.toEqual([])

    await releaseFinalLease(sharedLease, sharedWorker)
    expect(sharedWorker.terminated).toBe(true)
  })
})

defineTaskRepositoryContract('WebTaskRepository', createWebContractFixture)

describe('Web migrations', () => {
  test('uses the shared LF-only migration bytes and bootstraps history', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS, () => 123)

    for (const migration of WEB_MIGRATIONS) {
      expect(migration.sql).not.toContain('\r')
      expect(migration.sql.charCodeAt(0)).not.toBe(0xfeff)
    }
    expect(store.metadataEnsured).toBe(true)
    expect(store.metadataValidated).toBe(true)
    expect(store.executedSql).toEqual(
      WEB_MIGRATIONS.map((migration) => migration.sql),
    )
    expect(store.history).toEqual([
      {
        version: 1,
        id: '0001_create_tasks',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[0]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 2,
        id: '0002_add_task_planning_fields',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[1]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 3,
        id: '0003_add_task_projects',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[2]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 4,
        id: '0004_add_task_tags',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[3]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 5,
        id: '0005_add_task_soft_delete',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[4]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 6,
        id: '0006_add_canvas_core',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[5]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 7,
        id: '0007_add_canvas_edges',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[6]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 8,
        id: '0008_add_sticky_canvas_nodes',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[7]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 9,
        id: '0009_add_canvas_node_name',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[8]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 10,
        id: '0010_add_canvas_node_boxes',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[9]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 11,
        id: '0011_add_canvas_node_soft_delete',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[10]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 12,
        id: '0012_add_notes_and_diary',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[11]?.sql ?? ''),
        appliedAtMs: 123,
      },
      {
        version: 13,
        id: '0013_add_global_search',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[12]?.sql ?? ''),
        appliedAtMs: 123,
      },
    ])
  })

  test('upgrades an exact v1 prefix and is idempotent after v7', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 1), () => 123)
    expect(store.history.map((row) => row.version)).toEqual([1])
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)

    expect(store.executedSql).toEqual(
      WEB_MIGRATIONS.map((migration) => migration.sql),
    )
    expect(store.history.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
  })

  test('upgrades an exact v2 prefix through Canvas Edge migration 7', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 2), () => 123)
    expect(store.history.map((row) => row.version)).toEqual([1, 2])
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)
    expect(store.history.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(store.history[2]).toMatchObject({
      id: '0003_add_task_projects',
      appliedAtMs: 456,
    })
    expect(store.history[3]).toMatchObject({
      id: '0004_add_task_tags',
      appliedAtMs: 456,
    })
    expect(store.history[4]).toMatchObject({
      id: '0005_add_task_soft_delete',
      appliedAtMs: 456,
    })
    expect(store.history[5]).toMatchObject({
      id: '0006_add_canvas_core',
      appliedAtMs: 456,
    })
    expect(store.history[6]).toMatchObject({
      id: '0007_add_canvas_edges',
      appliedAtMs: 456,
    })
    expect(store.history[7]).toMatchObject({ id: '0008_add_sticky_canvas_nodes', appliedAtMs: 456 })
    expect(store.history[8]).toMatchObject({ id: '0009_add_canvas_node_name', appliedAtMs: 456 })
    expect(store.history[9]).toMatchObject({ id: '0010_add_canvas_node_boxes', appliedAtMs: 456 })
    expect(store.history[10]).toMatchObject({ id: '0011_add_canvas_node_soft_delete', appliedAtMs: 456 })
  })

  test('upgrades an exact v3 prefix through Canvas Edge migration 7', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 3), () => 123)
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)
    expect(store.history.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(store.history[3]).toMatchObject({
      id: '0004_add_task_tags',
      appliedAtMs: 456,
    })
    expect(store.history[4]).toMatchObject({
      id: '0005_add_task_soft_delete',
      appliedAtMs: 456,
    })
  })

  test('upgrades an exact v4 prefix through Canvas Edge migration 7', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 4), () => 123)
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)

    expect(store.history.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(store.history[4]).toMatchObject({
      id: '0005_add_task_soft_delete',
      appliedAtMs: 456,
    })
    expect(store.executedSql[4]).toBe(WEB_MIGRATIONS[4]?.sql)
  })

  test('upgrades an exact v5 prefix through Canvas Edge migration 7', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 5), () => 123)
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)
    expect(store.history.map((row) => row.version)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13])
    expect(store.history[5]).toMatchObject({
      id: '0006_add_canvas_core',
      appliedAtMs: 456,
    })
    expect(store.executedSql[5]).toBe(WEB_MIGRATIONS[5]?.sql)
    expect(store.history[6]).toMatchObject({
      id: '0007_add_canvas_edges',
      appliedAtMs: 456,
    })
    expect(store.executedSql[6]).toBe(WEB_MIGRATIONS[6]?.sql)
  })

  test('fails closed on id and checksum mismatch', async () => {
    const checksum = await sha256Hex(WEB_MIGRATIONS[0]?.sql ?? '')
    for (const history of [
      [{ version: 1, id: 'wrong', checksumSha256: checksum, appliedAtMs: 1 }],
      [
        {
          version: 1,
          id: '0001_create_tasks',
          checksumSha256: '0'.repeat(64),
          appliedAtMs: 1,
        },
      ],
    ]) {
      const store = new FakeMigrationStore()
      store.history = history
      await expect(runWebMigrations(store)).rejects.toEqual(
        new WebMigrationError('HISTORY_CORRUPT'),
      )
      expect(store.executedSql).toEqual([])
    }
  })

  test('fails closed on a non-contiguous or future history version', async () => {
    for (const version of [0, 2]) {
      const store = new FakeMigrationStore()
      store.history = [
        {
          version,
          id: '0001_create_tasks',
          checksumSha256: '0'.repeat(64),
          appliedAtMs: 1,
        },
      ]
      await expect(runWebMigrations(store)).rejects.toBeInstanceOf(
        WebMigrationError,
      )
      expect(store.executedSql).toEqual([])
    }
  })

  test('rolls Migration 2 SQL back when history insertion fails', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 1), () => 123)
    store.failHistoryInsert = true

    await expect(runWebMigrations(store)).rejects.toEqual(
      new WebMigrationError('APPLY_FAILED'),
    )
    expect(store.executedSql).toEqual([WEB_MIGRATIONS[0]?.sql])
    expect(store.history.map((row) => row.version)).toEqual([1])
  })

  test('rejects definition gaps before touching metadata', async () => {
    const store = new FakeMigrationStore()
    await expect(
      runWebMigrations(store, [
        {
          version: 2,
          id: 'gap',
          sql: 'SELECT 1\n',
          highRisk: false,
        },
      ]),
    ).rejects.toEqual(new WebMigrationError('DEFINITION_INVALID'))
    expect(store.metadataEnsured).toBe(false)
  })
})

test('Task Worker protocol does not expose a generic command', () => {
  const allowed = [
    'initialize',
    'task.create',
    'task.list',
    'task.rename',
    'task.changeStatus',
    'task.setImportance',
    'task.setUrgency',
    'task.setDeadline',
    'task.clearDeadline',
    'shutdown',
  ]
  expect(allowed).not.toContain('sql')
  expect(allowed).not.toContain('query')
  expect(allowed).not.toContain('execute')
  expect(parseTaskWorkerRequest({ requestId: 1, type: 'sql' })).toBeNull()
  expect(parseTaskWorkerRequest({ requestId: 2, type: 'query' })).toBeNull()
  expect(parseTaskWorkerRequest({ requestId: 3, type: 'execute' })).toBeNull()
})

test('planning Worker messages are capability-specific and strictly parsed', () => {
  expect(
    parseTaskWorkerRequest({
      requestId: 1,
      type: 'task.setImportance',
      input: { id: ID, isImportant: true, updatedAtMs: 200 },
    }),
  ).toEqual({
    requestId: 1,
    type: 'task.setImportance',
    input: { id: ID, isImportant: true, updatedAtMs: 200 },
  })
  expect(
    parseTaskWorkerRequest({
      requestId: 2,
      type: 'task.setUrgency',
      input: { id: ID, isUrgent: false, updatedAtMs: 200 },
    }),
  ).not.toBeNull()
  expect(
    parseTaskWorkerRequest({
      requestId: 3,
      type: 'task.setDeadline',
      input: { id: ID, dueDate: '2024-02-29', updatedAtMs: 200 },
    }),
  ).not.toBeNull()
  expect(
    parseTaskWorkerRequest({
      requestId: 4,
      type: 'task.clearDeadline',
      input: { id: ID, updatedAtMs: 200, sql: 'DELETE' },
    }),
  ).toEqual({
    requestId: 4,
    type: 'task.clearDeadline',
    input: { id: ID, updatedAtMs: 200 },
  })

  for (const request of [
    {
      requestId: 5,
      type: 'task.setImportance',
      input: { id: ID, isImportant: 1, updatedAtMs: 200 },
    },
    {
      requestId: 6,
      type: 'task.setUrgency',
      input: { id: ID, isUrgent: 'true', updatedAtMs: 200 },
    },
    {
      requestId: 7,
      type: 'task.setDeadline',
      input: { id: ID, dueDate: '2025-02-29', updatedAtMs: 200 },
    },
  ]) {
    expect(parseTaskWorkerRequest(request)).toBeNull()
  }
})
