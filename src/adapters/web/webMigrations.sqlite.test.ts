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
  test('applies all 12 migrations and creates notes + diary_entries', async () => {
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
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ])
      const last = history.at(-1)
      expect(last).toMatchObject({
        version: 12,
        id: '0012_add_notes_and_diary',
        checksum_sha256: await sha256Hex(WEB_MIGRATIONS[11]?.sql ?? ''),
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

  test('fresh 1→12 and upgrade 11→12 both reach a contiguous history with correct checksums', async () => {
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
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ])
      for (let i = 0; i < 12; i += 1) {
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
        1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      ])
      const last = upgradeHistory.at(-1)
      expect(last).toMatchObject({
        version: 12,
        id: '0012_add_notes_and_diary',
        checksum_sha256: await sha256Hex(WEB_MIGRATIONS[11]?.sql ?? ''),
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
