import type { LocalDate, Task, TaskStatusOperation } from '@/task/model'

export interface CreateTaskInput {
  readonly id: string
  readonly title: string
  readonly createdAtMs: number
  readonly isImportant?: boolean
  readonly isUrgent?: boolean
  readonly dueDate?: LocalDate | null
  readonly projectId?: string | null
  readonly tagIds?: readonly string[]
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

export interface SetTaskImportanceInput {
  readonly id: string
  readonly isImportant: boolean
  readonly updatedAtMs: number
}

export interface SetTaskUrgencyInput {
  readonly id: string
  readonly isUrgent: boolean
  readonly updatedAtMs: number
}

export interface SetTaskDeadlineInput {
  readonly id: string
  readonly dueDate: LocalDate
  readonly updatedAtMs: number
}

export interface ClearTaskDeadlineInput {
  readonly id: string
  readonly updatedAtMs: number
}

export interface SetTaskProjectInput {
  readonly id: string
  readonly projectId: string
  readonly updatedAtMs: number
}

export interface ClearTaskProjectInput {
  readonly id: string
  readonly updatedAtMs: number
}

export interface AddTaskTagInput {
  readonly id: string
  readonly tagId: string
  readonly updatedAtMs: number
}

export interface RemoveTaskTagInput {
  readonly id: string
  readonly tagId: string
  readonly updatedAtMs: number
}

export interface TrashTaskInput {
  readonly id: string
  readonly updatedAtMs: number
}

export interface RestoreTaskInput {
  readonly id: string
  readonly updatedAtMs: number
}

export interface TaskRepository {
  createTask(input: CreateTaskInput): Promise<Task>
  listTasks(): Promise<readonly Task[]>
  listTrashedTasks(): Promise<readonly Task[]>
  trashTask(input: TrashTaskInput): Promise<Task>
  restoreTask(input: RestoreTaskInput): Promise<Task>
  renameTask(input: RenameTaskInput): Promise<Task>
  changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task>
  setTaskImportance(input: SetTaskImportanceInput): Promise<Task>
  setTaskUrgency(input: SetTaskUrgencyInput): Promise<Task>
  setTaskDeadline(input: SetTaskDeadlineInput): Promise<Task>
  clearTaskDeadline(input: ClearTaskDeadlineInput): Promise<Task>
  setTaskProject(input: SetTaskProjectInput): Promise<Task>
  clearTaskProject(input: ClearTaskProjectInput): Promise<Task>
  addTaskTag(input: AddTaskTagInput): Promise<Task>
  removeTaskTag(input: RemoveTaskTagInput): Promise<Task>
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
  | 'listTrashedTasks'
  | 'trashTask'
  | 'restoreTask'
  | 'renameTask'
  | 'changeTaskStatus'
  | 'setTaskImportance'
  | 'setTaskUrgency'
  | 'setTaskDeadline'
  | 'clearTaskDeadline'
  | 'setTaskProject'
  | 'clearTaskProject'
  | 'addTaskTag'
  | 'removeTaskTag'

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
