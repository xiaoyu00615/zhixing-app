/// <reference types="vite/client" />

import { openWebTaskRepository } from '@/adapters/web'
import type { WebPersistenceCapability } from '@/adapters/web'
import type { Task } from '@/task/model'
import type { Project } from '@/project/model'
import type { Tag } from '@/tag/model'
import type {
  CreateProjectInput,
  ProjectRepository,
  RenameProjectInput,
} from '@/project/repository'
import type {
  CreateTagInput,
  RenameTagInput,
  TagRepository,
} from '@/tag/repository'
import type {
  ChangeTaskStatusInput,
  CreateTaskInput,
  RenameTaskInput,
  TaskRepository,
} from '@/task/repository'
import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
import type {
  CanvasRepository,
  AddCanvasNodeBoxMemberInput,
  CreateCanvasInput,
  CreateCanvasNodeInput,
  CreateCanvasEdgeInput,
  CreateTextNodeInput,
  DeleteCanvasEdgeInput,
  DeleteCanvasNodeInput,
  MoveCanvasNodeInput,
  MoveCanvasNodesInput,
  ReorderCanvasNodeBoxMembershipsInput,
  RenameCanvasInput,
  RenameCanvasNodeInput,
  UpdateCanvasEdgeRelationTypeInput,
  UpdateCanvasEdgeDirectionInput,
  UpdateCanvasEdgeLineStyleInput,
  UpdateCanvasViewportInput,
  UpdateCanvasNodeContentInput,
  UpdateTextNodeInput,
} from '@/canvas/repository'

interface PersistenceHarness {
  auditMigrationTenRollback(): Promise<{
    readonly failedClosed: boolean
    readonly historyVersion: number
    readonly originalNodeCount: number
    readonly originalTablesPresent: boolean
    readonly temporaryTablesPresent: boolean
  }>
  auditMigrationTenUpgrade(): Promise<{
    readonly historyVersion: number
    readonly canvasPreserved: boolean
    readonly nodesPreserved: number
    readonly edgesPreserved: number
    readonly unknownEdgePreserved: boolean
    readonly ordinaryMembershipPositionsNull: number
    readonly membershipColumnPresent: boolean
    readonly nodeSoftDeleteColumnPresent: boolean
    readonly temporaryTablesPresent: boolean
    readonly foreignKeyViolations: number
  }>
  capability(): Promise<WebPersistenceCapability>
  createTask(input: CreateTaskInput): Promise<Task>
  listTasks(): Promise<readonly Task[]>
  listTrashedTasks(): Promise<readonly Task[]>
  trashTask(input: import('@/task/repository').TrashTaskInput): Promise<Task>
  restoreTask(
    input: import('@/task/repository').RestoreTaskInput,
  ): Promise<Task>
  renameTask(input: RenameTaskInput): Promise<Task>
  changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task>
  setTaskProject(
    input: import('@/task/repository').SetTaskProjectInput,
  ): Promise<Task>
  clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Promise<Task>
  addTaskTag(input: import('@/task/repository').AddTaskTagInput): Promise<Task>
  removeTaskTag(
    input: import('@/task/repository').RemoveTaskTagInput,
  ): Promise<Task>
  createProject(input: CreateProjectInput): Promise<Project>
  listProjects(): Promise<readonly Project[]>
  renameProject(input: RenameProjectInput): Promise<Project>
  createTag(input: CreateTagInput): Promise<Tag>
  listTags(): Promise<readonly Tag[]>
  renameTag(input: RenameTagInput): Promise<Tag>
  createCanvas(input: CreateCanvasInput): Promise<Canvas>
  listCanvases(): Promise<readonly Canvas[]>
  getCanvas(id: string): Promise<Canvas>
  renameCanvas(input: RenameCanvasInput): Promise<Canvas>
  updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<Canvas>
  createTextNode(input: CreateTextNodeInput): Promise<CanvasNode>
  createCanvasNode(input: CreateCanvasNodeInput): Promise<CanvasNode>
  listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]>
  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode>
  updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): Promise<CanvasNode>
  renameCanvasNode(input: RenameCanvasNodeInput): Promise<CanvasNode>
  deleteCanvasNode(input: DeleteCanvasNodeInput): Promise<void>
  moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode>
  moveCanvasNodes(input: MoveCanvasNodesInput): Promise<readonly CanvasNode[]>
  createCanvasEdge(input: CreateCanvasEdgeInput): Promise<CanvasEdge>
  addCanvasNodeBoxMember(input: AddCanvasNodeBoxMemberInput): Promise<CanvasEdge>
  reorderCanvasNodeBoxMemberships(
    input: ReorderCanvasNodeBoxMembershipsInput,
  ): Promise<readonly CanvasEdge[]>
  listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]>
  updateCanvasEdgeRelationType(input: UpdateCanvasEdgeRelationTypeInput): Promise<CanvasEdge>
  updateCanvasEdgeDirection(input: UpdateCanvasEdgeDirectionInput): Promise<CanvasEdge>
  updateCanvasEdgeLineStyle(input: UpdateCanvasEdgeLineStyleInput): Promise<CanvasEdge>
  deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<CanvasEdge>
  shutdown(): Promise<void>
}

declare global {
  interface Window {
    __taskPersistenceHarness: PersistenceHarness
  }
}

const opened = openWebTaskRepository()

async function requireRepository(): Promise<TaskRepository> {
  const result = await opened
  if (!('repository' in result)) {
    throw new Error('Task persistence is unavailable.')
  }
  return result.repository
}

async function requireProjectRepository(): Promise<ProjectRepository> {
  const result = await opened
  if (!('projectRepository' in result))
    throw new Error('Project persistence is unavailable.')
  return result.projectRepository
}

async function requireTagRepository(): Promise<TagRepository> {
  const result = await opened
  if (!('tagRepository' in result))
    throw new Error('Tag persistence is unavailable.')
  return result.tagRepository
}

async function requireCanvasRepository(): Promise<CanvasRepository> {
  const result = await opened
  if (!('canvasRepository' in result)) {
    throw new Error('Canvas persistence is unavailable.')
  }
  return result.canvasRepository
}

window.__taskPersistenceHarness = {
  async auditMigrationTenRollback() {
    const [{ default: sqlite3InitModule }, migrations] = await Promise.all([
      import('@sqlite.org/sqlite-wasm'),
      import('@/adapters/web/webMigrations'),
    ])
    const sqlite3 = await sqlite3InitModule()
    const database = new sqlite3.oo1.DB(':memory:', 'c')
    try {
      const store = new migrations.SqliteWebMigrationStore(database)
      await migrations.runWebMigrations(
        store,
        migrations.WEB_MIGRATIONS.slice(0, 9),
        () => 100,
      )
      database.exec({
        sql: `INSERT INTO canvases
              (id, title, viewport_json, created_at_ms, updated_at_ms)
              VALUES (?, ?, ?, ?, ?)`,
        bind: [
          '00000000-0000-4000-8000-000000009001',
          'Migration rollback audit',
          '{"x":0,"y":0,"zoom":1}',
          10,
          10,
        ],
      })
      database.exec({
        sql: `INSERT INTO canvas_nodes
              (id, canvas_id, type, node_name, content_json, x, y,
               created_at_ms, updated_at_ms)
              VALUES (?, ?, 'text', ?, ?, ?, ?, ?, ?)`,
        bind: [
          '00000000-0000-4000-8000-000000009002',
          '00000000-0000-4000-8000-000000009001',
          'Preserved node',
          '{"type":"text","text":"original"}',
          12,
          24,
          20,
          20,
        ],
      })
      const migrationTen = migrations.WEB_MIGRATIONS[9]
      if (migrationTen === undefined) throw new Error('Migration 10 is missing.')
      let failedClosed = false
      try {
        await migrations.runWebMigrations(
          store,
          [
            ...migrations.WEB_MIGRATIONS.slice(0, 9),
            {
              ...migrationTen,
              sql: `${migrationTen.sql}\nSELECT * FROM missing_migration_ten_table;\n`,
            },
          ],
          () => 200,
        )
      } catch {
        failedClosed = true
      }
      return {
        failedClosed,
        historyVersion: database.selectValue(
          'SELECT MAX(version) FROM schema_migrations',
        ) as number,
        originalNodeCount: database.selectValue(
          "SELECT COUNT(*) FROM canvas_nodes WHERE node_name = 'Preserved node'",
        ) as number,
        originalTablesPresent: database.selectValue(
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('canvas_nodes', 'canvas_edges')",
        ) === 2,
        temporaryTablesPresent: database.selectValue(
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('canvas_nodes_v9', 'canvas_edges_v9')",
        ) !== 0,
      }
    } finally {
      database.close()
    }
  },
  async auditMigrationTenUpgrade() {
    const [{ default: sqlite3InitModule }, migrations] = await Promise.all([
      import('@sqlite.org/sqlite-wasm'),
      import('@/adapters/web/webMigrations'),
    ])
    const sqlite3 = await sqlite3InitModule()
    const database = new sqlite3.oo1.DB(':memory:', 'c')
    try {
      const store = new migrations.SqliteWebMigrationStore(database)
      await migrations.runWebMigrations(
        store,
        migrations.WEB_MIGRATIONS.slice(0, 9),
        () => 100,
      )
      const canvasId = '00000000-0000-4000-8000-000000009101'
      const sourceId = '00000000-0000-4000-8000-000000009102'
      const targetId = '00000000-0000-4000-8000-000000009103'
      database.exec({
        sql: `INSERT INTO canvases
              (id, title, viewport_json, created_at_ms, updated_at_ms)
              VALUES (?, ?, ?, ?, ?)`,
        bind: [canvasId, 'Exact Web upgrade', '{"x":17,"y":-9,"zoom":1.25}', 10, 15],
      })
      database.exec({
        sql: `INSERT INTO canvas_nodes
              (id, canvas_id, type, node_name, content_json, x, y,
               created_at_ms, updated_at_ms)
              VALUES (?, ?, 'text', ?, ?, ?, ?, ?, ?),
                     (?, ?, 'sticky', ?, ?, ?, ?, ?, ?)`,
        bind: [
          sourceId,
          canvasId,
          'Main concept',
          '{"type":"text","text":"Body A"}',
          -12.5,
          48.25,
          20,
          41,
          targetId,
          canvasId,
          'Reference',
          '{"type":"sticky","text":"Body B"}',
          300.75,
          -90.5,
          21,
          42,
        ],
      })
      const edgeRows = [
        ['00000000-0000-4000-8000-000000009104', 'default', 'forward', 'solid', 50, 50, null],
        ['00000000-0000-4000-8000-000000009105', 'hierarchy', 'bidirectional', 'dashed', 51, 61, null],
        ['00000000-0000-4000-8000-000000009106', 'peer', 'none', 'dotted', 52, 62, null],
        ['00000000-0000-4000-8000-000000009107', 'future_relation', 'bidirectional', 'dotted', 53, 73, 73],
      ] as const
      for (const [id, relationType, direction, lineStyle, createdAtMs, updatedAtMs, deletedAtMs] of edgeRows) {
        database.exec({
          sql: `INSERT INTO canvas_edges
                (id, canvas_id, source_node_id, target_node_id, relation_type,
                 direction, line_style, created_at_ms, updated_at_ms, deleted_at_ms)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          bind: [id, canvasId, sourceId, targetId, relationType, direction, lineStyle, createdAtMs, updatedAtMs, deletedAtMs],
        })
      }

      await migrations.runWebMigrations(
        store,
        migrations.WEB_MIGRATIONS,
        () => 200,
      )
      return {
        historyVersion: database.selectValue(
          'SELECT MAX(version) FROM schema_migrations',
        ) as number,
        canvasPreserved: database.selectValue(
          `SELECT COUNT(*) FROM canvases
           WHERE id = ? AND title = 'Exact Web upgrade'
             AND viewport_json = '{"x":17,"y":-9,"zoom":1.25}'
             AND created_at_ms = 10 AND updated_at_ms = 15`,
          [canvasId],
        ) === 1,
        nodesPreserved: database.selectValue(
          `SELECT COUNT(*) FROM canvas_nodes
           WHERE canvas_id = ?
             AND ((id = ? AND type = 'text' AND node_name = 'Main concept'
                   AND content_json = '{"type":"text","text":"Body A"}'
                   AND x = -12.5 AND y = 48.25
                   AND created_at_ms = 20 AND updated_at_ms = 41)
               OR (id = ? AND type = 'sticky' AND node_name = 'Reference'
                   AND content_json = '{"type":"sticky","text":"Body B"}'
                   AND x = 300.75 AND y = -90.5
                   AND created_at_ms = 21 AND updated_at_ms = 42))`,
          [canvasId, sourceId, targetId],
        ) as number,
        edgesPreserved: database.selectValue(
          'SELECT COUNT(*) FROM canvas_edges WHERE canvas_id = ?',
          [canvasId],
        ) as number,
        unknownEdgePreserved: database.selectValue(
          `SELECT COUNT(*) FROM canvas_edges
           WHERE id = '00000000-0000-4000-8000-000000009107'
             AND relation_type = 'future_relation'
             AND direction = 'bidirectional' AND line_style = 'dotted'
             AND membership_position IS NULL
             AND created_at_ms = 53 AND updated_at_ms = 73
             AND deleted_at_ms = 73`,
        ) === 1,
        ordinaryMembershipPositionsNull: database.selectValue(
          'SELECT COUNT(*) FROM canvas_edges WHERE canvas_id = ? AND membership_position IS NULL',
          [canvasId],
        ) as number,
        membershipColumnPresent: database.selectValue(
          "SELECT COUNT(*) FROM pragma_table_info('canvas_edges') WHERE name = 'membership_position'",
        ) === 1,
        nodeSoftDeleteColumnPresent: database.selectValue(
          "SELECT COUNT(*) FROM pragma_table_info('canvas_nodes') WHERE name = 'deleted_at_ms'",
        ) === 1,
        temporaryTablesPresent: database.selectValue(
          "SELECT COUNT(*) FROM sqlite_schema WHERE type = 'table' AND name IN ('canvas_nodes_v9', 'canvas_edges_v9')",
        ) !== 0,
        foreignKeyViolations: database.selectValue(
          'SELECT COUNT(*) FROM pragma_foreign_key_check',
        ) as number,
      }
    } finally {
      database.close()
    }
  },
  async capability() {
    return (await opened).capability
  },
  async createTask(input) {
    return (await requireRepository()).createTask(input)
  },
  async listTasks() {
    return (await requireRepository()).listTasks()
  },
  async listTrashedTasks() {
    return (await requireRepository()).listTrashedTasks()
  },
  async trashTask(input) {
    return (await requireRepository()).trashTask(input)
  },
  async restoreTask(input) {
    return (await requireRepository()).restoreTask(input)
  },
  async renameTask(input) {
    return (await requireRepository()).renameTask(input)
  },
  async changeTaskStatus(input) {
    return (await requireRepository()).changeTaskStatus(input)
  },
  async setTaskProject(input) {
    return (await requireRepository()).setTaskProject(input)
  },
  async clearTaskProject(input) {
    return (await requireRepository()).clearTaskProject(input)
  },
  async addTaskTag(input) {
    return (await requireRepository()).addTaskTag(input)
  },
  async removeTaskTag(input) {
    return (await requireRepository()).removeTaskTag(input)
  },
  async createProject(input) {
    return (await requireProjectRepository()).createProject(input)
  },
  async listProjects() {
    return (await requireProjectRepository()).listProjects()
  },
  async renameProject(input) {
    return (await requireProjectRepository()).renameProject(input)
  },
  async createTag(input) {
    return (await requireTagRepository()).createTag(input)
  },
  async listTags() {
    return (await requireTagRepository()).listTags()
  },
  async renameTag(input) {
    return (await requireTagRepository()).renameTag(input)
  },
  async createCanvas(input) {
    return (await requireCanvasRepository()).createCanvas(input)
  },
  async listCanvases() {
    return (await requireCanvasRepository()).listCanvases()
  },
  async getCanvas(id) {
    return (await requireCanvasRepository()).getCanvas(id)
  },
  async renameCanvas(input) {
    return (await requireCanvasRepository()).renameCanvas(input)
  },
  async updateCanvasViewport(input) {
    return (await requireCanvasRepository()).updateCanvasViewport(input)
  },
  async createTextNode(input) {
    return (await requireCanvasRepository()).createTextNode(input)
  },
  async createCanvasNode(input) {
    return (await requireCanvasRepository()).createCanvasNode(input)
  },
  async listCanvasNodes(canvasId) {
    return (await requireCanvasRepository()).listCanvasNodes(canvasId)
  },
  async updateTextNode(input) {
    return (await requireCanvasRepository()).updateTextNode(input)
  },
  async updateCanvasNodeContent(input) {
    return (await requireCanvasRepository()).updateCanvasNodeContent(input)
  },
  async renameCanvasNode(input) {
    return (await requireCanvasRepository()).renameCanvasNode(input)
  },
  async deleteCanvasNode(input) {
    return (await requireCanvasRepository()).deleteCanvasNode(input)
  },
  async moveCanvasNode(input) {
    return (await requireCanvasRepository()).moveCanvasNode(input)
  },
  async moveCanvasNodes(input) {
    return (await requireCanvasRepository()).moveCanvasNodes(input)
  },
  async createCanvasEdge(input) {
    return (await requireCanvasRepository()).createCanvasEdge(input)
  },
  async addCanvasNodeBoxMember(input) {
    return (await requireCanvasRepository()).addCanvasNodeBoxMember(input)
  },
  async reorderCanvasNodeBoxMemberships(input) {
    return (await requireCanvasRepository()).reorderCanvasNodeBoxMemberships(input)
  },
  async listCanvasEdges(canvasId) {
    return (await requireCanvasRepository()).listCanvasEdges(canvasId)
  },
  async updateCanvasEdgeRelationType(input) {
    return (await requireCanvasRepository()).updateCanvasEdgeRelationType(input)
  },
  async updateCanvasEdgeDirection(input) {
    return (await requireCanvasRepository()).updateCanvasEdgeDirection(input)
  },
  async updateCanvasEdgeLineStyle(input) {
    return (await requireCanvasRepository()).updateCanvasEdgeLineStyle(input)
  },
  async deleteCanvasEdge(input) {
    return (await requireCanvasRepository()).deleteCanvasEdge(input)
  },
  async shutdown() {
    const result = await opened
    if ('dispose' in result) {
      await result.dispose()
    }
  },
}

void opened.then((result) => {
  const output = document.querySelector('#capability')
  if (output !== null) {
    output.textContent = result.capability.status
  }
})

export {}
