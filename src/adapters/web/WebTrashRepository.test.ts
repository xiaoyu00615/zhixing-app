import { describe, expect, test } from 'vitest'

import { TrashRepositoryError, type TrashItem } from '@/trash/model'
import {
  TrashWorkerClientError,
  type TaskWorkerClient,
} from '@/adapters/web/taskWorkerClient'
import { WebTrashRepository } from '@/adapters/web/WebTrashRepository'

const VALID_DTO: TrashItem = {
  entityType: 'note',
  entityId: 'n1',
  title: 'Planning',
  deletedAtMs: 100,
}

class FakeClient {
  result: unknown = []
  rejectWith: Error | null = null

  listTrash(): Promise<unknown> {
    if (this.rejectWith !== null) {
      return Promise.reject(this.rejectWith)
    }
    return Promise.resolve(this.result)
  }
}

function repoWith(client: FakeClient): WebTrashRepository {
  return new WebTrashRepository(client as unknown as TaskWorkerClient)
}

describe('WebTrashRepository.list validation and mapping', () => {
  test('maps a valid client array result into TrashItem[]', async () => {
    const client = new FakeClient()
    client.result = [
      VALID_DTO,
      { ...VALID_DTO, entityId: 'n2', entityType: 'task' as const },
    ]
    const repo = repoWith(client)

    const items = await repo.list()
    expect(items).toHaveLength(2)
    expect(items[0]?.entityId).toBe('n1')
    expect(items[1]?.entityId).toBe('n2')
    expect(items[1]?.entityType).toBe('task')
  })

  test('empty client result maps to an empty array', async () => {
    const client = new FakeClient()
    client.result = []
    const repo = repoWith(client)
    expect(await repo.list()).toEqual([])
  })

  test('non-array client result throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = { not: 'an array' }
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' })
  })

  test('client PERSISTENCE_ERROR maps to repository PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.rejectWith = new TrashWorkerClientError('PERSISTENCE_ERROR')
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' })
  })

  test('unexpected client error maps to PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.rejectWith = new Error('boom')
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' })
  })

  test('a result row with a disallowed entityType throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = [{ ...VALID_DTO, entityType: 'ghost' as unknown as TrashItem['entityType'] }]
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' })
  })

  test('a result row with non-string fields throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = [{ ...VALID_DTO, title: 123 }]
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' })
  })

  test('a result row with negative deletedAtMs throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = [{ ...VALID_DTO, deletedAtMs: -1 }]
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR' })
  })

  test('TrashRepositoryError thrown by the client is propagated unchanged', async () => {
    const client = new FakeClient()
    const original = new TrashRepositoryError('PERSISTENCE_ERROR', 'list')
    client.rejectWith = original
    const repo = repoWith(client)
    await expect(repo.list()).rejects.toBe(original)
  })
})
