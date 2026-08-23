import { describe, expect, test } from 'vitest'

import {
  openWebTaskRepository,
  WebTaskRepository,
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
        case 'task.rename':
          result = this.backend.renameTask(request.input)
          break
        case 'task.changeStatus':
          result = this.backend.changeTaskStatus(request.input)
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

defineTaskRepositoryContract('WebTaskRepository', createWebContractFixture)

describe('Web migrations', () => {
  test('uses the shared LF-only migration bytes and bootstraps history', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS, () => 123)

    expect(WEB_MIGRATIONS[0]?.sql).not.toContain('\r')
    expect(WEB_MIGRATIONS[0]?.sql.charCodeAt(0)).not.toBe(0xfeff)
    expect(store.metadataEnsured).toBe(true)
    expect(store.metadataValidated).toBe(true)
    expect(store.executedSql).toEqual([WEB_MIGRATIONS[0]?.sql])
    expect(store.history).toEqual([
      {
        version: 1,
        id: '0001_create_tasks',
        checksumSha256: await sha256Hex(WEB_MIGRATIONS[0]?.sql ?? ''),
        appliedAtMs: 123,
      },
    ])
  })

  test('accepts an exact contiguous prefix and is idempotent', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS, () => 123)
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)

    expect(store.executedSql).toHaveLength(1)
    expect(store.history).toHaveLength(1)
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

  test('rolls migration SQL back when history insertion fails', async () => {
    const store = new FakeMigrationStore()
    store.failHistoryInsert = true

    await expect(runWebMigrations(store)).rejects.toEqual(
      new WebMigrationError('APPLY_FAILED'),
    )
    expect(store.executedSql).toEqual([])
    expect(store.history).toEqual([])
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

test('Batch B does not introduce a generic Worker command', () => {
  const allowed = [
    'initialize',
    'task.create',
    'task.list',
    'task.rename',
    'task.changeStatus',
    'shutdown',
  ]
  expect(allowed).not.toContain('sql')
  expect(allowed).not.toContain('query')
  expect(allowed).not.toContain('execute')
  expect(parseTaskWorkerRequest({ requestId: 1, type: 'sql' })).toBeNull()
  expect(parseTaskWorkerRequest({ requestId: 2, type: 'query' })).toBeNull()
  expect(parseTaskWorkerRequest({ requestId: 3, type: 'execute' })).toBeNull()
})
