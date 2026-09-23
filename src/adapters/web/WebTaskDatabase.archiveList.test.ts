import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import { WebTaskDatabase } from '@/adapters/web/taskDatabase'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

async function openTaskDatabase(): Promise<WebTaskDatabase> {
  const raw: Database = new sqlite3.oo1.DB(':memory:')
  return WebTaskDatabase.initialize(raw)
}

const ID = {
  taskA: '00000000-0000-4000-8000-000000000001',
  taskB: '00000000-0000-4000-8000-000000000002',
  taskC: '00000000-0000-4000-8000-000000000003',
  noteA: '00000000-0000-4000-8000-000000000011',
  noteB: '00000000-0000-4000-8000-000000000012',
} as const

function seedTask(database: WebTaskDatabase, id: string): void {
  database.createTask({ id, title: 'Task', createdAtMs: 10 })
}

function seedNote(database: WebTaskDatabase, id: string, title = 'Note'): void {
  database.createNote({ id, title, content: 'c', createdAtMs: 10 })
}

describe('WebTaskDatabase.listArchive (real sqlite-wasm)', () => {
  test('returns an empty array when nothing is archived', async () => {
    const database = await openTaskDatabase()
    seedTask(database, ID.taskA)
    seedNote(database, ID.noteA)

    expect(database.listArchive()).toEqual([])
  })

  test('excludes active tasks and notes', async () => {
    const database = await openTaskDatabase()
    seedTask(database, ID.taskA)
    seedNote(database, ID.noteA)

    expect(database.listArchive()).toEqual([])
  })

  test('includes archived tasks and archived notes as one union', async () => {
    const database = await openTaskDatabase()
    seedTask(database, ID.taskA)
    seedNote(database, ID.noteA)
    database.archiveTask({ id: ID.taskA, updatedAtMs: 100 })
    database.archiveNote({ id: ID.noteA, updatedAtMs: 200 })

    const items = database.listArchive()
    expect(items).toHaveLength(2)
    expect(items).toEqual([
      {
        entityType: 'note',
        entityId: ID.noteA,
        title: 'Note',
        archivedAtMs: 200,
      },
      {
        entityType: 'task',
        entityId: ID.taskA,
        title: 'Task',
        archivedAtMs: 100,
      },
    ])
  })

  test('excludes a task that was trashed from the archive', async () => {
    const database = await openTaskDatabase()
    seedTask(database, ID.taskA)
    database.archiveTask({ id: ID.taskA, updatedAtMs: 100 })
    expect(database.listArchive()).toHaveLength(1)

    // TRASHED_FROM_ARCHIVE belongs to the Trash workspace, not Archive.
    database.trashTask({ id: ID.taskA, updatedAtMs: 150 })
    expect(database.listArchive()).toEqual([])
  })

  test('excludes a note that was trashed from the archive', async () => {
    const database = await openTaskDatabase()
    seedNote(database, ID.noteA)
    database.archiveNote({ id: ID.noteA, updatedAtMs: 100 })
    expect(database.listArchive()).toHaveLength(1)

    database.softDeleteNote({ id: ID.noteA, updatedAtMs: 150 })
    expect(database.listArchive()).toEqual([])
  })

  test('keeps archived rows and drops trashed-from-archive rows in one read', async () => {
    const database = await openTaskDatabase()
    seedTask(database, ID.taskA)
    seedTask(database, ID.taskB)
    seedNote(database, ID.noteA)
    seedNote(database, ID.noteB)
    database.archiveTask({ id: ID.taskA, updatedAtMs: 100 })
    database.archiveNote({ id: ID.noteA, updatedAtMs: 100 })
    database.archiveTask({ id: ID.taskB, updatedAtMs: 120 })
    database.archiveNote({ id: ID.noteB, updatedAtMs: 120 })
    database.trashTask({ id: ID.taskB, updatedAtMs: 130 })
    database.softDeleteNote({ id: ID.noteB, updatedAtMs: 130 })

    expect(database.listArchive()).toEqual([
      {
        entityType: 'note',
        entityId: ID.noteA,
        title: 'Note',
        archivedAtMs: 100,
      },
      {
        entityType: 'task',
        entityId: ID.taskA,
        title: 'Task',
        archivedAtMs: 100,
      },
    ])
  })

  test('orders by archivedAtMs DESC, entityType ASC, entityId ASC', async () => {
    const database = await openTaskDatabase()
    seedTask(database, ID.taskA)
    seedTask(database, ID.taskB)
    seedTask(database, ID.taskC)
    seedNote(database, ID.noteA)
    database.archiveTask({ id: ID.taskB, updatedAtMs: 100 })
    database.archiveTask({ id: ID.taskA, updatedAtMs: 100 })
    database.archiveNote({ id: ID.noteA, updatedAtMs: 100 })
    database.archiveTask({ id: ID.taskC, updatedAtMs: 200 })

    expect(
      database
        .listArchive()
        .map((item) => [item.entityType, item.entityId] as const),
    ).toEqual([
      ['task', ID.taskC],
      ['note', ID.noteA],
      ['task', ID.taskA],
      ['task', ID.taskB],
    ])
  })

  test('preserves an empty title verbatim', async () => {
    const database = await openTaskDatabase()
    seedNote(database, ID.noteA, '')
    database.archiveNote({ id: ID.noteA, updatedAtMs: 10 })

    const items = database.listArchive()
    expect(items).toHaveLength(1)
    expect(items[0]!.title).toBe('')
  })
})
