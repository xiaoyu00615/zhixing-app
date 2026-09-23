import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import { TaskDatabaseError, WebTaskDatabase } from '@/adapters/web/taskDatabase'

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
  project: '00000000-0000-4000-8000-000000000101',
  tag: '00000000-0000-4000-8000-000000000201',
  missing: '00000000-0000-4000-8000-000000000099',
} as const

function captureCode(run: () => unknown): unknown {
  try {
    run()
    return null
  } catch (error: unknown) {
    return error instanceof TaskDatabaseError ? error.code : error
  }
}

describe('WebTaskDatabase Task archive state (real sqlite-wasm)', () => {
  test('archives an active task, hides it from listTasks, and unarchives it back', async () => {
    const { database } = await openTaskDatabase()
    const created = database.createTask({
      id: ID.a,
      title: 'Archivable',
      createdAtMs: 100,
    })
    expect(created.archivedAtMs).toBeNull()
    expect(created.deletedAtMs).toBeNull()

    const archived = database.archiveTask({ id: ID.a, updatedAtMs: 200 })
    expect(archived.archivedAtMs).toBe(200)
    expect(archived.updatedAtMs).toBe(200)
    expect(archived.deletedAtMs).toBeNull()
    expect(database.listTasks()).toEqual([])
    // Archiving is not deleting.
    expect(database.listTrashedTasks()).toEqual([])

    const unarchived = database.unarchiveTask({ id: ID.a, updatedAtMs: 300 })
    expect(unarchived.archivedAtMs).toBeNull()
    expect(unarchived.updatedAtMs).toBe(300)
    expect(database.listTasks().map((task) => task.id)).toEqual([ID.a])
  })

  test('preserves every other Task field across archive and unarchive', async () => {
    const { database } = await openTaskDatabase()
    database.createProject({
      id: ID.project,
      name: '项目',
      createdAtMs: 50,
    })
    database.createTag({ id: ID.tag, name: '标签', createdAtMs: 50 })
    const created = database.createTask({
      id: ID.a,
      title: '  Padded title  ',
      createdAtMs: 100,
      isImportant: true,
      isUrgent: true,
      dueDate: '2026-08-23',
      projectId: ID.project,
      tagIds: [ID.tag],
    })
    const started = database.changeTaskStatus({
      id: ID.a,
      operation: 'start',
      updatedAtMs: 150,
    })
    expect(started.status).toBe('doing')
    // Fresh rows start ACTIVE: neither deleted nor archived.
    expect(created.deletedAtMs).toBeNull()
    expect(created.archivedAtMs).toBeNull()

    database.archiveTask({ id: ID.a, updatedAtMs: 200 })
    const unarchived = database.unarchiveTask({ id: ID.a, updatedAtMs: 300 })

    expect(unarchived).toMatchObject({
      id: ID.a,
      title: '  Padded title  ',
      status: 'doing',
      createdAtMs: 100,
      updatedAtMs: 300,
      isImportant: true,
      isUrgent: true,
      dueDate: '2026-08-23',
      projectId: ID.project,
      tagIds: [ID.tag],
      deletedAtMs: null,
      archivedAtMs: null,
    })
  })

  test('excludes archived tasks from active-only mutations but keeps them trashable', async () => {
    const { database } = await openTaskDatabase()
    database.createTag({ id: ID.tag, name: '标签', createdAtMs: 50 })
    database.createTask({
      id: ID.a,
      title: 'Archived',
      createdAtMs: 100,
      tagIds: [ID.tag],
    })
    database.archiveTask({ id: ID.a, updatedAtMs: 200 })

    expect(
      captureCode(() =>
        database.renameTask({ id: ID.a, title: 'No', updatedAtMs: 300 }),
      ),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.changeTaskStatus({
          id: ID.a,
          operation: 'start',
          updatedAtMs: 300,
        }),
      ),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.setTaskImportance({
          id: ID.a,
          isImportant: true,
          updatedAtMs: 300,
        }),
      ),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.setTaskDeadline({
          id: ID.a,
          dueDate: '2026-08-23',
          updatedAtMs: 300,
        }),
      ),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.clearTaskProject({ id: ID.a, updatedAtMs: 300 }),
      ),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.removeTaskTag({ id: ID.a, tagId: ID.tag, updatedAtMs: 300 }),
      ),
    ).toBe('NOT_FOUND')

    // Archive -> Trash remains reachable.
    const trashed = database.trashTask({ id: ID.a, updatedAtMs: 400 })
    expect(trashed).toMatchObject({ deletedAtMs: 400, archivedAtMs: 200 })
  })

  test('accepts Archive -> Trash -> Restore -> Archive and preserves archivedAtMs', async () => {
    const { database } = await openTaskDatabase()
    database.createTask({ id: ID.a, title: 'Round trip', createdAtMs: 100 })
    database.archiveTask({ id: ID.a, updatedAtMs: 200 })
    const trashed = database.trashTask({ id: ID.a, updatedAtMs: 300 })
    expect(trashed.archivedAtMs).toBe(200)
    expect(trashed.deletedAtMs).toBe(300)

    const restored = database.restoreTask({ id: ID.a, updatedAtMs: 400 })
    expect(restored.deletedAtMs).toBeNull()
    // Canonical Trash restore PRESERVES archived_at_ms.
    expect(restored.archivedAtMs).toBe(200)
    // Restored from Trash it is ARCHIVED again, not active.
    expect(database.listTasks()).toEqual([])
    expect(database.listTrashedTasks()).toEqual([])

    const unarchived = database.unarchiveTask({ id: ID.a, updatedAtMs: 500 })
    expect(unarchived.archivedAtMs).toBeNull()
    expect(database.listTasks().map((task) => task.id)).toEqual([ID.a])
  })

  test('accepts Active -> Trash -> Restore -> Active without inventing an archive state', async () => {
    const { database } = await openTaskDatabase()
    database.createTask({ id: ID.a, title: 'Plain', createdAtMs: 100 })
    database.trashTask({ id: ID.a, updatedAtMs: 200 })
    const restored = database.restoreTask({ id: ID.a, updatedAtMs: 300 })
    expect(restored).toMatchObject({
      deletedAtMs: null,
      archivedAtMs: null,
      updatedAtMs: 300,
    })
    expect(database.listTasks().map((task) => task.id)).toEqual([ID.a])
  })

  test('fails closed for archive and unarchive on invalid Task lifecycle targets', async () => {
    const { database } = await openTaskDatabase()
    expect(
      captureCode(() => database.archiveTask({ id: ID.missing, updatedAtMs: 1 })),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.unarchiveTask({ id: ID.missing, updatedAtMs: 1 }),
      ),
    ).toBe('NOT_FOUND')

    database.createTask({ id: ID.a, title: 'A', createdAtMs: 100 })
    expect(
      captureCode(() => database.unarchiveTask({ id: ID.a, updatedAtMs: 2 })),
    ).toBe('NOT_FOUND')

    database.archiveTask({ id: ID.a, updatedAtMs: 200 })
    expect(
      captureCode(() => database.archiveTask({ id: ID.a, updatedAtMs: 300 })),
    ).toBe('NOT_FOUND')

    database.trashTask({ id: ID.a, updatedAtMs: 400 })
    expect(
      captureCode(() => database.archiveTask({ id: ID.a, updatedAtMs: 500 })),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() => database.unarchiveTask({ id: ID.a, updatedAtMs: 500 })),
    ).toBe('NOT_FOUND')

    const trashed = database.listTrashedTasks()
    expect(trashed).toHaveLength(1)
    expect(trashed[0]).toMatchObject({ deletedAtMs: 400, archivedAtMs: 200 })
  })

  test('rejects an invalid archive timestamp before touching the database', async () => {
    const { database } = await openTaskDatabase()
    database.createTask({ id: ID.a, title: 'A', createdAtMs: 100 })
    expect(
      captureCode(() => database.archiveTask({ id: ID.a, updatedAtMs: -1 })),
    ).toBe('PERSISTENCE_FAILED')
    expect(
      captureCode(() => database.unarchiveTask({ id: ID.a, updatedAtMs: -1 })),
    ).toBe('PERSISTENCE_FAILED')
    expect(database.listTasks()).toHaveLength(1)
  })
})

describe('WebTaskDatabase Note archive state (real sqlite-wasm)', () => {
  test('archives an active note, hides it from active reads, and unarchives it back', async () => {
    const { database } = await openTaskDatabase()
    const content = '  raw  content\n\nwith spacing\n'
    const created = database.createNote({
      id: ID.b,
      title: '  Keep me  ',
      content,
      createdAtMs: 100,
    })
    expect(created.archivedAtMs).toBeNull()

    database.archiveNote({ id: ID.b, updatedAtMs: 200 })
    expect(database.getActiveNote(ID.b)).toBeNull()
    expect(database.listActiveNotes()).toEqual([])
    expect(
      captureCode(() =>
        database.updateNote({
          id: ID.b,
          title: 'changed',
          content: 'changed',
          updatedAtMs: 300,
        }),
      ),
    ).toBe('NOT_FOUND')

    database.unarchiveNote({ id: ID.b, updatedAtMs: 400 })
    const unarchived = database.getActiveNote(ID.b)
    expect(unarchived).toMatchObject({
      id: ID.b,
      title: '  Keep me  ',
      content,
      createdAtMs: 100,
      updatedAtMs: 400,
      deletedAtMs: null,
      archivedAtMs: null,
    })
    expect(database.listActiveNotes().map((note) => note.id)).toEqual([ID.b])
  })

  test('accepts Archive -> Trash -> Restore -> Archive for a Note', async () => {
    const { database } = await openTaskDatabase()
    database.createNote({
      id: ID.b,
      title: 'N',
      content: 'C',
      createdAtMs: 100,
    })
    database.archiveNote({ id: ID.b, updatedAtMs: 200 })
    database.softDeleteNote({ id: ID.b, updatedAtMs: 300 })
    database.restoreNote({ id: ID.b, updatedAtMs: 400 })

    // Restored from Trash it is ARCHIVED again, not active.
    expect(database.getActiveNote(ID.b)).toBeNull()
    expect(database.listActiveNotes()).toEqual([])

    database.unarchiveNote({ id: ID.b, updatedAtMs: 500 })
    expect(database.getActiveNote(ID.b)).toMatchObject({
      id: ID.b,
      updatedAtMs: 500,
      deletedAtMs: null,
      archivedAtMs: null,
    })
  })

  test('fails closed for archive and unarchive on invalid Note lifecycle targets', async () => {
    const { database } = await openTaskDatabase()
    expect(
      captureCode(() => database.archiveNote({ id: ID.missing, updatedAtMs: 1 })),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() =>
        database.unarchiveNote({ id: ID.missing, updatedAtMs: 1 }),
      ),
    ).toBe('NOT_FOUND')

    database.createNote({ id: ID.b, title: 'N', content: 'C', createdAtMs: 100 })
    expect(
      captureCode(() => database.unarchiveNote({ id: ID.b, updatedAtMs: 2 })),
    ).toBe('NOT_FOUND')
    database.archiveNote({ id: ID.b, updatedAtMs: 200 })
    expect(
      captureCode(() => database.archiveNote({ id: ID.b, updatedAtMs: 300 })),
    ).toBe('NOT_FOUND')

    database.softDeleteNote({ id: ID.b, updatedAtMs: 400 })
    expect(
      captureCode(() => database.archiveNote({ id: ID.b, updatedAtMs: 500 })),
    ).toBe('NOT_FOUND')
    expect(
      captureCode(() => database.unarchiveNote({ id: ID.b, updatedAtMs: 500 })),
    ).toBe('NOT_FOUND')
  })

  test('rejects an invalid archive timestamp before touching the database', async () => {
    const { database } = await openTaskDatabase()
    database.createNote({ id: ID.b, title: 'N', content: 'C', createdAtMs: 100 })
    expect(
      captureCode(() => database.archiveNote({ id: ID.b, updatedAtMs: -1 })),
    ).toBe('PERSISTENCE_FAILED')
    expect(
      captureCode(() => database.unarchiveNote({ id: ID.b, updatedAtMs: -1 })),
    ).toBe('PERSISTENCE_FAILED')
    expect(database.listActiveNotes()).toHaveLength(1)
  })
})
