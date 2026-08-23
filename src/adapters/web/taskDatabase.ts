import type { Database } from '@sqlite.org/sqlite-wasm'

import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatus,
  isTaskStatusOperation,
  isValidLocalDate,
  resolveTaskStatusTransition,
  type Task,
} from '@/task/model'
import type {
  ChangeTaskStatusInput,
  ClearTaskDeadlineInput,
  CreateTaskInput,
  RenameTaskInput,
  SetTaskDeadlineInput,
  SetTaskImportanceInput,
  SetTaskUrgencyInput,
  TaskRepositoryErrorCode,
} from '@/task/repository'
import {
  runWebMigrations,
  SqliteWebMigrationStore,
} from '@/adapters/web/webMigrations'

export class TaskDatabaseError extends Error {
  readonly code: TaskRepositoryErrorCode

  constructor(code: TaskRepositoryErrorCode) {
    super('Web task persistence operation failed.')
    this.name = 'TaskDatabaseError'
    this.code = code
  }
}

const TASK_COLUMNS = `id, title, status, created_at_ms, updated_at_ms,
                      is_important, is_urgent, due_date`

function parseTaskRow(row: Record<string, unknown> | undefined): Task | null {
  if (row === undefined) {
    return null
  }

  const {
    id,
    title,
    status,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    is_important: isImportant,
    is_urgent: isUrgent,
    due_date: dueDate,
  } = row
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyTaskTitle(title) ||
    !isTaskStatus(status) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs ||
    (isImportant !== 0 && isImportant !== 1) ||
    (isUrgent !== 0 && isUrgent !== 1) ||
    (dueDate !== null && !isValidLocalDate(dueDate))
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
  return {
    id,
    title,
    status,
    createdAtMs,
    updatedAtMs,
    isImportant: isImportant === 1,
    isUrgent: isUrgent === 1,
    dueDate,
  }
}

function validateCreateInput(input: CreateTaskInput): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    !isNonEmptyTaskTitle(input.title) ||
    !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs) ||
    (input.isImportant !== undefined &&
      typeof input.isImportant !== 'boolean') ||
    (input.isUrgent !== undefined && typeof input.isUrgent !== 'boolean') ||
    (input.dueDate !== undefined &&
      input.dueDate !== null &&
      !isValidLocalDate(input.dueDate))
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
}

function validatePlanningBaseInput(input: {
  readonly id: string
  readonly updatedAtMs: number
}): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    !isNonNegativeSafeIntegerMilliseconds(input.updatedAtMs)
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
}

function validateRenameInput(input: RenameTaskInput): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    !isNonEmptyTaskTitle(input.title) ||
    !isNonNegativeSafeIntegerMilliseconds(input.updatedAtMs)
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
}

function validateStatusInput(input: ChangeTaskStatusInput): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    !isTaskStatusOperation(input.operation) ||
    !isNonNegativeSafeIntegerMilliseconds(input.updatedAtMs)
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
}

export class WebTaskDatabase {
  readonly #database: Database

  private constructor(database: Database) {
    this.#database = database
  }

  static async initialize(database: Database): Promise<WebTaskDatabase> {
    await runWebMigrations(new SqliteWebMigrationStore(database))
    const taskDatabase = new WebTaskDatabase(database)
    taskDatabase.assertSane()
    return taskDatabase
  }

  close(): void {
    this.#database.close()
  }

  createTask(input: CreateTaskInput): Task {
    validateCreateInput(input)
    try {
      return this.#database.transaction(() => {
        this.#database.exec({
          sql: `INSERT INTO tasks
                (id, title, status, created_at_ms, updated_at_ms,
                 is_important, is_urgent, due_date)
                VALUES (?, ?, 'todo', ?, ?, ?, ?, ?)`,
          bind: [
            input.id,
            input.title,
            input.createdAtMs,
            input.createdAtMs,
            input.isImportant === true ? 1 : 0,
            input.isUrgent === true ? 1 : 0,
            input.dueDate ?? null,
          ],
        })
        return this.requireTask(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) {
        throw error
      }
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  listTasks(): readonly Task[] {
    try {
      return this.#database
        .selectObjects(
          `SELECT ${TASK_COLUMNS}
           FROM tasks ORDER BY updated_at_ms DESC, id ASC`,
        )
        .map((row) => {
          const task = parseTaskRow(row)
          if (task === null) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          return task
        })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) {
        throw error
      }
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  renameTask(input: RenameTaskInput): Task {
    validateRenameInput(input)
    try {
      return this.#database.transaction(() => {
        this.#database.exec({
          sql: `UPDATE tasks SET title = ?, updated_at_ms = ?
                WHERE id = ?`,
          bind: [input.title, input.updatedAtMs, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireTask(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) {
        throw error
      }
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  changeTaskStatus(input: ChangeTaskStatusInput): Task {
    validateStatusInput(input)
    try {
      return this.#database.transaction(() => {
        const current = this.requireTask(input.id)
        const nextStatus = resolveTaskStatusTransition(
          current.status,
          input.operation,
        )
        if (nextStatus === null) {
          throw new TaskDatabaseError('STATUS_CONFLICT')
        }

        this.#database.exec({
          sql: `UPDATE tasks SET status = ?, updated_at_ms = ?
                WHERE id = ? AND status = ?`,
          bind: [nextStatus, input.updatedAtMs, input.id, current.status],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('STATUS_CONFLICT')
        }
        return this.requireTask(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) {
        throw error
      }
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  setTaskImportance(input: SetTaskImportanceInput): Task {
    validatePlanningBaseInput(input)
    if (typeof input.isImportant !== 'boolean') {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    return this.updatePlanningField(
      input.id,
      'is_important',
      input.isImportant ? 1 : 0,
      input.updatedAtMs,
    )
  }

  setTaskUrgency(input: SetTaskUrgencyInput): Task {
    validatePlanningBaseInput(input)
    if (typeof input.isUrgent !== 'boolean') {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    return this.updatePlanningField(
      input.id,
      'is_urgent',
      input.isUrgent ? 1 : 0,
      input.updatedAtMs,
    )
  }

  setTaskDeadline(input: SetTaskDeadlineInput): Task {
    validatePlanningBaseInput(input)
    if (!isValidLocalDate(input.dueDate)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    return this.updatePlanningField(
      input.id,
      'due_date',
      input.dueDate,
      input.updatedAtMs,
    )
  }

  clearTaskDeadline(input: ClearTaskDeadlineInput): Task {
    validatePlanningBaseInput(input)
    return this.updatePlanningField(
      input.id,
      'due_date',
      null,
      input.updatedAtMs,
    )
  }

  private updatePlanningField(
    id: string,
    column: 'is_important' | 'is_urgent' | 'due_date',
    value: number | string | null,
    updatedAtMs: number,
  ): Task {
    try {
      return this.#database.transaction(() => {
        this.#database.exec({
          sql: `UPDATE tasks SET ${column} = ?, updated_at_ms = ? WHERE id = ?`,
          bind: [value, updatedAtMs, id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireTask(id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) {
        throw error
      }
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private requireTask(id: string): Task {
    const task = parseTaskRow(
      this.#database.selectObject(
        `SELECT ${TASK_COLUMNS}
         FROM tasks WHERE id = ?`,
        [id],
      ),
    )
    if (task === null) {
      throw new TaskDatabaseError('NOT_FOUND')
    }
    return task
  }

  private assertSane(): void {
    const tasksTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema
       WHERE type = 'table' AND name = 'tasks'`,
    )
    const quickCheck = this.#database.selectValue('PRAGMA quick_check(1)')
    if (tasksTableCount !== 1 || quickCheck !== 'ok') {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }
}
