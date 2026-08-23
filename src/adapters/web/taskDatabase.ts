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
import { isNonEmptyProjectName, type Project } from '@/project/model'
import type {
  CreateProjectInput,
  RenameProjectInput,
} from '@/project/repository'
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
                      is_important, is_urgent, due_date, project_id`
const PROJECT_COLUMNS = 'id, name, created_at_ms, updated_at_ms'

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
    project_id: projectId,
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
    (dueDate !== null && !isValidLocalDate(dueDate)) ||
    (projectId !== null && !isCanonicalLowercaseUuid(projectId))
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
    projectId,
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
      !isValidLocalDate(input.dueDate)) ||
    (input.projectId !== undefined &&
      input.projectId !== null &&
      !isCanonicalLowercaseUuid(input.projectId))
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
    database.exec('PRAGMA foreign_keys = ON')
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
        if (input.projectId !== undefined && input.projectId !== null) {
          this.requireProject(input.projectId)
        }
        this.#database.exec({
          sql: `INSERT INTO tasks
                (id, title, status, created_at_ms, updated_at_ms,
                is_important, is_urgent, due_date, project_id)
                VALUES (?, ?, 'todo', ?, ?, ?, ?, ?, ?)`,
          bind: [
            input.id,
            input.title,
            input.createdAtMs,
            input.createdAtMs,
            input.isImportant === true ? 1 : 0,
            input.isUrgent === true ? 1 : 0,
            input.dueDate ?? null,
            input.projectId ?? null,
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

  setTaskProject(input: import('@/task/repository').SetTaskProjectInput): Task {
    validatePlanningBaseInput(input)
    if (!isCanonicalLowercaseUuid(input.projectId))
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    this.requireProject(input.projectId)
    return this.updatePlanningField(
      input.id,
      'project_id',
      input.projectId,
      input.updatedAtMs,
    )
  }

  clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Task {
    validatePlanningBaseInput(input)
    return this.updatePlanningField(
      input.id,
      'project_id',
      null,
      input.updatedAtMs,
    )
  }

  createProject(input: CreateProjectInput): Project {
    this.validateProjectInput(input.id, input.name, input.createdAtMs)
    try {
      this.#database.exec({
        sql: `INSERT INTO projects(id, name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)`,
        bind: [input.id, input.name, input.createdAtMs, input.createdAtMs],
      })
      return this.requireProject(input.id)
    } catch (error) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  listProjects(): readonly Project[] {
    try {
      return this.#database
        .selectObjects(
          `SELECT ${PROJECT_COLUMNS} FROM projects ORDER BY updated_at_ms DESC, id ASC`,
        )
        .map((row) => this.parseProjectRow(row))
    } catch (error) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  renameProject(input: RenameProjectInput): Project {
    this.validateProjectInput(input.id, input.name, input.updatedAtMs)
    try {
      this.#database.exec({
        sql: 'UPDATE projects SET name = ?, updated_at_ms = ? WHERE id = ?',
        bind: [input.name, input.updatedAtMs, input.id],
      })
      if (this.#database.changes() !== 1)
        throw new TaskDatabaseError('NOT_FOUND')
      return this.requireProject(input.id)
    } catch (error) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private updatePlanningField(
    id: string,
    column: 'is_important' | 'is_urgent' | 'due_date' | 'project_id',
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

  private parseProjectRow(row: Record<string, unknown> | undefined): Project {
    if (row === undefined) throw new TaskDatabaseError('NOT_FOUND')
    const {
      id,
      name,
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
    } = row
    if (
      !isCanonicalLowercaseUuid(id) ||
      !isNonEmptyProjectName(name) ||
      !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
      !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
      updatedAtMs < createdAtMs
    )
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    return { id, name, createdAtMs, updatedAtMs }
  }

  private requireProject(id: string): Project {
    return this.parseProjectRow(
      this.#database.selectObject(
        `SELECT ${PROJECT_COLUMNS} FROM projects WHERE id = ?`,
        [id],
      ),
    )
  }

  private validateProjectInput(
    id: string,
    name: string,
    timestamp: number,
  ): void {
    if (
      !isCanonicalLowercaseUuid(id) ||
      !isNonEmptyProjectName(name) ||
      !isNonNegativeSafeIntegerMilliseconds(timestamp)
    )
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }

  private assertSane(): void {
    const tasksTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema
       WHERE type = 'table' AND name = 'tasks'`,
    )
    const quickCheck = this.#database.selectValue('PRAGMA quick_check(1)')
    const foreignKeys = this.#database.selectValue('PRAGMA foreign_keys')
    const projectsTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'projects'`,
    )
    if (
      tasksTableCount !== 1 ||
      projectsTableCount !== 1 ||
      quickCheck !== 'ok' ||
      foreignKeys !== 1
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }
}
