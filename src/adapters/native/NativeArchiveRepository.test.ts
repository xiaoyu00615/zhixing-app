import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeArchiveRepository } from '@/adapters/native/NativeArchiveRepository'
import { ArchiveRepositoryError } from '@/archive/model'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const ENTITY_ID = '12345678-1234-4321-8000-0123456789ab'

const TASK_ITEM = {
  entityType: 'task',
  entityId: ENTITY_ID,
  title: 'Task title',
  archivedAtMs: 100,
} as const

const NOTE_ITEM = {
  entityType: 'note',
  entityId: 'other',
  title: 'Note title',
  archivedAtMs: 200,
} as const

function createRepo(): NativeArchiveRepository {
  return new NativeArchiveRepository()
}

describe('NativeArchiveRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('sends archive_list and returns parsed items', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([TASK_ITEM])

    const items = await repository.list()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0]!).toEqual(['archive_list'])
    expect(items).toHaveLength(1)
    expect(items[0]!.entityId).toBe(ENTITY_ID)
  })

  test('returns both a valid task item and a valid note item', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([TASK_ITEM, NOTE_ITEM])

    const items = await repository.list()
    expect(items).toEqual([
      {
        entityType: 'task',
        entityId: ENTITY_ID,
        title: 'Task title',
        archivedAtMs: 100,
      },
      {
        entityType: 'note',
        entityId: 'other',
        title: 'Note title',
        archivedAtMs: 200,
      },
    ])
  })

  test('returns an empty array when the native layer returns none', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([])

    const items = await repository.list()
    expect(items).toEqual([])
  })

  test('maps a structured PERSISTENCE_ERROR from the native layer', async () => {
    const repository = createRepo()
    invokeMock.mockRejectedValueOnce({ code: 'PERSISTENCE_ERROR' })

    await expect(repository.list()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'list',
    })
  })

  test('contains unknown invoke failures as PERSISTENCE_ERROR', async () => {
    const repository = createRepo()
    invokeMock
      .mockRejectedValueOnce(new Error('raw failure'))
      .mockRejectedValueOnce({ code: 'SQLITE_CONSTRAINT' })

    await expect(repository.list()).rejects.toBeInstanceOf(
      ArchiveRepositoryError,
    )
    await expect(repository.list()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('rejects malformed result rows returned by the native layer', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce([{ ...TASK_ITEM, archivedAtMs: -1 }])
      .mockResolvedValueOnce([{ ...TASK_ITEM, archivedAtMs: 1.5 }])
      .mockResolvedValueOnce([{ ...TASK_ITEM, entityType: 'ghost' }])
      .mockResolvedValueOnce([{ ...TASK_ITEM, entityType: 'diary' }])
      .mockResolvedValueOnce([{ ...TASK_ITEM, title: 42 }])
      .mockResolvedValueOnce('not an array')

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await expect(repository.list()).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
      })
    }
  })
})
