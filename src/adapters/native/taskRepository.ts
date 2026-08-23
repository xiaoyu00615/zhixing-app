import { invoke } from '@tauri-apps/api/core'

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
  isTaskRepositoryErrorCode,
  type ChangeTaskStatusInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
  type TaskRepository,
  type TaskRepositoryOperation,
} from '@/task/repository'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTaskDto(
  value: unknown,
  operation: TaskRepositoryOperation,
): Task {
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
    (dueDate !== null && !isValidLocalDate(dueDate))
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

function validateTime(
  timestamp: number,
  operation: TaskRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(timestamp)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function mapInvokeError(
  value: unknown,
  operation: TaskRepositoryOperation,
): TaskRepositoryError {
  if (isRecord(value) && isTaskRepositoryErrorCode(value.code)) {
    return new TaskRepositoryError(value.code, operation)
  }

  return new TaskRepositoryError('PERSISTENCE_UNAVAILABLE', operation)
}

async function invokeTask<T>(
  command: string,
  operation: TaskRepositoryOperation,
  args?: Record<string, unknown>,
): Promise<T> {
  try {
    return await invoke<T>(command, args)
  } catch (error: unknown) {
    if (error instanceof TaskRepositoryError) {
      throw error
    }
    throw mapInvokeError(error, operation)
  }
}

export class NativeTaskRepository implements TaskRepository {
  async createTask(input: CreateTaskInput): Promise<Task> {
    const operation = 'createTask'
    validateId(input.id, operation)
    validateTitle(input.title, operation)
    validateTime(input.createdAtMs, operation)
    if (
      (input.isImportant !== undefined &&
        typeof input.isImportant !== 'boolean') ||
      (input.isUrgent !== undefined && typeof input.isUrgent !== 'boolean') ||
      (input.dueDate !== undefined &&
        input.dueDate !== null &&
        !isValidLocalDate(input.dueDate))
    ) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }

    const dto = await invokeTask<unknown>('task_create', operation, {
      input: {
        ...input,
        isImportant: input.isImportant ?? false,
        isUrgent: input.isUrgent ?? false,
        dueDate: input.dueDate ?? null,
      },
    })
    return parseTaskDto(dto, operation)
  }

  async listTasks(): Promise<readonly Task[]> {
    const operation = 'listTasks'
    const value = await invokeTask<unknown>('task_list', operation)
    if (!Array.isArray(value)) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    return value.map((task) => parseTaskDto(task, operation))
  }

  async renameTask(input: RenameTaskInput): Promise<Task> {
    const operation = 'renameTask'
    validateId(input.id, operation)
    validateTitle(input.title, operation)
    validateTime(input.updatedAtMs, operation)

    const dto = await invokeTask<unknown>('task_rename', operation, { input })
    return parseTaskDto(dto, operation)
  }

  async changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task> {
    const operation = 'changeTaskStatus'
    validateId(input.id, operation)
    validateTime(input.updatedAtMs, operation)
    if (!isTaskStatusOperation(input.operation)) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }

    const dto = await invokeTask<unknown>('task_change_status', operation, {
      input,
    })
    return parseTaskDto(dto, operation)
  }

  async setTaskImportance(input: SetTaskImportanceInput): Promise<Task> {
    return this.invokePlanning(
      'setTaskImportance',
      'task_set_importance',
      input,
      typeof input.isImportant === 'boolean',
    )
  }

  async setTaskUrgency(input: SetTaskUrgencyInput): Promise<Task> {
    return this.invokePlanning(
      'setTaskUrgency',
      'task_set_urgency',
      input,
      typeof input.isUrgent === 'boolean',
    )
  }

  async setTaskDeadline(input: SetTaskDeadlineInput): Promise<Task> {
    return this.invokePlanning(
      'setTaskDeadline',
      'task_set_deadline',
      input,
      isValidLocalDate(input.dueDate),
    )
  }

  async clearTaskDeadline(input: ClearTaskDeadlineInput): Promise<Task> {
    return this.invokePlanning(
      'clearTaskDeadline',
      'task_clear_deadline',
      input,
      true,
    )
  }

  private async invokePlanning(
    operation: Extract<
      TaskRepositoryOperation,
      | 'setTaskImportance'
      | 'setTaskUrgency'
      | 'setTaskDeadline'
      | 'clearTaskDeadline'
    >,
    command: string,
    input: { readonly id: string; readonly updatedAtMs: number },
    valueIsValid: boolean,
  ): Promise<Task> {
    validateId(input.id, operation)
    validateTime(input.updatedAtMs, operation)
    if (!valueIsValid) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    const dto = await invokeTask<unknown>(command, operation, { input })
    return parseTaskDto(dto, operation)
  }
}
