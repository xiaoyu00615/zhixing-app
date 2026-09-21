import { describe, expect, test } from 'vitest'

import { SearchRepositoryError, type SearchResult } from '@/search/model'
import {
  SearchWorkerClientError,
  type TaskWorkerClient,
} from '@/adapters/web/taskWorkerClient'
import { WebSearchRepository } from '@/adapters/web/WebSearchRepository'

const VALID_DTO: SearchResult = {
  entityType: 'note',
  entityId: 'n1',
  title: 'Planning',
  snippet: 'project planning for q3',
  updatedAtMs: 100,
}

class FakeClient {
  lastInput: { query: string; limit: number } | null = null
  result: unknown = []
  rejectWith: Error | null = null

  searchQuery(input: { query: string; limit: number }): Promise<unknown> {
    this.lastInput = input
    if (this.rejectWith !== null) {
      return Promise.reject(this.rejectWith)
    }
    return Promise.resolve(this.result)
  }
}

function repoWith(client: FakeClient): WebSearchRepository {
  return new WebSearchRepository(client as unknown as TaskWorkerClient)
}

describe('WebSearchRepository.query validation and mapping', () => {
  test('maps a valid client array result into SearchResult[]', async () => {
    const client = new FakeClient()
    client.result = [VALID_DTO, { ...VALID_DTO, entityId: 'n2' }]
    const repo = repoWith(client)

    const results = await repo.query({ query: 'planning', limit: 10 })
    expect(results).toHaveLength(2)
    expect(results[0]?.entityId).toBe('n1')
    expect(results[1]?.entityId).toBe('n2')
  })

  test('omitted limit defaults to 50', async () => {
    const client = new FakeClient()
    client.result = []
    const repo = repoWith(client)

    await repo.query({ query: 'planning' })
    expect(client.lastInput).toEqual({ query: 'planning', limit: 50 })
  })

  test('non-string query throws INVALID_QUERY', async () => {
    const client = new FakeClient()
    const repo = repoWith(client)
    await expect(
      repo.query({ query: 5 as unknown as string, limit: 50 }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' })
  })

  test('more than 16 terms throws INVALID_QUERY', async () => {
    const client = new FakeClient()
    const repo = repoWith(client)
    await expect(
      repo.query({ query: Array.from({ length: 17 }, (_, i) => `t${i}`).join(' ') }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' })
    expect(client.lastInput).toBeNull()
  })

  test('out-of-range limit throws INVALID_QUERY', async () => {
    const client = new FakeClient()
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 0 })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    })
    await expect(repo.query({ query: 'x', limit: 201 })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    })
  })

  test('non-array client result throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = { not: 'an array' }
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('client INVALID_QUERY maps to repository INVALID_QUERY', async () => {
    const client = new FakeClient()
    client.rejectWith = new SearchWorkerClientError('INVALID_QUERY')
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    })
  })

  test('client PERSISTENCE_ERROR maps to repository PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.rejectWith = new SearchWorkerClientError('PERSISTENCE_ERROR')
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('unexpected client error maps to PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.rejectWith = new Error('boom')
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('a result row with a disallowed entityType throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = [{ ...VALID_DTO, entityType: 'ghost' }]
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('a result row with non-string fields throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = [{ ...VALID_DTO, title: 123 }]
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('a result row with negative updatedAtMs throws PERSISTENCE_ERROR', async () => {
    const client = new FakeClient()
    client.result = [{ ...VALID_DTO, updatedAtMs: -1 }]
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('SearchRepositoryError thrown by the client is propagated unchanged', async () => {
    const client = new FakeClient()
    const original = new SearchRepositoryError('INVALID_QUERY', 'query')
    client.rejectWith = original
    const repo = repoWith(client)
    await expect(repo.query({ query: 'x', limit: 50 })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    })
  })
})
