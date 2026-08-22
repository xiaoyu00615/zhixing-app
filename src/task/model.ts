export const TASK_STATUSES = [
  'todo',
  'doing',
  'completed',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_OPERATIONS = [
  'start',
  'complete',
  'cancel',
  'reopen',
] as const

export type TaskStatusOperation = (typeof TASK_STATUS_OPERATIONS)[number]

export interface Task {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    TASK_STATUSES.some((status) => status === value)
  )
}

export function isTaskStatusOperation(
  value: unknown,
): value is TaskStatusOperation {
  return (
    typeof value === 'string' &&
    TASK_STATUS_OPERATIONS.some((operation) => operation === value)
  )
}

export function isCanonicalLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_LOWERCASE_UUID.test(value)
}

export function isNonEmptyTaskTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isNonNegativeSafeIntegerMilliseconds(
  value: unknown,
): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

/**
 * Shared frontend/Web transition rule. A null result is STATUS_CONFLICT.
 */
export function resolveTaskStatusTransition(
  current: TaskStatus,
  operation: TaskStatusOperation,
): TaskStatus | null {
  switch (operation) {
    case 'start':
      return current === 'todo' ? 'doing' : null
    case 'complete':
      return current === 'todo' || current === 'doing' ? 'completed' : null
    case 'cancel':
      return current === 'todo' || current === 'doing' ? 'cancelled' : null
    case 'reopen':
      return current === 'completed' || current === 'cancelled' ? 'todo' : null
  }
}
