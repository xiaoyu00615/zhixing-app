import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeTrashRepository } from '@/adapters/native/NativeTrashRepository'
import { TrashRepositoryError } from '@/trash/model'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const ENTITY_ID = '12345678-1234-4321-8000-0123456789ab'

const ITEM = {
  entityType: 'note',
  entityId: ENTITY_ID,
  title: 'Title',
  deletedAtMs: 100,
} as const

function createRepo(): NativeTrashRepository {
  return new NativeTrashRepository()
}

describe('NativeTrashRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('sends trash_list and returns parsed items', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([ITEM])

    const items = await repository.list()

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0]!).toEqual(['trash_list'])
    expect(items).toHaveLength(1)
    expect(items[0]!.entityId).toBe(ENTITY_ID)
  })

  test('returns parsed results from the native layer', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([
      ITEM,
      { ...ITEM, entityId: 'other', entityType: 'task' },
    ])

    const items = await repository.list()
    expect(items).toEqual([
      {
        entityType: 'note',
        entityId: ENTITY_ID,
        title: 'Title',
        deletedAtMs: 100,
      },
      {
        entityType: 'task',
        entityId: 'other',
        title: 'Title',
        deletedAtMs: 100,
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

    await expect(repository.list()).rejects.toBeInstanceOf(TrashRepositoryError)
    await expect(repository.list()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('rejects malformed result rows returned by the native layer', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce([{ ...ITEM, deletedAtMs: -1 }])
      .mockResolvedValueOnce([{ ...ITEM, entityType: 'ghost' }])
      .mockResolvedValueOnce('not an array')

    await expect(repository.list()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
    await expect(repository.list()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
    await expect(repository.list()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })
})
