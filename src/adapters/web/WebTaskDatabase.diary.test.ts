import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import {
  TaskDatabaseError,
  WebTaskDatabase,
} from '@/adapters/web/taskDatabase'
import type { DiaryEntry } from '@/diary/model'

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

const ID = {
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
  missing: '00000000-0000-4000-8000-000000000099',
} as const

function expectDiaryFields(
  entry: DiaryEntry,
  expected: {
    readonly id: string
    readonly title: string
    readonly content: string
    readonly diaryDate: string
    readonly createdAtMs: number
    readonly updatedAtMs: number
    readonly deletedAtMs: number | null
  },
): void {
  expect(entry.id).toBe(expected.id)
  expect(entry.title).toBe(expected.title)
  expect(entry.content).toBe(expected.content)
  expect(entry.diaryDate).toBe(expected.diaryDate)
  expect(entry.createdAtMs).toBe(expected.createdAtMs)
  expect(entry.updatedAtMs).toBe(expected.updatedAtMs)
  expect(entry.deletedAtMs).toBe(expected.deletedAtMs)
}

function captureCode(run: () => unknown): unknown {
  try {
    run()
    return null
  } catch (error: unknown) {
    return error
  }
}

describe('WebTaskDatabase Diary SQL direct execution', () => {
  test('createDiaryEntry persists every field exactly with updatedAtMs == createdAtMs', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const created = db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'First entry',
        content: 'body',
        createdAtMs: 1000,
      })
      expectDiaryFields(created, {
        id: ID.a,
        title: 'First entry',
        content: 'body',
        diaryDate: '2024-03-15',
        createdAtMs: 1000,
        updatedAtMs: 1000,
        deletedAtMs: null,
      })
    } finally {
      db.close()
    }
  })

  test('empty title and empty content roundtrip exactly', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const created = db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: '',
        content: '',
        createdAtMs: 7,
      })
      expectDiaryFields(created, {
        id: ID.a,
        title: '',
        content: '',
        diaryDate: '2024-03-15',
        createdAtMs: 7,
        updatedAtMs: 7,
        deletedAtMs: null,
      })
      const readBack = db.getActiveDiaryEntry(ID.a)
      expect(readBack).not.toBeNull()
      expect(readBack?.title).toBe('')
      expect(readBack?.content).toBe('')
    } finally {
      db.close()
    }
  })

  test('raw markdown with whitespace and fences roundtrips exactly', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const title = '  leading and trailing  '
      const content = [
        '# Heading',
        '',
        'line with trailing space  ',
        '',
        '```ts',
        'const x = 1',
        '```',
        '',
        '   indented line',
      ].join('\n')
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title,
        content,
        createdAtMs: 10,
      })
      const readBack = db.getActiveDiaryEntry(ID.a)
      expect(readBack?.title).toBe(title)
      expect(readBack?.content).toBe(content)
    } finally {
      db.close()
    }
  })

  test('unicode roundtrips exactly', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const title = '中文日记 título'
      const content = '你好，世界 🌍\ne\u0301motion — 组合字符\n再见'
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title,
        content,
        createdAtMs: 20,
      })
      const readBack = db.getActiveDiaryEntry(ID.a)
      expect(readBack?.title).toBe(title)
      expect(readBack?.content).toBe(content)
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntry returns the active entry', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      const entry = db.getActiveDiaryEntry(ID.a)
      expect(entry).not.toBeNull()
      expectDiaryFields(entry as DiaryEntry, {
        id: ID.a,
        title: 'a',
        content: 'a',
        diaryDate: '2024-03-15',
        createdAtMs: 1,
        updatedAtMs: 1,
        deletedAtMs: null,
      })
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntry returns null for a missing id', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      expect(db.getActiveDiaryEntry(ID.missing)).toBeNull()
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntry returns null for a soft-deleted entry', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      db.softDeleteDiaryEntry({ id: ID.a, updatedAtMs: 2 })
      expect(db.getActiveDiaryEntry(ID.a)).toBeNull()
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntryByDate returns the active entry for the date', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      const entry = db.getActiveDiaryEntryByDate('2024-03-15')
      expect(entry).not.toBeNull()
      expect(entry?.id).toBe(ID.a)
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntryByDate allows a valid future date read without rejection', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2099-12-31',
        title: 'future',
        content: 'a',
        createdAtMs: 1,
      })
      const entry = db.getActiveDiaryEntryByDate('2099-12-31')
      expect(entry).not.toBeNull()
      expect(entry?.id).toBe(ID.a)
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntryByDate returns null for a missing date', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      expect(db.getActiveDiaryEntryByDate('2024-03-15')).toBeNull()
    } finally {
      db.close()
    }
  })

  test('getActiveDiaryEntryByDate returns null when only a soft-deleted entry owns the date', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      db.softDeleteDiaryEntry({ id: ID.a, updatedAtMs: 2 })
      expect(db.getActiveDiaryEntryByDate('2024-03-15')).toBeNull()
    } finally {
      db.close()
    }
  })

  test('listActiveDiaryEntries returns only active entries ordered by diary_date DESC, updated_at_ms DESC, id ASC', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-10',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-20',
        title: 'b',
        content: 'b',
        createdAtMs: 200,
      })
      db.createDiaryEntry({
        id: ID.c,
        diaryDate: '2024-03-15',
        title: 'c',
        content: 'c',
        createdAtMs: 300,
      })
      db.updateDiaryEntry({
        id: ID.a,
        title: 'a2',
        content: 'a2',
        updatedAtMs: 500,
      })
      db.softDeleteDiaryEntry({ id: ID.c, updatedAtMs: 600 })

      const active = db.listActiveDiaryEntries()
      // diary_date DESC: 2024-03-20 (b), then 2024-03-10 (a, updated 500) over 2024-03-15 (c deleted)
      expect(active.map((entry) => entry.id)).toEqual([ID.b, ID.a])
      expect(active.map((entry) => entry.diaryDate)).toEqual([
        '2024-03-20',
        '2024-03-10',
      ])
    } finally {
      db.close()
    }
  })

  test('listActiveDiaryEntries orders by diary_date DESC then updated_at_ms DESC (id ASC is the terminal tiebreak)', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      // Active diary dates are unique, so the id ASC tiebreak is unreachable at
      // runtime; the SQL still carries it per the frozen contract. Here two
      // distinct dates with the same updated_at_ms must keep diary_date DESC.
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-20',
        title: 'b',
        content: 'b',
        createdAtMs: 100,
      })
      db.updateDiaryEntry({
        id: ID.a,
        title: 'a2',
        content: 'a2',
        updatedAtMs: 200,
      })
      db.updateDiaryEntry({
        id: ID.b,
        title: 'b2',
        content: 'b2',
        updatedAtMs: 200,
      })

      const active = db.listActiveDiaryEntries()
      expect(active.map((entry) => entry.diaryDate)).toEqual([
        '2024-03-20',
        '2024-03-15',
      ])
      expect(active.map((entry) => entry.updatedAtMs)).toEqual([200, 200])
    } finally {
      db.close()
    }
  })

  test('updateDiaryEntry changes title content updatedAtMs and keeps id diaryDate createdAtMs deletedAtMs', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'before',
        content: 'before',
        createdAtMs: 100,
      })
      const updated = db.updateDiaryEntry({
        id: ID.a,
        title: 'after',
        content: 'after',
        updatedAtMs: 500,
      })
      expectDiaryFields(updated, {
        id: ID.a,
        title: 'after',
        content: 'after',
        diaryDate: '2024-03-15',
        createdAtMs: 100,
        updatedAtMs: 500,
        deletedAtMs: null,
      })
    } finally {
      db.close()
    }
  })

  test('updateDiaryEntry throws NOT_FOUND for missing or soft-deleted targets', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const missing = captureCode(() =>
        db.updateDiaryEntry({
          id: ID.missing,
          title: 'x',
          content: 'x',
          updatedAtMs: 2,
        }),
      )
      expect(missing).toBeInstanceOf(TaskDatabaseError)
      expect((missing as TaskDatabaseError).code).toBe('NOT_FOUND')

      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      db.softDeleteDiaryEntry({ id: ID.a, updatedAtMs: 2 })
      const deleted = captureCode(() =>
        db.updateDiaryEntry({
          id: ID.a,
          title: 'x',
          content: 'x',
          updatedAtMs: 3,
        }),
      )
      expect(deleted).toBeInstanceOf(TaskDatabaseError)
      expect((deleted as TaskDatabaseError).code).toBe('NOT_FOUND')
    } finally {
      db.close()
    }
  })

  test('changeDiaryDate moves the active entry to a free date', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      const moved = db.changeDiaryDate({
        id: ID.a,
        diaryDate: '2024-04-01',
        updatedAtMs: 300,
      })
      expectDiaryFields(moved, {
        id: ID.a,
        title: 'a',
        content: 'a',
        diaryDate: '2024-04-01',
        createdAtMs: 100,
        updatedAtMs: 300,
        deletedAtMs: null,
      })
      expect(db.getActiveDiaryEntryByDate('2024-04-01')?.id).toBe(ID.a)
      expect(db.getActiveDiaryEntryByDate('2024-03-15')).toBeNull()
    } finally {
      db.close()
    }
  })

  test('changeDiaryDate to its own current date does not self-conflict', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      const moved = db.changeDiaryDate({
        id: ID.a,
        diaryDate: '2024-03-15',
        updatedAtMs: 300,
      })
      expect(moved.diaryDate).toBe('2024-03-15')
      expect(moved.updatedAtMs).toBe(300)
    } finally {
      db.close()
    }
  })

  test('changeDiaryDate to a date owned by another active entry throws DIARY_DATE_CONFLICT', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-20',
        title: 'b',
        content: 'b',
        createdAtMs: 200,
      })
      const conflict = captureCode(() =>
        db.changeDiaryDate({
          id: ID.a,
          diaryDate: '2024-03-20',
          updatedAtMs: 300,
        }),
      )
      expect(conflict).toBeInstanceOf(TaskDatabaseError)
      expect((conflict as TaskDatabaseError).code).toBe('DIARY_DATE_CONFLICT')
    } finally {
      db.close()
    }
  })

  test('failed changeDiaryDate preserves the original diary_date and updated_at_ms', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-20',
        title: 'b',
        content: 'b',
        createdAtMs: 200,
      })
      captureCode(() =>
        db.changeDiaryDate({
          id: ID.a,
          diaryDate: '2024-03-20',
          updatedAtMs: 300,
        }),
      )
      const row = raw.selectObject(
        'SELECT diary_date, updated_at_ms FROM diary_entries WHERE id = ?',
        [ID.a],
      )
      expect(row).toMatchObject({ diary_date: '2024-03-15', updated_at_ms: 100 })
    } finally {
      db.close()
    }
  })

  test('createDiaryEntry on an already-occupied date throws DIARY_DATE_CONFLICT', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      const conflict = captureCode(() =>
        db.createDiaryEntry({
          id: ID.b,
          diaryDate: '2024-03-15',
          title: 'b',
          content: 'b',
          createdAtMs: 200,
        }),
      )
      expect(conflict).toBeInstanceOf(TaskDatabaseError)
      expect((conflict as TaskDatabaseError).code).toBe('DIARY_DATE_CONFLICT')
    } finally {
      db.close()
    }
  })

  test('unexpected integrity failure on create maps to PERSISTENCE_ERROR not DIARY_DATE_CONFLICT', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      // Pre-plant a row with the same id on a free date. The occupancy probe
      // targets diary_date, so it passes; the INSERT then fails on the unique
      // id constraint, which must stay PERSISTENCE_ERROR.
      raw.exec({
        sql: `INSERT INTO diary_entries
              (id, title, content, diary_date, created_at_ms, updated_at_ms, deleted_at_ms)
              VALUES (?, ?, ?, ?, ?, ?, NULL)`,
        bind: [ID.a, 'pre', 'pre', '2020-01-01', 1, 1],
      })
      const failure = captureCode(() =>
        db.createDiaryEntry({
          id: ID.a,
          diaryDate: '2021-01-01',
          title: 'b',
          content: 'b',
          createdAtMs: 200,
        }),
      )
      expect(failure).toBeInstanceOf(TaskDatabaseError)
      expect((failure as TaskDatabaseError).code).toBe('PERSISTENCE_ERROR')
    } finally {
      db.close()
    }
  })

  test('softDeleteDiaryEntry hides the entry from active queries', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.softDeleteDiaryEntry({ id: ID.a, updatedAtMs: 300 })

      expect(db.listActiveDiaryEntries().map((entry) => entry.id)).toEqual([])
      expect(db.getActiveDiaryEntry(ID.a)).toBeNull()
      expect(db.getActiveDiaryEntryByDate('2024-03-15')).toBeNull()

      const rows = raw.selectObjects(
        'SELECT created_at_ms, updated_at_ms, deleted_at_ms FROM diary_entries WHERE id = ?',
        [ID.a],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]).toMatchObject({
        created_at_ms: 100,
        updated_at_ms: 300,
        deleted_at_ms: 300,
      })
    } finally {
      db.close()
    }
  })

  test('a new active entry may reuse the date after the previous one is soft-deleted', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.softDeleteDiaryEntry({ id: ID.a, updatedAtMs: 200 })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-15',
        title: 'b',
        content: 'b',
        createdAtMs: 300,
      })
      const byDate = db.getActiveDiaryEntryByDate('2024-03-15')
      expect(byDate).not.toBeNull()
      expect(byDate?.id).toBe(ID.b)
    } finally {
      db.close()
    }
  })

  test('restoreDiaryEntry revives a soft-deleted entry', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.softDeleteDiaryEntry({ id: ID.a, updatedAtMs: 200 })
      expect(db.getActiveDiaryEntry(ID.a)).toBeNull()

      db.restoreDiaryEntry({ id: ID.a, updatedAtMs: 400 })
      const restored = db.getActiveDiaryEntry(ID.a)
      expect(restored).not.toBeNull()
      expectDiaryFields(restored as DiaryEntry, {
        id: ID.a,
        title: 'a',
        content: 'a',
        diaryDate: '2024-03-15',
        createdAtMs: 100,
        updatedAtMs: 400,
        deletedAtMs: null,
      })
      expect(db.listActiveDiaryEntries().map((entry) => entry.id)).toEqual([ID.a])
    } finally {
      db.close()
    }
  })

  test('restoreDiaryEntry throws NOT_FOUND for a missing or already-active entry', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const missing = captureCode(() =>
        db.restoreDiaryEntry({ id: ID.missing, updatedAtMs: 1 }),
      )
      expect(missing).toBeInstanceOf(TaskDatabaseError)
      expect((missing as TaskDatabaseError).code).toBe('NOT_FOUND')

      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      const active = captureCode(() =>
        db.restoreDiaryEntry({ id: ID.a, updatedAtMs: 2 }),
      )
      expect(active).toBeInstanceOf(TaskDatabaseError)
      expect((active as TaskDatabaseError).code).toBe('NOT_FOUND')
    } finally {
      db.close()
    }
  })

  test('restoreDiaryEntry on a date owned by another active entry throws DIARY_DATE_CONFLICT', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-20',
        title: 'b',
        content: 'b',
        createdAtMs: 200,
      })
      db.softDeleteDiaryEntry({ id: ID.b, updatedAtMs: 250 })
      // Occupy 2024-03-20 again with a new active entry.
      db.createDiaryEntry({
        id: ID.c,
        diaryDate: '2024-03-20',
        title: 'c',
        content: 'c',
        createdAtMs: 300,
      })
      const conflict = captureCode(() =>
        db.restoreDiaryEntry({ id: ID.b, updatedAtMs: 400 }),
      )
      expect(conflict).toBeInstanceOf(TaskDatabaseError)
      expect((conflict as TaskDatabaseError).code).toBe('DIARY_DATE_CONFLICT')
    } finally {
      db.close()
    }
  })

  test('failed restoreDiaryEntry leaves the entry soft-deleted', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      db.createDiaryEntry({
        id: ID.a,
        diaryDate: '2024-03-15',
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.createDiaryEntry({
        id: ID.b,
        diaryDate: '2024-03-20',
        title: 'b',
        content: 'b',
        createdAtMs: 200,
      })
      db.softDeleteDiaryEntry({ id: ID.b, updatedAtMs: 250 })
      db.createDiaryEntry({
        id: ID.c,
        diaryDate: '2024-03-20',
        title: 'c',
        content: 'c',
        createdAtMs: 300,
      })
      captureCode(() => db.restoreDiaryEntry({ id: ID.b, updatedAtMs: 400 }))
      const row = raw.selectObject(
        'SELECT deleted_at_ms, updated_at_ms FROM diary_entries WHERE id = ?',
        [ID.b],
      )
      expect(row).toBeDefined()
      expect(row?.deleted_at_ms).not.toBeNull()
      expect(row?.updated_at_ms).toBe(250)
    } finally {
      db.close()
    }
  })
})
