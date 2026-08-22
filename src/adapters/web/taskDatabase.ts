import type { Database } from '@sqlite.org/sqlite-wasm'

import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatus,
  isTaskStatusOperation,
  resolveTaskStatusTransition,
  type Task,
} from '@/task/model'
import type {
  ChangeTaskStatusInput,
  CreateTaskInput,
  RenameTaskInput,
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
  } = row
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyTaskTitle(title) ||
    !isTaskStatus(status) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
  return { id, title, status, createdAtMs, updatedAtMs }
}

function validateCreateInput(input: CreateTaskInput): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    !isNonEmptyTaskTitle(input.title) ||
    !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs)
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
                (id, title, status, created_at_ms, updated_at_ms)
                VALUES (?, ?, 'todo', ?, ?)`,
          bind: [input.id, input.title, input.createdAtMs, input.createdAtMs],
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
          `SELECT id, title, status, created_at_ms, updated_at_ms
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

  private requireTask(id: string): Task {
    const task = parseTaskRow(
      this.#database.selectObject(
        `SELECT id, title, status, created_at_ms, updated_at_ms
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
