import { describe, expect, test, vi } from 'vitest'
import {
  DEFAULT_SEARCH_LIMIT,
  SearchRepositoryError,
  type SearchQuery,
  type SearchResult,
} from '@/search/model'
import type { SearchRepository } from '@/search/repository'
import { createSearchService, SearchApplicationError } from '@/search/service'

const RESULT: SearchResult = {
  entityType: 'task',
  entityId: '8d0b0b0e-0f1a-4c2b-9a3f-1c2d3e4f5a6b',
  title: '任务标题',
  snippet: '摘要内容',
  updatedAtMs: 1_700_000_000_000,
}

function createFakeRepository(handle: () => Promise<SearchResult[]>) {
  const inputs: SearchQuery[] = []
  const query = vi.fn((input: SearchQuery): Promise<SearchResult[]> => {
    inputs.push(input)
    return handle()
  })
  const repository: SearchRepository = { query }
  return { repository, query, inputs }
}

describe('createSearchService', () => {
  test('returns an empty list for an empty query without calling the repository', async () => {
    const { repository, query } = createFakeRepository(() =>
      Promise.resolve([RESULT]),
    )
    const service = createSearchService({ repository })

    await expect(service.search('')).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  test('returns an empty list for a whitespace-only query without calling the repository', async () => {
    const { repository, query } = createFakeRepository(() =>
      Promise.resolve([RESULT]),
    )
    const service = createSearchService({ repository })

    await expect(service.search('   \t\n  ')).resolves.toEqual([])
    expect(query).not.toHaveBeenCalled()
  })

  test('trims the public query before delegating to the repository', async () => {
    const { repository, inputs } = createFakeRepository(() =>
      Promise.resolve([]),
    )
    const service = createSearchService({ repository })

    await service.search('  任务  ')

    expect(inputs).toEqual([{ query: '任务', limit: DEFAULT_SEARCH_LIMIT }])
  })

  test('delegates a normal query and returns the results', async () => {
    const { repository, inputs } = createFakeRepository(() =>
      Promise.resolve([RESULT]),
    )
    const service = createSearchService({ repository })

    await expect(service.search('任务')).resolves.toEqual([RESULT])
    expect(inputs).toHaveLength(1)
  })

  test('uses the committed default result limit', async () => {
    const { repository, inputs } = createFakeRepository(() =>
      Promise.resolve([]),
    )
    const service = createSearchService({ repository })

    await service.search('任务')

    expect(inputs[0]?.limit).toBe(DEFAULT_SEARCH_LIMIT)
    expect(DEFAULT_SEARCH_LIMIT).toBe(50)
  })

  test('treats a successful zero-result query as a normal empty list', async () => {
    const { repository } = createFakeRepository(() => Promise.resolve([]))
    const service = createSearchService({ repository })

    await expect(service.search('不存在')).resolves.toEqual([])
  })

  test('maps INVALID_QUERY to VALIDATION', async () => {
    const { repository } = createFakeRepository(() =>
      Promise.reject(new SearchRepositoryError('INVALID_QUERY', 'query')),
    )
    const service = createSearchService({ repository })

    await expect(service.search('任务')).rejects.toBeInstanceOf(
      SearchApplicationError,
    )
    await expect(service.search('任务')).rejects.toMatchObject({
      code: 'VALIDATION',
    })
  })

  test('maps PERSISTENCE_ERROR to UNAVAILABLE', async () => {
    const { repository } = createFakeRepository(() =>
      Promise.reject(new SearchRepositoryError('PERSISTENCE_ERROR', 'query')),
    )
    const service = createSearchService({ repository })

    await expect(service.search('任务')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  test('maps unexpected failures to UNAVAILABLE', async () => {
    const { repository } = createFakeRepository(() =>
      Promise.reject(new Error('sqlite failure')),
    )
    const service = createSearchService({ repository })

    await expect(service.search('任务')).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  test('rejects a non-string query as VALIDATION without calling the repository', async () => {
    const { repository, query } = createFakeRepository(() =>
      Promise.resolve([RESULT]),
    )
    const service = createSearchService({ repository })

    await expect(
      (service.search as (value: unknown) => Promise<SearchResult[]>)(42),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    expect(query).not.toHaveBeenCalled()
  })
})
