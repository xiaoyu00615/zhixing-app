import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatus,
  isTaskStatusOperation,
  type Task,
} from '@/task/model'
import {
  TaskRepositoryError,
  type ChangeTaskStatusInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type TaskRepository,
  type TaskRepositoryOperation,
} from '@/task/repository'
import {
  createTaskPersistenceWorker,
  TaskWorkerClient,
  TaskWorkerClientError,
  type TaskWorkerEndpoint,
} from '@/adapters/web/taskWorkerClient'
import {
  isRecord,
  type WebPersistenceCapability,
} from '@/adapters/web/taskWorkerProtocol'

function parseTask(value: unknown, operation: TaskRepositoryOperation): Task {
  if (!isRecord(value)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }

  const { id, title, status, createdAtMs, updatedAtMs } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyTaskTitle(title) ||
    !isTaskStatus(status) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return { id, title, status, createdAtMs, updatedAtMs }
}

function validateId(id: string, operation: TaskRepositoryOperation): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function validateTitle(
  title: string,
  operation: TaskRepositoryOperation,
): void {
  if (!isNonEmptyTaskTitle(title)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function validateTimestamp(
  timestamp: number,
  operation: TaskRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(timestamp)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function mapClientError(
  error: unknown,
  operation: TaskRepositoryOperation,
): TaskRepositoryError {
  if (error instanceof TaskRepositoryError) {
    return error
  }
  if (error instanceof TaskWorkerClientError) {
    return new TaskRepositoryError(error.code, operation)
  }
  return new TaskRepositoryError('PERSISTENCE_FAILED', operation)
}

export class WebTaskRepository implements TaskRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const operation = 'createTask'
    validateId(input.id, operation)
    validateTitle(input.title, operation)
    validateTimestamp(input.createdAtMs, operation)
    try {
      return parseTask(await this.#client.createTask(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async listTasks(): Promise<readonly Task[]> {
    const operation = 'listTasks'
    try {
      const value = await this.#client.listTasks()
      if (!Array.isArray(value)) {
        throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((task) => parseTask(task, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async renameTask(input: RenameTaskInput): Promise<Task> {
    const operation = 'renameTask'
    validateId(input.id, operation)
    validateTitle(input.title, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      return parseTask(await this.#client.renameTask(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task> {
    const operation = 'changeTaskStatus'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isTaskStatusOperation(input.operation)) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseTask(await this.#client.changeTaskStatus(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }
}

export interface OpenWebTaskRepositoryOptions {
  readonly workerSupported?: boolean
  readonly crossOriginIsolated?: boolean
  readonly workerFactory?: () => TaskWorkerEndpoint
}

export type OpenWebTaskRepositoryResult =
  | {
      readonly capability: { readonly status: 'AVAILABLE' }
      readonly repository: WebTaskRepository
      readonly dispose: () => Promise<void>
    }
  | {
      readonly capability: Exclude<
        WebPersistenceCapability,
        { readonly status: 'AVAILABLE' }
      >
    }

export async function openWebTaskRepository(
  options: OpenWebTaskRepositoryOptions = {},
): Promise<OpenWebTaskRepositoryResult> {
  const workerSupported =
    options.workerSupported ?? typeof globalThis.Worker !== 'undefined'
  if (!workerSupported) {
    return {
      capability: { status: 'UNAVAILABLE', reason: 'WORKER_UNSUPPORTED' },
    }
  }

  const isolated =
    options.crossOriginIsolated ?? globalThis.crossOriginIsolated === true
  if (!isolated) {
    return {
      capability: {
        status: 'RESTRICTED',
        reason: 'CROSS_ORIGIN_ISOLATION_REQUIRED',
      },
    }
  }

  let client: TaskWorkerClient
  try {
    client = new TaskWorkerClient(
      (options.workerFactory ?? createTaskPersistenceWorker)(),
    )
  } catch {
    return {
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    }
  }

  try {
    const capability = await client.initialize()
    if (capability.status !== 'AVAILABLE') {
      client.terminate()
      return { capability }
    }
    return {
      capability,
      repository: new WebTaskRepository(client),
      dispose: () => client.shutdown(),
    }
  } catch {
    client.terminate()
    return {
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    }
  }
}
