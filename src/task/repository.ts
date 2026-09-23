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

/**
 * Archive V1 (P5C-S1).
 *
 * Target precondition: `deleted_at_ms IS NULL AND archived_at_ms IS NULL`.
 * On success: `archived_at_ms = updatedAtMs` and `updated_at_ms = updatedAtMs`.
 * Every other business field is preserved verbatim.
 */
export interface ArchiveTaskInput {
  readonly id: string
  readonly updatedAtMs: number
}

/**
 * Archive V1 (P5C-S1).
 *
 * Target precondition: `deleted_at_ms IS NULL AND archived_at_ms IS NOT NULL`.
 * On success: `archived_at_ms = NULL` and `updated_at_ms = updatedAtMs`.
 * Every other business field is preserved verbatim.
 */
export interface UnarchiveTaskInput {
  readonly id: string
  readonly updatedAtMs: number
}

export interface TaskRepository {
  createTask(input: CreateTaskInput): Promise<Task>
  /**
   * Active workspace read: `deleted_at_ms IS NULL AND archived_at_ms IS NULL`.
   * Archived tasks are hidden from the normal workspace without being deleted.
   */
  listTasks(): Promise<readonly Task[]>
  /**
   * Trash read: `deleted_at_ms IS NOT NULL`.
   * A row trashed from Archive keeps `archived_at_ms` and is still listed here.
   */
  listTrashedTasks(): Promise<readonly Task[]>
  /**
   * Lifecycle target is "not deleted" (`deleted_at_ms IS NULL`), NOT
   * "active": an archived task must still be trashable
   * (Archive -> Trash -> Restore -> Archive).
   */
  trashTask(input: TrashTaskInput): Promise<Task>
  /**
   * Clears `deleted_at_ms` and PRESERVES `archived_at_ms`, restoring the row to
   * its previous logical state (active or archived).
   */
  restoreTask(input: RestoreTaskInput): Promise<Task>
  /** Fails closed when the target is deleted or already archived. */
  archiveTask(input: ArchiveTaskInput): Promise<Task>
  /** Fails closed when the target is deleted or not archived. */
  unarchiveTask(input: UnarchiveTaskInput): Promise<Task>
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
  | 'archiveTask'
  | 'unarchiveTask'
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
