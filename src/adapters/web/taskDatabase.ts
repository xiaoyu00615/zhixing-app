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
  RestoreTaskInput,
  TaskRepositoryErrorCode,
  TrashTaskInput,
} from '@/task/repository'
import { isNonEmptyProjectName, type Project } from '@/project/model'
import type {
  CreateProjectInput,
  RenameProjectInput,
} from '@/project/repository'
import { isNonEmptyTagName, type Tag } from '@/tag/model'
import type { CreateTagInput, RenameTagInput } from '@/tag/repository'
import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasEdgeDirection,
  isCanvasEdgeLineStyle,
  isCanvasMembershipRelationType,
  isCanvasMembershipPosition,
  isCanvasOrdinaryEdgeRelationType,
  isPersistedCanvasEdgeRelationType,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isPersistedCanvasNodeName,
  parseCanvasViewportJson,
  parseCanvasNodeContentJson,
  type Canvas,
  type CanvasEdge,
  type CanvasEdgeDirection,
  type CanvasNode,
} from '@/canvas/model'
import type {
  AddCanvasNodeBoxMemberInput,
  ApplyCanvasMutationBatchInput,
  CanvasMutationEdgeSnapshot,
  CreateCanvasInput,
  CreateCanvasEdgeInput,
  CreateCanvasNodeInput,
  CreateCanvasSubgraphInput,
  CreateTextNodeInput,
  DeleteCanvasEdgeInput,
  DeleteCanvasNodeInput,
  MoveCanvasNodeInput,
  MoveCanvasNodesInput,
  ReorderCanvasNodeBoxMembershipsInput,
  RenameCanvasInput,
  RenameCanvasNodeInput,
  UpdateCanvasViewportInput,
  UpdateCanvasEdgeDirectionInput,
  UpdateCanvasEdgeLineStyleInput,
  UpdateCanvasEdgeRelationTypeInput,
  UpdateCanvasNodeContentInput,
  UpdateTextNodeInput,
} from '@/canvas/repository'
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
                      is_important, is_urgent, due_date, project_id,
                      deleted_at_ms`
const PROJECT_COLUMNS = 'id, name, created_at_ms, updated_at_ms'
const TAG_COLUMNS = 'id, name, created_at_ms, updated_at_ms'
const CANVAS_COLUMNS = 'id, title, viewport_json, created_at_ms, updated_at_ms'
const CANVAS_NODE_COLUMNS = `id, canvas_id, type, node_name, content_json, x, y,
                             created_at_ms, updated_at_ms`
const CANVAS_EDGE_COLUMNS = `id, canvas_id, source_node_id, target_node_id,
                             relation_type, direction, line_style, membership_position,
                             created_at_ms, updated_at_ms, deleted_at_ms`

function parseCanvasRow(row: Record<string, unknown> | undefined): Canvas | null {
  if (row === undefined) return null
  const {
    id,
    title,
    viewport_json: viewportJson,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
  } = row
  const viewport = parseCanvasViewportJson(viewportJson)
  if (
    !isCanonicalCanvasId(id) ||
    !isNonEmptyCanvasTitle(title) ||
    viewport === null ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
  return { id, title, viewport, createdAtMs, updatedAtMs }
}

function parseCanvasNodeRow(
  row: Record<string, unknown> | undefined,
): CanvasNode | null {
  if (row === undefined) return null
  const {
    id,
    canvas_id: canvasId,
    type,
    node_name: nodeName,
    content_json: contentJson,
    x,
    y,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
  } = row
  const content = typeof type === 'string' ? parseCanvasNodeContentJson(type, contentJson) : null
  if (
    !isCanonicalCanvasId(id) ||
    !isCanonicalCanvasId(canvasId) ||
    !isPersistedCanvasNodeName(nodeName) ||
    content === null ||
    !isCanvasCoordinate(x) ||
    !isCanvasCoordinate(y) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
  if (type === 'text' || type === 'sticky' || type === 'node_box') {
    return { id, canvasId, type, nodeName, content, x, y, createdAtMs, updatedAtMs } as CanvasNode
  }
  return { id, canvasId, type: 'unknown', originalType: type as string, nodeName, content: content as import('@/canvas/model').UnknownNodeContent, x, y, createdAtMs, updatedAtMs }
}

function parseCanvasEdgeRow(
  row: Record<string, unknown> | undefined,
): CanvasEdge | null {
  if (row === undefined) return null
  const {
    id,
    canvas_id: canvasId,
    source_node_id: sourceNodeId,
    target_node_id: targetNodeId,
    relation_type: relationType,
    direction,
    line_style: lineStyle,
    membership_position: membershipPosition,
    created_at_ms: createdAtMs,
    updated_at_ms: updatedAtMs,
    deleted_at_ms: deletedAtMs,
  } = row
  if (
    !isCanonicalCanvasId(id) ||
    !isCanonicalCanvasId(canvasId) ||
    !isCanonicalCanvasId(sourceNodeId) ||
    !isCanonicalCanvasId(targetNodeId) ||
    sourceNodeId === targetNodeId ||
    !isPersistedCanvasEdgeRelationType(relationType) ||
    !isCanvasEdgeDirection(direction) ||
    !isCanvasEdgeLineStyle(lineStyle) ||
    !isCanvasMembershipPosition(membershipPosition) ||
    (isCanvasMembershipRelationType(relationType)
      ? membershipPosition === null
      : membershipPosition !== null) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs ||
    (deletedAtMs !== null &&
      !isNonNegativeSafeIntegerMilliseconds(deletedAtMs))
  ) {
    throw new TaskDatabaseError('PERSISTENCE_FAILED')
  }
  return {
    id,
    canvasId,
    sourceNodeId,
    targetNodeId,
    relationType,
    direction,
    lineStyle,
    membershipPosition,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
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
    is_important: isImportant,
    is_urgent: isUrgent,
    due_date: dueDate,
    project_id: projectId,
    deleted_at_ms: deletedAtMs,
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
    (projectId !== null && !isCanonicalLowercaseUuid(projectId)) ||
    (deletedAtMs !== null && !isNonNegativeSafeIntegerMilliseconds(deletedAtMs))
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
    tagIds: [],
    deletedAtMs,
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
      !isCanonicalLowercaseUuid(input.projectId)) ||
    (input.tagIds !== undefined &&
      (!Array.isArray(input.tagIds) ||
        input.tagIds.some((tagId) => !isCanonicalLowercaseUuid(tagId)) ||
        new Set(input.tagIds).size !== input.tagIds.length))
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
        for (const tagId of input.tagIds ?? []) {
          this.requireTag(tagId)
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
        for (const tagId of input.tagIds ?? []) {
          this.#database.exec({
            sql: 'INSERT INTO task_tags(task_id, tag_id) VALUES (?, ?)',
            bind: [input.id, tagId],
          })
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

  listTasks(): readonly Task[] {
    try {
      return this.#database
        .selectObjects(
          `SELECT ${TASK_COLUMNS}
           FROM tasks
           WHERE deleted_at_ms IS NULL
           ORDER BY updated_at_ms DESC, id ASC`,
        )
        .map((row) => {
          const task = parseTaskRow(row)
          if (task === null) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          return this.withTaskTags(task)
        })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) {
        throw error
      }
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  listTrashedTasks(): readonly Task[] {
    try {
      return this.#database
        .selectObjects(
          `SELECT ${TASK_COLUMNS}
           FROM tasks
           WHERE deleted_at_ms IS NOT NULL
           ORDER BY deleted_at_ms DESC, id ASC`,
        )
        .map((row) => {
          const task = parseTaskRow(row)
          if (task === null) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          return this.withTaskTags(task)
        })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  trashTask(input: TrashTaskInput): Task {
    validatePlanningBaseInput(input)
    return this.updateDeletedState(input, true)
  }

  restoreTask(input: RestoreTaskInput): Task {
    validatePlanningBaseInput(input)
    return this.updateDeletedState(input, false)
  }

  renameTask(input: RenameTaskInput): Task {
    validateRenameInput(input)
    try {
      return this.#database.transaction(() => {
        this.#database.exec({
          sql: `UPDATE tasks SET title = ?, updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
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
                WHERE id = ? AND status = ? AND deleted_at_ms IS NULL`,
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

  addTaskTag(input: import('@/task/repository').AddTaskTagInput): Task {
    validatePlanningBaseInput(input)
    if (!isCanonicalLowercaseUuid(input.tagId)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        this.requireTask(input.id)
        this.requireTag(input.tagId)
        this.#database.exec({
          sql: 'INSERT INTO task_tags(task_id, tag_id) VALUES (?, ?)',
          bind: [input.id, input.tagId],
        })
        this.#database.exec({
          sql: `UPDATE tasks SET updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
          bind: [input.updatedAtMs, input.id],
        })
        return this.requireTask(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  removeTaskTag(input: import('@/task/repository').RemoveTaskTagInput): Task {
    validatePlanningBaseInput(input)
    if (!isCanonicalLowercaseUuid(input.tagId)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        this.requireTask(input.id)
        this.#database.exec({
          sql: 'DELETE FROM task_tags WHERE task_id = ? AND tag_id = ?',
          bind: [input.id, input.tagId],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        this.#database.exec({
          sql: `UPDATE tasks SET updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
          bind: [input.updatedAtMs, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireTask(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
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

  createTag(input: CreateTagInput): Tag {
    this.validateTagInput(input.id, input.name, input.createdAtMs)
    try {
      this.#database.exec({
        sql: 'INSERT INTO tags(id, name, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?)',
        bind: [input.id, input.name, input.createdAtMs, input.createdAtMs],
      })
      return this.requireTag(input.id)
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  listTags(): readonly Tag[] {
    try {
      return this.#database
        .selectObjects(
          `SELECT ${TAG_COLUMNS} FROM tags ORDER BY updated_at_ms DESC, id ASC`,
        )
        .map((row) => this.parseTagRow(row))
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  renameTag(input: RenameTagInput): Tag {
    this.validateTagInput(input.id, input.name, input.updatedAtMs)
    try {
      this.#database.exec({
        sql: 'UPDATE tags SET name = ?, updated_at_ms = ? WHERE id = ?',
        bind: [input.name, input.updatedAtMs, input.id],
      })
      if (this.#database.changes() !== 1) {
        throw new TaskDatabaseError('NOT_FOUND')
      }
      return this.requireTag(input.id)
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  createCanvas(input: CreateCanvasInput): Canvas {
    this.validateCanvasInput(
      input.id,
      input.title,
      input.viewport,
      input.createdAtMs,
    )
    try {
      this.#database.exec({
        sql: `INSERT INTO canvases
              (id, title, viewport_json, created_at_ms, updated_at_ms)
              VALUES (?, ?, ?, ?, ?)`,
        bind: [
          input.id,
          input.title,
          JSON.stringify(input.viewport),
          input.createdAtMs,
          input.createdAtMs,
        ],
      })
      return this.requireCanvas(input.id)
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  listCanvases(): readonly Canvas[] {
    try {
      return this.#database
        .selectObjects(
          `SELECT ${CANVAS_COLUMNS} FROM canvases
           ORDER BY updated_at_ms DESC, id ASC`,
        )
        .map((row) => {
          const canvas = parseCanvasRow(row)
          if (canvas === null) throw new TaskDatabaseError('PERSISTENCE_FAILED')
          return canvas
        })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  getCanvas(id: string): Canvas {
    if (!isCanonicalCanvasId(id)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    return this.requireCanvas(id)
  }

  renameCanvas(input: RenameCanvasInput): Canvas {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (!isNonEmptyCanvasTitle(input.title)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      this.#database.exec({
        sql: 'UPDATE canvases SET title = ?, updated_at_ms = ? WHERE id = ?',
        bind: [input.title, input.updatedAtMs, input.id],
      })
      if (this.#database.changes() !== 1) {
        throw new TaskDatabaseError('NOT_FOUND')
      }
      return this.requireCanvas(input.id)
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  updateCanvasViewport(input: UpdateCanvasViewportInput): Canvas {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (!isCanvasViewport(input.viewport)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      this.#database.exec({
        sql: `UPDATE canvases SET viewport_json = ?, updated_at_ms = ?
              WHERE id = ?`,
        bind: [JSON.stringify(input.viewport), input.updatedAtMs, input.id],
      })
      if (this.#database.changes() !== 1) {
        throw new TaskDatabaseError('NOT_FOUND')
      }
      return this.requireCanvas(input.id)
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  createCanvasNode(input: CreateCanvasNodeInput): CanvasNode {
    this.validateNodeInput(
      input.id,
      input.canvasId,
      input.x,
      input.y,
      input.createdAtMs,
    )
    if (
      input.content.type !== input.type ||
      (input.content.type !== 'node_box' && typeof input.content.text !== 'string')
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)
        this.#database.exec({
          sql: `INSERT INTO canvas_nodes
                (id, canvas_id, type, node_name, content_json, x, y,
                 created_at_ms, updated_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bind: [
            input.id,
            input.canvasId,
            input.type,
            input.nodeName ?? '',
            JSON.stringify(input.content),
            input.x,
            input.y,
            input.createdAtMs,
            input.createdAtMs,
          ],
        })
        return this.requireCanvasNode(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  createTextNode(input: CreateTextNodeInput): CanvasNode {
    return this.createCanvasNode({ ...input, type: 'text' })
  }

  listCanvasNodes(canvasId: string): readonly CanvasNode[] {
    if (!isCanonicalCanvasId(canvasId)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      this.requireCanvas(canvasId)
      return this.#database
        .selectObjects(
          `SELECT ${CANVAS_NODE_COLUMNS} FROM canvas_nodes
           WHERE canvas_id = ? AND deleted_at_ms IS NULL
           ORDER BY created_at_ms ASC, id ASC`,
          [canvasId],
        )
        .map((row) => {
          const node = parseCanvasNodeRow(row)
          if (node === null) throw new TaskDatabaseError('PERSISTENCE_FAILED')
          return node
        })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): CanvasNode {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (
      input.content.type !== input.type ||
      (input.content.type !== 'node_box' && typeof input.content.text !== 'string')
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    const current = this.requireCanvasNode(input.id)
    const currentType = current.type === 'unknown' ? current.originalType : current.type
    if (currentType !== input.type) throw new TaskDatabaseError('PERSISTENCE_FAILED')
    return this.updateCanvasNode(
      input.id,
      'content_json',
      JSON.stringify(input.content),
      input.updatedAtMs,
    )
  }

  renameCanvasNode(input: RenameCanvasNodeInput): CanvasNode {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (
      !isCanonicalCanvasId(input.canvasId) ||
      !isPersistedCanvasNodeName(input.nodeName)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        const current = this.requireNodeInCanvas(input.canvasId, input.id)
        if (current.type === 'unknown') {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        this.#database.exec({
          sql: `UPDATE canvas_nodes SET node_name = ?, updated_at_ms = ?
                WHERE canvas_id = ? AND id = ? AND deleted_at_ms IS NULL
                  AND type IN ('text', 'sticky', 'node_box')`,
          bind: [input.nodeName, input.updatedAtMs, input.canvasId, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireCanvasNode(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  updateTextNode(input: UpdateTextNodeInput): CanvasNode {
    return this.updateCanvasNodeContent({ ...input, type: 'text' })
  }

  moveCanvasNode(input: MoveCanvasNodeInput): CanvasNode {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (!isCanvasCoordinate(input.x) || !isCanvasCoordinate(input.y)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        this.requireCanvasNode(input.id)
        this.#database.exec({
          sql: `UPDATE canvas_nodes SET x = ?, y = ?, updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
          bind: [input.x, input.y, input.updatedAtMs, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireCanvasNode(input.id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  moveCanvasNodes(input: MoveCanvasNodesInput): readonly CanvasNode[] {
    this.validateCanvasUpdate(input.canvasId, input.updatedAtMs)
    if (input.moves.length === 0) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    const nodeIds = new Set<string>()
    for (const move of input.moves) {
      if (
        !isCanonicalCanvasId(move.nodeId) ||
        !isCanvasCoordinate(move.x) ||
        !isCanvasCoordinate(move.y) ||
        nodeIds.has(move.nodeId)
      ) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      nodeIds.add(move.nodeId)
    }
    try {
      return this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)
        for (const move of input.moves) {
          this.requireNodeInCanvas(input.canvasId, move.nodeId)
        }
        for (const move of input.moves) {
          this.#database.exec({
            sql: `UPDATE canvas_nodes SET x = ?, y = ?, updated_at_ms = ?
                  WHERE canvas_id = ? AND id = ? AND deleted_at_ms IS NULL`,
            bind: [
              move.x,
              move.y,
              input.updatedAtMs,
              input.canvasId,
              move.nodeId,
            ],
          })
          if (this.#database.changes() !== 1) {
            throw new TaskDatabaseError('NOT_FOUND')
          }
        }
        return input.moves.map((move) =>
          this.requireNodeInCanvas(input.canvasId, move.nodeId),
        )
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  deleteCanvasNode(input: DeleteCanvasNodeInput): void {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (
      !isCanonicalCanvasId(input.canvasId) ||
      !isNonNegativeSafeIntegerMilliseconds(input.deletedAtMs)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      this.#database.transaction(() => {
        this.requireNodeInCanvas(input.canvasId, input.id)
        this.#database.exec({
          sql: `UPDATE canvas_edges
                SET deleted_at_ms = ?, updated_at_ms = ?
                WHERE canvas_id = ?
                  AND (source_node_id = ? OR target_node_id = ?)
                  AND deleted_at_ms IS NULL`,
          bind: [
            input.deletedAtMs,
            input.updatedAtMs,
            input.canvasId,
            input.id,
            input.id,
          ],
        })
        this.#database.exec({
          sql: `UPDATE canvas_nodes
                SET deleted_at_ms = ?, updated_at_ms = ?
                WHERE canvas_id = ? AND id = ? AND deleted_at_ms IS NULL`,
          bind: [input.deletedAtMs, input.updatedAtMs, input.canvasId, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  createCanvasEdge(input: CreateCanvasEdgeInput): CanvasEdge {
    this.validateCanvasEdgeInput(input)
    try {
      return this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)
        this.requireNodeInCanvas(input.canvasId, input.sourceNodeId)
        this.requireNodeInCanvas(input.canvasId, input.targetNodeId)
        this.assertNoDuplicateCanvasEdge(
          input.canvasId,
          input.sourceNodeId,
          input.targetNodeId,
          input.relationType,
          input.direction,
        )
        this.#database.exec({
          sql: `INSERT INTO canvas_edges
                (id, canvas_id, source_node_id, target_node_id, relation_type,
                 direction, line_style, membership_position, created_at_ms, updated_at_ms,
                 deleted_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
          bind: [
            input.id,
            input.canvasId,
            input.sourceNodeId,
            input.targetNodeId,
            input.relationType,
            input.direction,
            input.lineStyle,
            input.createdAtMs,
            input.createdAtMs,
          ],
        })
        return this.requireCanvasEdge(input.id, false)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  createCanvasSubgraph(input: CreateCanvasSubgraphInput): {
    readonly nodes: readonly CanvasNode[]
    readonly edges: readonly CanvasEdge[]
  } {
    if (!isCanonicalCanvasId(input.canvasId) || !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    if (input.nodes.length === 0) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    const nodeIdSet = new Set<string>()
    for (const node of input.nodes) {
      if (
        !isCanonicalCanvasId(node.id) ||
        node.canvasId !== input.canvasId ||
        !isPersistedCanvasNodeName(node.nodeName) ||
        !isCanvasCoordinate(node.x) ||
        !isCanvasCoordinate(node.y) ||
        !isNonNegativeSafeIntegerMilliseconds(node.createdAtMs)
      ) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      if (nodeIdSet.has(node.id)) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      nodeIdSet.add(node.id)
    }
    const edgeIdSet = new Set<string>()
    for (const edge of input.edges) {
      if (
        !isCanonicalCanvasId(edge.id) ||
        edge.canvasId !== input.canvasId ||
        !isCanonicalCanvasId(edge.sourceNodeId) ||
        !isCanonicalCanvasId(edge.targetNodeId) ||
        edge.sourceNodeId === edge.targetNodeId ||
        !isCanvasOrdinaryEdgeRelationType(edge.relationType) ||
        !isCanvasEdgeDirection(edge.direction) ||
        !isCanvasEdgeLineStyle(edge.lineStyle) ||
        !isNonNegativeSafeIntegerMilliseconds(edge.createdAtMs)
      ) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      if (edgeIdSet.has(edge.id)) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      edgeIdSet.add(edge.id)
    }
    for (const membership of input.memberships) {
      if (
        !isCanonicalCanvasId(membership.id) ||
        membership.canvasId !== input.canvasId ||
        !isCanonicalCanvasId(membership.sourceNodeId) ||
        !isCanonicalCanvasId(membership.targetNodeId) ||
        membership.sourceNodeId === membership.targetNodeId ||
        !isCanvasMembershipRelationType(membership.relationType) ||
        !Number.isSafeInteger(membership.membershipPosition) ||
        membership.membershipPosition < 0 ||
        !isNonNegativeSafeIntegerMilliseconds(membership.createdAtMs)
      ) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      if (edgeIdSet.has(membership.id)) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      edgeIdSet.add(membership.id)
    }

    try {
      return this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)
        const resultNodes: CanvasNode[] = []
        for (const nodeInput of input.nodes) {
          this.#database.exec({
            sql: `INSERT INTO canvas_nodes
                  (id, canvas_id, type, node_name, content_json, x, y,
                   created_at_ms, updated_at_ms)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            bind: [
              nodeInput.id,
              nodeInput.canvasId,
              nodeInput.type,
              nodeInput.nodeName,
              JSON.stringify(nodeInput.content),
              nodeInput.x,
              nodeInput.y,
              nodeInput.createdAtMs,
              nodeInput.createdAtMs,
            ],
          })
          resultNodes.push(this.requireCanvasNode(nodeInput.id))
        }
        const resultEdges: CanvasEdge[] = []
        for (const edgeInput of input.edges) {
          this.#database.exec({
            sql: `INSERT INTO canvas_edges
                  (id, canvas_id, source_node_id, target_node_id, relation_type,
                   direction, line_style, membership_position, created_at_ms, updated_at_ms,
                   deleted_at_ms)
                  VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, NULL)`,
            bind: [
              edgeInput.id,
              edgeInput.canvasId,
              edgeInput.sourceNodeId,
              edgeInput.targetNodeId,
              edgeInput.relationType,
              edgeInput.direction,
              edgeInput.lineStyle,
              edgeInput.createdAtMs,
              edgeInput.createdAtMs,
            ],
          })
          resultEdges.push(this.requireCanvasEdge(edgeInput.id, false))
        }

        // Memberships may only reference nodes created by this same batch.
        const membershipPairs = new Set<string>()
        const membershipGroups = new Map<string, number[]>()
        for (const membershipInput of input.memberships) {
          if (
            !nodeIdSet.has(membershipInput.sourceNodeId) ||
            !nodeIdSet.has(membershipInput.targetNodeId)
          ) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          const source = this.requireNodeInCanvas(input.canvasId, membershipInput.sourceNodeId)
          const target = this.requireNodeInCanvas(input.canvasId, membershipInput.targetNodeId)
          if (source.type === 'node_box' || target.type !== 'node_box') {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          const pairKey = `${membershipInput.sourceNodeId} ${membershipInput.targetNodeId}`
          if (membershipPairs.has(pairKey)) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          membershipPairs.add(pairKey)
          const groupKey = `${membershipInput.targetNodeId}|${membershipInput.relationType}`
          const group = membershipGroups.get(groupKey)
          if (group === undefined) {
            membershipGroups.set(groupKey, [membershipInput.membershipPosition])
          } else {
            group.push(membershipInput.membershipPosition)
          }
        }
        // Each target box/section must carry a continuous 0..N-1 sequence.
        for (const positions of membershipGroups.values()) {
          const sorted = [...positions].sort((left, right) => left - right)
          if (sorted.some((position, expected) => position !== expected)) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
        }
        for (const membershipInput of input.memberships) {
          this.#database.exec({
            sql: `INSERT INTO canvas_edges
                  (id, canvas_id, source_node_id, target_node_id, relation_type,
                   direction, line_style, membership_position, created_at_ms,
                   updated_at_ms, deleted_at_ms)
                  VALUES (?, ?, ?, ?, ?, 'forward', 'solid', ?, ?, ?, NULL)`,
            bind: [
              membershipInput.id,
              membershipInput.canvasId,
              membershipInput.sourceNodeId,
              membershipInput.targetNodeId,
              membershipInput.relationType,
              membershipInput.membershipPosition,
              membershipInput.createdAtMs,
              membershipInput.createdAtMs,
            ],
          })
          resultEdges.push(this.requireCanvasEdge(membershipInput.id, false))
        }
        return { nodes: resultNodes, edges: resultEdges }
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  applyCanvasMutationBatch(input: ApplyCanvasMutationBatchInput): void {
    if (
      !isCanonicalCanvasId(input.canvasId) ||
      !isNonNegativeSafeIntegerMilliseconds(input.atMs) ||
      input.actions.length === 0
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }

    // Pre-transaction structural validation, mirroring the native batch.
    const nodeIdActionSet = new Set<string>()
    const edgeIdActionSet = new Set<string>()
    const rememberNodeId = (id: string): void => {
      if (nodeIdActionSet.has(id)) throw new TaskDatabaseError('PERSISTENCE_FAILED')
      nodeIdActionSet.add(id)
    }
    const rememberEdgeId = (id: string): void => {
      if (edgeIdActionSet.has(id)) throw new TaskDatabaseError('PERSISTENCE_FAILED')
      edgeIdActionSet.add(id)
    }
    const assertMutationEdgeShape = (
      edge: CanvasMutationEdgeSnapshot,
    ): void => {
      if (
        edge.canvasId !== input.canvasId ||
        !isCanonicalCanvasId(edge.sourceNodeId) ||
        !isCanonicalCanvasId(edge.targetNodeId) ||
        edge.sourceNodeId === edge.targetNodeId ||
        !isNonNegativeSafeIntegerMilliseconds(edge.createdAtMs)
      ) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      if (isCanvasOrdinaryEdgeRelationType(edge.relationType)) {
        if (edge.membershipPosition !== null) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        if (!isCanvasEdgeDirection(edge.direction) || !isCanvasEdgeLineStyle(edge.lineStyle)) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
      } else if (isCanvasMembershipRelationType(edge.relationType)) {
        if (
          edge.direction !== 'forward' ||
          edge.lineStyle !== 'solid' ||
          !isCanvasMembershipPosition(edge.membershipPosition)
        ) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
      } else {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
    }

    for (const action of input.actions) {
      switch (action.kind) {
        case 'insert_nodes': {
          for (const node of action.nodes) {
            if (
              !isCanonicalCanvasId(node.id) ||
              node.canvasId !== input.canvasId ||
              !isPersistedCanvasNodeName(node.nodeName) ||
              !isCanvasCoordinate(node.x) ||
              !isCanvasCoordinate(node.y) ||
              !isNonNegativeSafeIntegerMilliseconds(node.createdAtMs) ||
              node.content.type !== node.type
            ) {
              throw new TaskDatabaseError('PERSISTENCE_FAILED')
            }
            rememberNodeId(node.id)
          }
          break
        }
        case 'soft_delete_nodes': {
          for (const nodeId of action.nodeIds) {
            if (!isCanonicalCanvasId(nodeId)) {
              throw new TaskDatabaseError('PERSISTENCE_FAILED')
            }
            rememberNodeId(nodeId)
          }
          break
        }
        case 'set_node_name': {
          if (
            !isCanonicalCanvasId(action.nodeId) ||
            !isPersistedCanvasNodeName(action.nodeName)
          ) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          break
        }
        case 'set_node_content': {
          if (!isCanonicalCanvasId(action.nodeId)) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          break
        }
        case 'insert_edges':
        case 'restore_edges': {
          for (const edge of action.edges) {
            if (!isCanonicalCanvasId(edge.id) || edge.canvasId !== input.canvasId) {
              throw new TaskDatabaseError('PERSISTENCE_FAILED')
            }
            assertMutationEdgeShape(edge)
            rememberEdgeId(edge.id)
          }
          break
        }
        case 'soft_delete_edges': {
          for (const edgeId of action.edgeIds) {
            if (!isCanonicalCanvasId(edgeId)) {
              throw new TaskDatabaseError('PERSISTENCE_FAILED')
            }
            rememberEdgeId(edgeId)
          }
          break
        }
        default:
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
    }

    try {
      this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)

        // Returns 'missing' | 'active' | 'deleted' for the id.
        const nodeState = (id: string): 'missing' | 'active' | 'deleted' => {
          const row = this.#database.selectObject(
            'SELECT deleted_at_ms FROM canvas_nodes WHERE id = ?',
            [id],
          )
          if (row === undefined) return 'missing'
          return row.deleted_at_ms === null ? 'active' : 'deleted'
        }
        const edgeState = (id: string): 'missing' | 'active' | 'deleted' => {
          const row = this.#database.selectObject(
            'SELECT deleted_at_ms FROM canvas_edges WHERE id = ?',
            [id],
          )
          if (row === undefined) return 'missing'
          return row.deleted_at_ms === null ? 'active' : 'deleted'
        }
        const writeEdgeSnapshot = (edge: CanvasMutationEdgeSnapshot): void => {
          this.#database.exec({
            sql: `UPDATE canvas_edges
                  SET canvas_id = ?, source_node_id = ?, target_node_id = ?,
                      relation_type = ?, direction = ?, line_style = ?,
                      membership_position = ?, created_at_ms = ?, updated_at_ms = ?,
                      deleted_at_ms = NULL
                  WHERE id = ? AND canvas_id = ?
                    AND deleted_at_ms IS NOT NULL`,
            bind: [
              input.canvasId,
              edge.sourceNodeId,
              edge.targetNodeId,
              edge.relationType,
              edge.direction,
              edge.lineStyle,
              edge.membershipPosition,
              edge.createdAtMs,
              input.atMs,
              edge.id,
              input.canvasId,
            ],
          })
          if (this.#database.changes() !== 1) {
            throw new TaskDatabaseError('NOT_FOUND')
          }
        }

        for (const action of input.actions) {
          switch (action.kind) {
            case 'insert_nodes': {
              for (const node of action.nodes) {
                const state = nodeState(node.id)
                if (state === 'active') {
                  throw new TaskDatabaseError('STATUS_CONFLICT')
                }
                if (state === 'missing') {
                  this.#database.exec({
                    sql: `INSERT INTO canvas_nodes
                          (id, canvas_id, type, node_name, content_json, x, y,
                           created_at_ms, updated_at_ms)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    bind: [
                      node.id,
                      input.canvasId,
                      node.type,
                      node.nodeName,
                      JSON.stringify(node.content),
                      node.x,
                      node.y,
                      node.createdAtMs,
                      input.atMs,
                    ],
                  })
                } else {
                  this.#database.exec({
                    sql: `UPDATE canvas_nodes
                          SET canvas_id = ?, type = ?, node_name = ?, content_json = ?,
                              x = ?, y = ?, created_at_ms = ?, updated_at_ms = ?,
                              deleted_at_ms = NULL
                          WHERE id = ? AND canvas_id = ?`,
                    bind: [
                      input.canvasId,
                      node.type,
                      node.nodeName,
                      JSON.stringify(node.content),
                      node.x,
                      node.y,
                      node.createdAtMs,
                      input.atMs,
                      node.id,
                      input.canvasId,
                    ],
                  })
                  if (this.#database.changes() !== 1) {
                    throw new TaskDatabaseError('NOT_FOUND')
                  }
                }
              }
              break
            }
            case 'soft_delete_nodes': {
              for (const nodeId of action.nodeIds) {
                this.#database.exec({
                  sql: `UPDATE canvas_nodes
                        SET deleted_at_ms = ?, updated_at_ms = ?
                        WHERE id = ? AND canvas_id = ? AND deleted_at_ms IS NULL`,
                  bind: [input.atMs, input.atMs, nodeId, input.canvasId],
                })
                if (this.#database.changes() !== 1) {
                  throw new TaskDatabaseError('NOT_FOUND')
                }
              }
              break
            }
            case 'set_node_name': {
              this.#database.exec({
                sql: `UPDATE canvas_nodes
                      SET node_name = ?, updated_at_ms = ?
                      WHERE canvas_id = ? AND id = ? AND deleted_at_ms IS NULL`,
                bind: [action.nodeName, input.atMs, input.canvasId, action.nodeId],
              })
              if (this.#database.changes() !== 1) {
                throw new TaskDatabaseError('NOT_FOUND')
              }
              break
            }
            case 'set_node_content': {
              const node = this.requireNodeInCanvas(input.canvasId, action.nodeId)
              if (node.type !== action.content.type) {
                throw new TaskDatabaseError('PERSISTENCE_FAILED')
              }
              this.#database.exec({
                sql: `UPDATE canvas_nodes
                      SET content_json = ?, updated_at_ms = ?
                      WHERE canvas_id = ? AND id = ? AND deleted_at_ms IS NULL`,
                bind: [
                  JSON.stringify(action.content),
                  input.atMs,
                  input.canvasId,
                  action.nodeId,
                ],
              })
              if (this.#database.changes() !== 1) {
                throw new TaskDatabaseError('NOT_FOUND')
              }
              break
            }
            case 'insert_edges': {
              for (const edge of action.edges) {
                this.requireNodeInCanvas(input.canvasId, edge.sourceNodeId)
                this.requireNodeInCanvas(input.canvasId, edge.targetNodeId)
                const state = edgeState(edge.id)
                if (state === 'active') {
                  throw new TaskDatabaseError('STATUS_CONFLICT')
                }
                if (state === 'missing') {
                  this.assertNoDuplicateCanvasEdge(
                    input.canvasId,
                    edge.sourceNodeId,
                    edge.targetNodeId,
                    edge.relationType,
                    edge.direction,
                  )
                  this.#database.exec({
                    sql: `INSERT INTO canvas_edges
                          (id, canvas_id, source_node_id, target_node_id, relation_type,
                           direction, line_style, membership_position, created_at_ms,
                           updated_at_ms, deleted_at_ms)
                          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
                    bind: [
                      edge.id,
                      input.canvasId,
                      edge.sourceNodeId,
                      edge.targetNodeId,
                      edge.relationType,
                      edge.direction,
                      edge.lineStyle,
                      edge.membershipPosition,
                      edge.createdAtMs,
                      input.atMs,
                    ],
                  })
                } else {
                  this.assertNoDuplicateCanvasEdge(
                    input.canvasId,
                    edge.sourceNodeId,
                    edge.targetNodeId,
                    edge.relationType,
                    edge.direction,
                    edge.id,
                  )
                  writeEdgeSnapshot(edge)
                }
              }
              break
            }
            case 'soft_delete_edges': {
              for (const edgeId of action.edgeIds) {
                this.#database.exec({
                  sql: `UPDATE canvas_edges
                        SET deleted_at_ms = ?, updated_at_ms = ?
                        WHERE id = ? AND canvas_id = ? AND deleted_at_ms IS NULL`,
                  bind: [input.atMs, input.atMs, edgeId, input.canvasId],
                })
                if (this.#database.changes() !== 1) {
                  throw new TaskDatabaseError('NOT_FOUND')
                }
              }
              break
            }
            case 'restore_edges': {
              for (const edge of action.edges) {
                this.requireNodeInCanvas(input.canvasId, edge.sourceNodeId)
                this.requireNodeInCanvas(input.canvasId, edge.targetNodeId)
                if (edgeState(edge.id) !== 'deleted') {
                  throw new TaskDatabaseError('NOT_FOUND')
                }
                this.assertNoDuplicateCanvasEdge(
                  input.canvasId,
                  edge.sourceNodeId,
                  edge.targetNodeId,
                  edge.relationType,
                  edge.direction,
                  edge.id,
                )
                writeEdgeSnapshot(edge)
              }
              break
            }
          }
        }
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  addCanvasNodeBoxMember(input: AddCanvasNodeBoxMemberInput): CanvasEdge {
    if (
      !isCanonicalCanvasId(input.id) ||
      !isCanonicalCanvasId(input.canvasId) ||
      !isCanonicalCanvasId(input.sourceNodeId) ||
      !isCanonicalCanvasId(input.targetNodeId) ||
      input.sourceNodeId === input.targetNodeId ||
      !isCanvasMembershipRelationType(input.relationType) ||
      !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)
        const source = this.requireNodeInCanvas(input.canvasId, input.sourceNodeId)
        const target = this.requireNodeInCanvas(input.canvasId, input.targetNodeId)
        if (source.type === 'node_box' || target.type !== 'node_box') {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        const duplicate = this.#database.selectValue(
          `SELECT COUNT(*) FROM canvas_edges
           WHERE canvas_id = ? AND source_node_id = ? AND target_node_id = ?
             AND relation_type IN ('ordered_box_member', 'unordered_box_member')
             AND deleted_at_ms IS NULL`,
          [input.canvasId, input.sourceNodeId, input.targetNodeId],
        )
        if (duplicate !== 0) throw new TaskDatabaseError('STATUS_CONFLICT')
        const maxPosition = this.#database.selectValue(
          `SELECT COALESCE(MAX(membership_position), -1) FROM canvas_edges
           WHERE canvas_id = ? AND target_node_id = ? AND relation_type = ?
             AND deleted_at_ms IS NULL`,
          [input.canvasId, input.targetNodeId, input.relationType],
        )
        if (typeof maxPosition !== 'number' || !Number.isSafeInteger(maxPosition)) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        const position = maxPosition + 1
        this.#database.exec({
          sql: `INSERT INTO canvas_edges
                (id, canvas_id, source_node_id, target_node_id, relation_type,
                 direction, line_style, membership_position, created_at_ms,
                 updated_at_ms, deleted_at_ms)
                VALUES (?, ?, ?, ?, ?, 'forward', 'solid', ?, ?, ?, NULL)`,
          bind: [
            input.id,
            input.canvasId,
            input.sourceNodeId,
            input.targetNodeId,
            input.relationType,
            position,
            input.createdAtMs,
            input.createdAtMs,
          ],
        })
        return this.requireCanvasEdge(input.id, false)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  reorderCanvasNodeBoxMemberships(
    input: ReorderCanvasNodeBoxMembershipsInput,
  ): readonly CanvasEdge[] {
    if (
      !isCanonicalCanvasId(input.canvasId) ||
      !isCanonicalCanvasId(input.nodeBoxId) ||
      !isNonNegativeSafeIntegerMilliseconds(input.updatedAtMs)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    const suppliedEdgeIds = [
      ...input.orderedMembershipEdgeIds,
      ...input.unorderedMembershipEdgeIds,
    ]
    const uniqueEdgeIds = new Set<string>()
    for (const edgeId of suppliedEdgeIds) {
      if (!isCanonicalCanvasId(edgeId) || uniqueEdgeIds.has(edgeId)) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      uniqueEdgeIds.add(edgeId)
    }

    try {
      return this.#database.transaction(() => {
        this.requireCanvas(input.canvasId)
        const nodeBox = this.requireNodeInCanvas(input.canvasId, input.nodeBoxId)
        if (nodeBox.type !== 'node_box') {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        const currentMemberships = this.#database
          .selectObjects(
            `SELECT ${CANVAS_EDGE_COLUMNS} FROM canvas_edges
             WHERE canvas_id = ? AND target_node_id = ?
               AND relation_type IN ('ordered_box_member', 'unordered_box_member')
               AND deleted_at_ms IS NULL
             ORDER BY relation_type ASC, membership_position ASC, id ASC`,
            [input.canvasId, input.nodeBoxId],
          )
          .map((row) => {
            const edge = parseCanvasEdgeRow(row)
            if (edge === null) throw new TaskDatabaseError('PERSISTENCE_FAILED')
            return edge
          })
        if (
          currentMemberships.length !== suppliedEdgeIds.length ||
          currentMemberships.some((edge) => !uniqueEdgeIds.has(edge.id))
        ) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }

        const desired = new Map<
          string,
          { readonly relationType: 'ordered_box_member' | 'unordered_box_member'; readonly position: number }
        >()
        input.orderedMembershipEdgeIds.forEach((edgeId, position) => {
          desired.set(edgeId, { relationType: 'ordered_box_member', position })
        })
        input.unorderedMembershipEdgeIds.forEach((edgeId, position) => {
          desired.set(edgeId, { relationType: 'unordered_box_member', position })
        })
        const changedIds = new Set(
          currentMemberships
            .filter((edge) => {
              const next = desired.get(edge.id)!
              return edge.relationType !== next.relationType ||
                edge.membershipPosition !== next.position
            })
            .map((edge) => edge.id),
        )
        if (changedIds.size === 0) {
          const byId = new Map(currentMemberships.map((edge) => [edge.id, edge]))
          return suppliedEdgeIds.map((edgeId) => byId.get(edgeId)!)
        }

        const maxPosition = Math.max(
          -1,
          ...currentMemberships.map((edge) => edge.membershipPosition ?? -1),
        )
        const temporaryBase = maxPosition + currentMemberships.length + 1
        if (!Number.isSafeInteger(temporaryBase)) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        currentMemberships.forEach((edge, index) => {
          const temporaryPosition = temporaryBase + index
          if (!Number.isSafeInteger(temporaryPosition)) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
          this.#database.exec({
            sql: `UPDATE canvas_edges SET membership_position = ?
                  WHERE id = ? AND deleted_at_ms IS NULL`,
            bind: [temporaryPosition, edge.id],
          })
          if (this.#database.changes() !== 1) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
        })
        for (const edge of currentMemberships) {
          const next = desired.get(edge.id)!
          this.#database.exec({
            sql: `UPDATE canvas_edges
                  SET relation_type = ?, membership_position = ?, updated_at_ms = ?
                  WHERE id = ? AND deleted_at_ms IS NULL`,
            bind: [
              next.relationType,
              next.position,
              changedIds.has(edge.id) ? input.updatedAtMs : edge.updatedAtMs,
              edge.id,
            ],
          })
          if (this.#database.changes() !== 1) {
            throw new TaskDatabaseError('PERSISTENCE_FAILED')
          }
        }
        return suppliedEdgeIds.map((edgeId) =>
          this.requireCanvasEdge(edgeId, false),
        )
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  listCanvasEdges(canvasId: string): readonly CanvasEdge[] {
    if (!isCanonicalCanvasId(canvasId)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      this.requireCanvas(canvasId)
      return this.#database
        .selectObjects(
          `SELECT ${CANVAS_EDGE_COLUMNS} FROM canvas_edges
           WHERE canvas_id = ? AND deleted_at_ms IS NULL
           ORDER BY created_at_ms ASC, id ASC`,
          [canvasId],
        )
        .map((row) => {
          const edge = parseCanvasEdgeRow(row)
          if (edge === null) throw new TaskDatabaseError('PERSISTENCE_FAILED')
          return edge
        })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  updateCanvasEdgeDirection(
    input: UpdateCanvasEdgeDirectionInput,
  ): CanvasEdge {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (!isCanvasEdgeDirection(input.direction)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        const current = this.requireCanvasEdge(input.id, false)
        if (isCanvasMembershipRelationType(current.relationType)) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        this.assertNoDuplicateCanvasEdge(
          current.canvasId,
          current.sourceNodeId,
          current.targetNodeId,
          current.relationType,
          input.direction,
          input.id,
        )
        this.#database.exec({
          sql: `UPDATE canvas_edges SET direction = ?, updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
          bind: [input.direction, input.updatedAtMs, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireCanvasEdge(input.id, false)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  updateCanvasEdgeLineStyle(
    input: UpdateCanvasEdgeLineStyleInput,
  ): CanvasEdge {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (!isCanvasEdgeLineStyle(input.lineStyle)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      const current = this.requireCanvasEdge(input.id, false)
      if (isCanvasMembershipRelationType(current.relationType)) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      this.#database.exec({
        sql: `UPDATE canvas_edges SET line_style = ?, updated_at_ms = ?
              WHERE id = ? AND deleted_at_ms IS NULL`,
        bind: [input.lineStyle, input.updatedAtMs, input.id],
      })
      if (this.#database.changes() !== 1) {
        throw new TaskDatabaseError('NOT_FOUND')
      }
      return this.requireCanvasEdge(input.id, false)
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  updateCanvasEdgeRelationType(
    input: UpdateCanvasEdgeRelationTypeInput,
  ): CanvasEdge {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (
      !isCanvasOrdinaryEdgeRelationType(input.relationType) ||
      !isCanvasEdgeDirection(input.direction) ||
      !isCanvasEdgeLineStyle(input.lineStyle)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      return this.#database.transaction(() => {
        const current = this.requireCanvasEdge(input.id, false)
        if (!isCanvasOrdinaryEdgeRelationType(current.relationType)) {
          throw new TaskDatabaseError('PERSISTENCE_FAILED')
        }
        this.assertNoDuplicateCanvasEdge(
          current.canvasId,
          current.sourceNodeId,
          current.targetNodeId,
          input.relationType,
          input.direction,
          input.id,
        )
        this.#database.exec({
          sql: `UPDATE canvas_edges
                SET relation_type = ?, direction = ?, line_style = ?, updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
          bind: [
            input.relationType,
            input.direction,
            input.lineStyle,
            input.updatedAtMs,
            input.id,
          ],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireCanvasEdge(input.id, false)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  deleteCanvasEdge(input: DeleteCanvasEdgeInput): CanvasEdge {
    this.validateCanvasUpdate(input.id, input.updatedAtMs)
    if (!isNonNegativeSafeIntegerMilliseconds(input.deletedAtMs)) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    try {
      this.#database.exec({
        sql: `UPDATE canvas_edges
              SET deleted_at_ms = ?, updated_at_ms = ?
              WHERE id = ? AND deleted_at_ms IS NULL`,
        bind: [input.deletedAtMs, input.updatedAtMs, input.id],
      })
      if (this.#database.changes() !== 1) {
        throw new TaskDatabaseError('NOT_FOUND')
      }
      return this.requireCanvasEdge(input.id, true)
    } catch (error: unknown) {
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
          sql: `UPDATE tasks SET ${column} = ?, updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
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

  private updateDeletedState(
    input: TrashTaskInput | RestoreTaskInput,
    trash: boolean,
  ): Task {
    try {
      return this.#database.transaction(() => {
        this.#database.exec({
          sql: trash
            ? `UPDATE tasks
               SET deleted_at_ms = ?, updated_at_ms = ?
               WHERE id = ? AND deleted_at_ms IS NULL`
            : `UPDATE tasks
               SET deleted_at_ms = NULL, updated_at_ms = ?
               WHERE id = ? AND deleted_at_ms IS NOT NULL`,
          bind: trash
            ? [input.updatedAtMs, input.updatedAtMs, input.id]
            : [input.updatedAtMs, input.id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireTaskByDeletedState(input.id, trash)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private requireTask(id: string): Task {
    const task = parseTaskRow(
      this.#database.selectObject(
        `SELECT ${TASK_COLUMNS}
         FROM tasks WHERE id = ? AND deleted_at_ms IS NULL`,
        [id],
      ),
    )
    if (task === null) {
      throw new TaskDatabaseError('NOT_FOUND')
    }
    return this.withTaskTags(task)
  }

  private requireTaskByDeletedState(id: string, trashed: boolean): Task {
    const task = parseTaskRow(
      this.#database.selectObject(
        `SELECT ${TASK_COLUMNS}
         FROM tasks
         WHERE id = ? AND deleted_at_ms IS ${trashed ? 'NOT NULL' : 'NULL'}`,
        [id],
      ),
    )
    if (task === null) throw new TaskDatabaseError('NOT_FOUND')
    return this.withTaskTags(task)
  }

  private withTaskTags(task: Task): Task {
    const tagIds: string[] = []
    for (const row of this.#database.selectObjects(
      'SELECT tag_id FROM task_tags WHERE task_id = ? ORDER BY tag_id ASC',
      [task.id],
    )) {
      if (
        !isCanonicalLowercaseUuid(row.tag_id) ||
        tagIds.includes(row.tag_id)
      ) {
        throw new TaskDatabaseError('PERSISTENCE_FAILED')
      }
      tagIds.push(row.tag_id)
    }
    return { ...task, tagIds }
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

  private parseTagRow(row: Record<string, unknown> | undefined): Tag {
    if (row === undefined) throw new TaskDatabaseError('NOT_FOUND')
    const {
      id,
      name,
      created_at_ms: createdAtMs,
      updated_at_ms: updatedAtMs,
    } = row
    if (
      !isCanonicalLowercaseUuid(id) ||
      !isNonEmptyTagName(name) ||
      !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
      !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
      updatedAtMs < createdAtMs
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
    return { id, name, createdAtMs, updatedAtMs }
  }

  private requireTag(id: string): Tag {
    return this.parseTagRow(
      this.#database.selectObject(
        `SELECT ${TAG_COLUMNS} FROM tags WHERE id = ?`,
        [id],
      ),
    )
  }

  private requireCanvas(id: string): Canvas {
    const canvas = parseCanvasRow(
      this.#database.selectObject(
        `SELECT ${CANVAS_COLUMNS} FROM canvases WHERE id = ?`,
        [id],
      ),
    )
    if (canvas === null) throw new TaskDatabaseError('NOT_FOUND')
    return canvas
  }

  private requireCanvasNode(id: string): CanvasNode {
    const node = parseCanvasNodeRow(
      this.#database.selectObject(
        `SELECT ${CANVAS_NODE_COLUMNS} FROM canvas_nodes
         WHERE id = ? AND deleted_at_ms IS NULL`,
        [id],
      ),
    )
    if (node === null) throw new TaskDatabaseError('NOT_FOUND')
    return node
  }

  private requireNodeInCanvas(canvasId: string, id: string): CanvasNode {
    const node = parseCanvasNodeRow(
      this.#database.selectObject(
        `SELECT ${CANVAS_NODE_COLUMNS} FROM canvas_nodes
         WHERE canvas_id = ? AND id = ? AND deleted_at_ms IS NULL`,
        [canvasId, id],
      ),
    )
    if (node === null) throw new TaskDatabaseError('NOT_FOUND')
    return node
  }

  private requireCanvasEdge(id: string, deleted: boolean): CanvasEdge {
    const edge = parseCanvasEdgeRow(
      this.#database.selectObject(
        `SELECT ${CANVAS_EDGE_COLUMNS} FROM canvas_edges
         WHERE id = ? AND deleted_at_ms IS ${deleted ? 'NOT NULL' : 'NULL'}`,
        [id],
      ),
    )
    if (edge === null) throw new TaskDatabaseError('NOT_FOUND')
    return edge
  }

  private assertNoDuplicateCanvasEdge(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string,
    relationType: string,
    direction: CanvasEdgeDirection,
    excludedId?: string,
  ): void {
    const symmetric = direction !== 'forward'
    const count = this.#database.selectValue(
      `SELECT COUNT(*) FROM canvas_edges
       WHERE canvas_id = ? AND relation_type = ? AND direction = ?
         AND deleted_at_ms IS NULL
         AND ${
           symmetric
             ? '((source_node_id = ? AND target_node_id = ?) OR (source_node_id = ? AND target_node_id = ?))'
             : '(source_node_id = ? AND target_node_id = ?)'
         }
         ${excludedId === undefined ? '' : 'AND id <> ?'}`,
      symmetric
        ? [
            canvasId,
            relationType,
            direction,
            sourceNodeId,
            targetNodeId,
            targetNodeId,
            sourceNodeId,
            ...(excludedId === undefined ? [] : [excludedId]),
          ]
        : [
            canvasId,
            relationType,
            direction,
            sourceNodeId,
            targetNodeId,
            ...(excludedId === undefined ? [] : [excludedId]),
          ],
    )
    if (count !== 0) throw new TaskDatabaseError('STATUS_CONFLICT')
  }

  private updateCanvasNode(
    id: string,
    column: 'content_json',
    value: string,
    updatedAtMs: number,
  ): CanvasNode {
    try {
      return this.#database.transaction(() => {
        this.requireCanvasNode(id)
        this.#database.exec({
          sql: `UPDATE canvas_nodes SET ${column} = ?, updated_at_ms = ?
                WHERE id = ? AND deleted_at_ms IS NULL`,
          bind: [value, updatedAtMs, id],
        })
        if (this.#database.changes() !== 1) {
          throw new TaskDatabaseError('NOT_FOUND')
        }
        return this.requireCanvasNode(id)
      })
    } catch (error: unknown) {
      if (error instanceof TaskDatabaseError) throw error
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private validateCanvasInput(
    id: string,
    title: string,
    viewport: unknown,
    timestamp: number,
  ): void {
    if (
      !isCanonicalCanvasId(id) ||
      !isNonEmptyCanvasTitle(title) ||
      !isCanvasViewport(viewport) ||
      !isNonNegativeSafeIntegerMilliseconds(timestamp)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private validateCanvasUpdate(id: string, timestamp: number): void {
    if (
      !isCanonicalCanvasId(id) ||
      !isNonNegativeSafeIntegerMilliseconds(timestamp)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private validateNodeInput(
    id: string,
    canvasId: string,
    x: number,
    y: number,
    timestamp: number,
  ): void {
    if (
      !isCanonicalCanvasId(id) ||
      !isCanonicalCanvasId(canvasId) ||
      !isCanvasCoordinate(x) ||
      !isCanvasCoordinate(y) ||
      !isNonNegativeSafeIntegerMilliseconds(timestamp)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }

  private validateCanvasEdgeInput(input: CreateCanvasEdgeInput): void {
    if (
      !isCanonicalCanvasId(input.id) ||
      !isCanonicalCanvasId(input.canvasId) ||
      !isCanonicalCanvasId(input.sourceNodeId) ||
      !isCanonicalCanvasId(input.targetNodeId) ||
      input.sourceNodeId === input.targetNodeId ||
      !isCanvasOrdinaryEdgeRelationType(input.relationType) ||
      !isCanvasEdgeDirection(input.direction) ||
      !isCanvasEdgeLineStyle(input.lineStyle) ||
      !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
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

  private validateTagInput(id: string, name: string, timestamp: number): void {
    if (
      !isCanonicalLowercaseUuid(id) ||
      !isNonEmptyTagName(name) ||
      !isNonNegativeSafeIntegerMilliseconds(timestamp)
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
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
    const tagsTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'tags'`,
    )
    const taskTagsTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'task_tags'`,
    )
    const canvasesTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'canvases'`,
    )
    const canvasNodesTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'canvas_nodes'`,
    )
    const canvasEdgesTableCount = this.#database.selectValue(
      `SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name = 'canvas_edges'`,
    )
    if (
      tasksTableCount !== 1 ||
      projectsTableCount !== 1 ||
      tagsTableCount !== 1 ||
      taskTagsTableCount !== 1 ||
      canvasesTableCount !== 1 ||
      canvasNodesTableCount !== 1 ||
      canvasEdgesTableCount !== 1 ||
      quickCheck !== 'ok' ||
      foreignKeys !== 1
    ) {
      throw new TaskDatabaseError('PERSISTENCE_FAILED')
    }
  }
}
