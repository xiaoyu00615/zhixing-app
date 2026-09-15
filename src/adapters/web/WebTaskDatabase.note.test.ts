import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import {
  TaskDatabaseError,
  WebTaskDatabase,
} from '@/adapters/web/taskDatabase'
import type { Note } from '@/note/model'

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
  d: '00000000-0000-4000-8000-000000000004',
  missing: '00000000-0000-4000-8000-000000000099',
} as const

function expectNoteFields(
  note: Note,
  expected: {
    readonly id: string
    readonly title: string
    readonly content: string
    readonly createdAtMs: number
    readonly updatedAtMs: number
    readonly deletedAtMs: number | null
  },
): void {
  expect(note.id).toBe(expected.id)
  expect(note.title).toBe(expected.title)
  expect(note.content).toBe(expected.content)
  expect(note.createdAtMs).toBe(expected.createdAtMs)
  expect(note.updatedAtMs).toBe(expected.updatedAtMs)
  expect(note.deletedAtMs).toBe(expected.deletedAtMs)
}

function captureCode(run: () => unknown): unknown {
  try {
    run()
    return null
  } catch (error: unknown) {
    return error
  }
}

describe('WebTaskDatabase Note SQL direct execution', () => {
  test('createNote persists every field exactly', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const created = db.createNote({
        id: ID.a,
        title: 'First note',
        content: 'body',
        createdAtMs: 1000,
      })
      expectNoteFields(created, {
        id: ID.a,
        title: 'First note',
        content: 'body',
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
      const created = db.createNote({
        id: ID.a,
        title: '',
        content: '',
        createdAtMs: 7,
      })
      expectNoteFields(created, {
        id: ID.a,
        title: '',
        content: '',
        createdAtMs: 7,
        updatedAtMs: 7,
        deletedAtMs: null,
      })
      const readBack = db.getActiveNote(ID.a)
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
      db.createNote({
        id: ID.a,
        title,
        content,
        createdAtMs: 10,
      })
      const readBack = db.getActiveNote(ID.a)
      expect(readBack?.title).toBe(title)
      expect(readBack?.content).toBe(content)
    } finally {
      db.close()
    }
  })

  test('unicode roundtrips exactly', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const title = '中文笔记 título'
      const content = '你好，世界 🌍\ne\u0301motion — 组合字符\n再见'
      db.createNote({
        id: ID.a,
        title,
        content,
        createdAtMs: 20,
      })
      const readBack = db.getActiveNote(ID.a)
      expect(readBack?.title).toBe(title)
      expect(readBack?.content).toBe(content)
    } finally {
      db.close()
    }
  })

  test('getActiveNote returns the active note', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createNote({
        id: ID.a,
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      const note = db.getActiveNote(ID.a)
      expect(note).not.toBeNull()
      expectNoteFields(note as Note, {
        id: ID.a,
        title: 'a',
        content: 'a',
        createdAtMs: 1,
        updatedAtMs: 1,
        deletedAtMs: null,
      })
    } finally {
      db.close()
    }
  })

  test('getActiveNote returns null for a missing id', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      expect(db.getActiveNote(ID.missing)).toBeNull()
    } finally {
      db.close()
    }
  })

  test('getActiveNote returns null for a soft-deleted note', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createNote({
        id: ID.a,
        title: 'a',
        content: 'a',
        createdAtMs: 1,
      })
      db.softDeleteNote({ id: ID.a, updatedAtMs: 2 })
      expect(db.getActiveNote(ID.a)).toBeNull()
    } finally {
      db.close()
    }
  })

  test('listActiveNotes filters deleted notes and orders by updated_at_ms DESC then id ASC', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createNote({ id: ID.a, title: 'a', content: 'a', createdAtMs: 100 })
      db.createNote({ id: ID.b, title: 'b', content: 'b', createdAtMs: 200 })
      db.createNote({ id: ID.c, title: 'c', content: 'c', createdAtMs: 300 })
      db.createNote({ id: ID.d, title: 'd', content: 'd', createdAtMs: 400 })
      db.updateNote({
        id: ID.a,
        title: 'a2',
        content: 'a2',
        updatedAtMs: 500,
      })
      db.softDeleteNote({ id: ID.c, updatedAtMs: 600 })

      const active = db.listActiveNotes()
      expect(active.map((note) => note.id)).toEqual([ID.a, ID.d, ID.b])
      expect(active.map((note) => note.updatedAtMs)).toEqual([500, 400, 200])
      expect(active.some((note) => note.id === ID.c)).toBe(false)
    } finally {
      db.close()
    }
  })

  test('listActiveNotes breaks updated_at_ms ties by id ASC', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createNote({ id: ID.b, title: 'b', content: 'b', createdAtMs: 100 })
      db.createNote({ id: ID.a, title: 'a', content: 'a', createdAtMs: 100 })
      db.updateNote({ id: ID.b, title: 'b2', content: 'b2', updatedAtMs: 200 })
      db.updateNote({ id: ID.a, title: 'a2', content: 'a2', updatedAtMs: 200 })

      const active = db.listActiveNotes()
      expect(active.map((note) => note.updatedAtMs)).toEqual([200, 200])
      expect(active.map((note) => note.id)).toEqual([ID.a, ID.b])
    } finally {
      db.close()
    }
  })

  test('updateNote changes title content updatedAtMs and keeps id createdAtMs deletedAtMs', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createNote({
        id: ID.a,
        title: 'before',
        content: 'before',
        createdAtMs: 100,
      })
      const updated = db.updateNote({
        id: ID.a,
        title: 'after',
        content: 'after',
        updatedAtMs: 500,
      })
      expectNoteFields(updated, {
        id: ID.a,
        title: 'after',
        content: 'after',
        createdAtMs: 100,
        updatedAtMs: 500,
        deletedAtMs: null,
      })
    } finally {
      db.close()
    }
  })

  test('updateNote throws NOT_FOUND for missing or soft-deleted targets', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      const missing = captureCode(() =>
        db.updateNote({
          id: ID.missing,
          title: 'x',
          content: 'x',
          updatedAtMs: 2,
        }),
      )
      expect(missing).toBeInstanceOf(TaskDatabaseError)
      expect((missing as TaskDatabaseError).code).toBe('NOT_FOUND')

      db.createNote({ id: ID.a, title: 'a', content: 'a', createdAtMs: 1 })
      db.softDeleteNote({ id: ID.a, updatedAtMs: 2 })
      const deleted = captureCode(() =>
        db.updateNote({
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

  test('softDeleteNote writes deleted_at_ms and updated_at_ms while keeping created_at_ms', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      db.createNote({
        id: ID.a,
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.softDeleteNote({ id: ID.a, updatedAtMs: 300 })

      const hidden = db.listActiveNotes()
      expect(hidden.map((note) => note.id)).toEqual([])
      expect(db.getActiveNote(ID.a)).toBeNull()

      const rows = raw.selectObjects(
        'SELECT created_at_ms, updated_at_ms, deleted_at_ms FROM notes WHERE id = ?',
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

  test('restoreNote clears deleted_at_ms and makes the note active again', async () => {
    const { database: db } = await openTaskDatabase()
    try {
      db.createNote({
        id: ID.a,
        title: 'a',
        content: 'a',
        createdAtMs: 100,
      })
      db.softDeleteNote({ id: ID.a, updatedAtMs: 200 })
      expect(db.getActiveNote(ID.a)).toBeNull()

      db.restoreNote({ id: ID.a, updatedAtMs: 400 })
      const restored = db.getActiveNote(ID.a)
      expect(restored).not.toBeNull()
      expectNoteFields(restored as Note, {
        id: ID.a,
        title: 'a',
        content: 'a',
        createdAtMs: 100,
        updatedAtMs: 400,
        deletedAtMs: null,
      })
      expect(db.listActiveNotes().map((note) => note.id)).toEqual([ID.a])
    } finally {
      db.close()
    }
  })
})
