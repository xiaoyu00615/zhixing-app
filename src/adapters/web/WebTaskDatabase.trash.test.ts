import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import { WebTaskDatabase } from '@/adapters/web/taskDatabase'
import type { TrashItem } from '@/trash/model'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

function openInMemoryDatabase(): Database {
  return new sqlite3.oo1.DB(':memory:')
}

async function openTaskDatabase(): Promise<{
  database: WebTaskDatabase
  raw: Database
}> {
  const raw = openInMemoryDatabase()
  const database = await WebTaskDatabase.initialize(raw)
  return { database, raw }
}

function seedTrashedTask(
  raw: Database,
  id: string,
  title: string,
  deletedAtMs: number,
): void {
  raw.exec({
    sql: 'INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 0, 0)',
    bind: [id, title, 'todo'],
  })
  raw.exec({
    sql: 'UPDATE tasks SET deleted_at_ms = ? WHERE id = ?',
    bind: [deletedAtMs, id],
  })
}

function seedActiveTask(raw: Database, id: string, title: string): void {
  raw.exec({
    sql: 'INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 0, 0)',
    bind: [id, title, 'todo'],
  })
}

function seedTrashedNote(
  raw: Database,
  id: string,
  title: string,
  deletedAtMs: number,
): void {
  raw.exec({
    sql: 'INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms) VALUES (?, ?, ?, 0, 0, ?)',
    bind: [id, title, 'body', deletedAtMs],
  })
}

function seedTrashedDiary(
  raw: Database,
  id: string,
  title: string,
  deletedAtMs: number,
): void {
  raw.exec({
    sql: 'INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, 0, 0, ?)',
    bind: [id, title, 'body', '2026-01-01', deletedAtMs],
  })
}

function expectTrashItemShape(value: unknown): asserts value is TrashItem {
  const record = value as Record<string, unknown>
  expect(typeof record.entityType).toBe('string')
  expect(typeof record.entityId).toBe('string')
  expect(typeof record.title).toBe('string')
  expect(typeof record.deletedAtMs).toBe('number')
}

describe('WebTaskDatabase listTrash UNION ALL', () => {
  test('empty database returns no trash', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      expect(db.listTrash()).toEqual([])
    } finally {
      db.close()
    }
  })

  test('trashed task, note and diary all appear in the unified view', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedTrashedTask(raw, 't1', 'Trashed task', 300)
      seedTrashedNote(raw, 'n1', 'Trashed note', 200)
      seedTrashedDiary(raw, 'd1', 'Trashed diary', 100)

      const items = db.listTrash()
      expect(items).toHaveLength(3)
      const types = items.map((item) => item.entityType).sort()
      expect(types).toEqual(['diary', 'note', 'task'])
      for (const item of items) {
        expectTrashItemShape(item)
      }
      const byId = new Map(items.map((item) => [item.entityId, item]))
      expect(byId.get('t1')).toMatchObject({ entityType: 'task', title: 'Trashed task', deletedAtMs: 300 })
      expect(byId.get('n1')).toMatchObject({ entityType: 'note', title: 'Trashed note', deletedAtMs: 200 })
      expect(byId.get('d1')).toMatchObject({ entityType: 'diary', title: 'Trashed diary', deletedAtMs: 100 })
    } finally {
      db.close()
    }
  })

  test('active (non-deleted) rows are excluded', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedActiveTask(raw, 't1', 'Active task')
      seedTrashedTask(raw, 't2', 'Trashed task', 50)

      const items = db.listTrash()
      expect(items).toHaveLength(1)
      expect(items[0]?.entityId).toBe('t2')
    } finally {
      db.close()
    }
  })

  test('empty title is preserved verbatim', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedTrashedNote(raw, 'n1', '', 10)

      const items = db.listTrash()
      expect(items).toHaveLength(1)
      expect(items[0]?.title).toBe('')
    } finally {
      db.close()
    }
  })

  test('ordering follows deleted_at_ms DESC, entity_type ASC, entity_id ASC', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedActiveTask(raw, 'aa', 'Active')
      seedActiveTask(raw, 'bb', 'Active')
      seedTrashedTask(raw, 'a', 'Task a', 200)
      seedTrashedTask(raw, 'b', 'Task b', 100)
      seedTrashedNote(raw, 'n1', 'Note', 100)
      seedTrashedDiary(raw, 'd1', 'Diary', 100)

      const items = db.listTrash()
      // 200 first (task a); then 100 group in entity_type ASC: diary, note, task(b).
      expect(items.map((item) => [item.entityType, item.entityId])).toEqual([
        ['task', 'a'],
        ['diary', 'd1'],
        ['note', 'n1'],
        ['task', 'b'],
      ])
      for (const item of items) {
        expect(item.deletedAtMs).toBeGreaterThanOrEqual(100)
      }
    } finally {
      db.close()
    }
  })

  test('canvas nodes and edges are not in trash even when soft-deleted', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      raw.exec({
        sql: 'INSERT INTO canvases(id, title, viewport_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 0, 0)',
        bind: ['c1', 'Canvas', '{}'],
      })
      raw.exec({
        sql: "INSERT INTO canvas_nodes(id, canvas_id, type, node_name, content_json, x, y, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
        bind: ['cn1', 'c1', 'text', 'Node', '{}'],
      })
      raw.exec({
        sql: "INSERT INTO canvas_nodes(id, canvas_id, type, node_name, content_json, x, y, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0)",
        bind: ['cn2', 'c1', 'text', 'Other', '{}'],
      })
      raw.exec({
        sql: "INSERT INTO canvas_edges(id, canvas_id, source_node_id, target_node_id, relation_type, direction, line_style, membership_position, created_at_ms, updated_at_ms, deleted_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?)",
        bind: ['ce1', 'c1', 'cn1', 'cn2', 'association', 'forward', 'solid', null, 999],
      })

      expect(db.listTrash()).toEqual([])
    } finally {
      db.close()
    }
  })
})
