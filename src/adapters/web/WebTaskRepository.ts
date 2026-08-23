import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatus,
  isTaskStatusOperation,
  isValidLocalDate,
  type Task,
} from '@/task/model'
import {
  TaskRepositoryError,
  type ChangeTaskStatusInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type RestoreTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
  type TaskRepository,
  type TaskRepositoryOperation,
  type TrashTaskInput,
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
import { WebProjectRepository } from '@/adapters/web/WebProjectRepository'
import { WebTagRepository } from '@/adapters/web/WebTagRepository'
import { WebCanvasRepository } from '@/adapters/web/WebCanvasRepository'

function parseTask(value: unknown, operation: TaskRepositoryOperation): Task {
  if (!isRecord(value)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }

  const {
    id,
    title,
    status,
    createdAtMs,
    updatedAtMs,
    isImportant,
    isUrgent,
    dueDate,
    projectId,
    tagIds,
    deletedAtMs,
  } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyTaskTitle(title) ||
    !isTaskStatus(status) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs ||
    typeof isImportant !== 'boolean' ||
    typeof isUrgent !== 'boolean' ||
    (dueDate !== null && !isValidLocalDate(dueDate)) ||
    (projectId !== null && !isCanonicalLowercaseUuid(projectId)) ||
    !Array.isArray(tagIds) ||
    tagIds.some((tagId) => !isCanonicalLowercaseUuid(tagId)) ||
    new Set(tagIds).size !== tagIds.length ||
    (deletedAtMs !== null && !isNonNegativeSafeIntegerMilliseconds(deletedAtMs))
  ) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return {
    id,
    title,
    status,
    createdAtMs,
    updatedAtMs,
    isImportant,
    isUrgent,
    dueDate,
    projectId,
    tagIds,
    deletedAtMs,
  }
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
    if (
      (input.isImportant !== undefined &&
        typeof input.isImportant !== 'boolean') ||
      (input.isUrgent !== undefined && typeof input.isUrgent !== 'boolean') ||
      (input.dueDate !== undefined &&
        input.dueDate !== null &&
        !isValidLocalDate(input.dueDate)) ||
      (input.projectId !== undefined &&
        input.projectId !== null &&
        !isCanonicalLowercaseUuid(input.projectId)) ||
      (input.tagIds !== undefined &&
        (!Array.isArray(input.tagIds) ||
          input.tagIds.some((tagId) => !isCanonicalLowercaseUuid(tagId)) ||
          new Set(input.tagIds).size !== input.tagIds.length))
    ) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseTask(
        await this.#client.createTask({
          ...input,
          isImportant: input.isImportant ?? false,
          isUrgent: input.isUrgent ?? false,
          dueDate: input.dueDate ?? null,
          projectId: input.projectId ?? null,
          tagIds: input.tagIds ?? [],
        }),
        operation,
      )
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

  async listTrashedTasks(): Promise<readonly Task[]> {
    const operation = 'listTrashedTasks'
    try {
      const value = await this.#client.listTrashedTasks()
      if (!Array.isArray(value)) {
        throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((task) => parseTask(task, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  trashTask(input: TrashTaskInput): Promise<Task> {
    return this.callLifecycle('trashTask', input, () =>
      this.#client.trashTask(input),
    )
  }

  restoreTask(input: RestoreTaskInput): Promise<Task> {
    return this.callLifecycle('restoreTask', input, () =>
      this.#client.restoreTask(input),
    )
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

  async setTaskImportance(input: SetTaskImportanceInput): Promise<Task> {
    return this.callPlanning(
      'setTaskImportance',
      input,
      () => this.#client.setTaskImportance(input),
      typeof input.isImportant === 'boolean',
    )
  }

  async setTaskUrgency(input: SetTaskUrgencyInput): Promise<Task> {
    return this.callPlanning(
      'setTaskUrgency',
      input,
      () => this.#client.setTaskUrgency(input),
      typeof input.isUrgent === 'boolean',
    )
  }

  async setTaskDeadline(input: SetTaskDeadlineInput): Promise<Task> {
    return this.callPlanning(
      'setTaskDeadline',
      input,
      () => this.#client.setTaskDeadline(input),
      isValidLocalDate(input.dueDate),
    )
  }

  async clearTaskDeadline(input: ClearTaskDeadlineInput): Promise<Task> {
    return this.callPlanning(
      'clearTaskDeadline',
      input,
      () => this.#client.clearTaskDeadline(input),
      true,
    )
  }

  async setTaskProject(
    input: import('@/task/repository').SetTaskProjectInput,
  ): Promise<Task> {
    return this.callPlanning(
      'setTaskProject',
      input,
      () => this.#client.setTaskProject(input),
      isCanonicalLowercaseUuid(input.projectId),
    )
  }

  async clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Promise<Task> {
    return this.callPlanning(
      'clearTaskProject',
      input,
      () => this.#client.clearTaskProject(input),
      true,
    )
  }

  async addTaskTag(
    input: import('@/task/repository').AddTaskTagInput,
  ): Promise<Task> {
    return this.callPlanning(
      'addTaskTag',
      input,
      () => this.#client.addTaskTag(input),
      isCanonicalLowercaseUuid(input.tagId),
    )
  }

  async removeTaskTag(
    input: import('@/task/repository').RemoveTaskTagInput,
  ): Promise<Task> {
    return this.callPlanning(
      'removeTaskTag',
      input,
      () => this.#client.removeTaskTag(input),
      isCanonicalLowercaseUuid(input.tagId),
    )
  }

  private async callPlanning(
    operation: Extract<
      TaskRepositoryOperation,
      | 'setTaskImportance'
      | 'setTaskUrgency'
      | 'setTaskDeadline'
      | 'clearTaskDeadline'
      | 'setTaskProject'
      | 'clearTaskProject'
      | 'addTaskTag'
      | 'removeTaskTag'
    >,
    input: { readonly id: string; readonly updatedAtMs: number },
    call: () => Promise<unknown>,
    valueIsValid: boolean,
  ): Promise<Task> {
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!valueIsValid) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseTask(await call(), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  private async callLifecycle(
    operation: 'trashTask' | 'restoreTask',
    input: { readonly id: string; readonly updatedAtMs: number },
    call: () => Promise<unknown>,
  ): Promise<Task> {
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      return parseTask(await call(), operation)
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
      readonly projectRepository: import('@/project/repository').ProjectRepository
      readonly tagRepository: import('@/tag/repository').TagRepository
      readonly canvasRepository: import('@/canvas/repository').CanvasRepository
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
      projectRepository: new WebProjectRepository(client),
      tagRepository: new WebTagRepository(client),
      canvasRepository: new WebCanvasRepository(client),
      dispose: () => client.shutdown(),
    }
  } catch {
    client.terminate()
    return {
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    }
  }
}
