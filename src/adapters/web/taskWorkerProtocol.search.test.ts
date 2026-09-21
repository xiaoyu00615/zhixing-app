import { describe, expect, test } from 'vitest'

import {
  parseSearchWorkerResponse,
  parseTaskWorkerRequest,
} from '@/adapters/web/taskWorkerProtocol'

describe('taskWorkerProtocol search.query parsing', () => {
  test('parses a well-formed search.query request', () => {
    const parsed = parseTaskWorkerRequest({
      requestId: 1,
      type: 'search.query',
      input: { query: 'planning', limit: 50 },
    })
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      requestId: 1,
      type: 'search.query',
      input: { query: 'planning', limit: 50 },
    })
  })

  test('rejects search.query with a non-string query', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 2, type: 'search.query', input: { query: 5, limit: 50 } }),
    ).toBeNull()
  })

  test('rejects search.query with a non-integer limit', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 3, type: 'search.query', input: { query: 'x', limit: 1.5 } }),
    ).toBeNull()
    expect(
      parseTaskWorkerRequest({ requestId: 3, type: 'search.query', input: { query: 'x' } }),
    ).toBeNull()
  })

  test('rejects search.query with a non-record input', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 4, type: 'search.query', input: 'planning' }),
    ).toBeNull()
  })

  test('parses an ok search response with a result array', () => {
    const result = [{ entityType: 'note', entityId: 'n1', title: 't', snippet: 's', updatedAtMs: 1 }]
    const parsed = parseSearchWorkerResponse({
      requestId: 1,
      ok: true,
      result,
    })
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ requestId: 1, ok: true, result })
  })

  test('parses a failed search response with a search error code', () => {
    const parsed = parseSearchWorkerResponse({
      requestId: 2,
      ok: false,
      error: { code: 'INVALID_QUERY' },
    })
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ requestId: 2, ok: false, error: { code: 'INVALID_QUERY' } })
  })

  test('rejects a failed response whose code is not a search code', () => {
    expect(
      parseSearchWorkerResponse({ requestId: 3, ok: false, error: { code: 'NOT_FOUND' } }),
    ).toBeNull()
  })

  test('rejects a malformed search response envelope', () => {
    expect(parseSearchWorkerResponse({ requestId: 4, ok: true })).toBeNull()
    expect(parseSearchWorkerResponse({ type: 'search.query' })).toBeNull()
  })
})
