import type { Task, TaskStatusOperation } from '@/task/model'

export interface CreateTaskInput {
  readonly id: string
  readonly title: string
  readonly createdAtMs: number
}

export interface RenameTaskInput {
  readonly id: string
  readonly title: string
  readonly updatedAtMs: number
}

export interface ChangeTaskStatusInput {
  readonly id: string
  readonly operation: TaskStatusOperation
  readonly updatedAtMs: number
}

export interface TaskRepository {
  createTask(input: CreateTaskInput): Promise<Task>
  listTasks(): Promise<readonly Task[]>
  renameTask(input: RenameTaskInput): Promise<Task>
  changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task>
}

export const TASK_REPOSITORY_ERROR_CODES = [
  'NOT_FOUND',
  'STATUS_CONFLICT',
  'PERSISTENCE_UNAVAILABLE',
  'PERSISTENCE_FAILED',
] as const

export type TaskRepositoryErrorCode =
  (typeof TASK_REPOSITORY_ERROR_CODES)[number]

export type TaskRepositoryOperation =
  | 'createTask'
  | 'listTasks'
  | 'renameTask'
  | 'changeTaskStatus'

const SAFE_ERROR_MESSAGES: Record<TaskRepositoryErrorCode, string> = {
  NOT_FOUND: 'Task not found.',
  STATUS_CONFLICT: 'Task status conflict.',
  PERSISTENCE_UNAVAILABLE: 'Task persistence is unavailable.',
  PERSISTENCE_FAILED: 'Task persistence operation failed.',
}

export class TaskRepositoryError extends Error {
  readonly code: TaskRepositoryErrorCode
  readonly operation: TaskRepositoryOperation

  constructor(
    code: TaskRepositoryErrorCode,
    operation: TaskRepositoryOperation,
  ) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'TaskRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isTaskRepositoryErrorCode(
  value: unknown,
): value is TaskRepositoryErrorCode {
  return (
    typeof value === 'string' &&
    TASK_REPOSITORY_ERROR_CODES.some((code) => code === value)
  )
}
