import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeSearchRepository } from '@/adapters/native/NativeSearchRepository'
import { SearchRepositoryError } from '@/search/model'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const ENTITY_ID = '12345678-1234-4321-8000-0123456789ab'

const RESULT = {
  entityType: 'note',
  entityId: ENTITY_ID,
  title: 'Title',
  snippet: '...matched text...',
  updatedAtMs: 100,
} as const

function createRepo(): NativeSearchRepository {
  return new NativeSearchRepository()
}

describe('NativeSearchRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('sends search_query with query and resolved limit', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([RESULT])

    const results = await repository.query({ query: 'planning apple', limit: 20 })

    expect(invokeMock).toHaveBeenCalledTimes(1)
    expect(invokeMock.mock.calls[0]!).toEqual([
      'search_query',
      { query: 'planning apple', limit: 20 },
    ])
    expect(results).toHaveLength(1)
    expect(results[0]!.entityId).toBe(ENTITY_ID)
  })

  test('defaults limit to 50 when omitted', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([])

    await repository.query({ query: 'hello' })

    expect(invokeMock.mock.calls[0]!).toEqual([
      'search_query',
      { query: 'hello', limit: 50 },
    ])
  })

  test('returns parsed results from the native layer', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([RESULT, { ...RESULT, entityId: 'other' }])

    const results = await repository.query({ query: 'x' })
    expect(results).toEqual([
      {
        entityType: 'note',
        entityId: ENTITY_ID,
        title: 'Title',
        snippet: '...matched text...',
        updatedAtMs: 100,
      },
      {
        entityType: 'note',
        entityId: 'other',
        title: 'Title',
        snippet: '...matched text...',
        updatedAtMs: 100,
      },
    ])
  })

  test('rejects more than 16 terms before invoking', async () => {
    const repository = createRepo()
    const tooMany = Array.from({ length: 17 }, (_, i) => `t${i}`).join(' ')

    await expect(repository.query({ query: tooMany })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      operation: 'query',
    })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('rejects out-of-range and non-integer limits before invoking', async () => {
    const repository = createRepo()

    await expect(repository.query({ query: 'x', limit: 0 })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    })
    await expect(repository.query({ query: 'x', limit: 201 })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
    })
    await expect(
      repository.query({ query: 'x', limit: 1.5 }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' })
    await expect(
      repository.query({ query: 'x', limit: -3 }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY' })

    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('rejects non-string query before invoking', async () => {
    const repository = createRepo()
    await expect(
      repository.query({ query: 42 as never }),
    ).rejects.toMatchObject({ code: 'INVALID_QUERY', operation: 'query' })
    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('maps INVALID_QUERY from the structured native error', async () => {
    const repository = createRepo()
    invokeMock.mockRejectedValueOnce({ code: 'INVALID_QUERY' })

    await expect(repository.query({ query: 'x' })).rejects.toMatchObject({
      code: 'INVALID_QUERY',
      operation: 'query',
    })
  })

  test('contains unknown invoke failures as PERSISTENCE_ERROR', async () => {
    const repository = createRepo()
    invokeMock
      .mockRejectedValueOnce(new Error('raw failure'))
      .mockRejectedValueOnce({ code: 'SQLITE_CONSTRAINT' })

    await expect(repository.query({ query: 'x' })).rejects.toBeInstanceOf(
      SearchRepositoryError,
    )
    await expect(repository.query({ query: 'x' })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })

  test('rejects malformed result rows returned by the native layer', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce([{ ...RESULT, updatedAtMs: -1 }])
      .mockResolvedValueOnce([{ ...RESULT, entityType: 'ghost' }])
      .mockResolvedValueOnce('not an array')

    await expect(repository.query({ query: 'x' })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
    await expect(repository.query({ query: 'x' })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
    await expect(repository.query({ query: 'x' })).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
    })
  })
})
