import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
  isValidLocalDate,
  type LocalDate,
  type Task,
  type TaskStatusOperation,
} from '@/task/model'
import { TaskRepositoryError, type TaskRepository } from '@/task/repository'

export const TASK_APPLICATION_ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'STATUS_CONFLICT',
  'UNAVAILABLE',
] as const

export type TaskApplicationErrorCode =
  (typeof TASK_APPLICATION_ERROR_CODES)[number]

export type TaskApplicationErrorField =
  'id' | 'title' | 'dueDate' | 'importance' | 'urgency'

const SAFE_ERROR_MESSAGES: Record<TaskApplicationErrorCode, string> = {
  VALIDATION: 'Task input is invalid.',
  NOT_FOUND: 'Task not found.',
  STATUS_CONFLICT: 'Task status conflict.',
  UNAVAILABLE: 'Task service is unavailable.',
}

export class TaskApplicationError extends Error {
  readonly code: TaskApplicationErrorCode
  readonly field?: TaskApplicationErrorField

  constructor(
    code: TaskApplicationErrorCode,
    field?: TaskApplicationErrorField,
  ) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'TaskApplicationError'
    this.code = code
    this.field = field
  }
}

export type GenerateTaskId = () => string
export type NowMs = () => number

export interface CreateTaskServiceOptions {
  readonly repository: TaskRepository
  readonly generateTaskId?: GenerateTaskId
  readonly nowMs?: NowMs
}

function defaultGenerateTaskId(): string {
  return globalThis.crypto.randomUUID()
}

function defaultNowMs(): number {
  return Date.now()
}

function normalizeTitle(title: string): string {
  const normalized = title.trim()
  if (normalized.length === 0) {
    throw new TaskApplicationError('VALIDATION', 'title')
  }
  return normalized
}

function validateTaskId(id: string): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new TaskApplicationError('VALIDATION', 'id')
  }
}

function readBoolean(value: unknown, field: 'importance' | 'urgency'): boolean {
  if (typeof value !== 'boolean') {
    throw new TaskApplicationError('VALIDATION', field)
  }
  return value
}

function readDueDate(value: unknown): LocalDate {
  if (!isValidLocalDate(value)) {
    throw new TaskApplicationError('VALIDATION', 'dueDate')
  }
  return value
}

function readGeneratedTaskId(generateTaskId: GenerateTaskId): string {
  try {
    const id = generateTaskId()
    if (!isCanonicalLowercaseUuid(id)) {
      throw new TaskApplicationError('UNAVAILABLE')
    }
    return id
  } catch (error: unknown) {
    if (error instanceof TaskApplicationError) {
      throw error
    }
    throw new TaskApplicationError('UNAVAILABLE')
  }
}

function readNowMs(nowMs: NowMs): number {
  try {
    const value = nowMs()
    if (!isNonNegativeSafeIntegerMilliseconds(value)) {
      throw new TaskApplicationError('UNAVAILABLE')
    }
    return value
  } catch (error: unknown) {
    if (error instanceof TaskApplicationError) {
      throw error
    }
    throw new TaskApplicationError('UNAVAILABLE')
  }
}

function mapRepositoryError(error: unknown): TaskApplicationError {
  if (!(error instanceof TaskRepositoryError)) {
    return new TaskApplicationError('UNAVAILABLE')
  }

  switch (error.code) {
    case 'NOT_FOUND':
      return new TaskApplicationError('NOT_FOUND')
    case 'STATUS_CONFLICT':
      return new TaskApplicationError('STATUS_CONFLICT')
    case 'PERSISTENCE_UNAVAILABLE':
    case 'PERSISTENCE_FAILED':
      return new TaskApplicationError('UNAVAILABLE')
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw mapRepositoryError(error)
  }
}

export function createTaskService({
  repository,
  generateTaskId = defaultGenerateTaskId,
  nowMs = defaultNowMs,
}: CreateTaskServiceOptions) {
  async function changeStatus(
    id: string,
    operation: TaskStatusOperation,
  ): Promise<Task> {
    validateTaskId(id)
    const updatedAtMs = readNowMs(nowMs)
    return callRepository(() =>
      repository.changeTaskStatus({ id, operation, updatedAtMs }),
    )
  }

  return {
    async createTask(input: {
      readonly title: string
      readonly isImportant?: boolean
      readonly isUrgent?: boolean
      readonly dueDate?: LocalDate | null
    }): Promise<Task> {
      const title = normalizeTitle(input.title)
      const isImportant =
        input.isImportant === undefined
          ? false
          : readBoolean(input.isImportant, 'importance')
      const isUrgent =
        input.isUrgent === undefined
          ? false
          : readBoolean(input.isUrgent, 'urgency')
      const dueDate =
        input.dueDate === undefined || input.dueDate === null
          ? null
          : readDueDate(input.dueDate)
      const id = readGeneratedTaskId(generateTaskId)
      const createdAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.createTask({
          id,
          title,
          createdAtMs,
          isImportant,
          isUrgent,
          dueDate,
        }),
      )
    },

    listTasks(): Promise<readonly Task[]> {
      return callRepository(() => repository.listTasks())
    },

    async renameTask(input: {
      readonly id: string
      readonly title: string
    }): Promise<Task> {
      validateTaskId(input.id)
      const title = normalizeTitle(input.title)
      const updatedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.renameTask({ id: input.id, title, updatedAtMs }),
      )
    },

    startTask(id: string): Promise<Task> {
      return changeStatus(id, 'start')
    },

    completeTask(id: string): Promise<Task> {
      return changeStatus(id, 'complete')
    },

    cancelTask(id: string): Promise<Task> {
      return changeStatus(id, 'cancel')
    },

    reopenTask(id: string): Promise<Task> {
      return changeStatus(id, 'reopen')
    },

    async setTaskImportance(id: string, isImportant: boolean): Promise<Task> {
      validateTaskId(id)
      const normalized = readBoolean(isImportant, 'importance')
      const updatedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.setTaskImportance({
          id,
          isImportant: normalized,
          updatedAtMs,
        }),
      )
    },

    async setTaskUrgency(id: string, isUrgent: boolean): Promise<Task> {
      validateTaskId(id)
      const normalized = readBoolean(isUrgent, 'urgency')
      const updatedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.setTaskUrgency({ id, isUrgent: normalized, updatedAtMs }),
      )
    },

    async setTaskDeadline(id: string, dueDate: LocalDate): Promise<Task> {
      validateTaskId(id)
      const normalized = readDueDate(dueDate)
      const updatedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.setTaskDeadline({ id, dueDate: normalized, updatedAtMs }),
      )
    },

    async clearTaskDeadline(id: string): Promise<Task> {
      validateTaskId(id)
      const updatedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.clearTaskDeadline({ id, updatedAtMs }),
      )
    },
  }
}

export type TaskService = ReturnType<typeof createTaskService>
