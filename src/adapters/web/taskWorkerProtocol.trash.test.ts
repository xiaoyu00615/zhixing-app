import { describe, expect, test } from 'vitest'

import {
  parseTaskWorkerRequest,
  parseTrashWorkerResponse,
} from '@/adapters/web/taskWorkerProtocol'

describe('taskWorkerProtocol trash.list parsing', () => {
  test('parses a well-formed trash.list request', () => {
    const parsed = parseTaskWorkerRequest({ requestId: 1, type: 'trash.list' })
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ requestId: 1, type: 'trash.list' })
  })

  test('rejects a trash.list request without a requestId', () => {
    expect(parseTaskWorkerRequest({ type: 'trash.list' })).toBeNull()
  })

  test('parses an ok trash response with a result array', () => {
    const result = [{ entityType: 'note', entityId: 'n1', title: 't', deletedAtMs: 1 }]
    const parsed = parseTrashWorkerResponse({ requestId: 1, ok: true, result })
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({ requestId: 1, ok: true, result })
  })

  test('parses a failed trash response with a trash error code', () => {
    const parsed = parseTrashWorkerResponse({
      requestId: 2,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
    expect(parsed).not.toBeNull()
    expect(parsed).toMatchObject({
      requestId: 2,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
  })

  test('rejects a failed response whose code is not a trash code', () => {
    expect(
      parseTrashWorkerResponse({ requestId: 3, ok: false, error: { code: 'NOT_FOUND' } }),
    ).toBeNull()
  })

  test('rejects a malformed trash response envelope', () => {
    expect(parseTrashWorkerResponse({ requestId: 4, ok: true })).toBeNull()
    expect(parseTrashWorkerResponse({ type: 'trash.list' })).toBeNull()
  })
})
