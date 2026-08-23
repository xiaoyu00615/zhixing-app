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
  isImportant: false,
  isUrgent: false,
  dueDate: null,
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
    ])
  })

  test('upgrades an exact v1 prefix and is idempotent after v2', async () => {
    const store = new FakeMigrationStore()
    await runWebMigrations(store, WEB_MIGRATIONS.slice(0, 1), () => 123)
    expect(store.history.map((row) => row.version)).toEqual([1])
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)
    await runWebMigrations(store, WEB_MIGRATIONS, () => 456)

    expect(store.executedSql).toEqual(
      WEB_MIGRATIONS.map((migration) => migration.sql),
    )
    expect(store.history.map((row) => row.version)).toEqual([1, 2])
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
