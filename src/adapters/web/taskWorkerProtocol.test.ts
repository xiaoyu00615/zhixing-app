import { describe, expect, test } from 'vitest'

import {
  parseArchiveWorkerResponse,
  parseMaintenanceLeaseId,
  parseNoteWorkerResponse,
  parseTaskWorkerRequest,
  parseTaskWorkerResponse,
} from '@/adapters/web/taskWorkerProtocol'

const NOTE_ID = '12345678-1234-4321-8000-0123456789ab'

const NOTE_CREATE_INPUT = {
  id: NOTE_ID,
  title: 'Note',
  content: 'body',
  createdAtMs: 100,
} as const

const NOTE_MUTATION_INPUT = {
  id: NOTE_ID,
  title: 'Note',
  content: 'body',
  updatedAtMs: 200,
} as const

describe('parseTaskWorkerResponse', () => {
  test('accepts valid Task error response with Task-only code', () => {
    const parsed = parseTaskWorkerResponse({
      requestId: 1,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    expect(parsed).not.toBeNull()
    if (parsed === null || parsed.ok) return
    expect(parsed.error.code).toBe('NOT_FOUND')
  })

  test('rejects Task response with Note-only error code', () => {
    expect(
      parseTaskWorkerResponse({
        requestId: 1,
        ok: false,
        error: { code: 'INVALID_TITLE' },
      }),
    ).toBeNull()
  })

  test('rejects Task response with malformed error shape', () => {
    expect(
      parseTaskWorkerResponse({
        requestId: 1,
        ok: false,
        error: null,
      }),
    ).toBeNull()
  })
})

describe('parseNoteWorkerResponse', () => {
  test('accepts valid Note error response with Note-only code', () => {
    const parsed = parseNoteWorkerResponse({
      requestId: 1,
      ok: false,
      error: { code: 'INVALID_TITLE' },
    })
    expect(parsed).not.toBeNull()
    if (parsed === null || parsed.ok) return
    expect(parsed.error.code).toBe('INVALID_TITLE')
  })

  test('rejects Note response with Task-only error code', () => {
    expect(
      parseNoteWorkerResponse({
        requestId: 1,
        ok: false,
        error: { code: 'STATUS_CONFLICT' },
      }),
    ).toBeNull()
  })

  test('rejects malformed Note payload', () => {
    expect(parseNoteWorkerResponse({ requestId: 1, ok: false })).toBeNull()
    expect(
      parseNoteWorkerResponse({
        requestId: -1,
        ok: false,
        error: { code: 'NOT_FOUND' },
      }),
    ).toBeNull()
    expect(
      parseNoteWorkerResponse({
        requestId: 1,
        ok: 'not-a-bool' as unknown as boolean,
        error: { code: 'NOT_FOUND' },
      }),
    ).toBeNull()
  })

  test('rejects malformed success envelope', () => {
    expect(parseNoteWorkerResponse({ requestId: 1, ok: true })).toBeNull()
  })
})

describe('maintenance control requests (P6-S4A1)', () => {
  test('parses maintenance.enter and maintenance.exit control requests', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'maintenance.enter' }),
    ).toEqual({ requestId: 1, type: 'maintenance.enter' })
    expect(
      parseTaskWorkerRequest({
        requestId: 2,
        type: 'maintenance.exit',
        leaseId: 'web-maint-1',
      }),
    ).toEqual({ requestId: 2, type: 'maintenance.exit', leaseId: 'web-maint-1' })
  })

  test('rejects maintenance control requests with a malformed requestId', () => {
    expect(parseTaskWorkerRequest({ requestId: 0, type: 'maintenance.enter' })).toBeNull()
    expect(
      parseTaskWorkerRequest({
        requestId: 0,
        type: 'maintenance.exit',
        leaseId: 'web-maint-1',
      }),
    ).toBeNull()
    expect(parseTaskWorkerRequest({ type: 'maintenance.exit', leaseId: 'x' })).toBeNull()
  })
})

describe('maintenance ownership (P6-S4A1R)', () => {
  test('maintenance.exit requires a lease id', () => {
    // Ownership is meaningless without an identity: a lease-less exit must never
    // be able to reach the worker's owner check.
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'maintenance.exit' }),
    ).toBeNull()
    expect(
      parseTaskWorkerRequest({
        requestId: 1,
        type: 'maintenance.exit',
        leaseId: 42,
      }),
    ).toBeNull()
  })

  test('parseMaintenanceLeaseId accepts only a real lease id', () => {
    expect(parseMaintenanceLeaseId({ leaseId: 'web-maint-1' })).toBe('web-maint-1')
    expect(parseMaintenanceLeaseId(null)).toBeNull()
    expect(parseMaintenanceLeaseId({})).toBeNull()
    expect(parseMaintenanceLeaseId({ leaseId: '' })).toBeNull()
    expect(parseMaintenanceLeaseId({ leaseId: 7 })).toBeNull()
  })
})

describe('parseTaskWorkerRequest', () => {
  test('accepts known note operations', () => {
    expect(
      parseTaskWorkerRequest({
        requestId: 1,
        type: 'note.create',
        input: NOTE_CREATE_INPUT,
      }),
    ).not.toBeNull()
    expect(
      parseTaskWorkerRequest({
        requestId: 2,
        type: 'note.getActiveById',
        id: NOTE_ID,
      }),
    ).not.toBeNull()
    expect(
      parseTaskWorkerRequest({ requestId: 3, type: 'note.listActive' }),
    ).not.toBeNull()
    expect(
      parseTaskWorkerRequest({
        requestId: 4,
        type: 'note.updateNote',
        input: NOTE_MUTATION_INPUT,
      }),
    ).not.toBeNull()
    expect(
      parseTaskWorkerRequest({
        requestId: 5,
        type: 'note.softDelete',
        input: { id: NOTE_ID, updatedAtMs: 200 },
      }),
    ).not.toBeNull()
    expect(
      parseTaskWorkerRequest({
        requestId: 6,
        type: 'note.restore',
        input: { id: NOTE_ID, updatedAtMs: 200 },
      }),
    ).not.toBeNull()
  })

  test('parses the Archive V1 task and note archive lifecycle requests', () => {
    expect(
      parseTaskWorkerRequest({
        requestId: 7,
        type: 'task.archive',
        input: { id: NOTE_ID, updatedAtMs: 200 },
      }),
    ).toEqual({
      requestId: 7,
      type: 'task.archive',
      input: { id: NOTE_ID, updatedAtMs: 200 },
    })
    expect(
      parseTaskWorkerRequest({
        requestId: 8,
        type: 'task.unarchive',
        input: { id: NOTE_ID, updatedAtMs: 300 },
      }),
    ).toEqual({
      requestId: 8,
      type: 'task.unarchive',
      input: { id: NOTE_ID, updatedAtMs: 300 },
    })
    expect(
      parseTaskWorkerRequest({
        requestId: 9,
        type: 'note.archive',
        input: { id: NOTE_ID, updatedAtMs: 200 },
      }),
    ).toEqual({
      requestId: 9,
      type: 'note.archive',
      input: { id: NOTE_ID, updatedAtMs: 200 },
    })
    expect(
      parseTaskWorkerRequest({
        requestId: 10,
        type: 'note.unarchive',
        input: { id: NOTE_ID, updatedAtMs: 300 },
      }),
    ).toEqual({
      requestId: 10,
      type: 'note.unarchive',
      input: { id: NOTE_ID, updatedAtMs: 300 },
    })
  })

  test('rejects malformed archive lifecycle payloads', () => {
    for (const type of [
      'task.archive',
      'task.unarchive',
      'note.archive',
      'note.unarchive',
    ]) {
      expect(
        parseTaskWorkerRequest({ requestId: 1, type, input: undefined }),
      ).toBeNull()
      expect(
        parseTaskWorkerRequest({
          requestId: 1,
          type,
          input: { id: 'not-a-uuid', updatedAtMs: 1 },
        }),
      ).toBeNull()
      expect(
        parseTaskWorkerRequest({
          requestId: 1,
          type,
          input: { id: NOTE_ID, updatedAtMs: -1 },
        }),
      ).toBeNull()
    }
  })

  test('rejects unknown request types without leaking domain errors', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'note.unknown' }),
    ).toBeNull()
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'task.unknown' }),
    ).toBeNull()
    expect(parseTaskWorkerRequest({ requestId: 1, type: undefined })).toBeNull()
  })

  test('rejects malformed note.create payload', () => {
    expect(
      parseTaskWorkerRequest({
        requestId: 1,
        type: 'note.create',
        input: { id: 'not-a-uuid', title: '', content: '', createdAtMs: -1 },
      }),
    ).toBeNull()
  })
})

describe('archive.list request and response (P5C S2)', () => {
  test('accepts the cross-domain archive.list read request', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'archive.list' }),
    ).toEqual({ requestId: 1, type: 'archive.list' })
  })

  test('archive.list is a distinct op from the canonical write ops', () => {
    // `archive.list` carries no input payload; the canonical writes stay on
    // `task.archive` / `note.archive` and require one.
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'archive.list' }),
    ).not.toBeNull()
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'task.archive' }),
    ).toBeNull()
    expect(
      parseTaskWorkerRequest({ requestId: 1, type: 'note.archive' }),
    ).toBeNull()
  })

  test('rejects malformed archive.list envelopes', () => {
    expect(
      parseTaskWorkerRequest({ requestId: 0, type: 'archive.list' }),
    ).toBeNull()
    expect(
      parseTaskWorkerRequest({ requestId: 'x', type: 'archive.list' }),
    ).toBeNull()
  })

  test('parses a successful archive.list response', () => {
    const parsed = parseArchiveWorkerResponse({
      requestId: 1,
      ok: true,
      result: [
        { entityType: 'task', entityId: NOTE_ID, title: 'T', archivedAtMs: 1 },
      ],
    })
    expect(parsed).not.toBeNull()
    if (parsed === null || !parsed.ok) return
    expect(parsed.result).toEqual([
      { entityType: 'task', entityId: NOTE_ID, title: 'T', archivedAtMs: 1 },
    ])
  })

  test('accepts an Archive PERSISTENCE_ERROR response', () => {
    const parsed = parseArchiveWorkerResponse({
      requestId: 1,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
    expect(parsed).not.toBeNull()
    if (parsed === null || parsed.ok) return
    expect(parsed.error.code).toBe('PERSISTENCE_ERROR')
  })

  test('rejects an Archive response carrying a foreign error code', () => {
    expect(
      parseArchiveWorkerResponse({
        requestId: 1,
        ok: false,
        error: { code: 'NOT_FOUND' },
      }),
    ).toBeNull()
  })

  test('rejects malformed Archive envelopes', () => {
    expect(parseArchiveWorkerResponse(null)).toBeNull()
    expect(parseArchiveWorkerResponse({ requestId: 1, ok: true })).toBeNull()
    expect(
      parseArchiveWorkerResponse({ requestId: 0, ok: true, result: [] }),
    ).toBeNull()
    expect(
      parseArchiveWorkerResponse({
        requestId: 1,
        ok: false,
        error: { code: 'PERSISTENCE_ERROR', message: 'leaked' },
      }),
    ).not.toBeNull()
  })
})
