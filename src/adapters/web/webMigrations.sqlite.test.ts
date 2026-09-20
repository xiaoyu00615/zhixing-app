import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import {
  SqliteWebMigrationStore,
  WEB_MIGRATIONS,
  runWebMigrations,
  sha256Hex,
} from '@/adapters/web/webMigrations'
import { WebTaskDatabase } from '@/adapters/web/taskDatabase'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

function openInMemoryDatabase(): Database {
  return new sqlite3.oo1.DB(':memory:')
}

function listTables(db: Database): string[] {
  const rows = db.selectObjects(
    "SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name ASC",
  )
  return rows.map((row) => row.name as string)
}

describe('Web SQLite migration 12 (real sqlite-wasm)', () => {
  test('applies all 13 migrations and creates notes + diary_entries', async () => {
    const db = openInMemoryDatabase()
    try {
      await runWebMigrations(new SqliteWebMigrationStore(db), WEB_MIGRATIONS, () => 123)

      const tables = listTables(db)
      expect(tables).toContain('notes')
      expect(tables).toContain('diary_entries')
      expect(tables).not.toContain('documents')

      const history = db.selectObjects(
        `SELECT version, id, checksum_sha256, applied_at_ms
         FROM schema_migrations ORDER BY version ASC`,
      )
      expect(history.map((row) => row.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ])
      const last = history.at(-1)
      expect(last).toMatchObject({
        version: 13,
        id: '0013_add_global_search',
        checksum_sha256: await sha256Hex(WEB_MIGRATIONS[12]?.sql ?? ''),
      })
    } finally {
      db.close()
    }
  })

  test('WebTaskDatabase.initialize passes sanity after migration 12', async () => {
    const raw = openInMemoryDatabase()
    await WebTaskDatabase.initialize(raw)
  })

  test('enforces active diary_date uniqueness and allows deleted duplicates', async () => {
    const db = openInMemoryDatabase()
    try {
      await runWebMigrations(
        new SqliteWebMigrationStore(db),
        WEB_MIGRATIONS,
        () => 123,
      )

      const insertDiary = (id: string, diaryDate: string, deletedAtMs: number | null) => {
        db.exec({
          sql: `INSERT INTO diary_entries
                 (id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms)
                 VALUES (?, 't', 'c', ?, 1, 1, ?)`,
          bind: [id, diaryDate, deletedAtMs],
        })
      }

      insertDiary('a1', '2026-09-01', null)
      expect(() => insertDiary('a2', '2026-09-01', null)).toThrow()

      insertDiary('d1', '2026-09-02', 100)
      insertDiary('d2', '2026-09-02', 200)
      insertDiary('d3', '2026-09-02', 300)

      insertDiary('m1', '2026-09-03', 100)
      insertDiary('m2', '2026-09-03', null)

      const total = db.selectObjects('SELECT COUNT(*) AS n FROM diary_entries').shift() as { n: number }
      expect(total.n).toBe(6)
    } finally {
      db.close()
    }
  })

  test('fresh 1→13 and upgrade 11→13 both reach a contiguous history with correct checksums', async () => {
    const fresh = openInMemoryDatabase()
    try {
      await runWebMigrations(
        new SqliteWebMigrationStore(fresh),
        WEB_MIGRATIONS,
        () => 123,
      )
      const freshHistory = fresh.selectObjects(
        'SELECT version, id, checksum_sha256 FROM schema_migrations ORDER BY version ASC',
      )
      expect(freshHistory.map((row) => row.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ])
      for (let i = 0; i < 13; i += 1) {
        const row = freshHistory[i]
        const definition = WEB_MIGRATIONS[i]
        expect(row).toMatchObject({
          version: i + 1,
          id: definition?.id,
          checksum_sha256: await sha256Hex(definition?.sql ?? ''),
        })
      }
    } finally {
      fresh.close()
    }

    const upgrade = openInMemoryDatabase()
    try {
      await runWebMigrations(
        new SqliteWebMigrationStore(upgrade),
        WEB_MIGRATIONS.slice(0, 11),
        () => 123,
      )
      await runWebMigrations(new SqliteWebMigrationStore(upgrade), WEB_MIGRATIONS, () => 456)

      const upgradeHistory = upgrade.selectObjects(
        'SELECT version, id, checksum_sha256, applied_at_ms FROM schema_migrations ORDER BY version ASC',
      )
      expect(upgradeHistory.map((row) => row.version)).toEqual([
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
      ])
      const last = upgradeHistory.at(-1)
      expect(last).toMatchObject({
        version: 13,
        id: '0013_add_global_search',
        checksum_sha256: await sha256Hex(WEB_MIGRATIONS[12]?.sql ?? ''),
        applied_at_ms: 456,
      })

      const tables = listTables(upgrade)
      expect(tables).toContain('notes')
      expect(tables).toContain('diary_entries')
    } finally {
      upgrade.close()
    }
  })
})

describe('Web SQLite migration 13 global search index (real sqlite-wasm)', () => {
  async function openMigratedDatabase(upTo?: number): Promise<Database> {
    const db = openInMemoryDatabase()
    const definitions = upTo === undefined ? WEB_MIGRATIONS : WEB_MIGRATIONS.slice(0, upTo)
    await runWebMigrations(new SqliteWebMigrationStore(db), definitions, () => 123)
    return db
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

  function projectionCount(db: Database, entityType: string): number {
    const rows = db.exec({
      sql: 'SELECT COUNT(*) AS n FROM search_documents WHERE entity_type = ?',
      bind: [entityType],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ n: number }>
    return rows[0]?.n ?? 0
  }

  function projectionExists(db: Database, entityType: string, entityId: string): boolean {
    const rows = db.exec({
      sql: 'SELECT COUNT(*) AS n FROM search_documents WHERE entity_type = ? AND entity_id = ?',
      bind: [entityType, entityId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ n: number }>
    return (rows[0]?.n ?? 0) > 0
  }

  function projectionTitle(db: Database, entityType: string, entityId: string): string {
    const rows = db.exec({
      sql: 'SELECT title FROM search_documents WHERE entity_type = ? AND entity_id = ?',
      bind: [entityType, entityId],
      rowMode: 'object',
      returnValue: 'resultRows',
    }) as Array<{ title: string }>
    return rows[0]?.title ?? ''
  }

  function insertTask(db: Database, id: string, title: string, deleted: number | null): void {
    db.exec({
      sql: `INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms, deleted_at_ms)
            VALUES(?, ?, 'todo', 10, 20, ?)`,
      bind: [id, title, deleted],
    })
  }

  function insertNote(
    db: Database,
    id: string,
    title: string,
    content: string,
    deleted: number | null,
  ): void {
    db.exec({
      sql: `INSERT INTO notes(id, title, content, created_at_ms, updated_at_ms, deleted_at_ms)
            VALUES(?, ?, ?, 10, 20, ?)`,
      bind: [id, title, content, deleted],
    })
  }

  function insertDiary(
    db: Database,
    id: string,
    title: string,
    content: string,
    diaryDate: string,
    deleted: number | null,
  ): void {
    db.exec({
      sql: `INSERT INTO diary_entries(id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms)
            VALUES(?, ?, ?, ?, 10, 20, ?)`,
      bind: [id, title, content, diaryDate, deleted],
    })
  }

  function insertCanvas(db: Database, id: string, title: string): void {
    db.exec({
      sql: `INSERT INTO canvases(id, title, viewport_json, created_at_ms, updated_at_ms)
            VALUES(?, ?, '{"x":0,"y":0,"zoom":1}', 10, 20)`,
      bind: [id, title],
    })
  }

  test('creates derived search objects and restricts entity_type', async () => {
    const db = await openMigratedDatabase()
    try {
      expect(listTables(db)).toContain('search_documents')
      expect(listTables(db)).toContain('search_fts')

      const indexes = db.exec({
        sql: `SELECT COUNT(*) AS n FROM sqlite_schema
              WHERE type = 'index' AND name = 'idx_search_documents_entity_unique'`,
        rowMode: 'object',
        returnValue: 'resultRows',
      }) as Array<{ n: number }>
      expect(indexes[0]?.n ?? 0).toBe(1)

      expect(() =>
        db.exec({
          sql: `INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
                VALUES('capture_item', 'x', 't', '', 1)`,
        }),
      ).toThrow()
    } finally {
      db.close()
    }
  })

  test('backfills only active existing content on 12->13 upgrade', async () => {
    const db = await openMigratedDatabase(12)
    try {
      insertTask(db, 't-active', '活跃任务', null)
      insertTask(db, 't-deleted', '删除任务', 100)
      insertNote(db, 'n-active', '活跃笔记', '正文内容', null)
      insertNote(db, 'n-deleted', '删除笔记', '正文内容', 200)
      insertDiary(db, 'd-active', '活跃日记', '日记正文', '2026-09-01', null)
      insertDiary(db, 'd-deleted', '删除日记', '日记正文', '2026-09-02', 300)
      insertCanvas(db, 'c-active', '活跃画布')

      await runWebMigrations(new SqliteWebMigrationStore(db), WEB_MIGRATIONS, () => 456)

      expect(projectionCount(db, 'task')).toBe(1)
      expect(projectionCount(db, 'note')).toBe(1)
      expect(projectionCount(db, 'diary')).toBe(1)
      expect(projectionCount(db, 'canvas')).toBe(1)

      expect(projectionExists(db, 'task', 't-active')).toBe(true)
      expect(projectionExists(db, 'note', 'n-active')).toBe(true)
      expect(projectionExists(db, 'diary', 'd-active')).toBe(true)
      expect(projectionExists(db, 'canvas', 'c-active')).toBe(true)

      expect(projectionExists(db, 'task', 't-deleted')).toBe(false)
      expect(projectionExists(db, 'note', 'n-deleted')).toBe(false)
      expect(projectionExists(db, 'diary', 'd-deleted')).toBe(false)
    } finally {
      db.close()
    }
  })

  test('task projection tracks insert, update, soft delete and restore', async () => {
    const db = await openMigratedDatabase()
    try {
      insertTask(db, 'task-1', '完成数学作业', null)
      expect(ftsHits(db, '完成数')).toBe(1)

      db.exec({ sql: `UPDATE tasks SET title='复习物理习题' WHERE id='task-1'` })
      expect(projectionTitle(db, 'task', 'task-1')).toBe('复习物理习题')
      expect(ftsHits(db, '复习物')).toBe(1)
      expect(ftsHits(db, '完成数')).toBe(0)

      db.exec({ sql: `UPDATE tasks SET deleted_at_ms=100 WHERE id='task-1'` })
      expect(projectionExists(db, 'task', 'task-1')).toBe(false)
      expect(ftsHits(db, '复习物')).toBe(0)

      db.exec({ sql: `UPDATE tasks SET deleted_at_ms=NULL WHERE id='task-1'` })
      expect(projectionExists(db, 'task', 'task-1')).toBe(true)
      expect(ftsHits(db, '复习物')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('note and diary projections track updates, soft delete and restore', async () => {
    const db = await openMigratedDatabase()
    try {
      insertNote(db, 'note-1', '标题', '今天完成数学作业', null)
      expect(ftsHits(db, '数学作')).toBe(1)
      db.exec({ sql: `UPDATE notes SET content='明天复习物理习题' WHERE id='note-1'` })
      expect(ftsHits(db, '复习物')).toBe(1)
      expect(ftsHits(db, '数学作')).toBe(0)
      db.exec({ sql: `UPDATE notes SET deleted_at_ms=100 WHERE id='note-1'` })
      expect(projectionExists(db, 'note', 'note-1')).toBe(false)
      db.exec({ sql: `UPDATE notes SET deleted_at_ms=NULL WHERE id='note-1'` })
      expect(projectionExists(db, 'note', 'note-1')).toBe(true)

      insertDiary(db, 'diary-1', '日记', '今天完成数学作业', '2026-09-01', null)
      expect(ftsHits(db, '数学作')).toBe(1)
      // 单独 changeDiaryDate 不得破坏已索引文本
      db.exec({ sql: `UPDATE diary_entries SET diary_date='2026-09-03' WHERE id='diary-1'` })
      expect(ftsHits(db, '数学作')).toBe(1)
      db.exec({ sql: `UPDATE diary_entries SET deleted_at_ms=100 WHERE id='diary-1'` })
      expect(projectionExists(db, 'diary', 'diary-1')).toBe(false)
      db.exec({ sql: `UPDATE diary_entries SET deleted_at_ms=NULL WHERE id='diary-1'` })
      expect(projectionExists(db, 'diary', 'diary-1')).toBe(true)
    } finally {
      db.close()
    }
  })

  test('canvas projection tracks create and title update only', async () => {
    const db = await openMigratedDatabase()
    try {
      insertCanvas(db, 'canvas-1', '架构图')
      expect(ftsHits(db, '架构图')).toBe(1)
      db.exec({ sql: `UPDATE canvases SET title='部署拓扑图' WHERE id='canvas-1'` })
      expect(projectionTitle(db, 'canvas', 'canvas-1')).toBe('部署拓扑图')
      expect(ftsHits(db, '部署拓')).toBe(1)
      expect(ftsHits(db, '架构图')).toBe(0)
    } finally {
      db.close()
    }
  })

  test('projection changes propagate to FTS and rebuild is supported', async () => {
    const db = await openMigratedDatabase()
    try {
      db.exec({
        sql: `INSERT INTO search_documents(entity_type, entity_id, title, body, updated_at_ms)
              VALUES('note', 'generic-1', '标题', '今天完成数学作业', 10)`,
      })
      expect(ftsHits(db, '数学作')).toBe(1)

      db.exec({
        sql: `UPDATE search_documents SET body='明天复习物理习题'
              WHERE entity_type='note' AND entity_id='generic-1'`,
      })
      expect(ftsHits(db, '复习物')).toBe(1)
      expect(ftsHits(db, '数学作')).toBe(0)

      db.exec({
        sql: `DELETE FROM search_documents
              WHERE entity_type='note' AND entity_id='generic-1'`,
      })
      expect(ftsHits(db, '复习物')).toBe(0)

      insertNote(db, 'note-rebuild', '标题', '今天完成数学作业', null)
      db.exec({ sql: `INSERT INTO search_fts(search_fts) VALUES('rebuild');` })
      expect(ftsHits(db, '数学作')).toBe(1)
    } finally {
      db.close()
    }
  })

  test('Chinese trigram retrieval works and 2-character MATCH limit holds', async () => {
    const db = await openMigratedDatabase()
    try {
      insertNote(db, 'note-cn', '数学', '今天完成数学作业', null)
      expect(ftsHits(db, '数学作')).toBe(1)
      expect(ftsHits(db, '数学')).toBe(0)
    } finally {
      db.close()
    }
  })
})
