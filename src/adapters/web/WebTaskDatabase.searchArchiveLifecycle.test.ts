import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import { WebTaskDatabase } from '@/adapters/web/taskDatabase'
import {
  SqliteWebMigrationStore,
  WEB_MIGRATIONS,
  runWebMigrations,
  sha256Hex,
} from '@/adapters/web/webMigrations'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

function openRaw(): Database {
  return new sqlite3.oo1.DB(':memory:')
}

async function openTaskDatabase(): Promise<WebTaskDatabase> {
  return WebTaskDatabase.initialize(openRaw())
}

const ID = {
  taskActive: '00000000-0000-4000-8000-000000000201',
  taskArchived: '00000000-0000-4000-8000-000000000202',
  taskTrashed: '00000000-0000-4000-8000-000000000203',
  taskTrashedArchived: '00000000-0000-4000-8000-000000000204',
  noteActive: '00000000-0000-4000-8000-000000000211',
  noteArchived: '00000000-0000-4000-8000-000000000212',
  noteTrashed: '00000000-0000-4000-8000-000000000213',
  noteTrashedArchived: '00000000-0000-4000-8000-000000000214',
  diaryActive: '00000000-0000-4000-8000-000000000221',
  canvasActive: '00000000-0000-4000-8000-000000000231',
} as const

function projectionCount(db: Database, entityType: string): number {
  const rows = db.exec({
    sql: 'SELECT COUNT(*) AS n FROM search_documents WHERE entity_type = ?',
    bind: [entityType],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

function projectionExists(
  db: Database,
  entityType: string,
  entityId: string,
): boolean {
  const rows = db.exec({
    sql: 'SELECT COUNT(*) AS n FROM search_documents WHERE entity_type = ? AND entity_id = ?',
    bind: [entityType, entityId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ n: number }>
  return (rows[0]?.n ?? 0) > 0
}

function projectionTitle(
  db: Database,
  entityType: string,
  entityId: string,
): string {
  const rows = db.exec({
    sql: 'SELECT title FROM search_documents WHERE entity_type = ? AND entity_id = ?',
    bind: [entityType, entityId],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ title: string }>
  return rows[0]?.title ?? ''
}

function ftsHits(db: Database, term: string): number {
  const quoted = `"${term.replaceAll('"', '""')}"`
  const rows = db.exec({
    sql: 'SELECT COUNT(*) AS n FROM search_fts WHERE search_fts MATCH ?',
    bind: [quoted],
    rowMode: 'object',
    returnValue: 'resultRows',
  }) as Array<{ n: number }>
  return rows[0]?.n ?? 0
}

function insertTaskRaw(
  db: Database,
  id: string,
  title: string,
  deletedAtMs: number | null,
): void {
  db.exec({
    sql: `INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, deleted_at_ms)
          VALUES(?, ?, 'todo', 10, 20, ?)`,
    bind: [id, title, deletedAtMs],
  })
}

function insertNoteRaw(
  db: Database,
  id: string,
  title: string,
  content: string,
  deletedAtMs: number | null,
): void {
  db.exec({
    sql: `INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms)
          VALUES(?, ?, ?, 10, 20, ?)`,
    bind: [id, title, content, deletedAtMs],
  })
}

function setArchived(db: Database, table: string, id: string, ms: number): void {
  db.exec({
    sql: `UPDATE ${table} SET archived_at_ms = ? WHERE id = ?`,
    bind: [ms, id],
  })
}

function setDeleted(db: Database, table: string, id: string, ms: number): void {
  db.exec({
    sql: `UPDATE ${table} SET deleted_at_ms = ? WHERE id = ?`,
    bind: [ms, id],
  })
}

function insertDiaryRaw(db: Database, id: string, title: string): void {
  db.exec({
    sql: `INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms)
          VALUES(?, ?, '日记正文内容', '2026-09-01', 10, 20, NULL)`,
    bind: [id, title],
  })
}

function insertCanvasRaw(db: Database, id: string, title: string): void {
  db.exec({
    sql: `INSERT INTO canvases(id, title, viewport_json, created_at_ms, updated_at_ms)
          VALUES(?, ?, '{"x":0,"y":0,"zoom":1}', 10, 20)`,
    bind: [id, title],
  })
}

describe('Web SQLite migration 15 search/archive lifecycle (real sqlite-wasm)', () => {
  /// 构造一个真实 0014 数据库：旧 0013 触发器不认识 Archive，
  /// 因此 ARCHIVED 的 Task / Note 会残留在派生 Search 投影里。
  async function openPre0015Database(): Promise<Database> {
    const db = openRaw()
    await runWebMigrations(
      new SqliteWebMigrationStore(db),
      WEB_MIGRATIONS.slice(0, 14),
      () => 123,
    )

    insertTaskRaw(db, ID.taskActive, '活跃任务标题', null)
    insertTaskRaw(db, ID.taskArchived, '归档任务标题', null)
    insertTaskRaw(db, ID.taskTrashed, '回收任务标题', 200)
    insertTaskRaw(db, ID.taskTrashedArchived, '归档回收任务', null)
    setArchived(db, 'tasks', ID.taskArchived, 100)
    setArchived(db, 'tasks', ID.taskTrashedArchived, 100)
    setDeleted(db, 'tasks', ID.taskTrashedArchived, 200)

    insertNoteRaw(db, ID.noteActive, '活跃笔记', '活跃笔记正文内容', null)
    insertNoteRaw(db, ID.noteArchived, '归档笔记', '归档笔记正文内容', null)
    insertNoteRaw(db, ID.noteTrashed, '回收笔记', '回收笔记正文内容', 200)
    insertNoteRaw(
      db,
      ID.noteTrashedArchived,
      '归档回收笔记',
      '归档回收笔记正文',
      null,
    )
    setArchived(db, 'notes', ID.noteArchived, 100)
    setArchived(db, 'notes', ID.noteTrashedArchived, 100)
    setDeleted(db, 'notes', ID.noteTrashedArchived, 200)

    insertDiaryRaw(db, ID.diaryActive, '活跃日记')
    insertCanvasRaw(db, ID.canvasActive, '活跃画布')
    return db
  }

  test('registers version 15 with the correct id and checksum on a 14 -> 15 upgrade', async () => {
    const db = await openPre0015Database()
    try {
      await runWebMigrations(
        new SqliteWebMigrationStore(db),
        WEB_MIGRATIONS,
        () => 456,
      )

      const history = db.exec({
        sql: 'SELECT version, id, checksum_sha256, applied_at_ms FROM schema_migrations ORDER BY version ASC',
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as Array<{
        version: number
        id: string
        checksum_sha256: string
        applied_at_ms: number
      }>

      expect(history.map((row) => row.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
      ])
      expect(history.at(-1)).toMatchObject({
        version: 15,
        id: '0015_search_archive_lifecycle',
        checksum_sha256: await sha256Hex(WEB_MIGRATIONS[14]?.sql ?? ''),
        applied_at_ms: 456,
      })
    } finally {
      db.close()
    }
  })

  test('repairs the Task and Note projection: active included, archived and trashed excluded', async () => {
    const db = await openPre0015Database()
    try {
      // BEFORE 0015：ARCHIVED 行仍留在派生投影里（旧触发器只认识 deleted_at_ms）。
      expect(projectionExists(db, 'task', ID.taskArchived)).toBe(true)
      expect(projectionExists(db, 'note', ID.noteArchived)).toBe(true)

      await runWebMigrations(
        new SqliteWebMigrationStore(db),
        WEB_MIGRATIONS,
        () => 456,
      )

      // Task：只有 ACTIVE 可检索
      expect(projectionExists(db, 'task', ID.taskActive)).toBe(true)
      expect(projectionExists(db, 'task', ID.taskArchived)).toBe(false)
      expect(projectionExists(db, 'task', ID.taskTrashed)).toBe(false)
      expect(projectionExists(db, 'task', ID.taskTrashedArchived)).toBe(false)

      // Note：只有 ACTIVE 可检索
      expect(projectionExists(db, 'note', ID.noteActive)).toBe(true)
      expect(projectionExists(db, 'note', ID.noteArchived)).toBe(false)
      expect(projectionExists(db, 'note', ID.noteTrashed)).toBe(false)
      expect(projectionExists(db, 'note', ID.noteTrashedArchived)).toBe(false)

      expect(projectionCount(db, 'task')).toBe(1)
      expect(projectionCount(db, 'note')).toBe(1)

      // FTS：归档 token 必须消失，活跃 token 必须仍在
      expect(ftsHits(db, '活跃任')).toBe(1)
      expect(ftsHits(db, '归档任')).toBe(0)
      expect(ftsHits(db, '档笔记')).toBe(0)
      expect(ftsHits(db, '笔记正')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('leaves Diary and Canvas projections unchanged', async () => {
    const db = await openPre0015Database()
    try {
      const diaryBefore = projectionTitle(db, 'diary', ID.diaryActive)
      const canvasBefore = projectionTitle(db, 'canvas', ID.canvasActive)

      await runWebMigrations(
        new SqliteWebMigrationStore(db),
        WEB_MIGRATIONS,
        () => 456,
      )

      expect(projectionCount(db, 'diary')).toBe(1)
      expect(projectionCount(db, 'canvas')).toBe(1)
      expect(projectionExists(db, 'diary', ID.diaryActive)).toBe(true)
      expect(projectionExists(db, 'canvas', ID.canvasActive)).toBe(true)
      expect(projectionTitle(db, 'diary', ID.diaryActive)).toBe(diaryBefore)
      expect(projectionTitle(db, 'canvas', ID.canvasActive)).toBe(canvasBefore)
    } finally {
      db.close()
    }
  })
})

describe('WebTaskDatabase search/archive lifecycle (real sqlite-wasm)', () => {
  function searchHits(database: WebTaskDatabase, term: string): number {
    return database.searchQuery({ query: term, limit: 50 }).length
  }

  test('task search lifecycle follows the archive state', async () => {
    const database = await openTaskDatabase()
    try {
      database.createTask({
        id: ID.taskActive,
        title: '生命周期任务',
        createdAtMs: 10,
      })
      expect(searchHits(database, '生命周期')).toBe(1)

      database.archiveTask({ id: ID.taskActive, updatedAtMs: 20 })
      expect(searchHits(database, '生命周期')).toBe(0)

      database.unarchiveTask({ id: ID.taskActive, updatedAtMs: 30 })
      expect(searchHits(database, '生命周期')).toBe(1)

      // Archive -> Trash -> Restore 回到 ARCHIVED，必须仍然不可检索。
      database.archiveTask({ id: ID.taskActive, updatedAtMs: 40 })
      database.trashTask({ id: ID.taskActive, updatedAtMs: 50 })
      expect(searchHits(database, '生命周期')).toBe(0)
      database.restoreTask({ id: ID.taskActive, updatedAtMs: 60 })
      expect(searchHits(database, '生命周期')).toBe(0)

      database.unarchiveTask({ id: ID.taskActive, updatedAtMs: 70 })
      expect(searchHits(database, '生命周期')).toBe(1)
    } finally {
      database.close()
    }
  })

  test('note search lifecycle follows the archive state including the body token', async () => {
    const database = await openTaskDatabase()
    try {
      database.createNote({
        id: ID.noteActive,
        title: '生命周期笔记',
        content: '生命周期正文内容',
        createdAtMs: 10,
      })
      expect(searchHits(database, '生命周期')).toBe(1)
      expect(searchHits(database, '周期正')).toBe(1)

      database.archiveNote({ id: ID.noteActive, updatedAtMs: 20 })
      expect(searchHits(database, '生命周期')).toBe(0)
      expect(searchHits(database, '周期正')).toBe(0)

      database.unarchiveNote({ id: ID.noteActive, updatedAtMs: 30 })
      expect(searchHits(database, '周期正')).toBe(1)

      database.archiveNote({ id: ID.noteActive, updatedAtMs: 40 })
      database.softDeleteNote({ id: ID.noteActive, updatedAtMs: 50 })
      expect(searchHits(database, '周期正')).toBe(0)
      database.restoreNote({ id: ID.noteActive, updatedAtMs: 60 })
      expect(searchHits(database, '周期正')).toBe(0)

      database.unarchiveNote({ id: ID.noteActive, updatedAtMs: 70 })
      expect(searchHits(database, '周期正')).toBe(1)
    } finally {
      database.close()
    }
  })
})
