import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeNoteRepository } from '@/adapters/native/noteRepository'
import { NoteRepositoryError } from '@/note/repository'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const ID = '12345678-1234-4321-8000-0123456789ab'

const NOTE = {
  id: ID,
  title: 'Note',
  content: 'body',
  createdAtMs: 100,
  updatedAtMs: 200,
  deletedAtMs: null,
} as const

function createRepo(): NativeNoteRepository {
  return new NativeNoteRepository()
}

describe('NativeNoteRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('uses capability-specific commands and camelCase DTOs without extra fields', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce(NOTE)
      .mockResolvedValueOnce(NOTE)
      .mockResolvedValueOnce([NOTE])
      .mockResolvedValueOnce({ ...NOTE, title: 'Updated', updatedAtMs: 300 })

    await repository.create({
      id: ID,
      title: 'Note',
      content: 'body',
      createdAtMs: 100,
    })
    await repository.getActiveById(ID)
    await repository.listActive()
    await repository.updateNote({
      id: ID,
      title: 'Updated',
      content: 'body',
      updatedAtMs: 300,
    })

    expect(invokeMock.mock.calls).toEqual([
      [
        'note_create',
        { input: { id: ID, title: 'Note', content: 'body', createdAtMs: 100 } },
      ],
      ['note_get_active_by_id', { id: ID }],
      ['note_list_active', undefined],
      [
        'note_update',
        {
          input: { id: ID, title: 'Updated', content: 'body', updatedAtMs: 300 },
        },
      ],
    ])
  })

  test('softDelete sends only id and updatedAtMs to note_soft_delete', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce(undefined)

    await repository.softDelete({ id: ID, updatedAtMs: 300 })

    expect(invokeMock.mock.calls).toEqual([
      ['note_soft_delete', { input: { id: ID, updatedAtMs: 300 } }],
    ])
  })

  test('restore sends only id and updatedAtMs to note_restore', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce(undefined)

    await repository.restore({ id: ID, updatedAtMs: 400 })

    expect(invokeMock.mock.calls).toEqual([
      ['note_restore', { input: { id: ID, updatedAtMs: 400 } }],
    ])
  })

  test('accepts empty title and forwards it unchanged', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce({ ...NOTE, title: '', content: '' })

    const created = await repository.create({
      id: ID,
      title: '',
      content: '',
      createdAtMs: 100,
    })

    expect(created.title).toBe('')
    expect(created.content).toBe('')
    expect(invokeMock.mock.calls[0]).toEqual([
      'note_create',
      { input: { id: ID, title: '', content: '', createdAtMs: 100 } },
    ])
  })

  test('accepts whitespace title and forwards it unchanged', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce({ ...NOTE, title: '   ' })

    await repository.create({
      id: ID,
      title: '   ',
      content: '   ',
      createdAtMs: 100,
    })

    expect(invokeMock.mock.calls[0]).toEqual([
      'note_create',
      { input: { id: ID, title: '   ', content: '   ', createdAtMs: 100 } },
    ])
  })

  test('preserves raw content exactly: spaces, newlines, code fence, Unicode', async () => {
    const repository = createRepo()
    const content = [
      '  leading',
      '',
      '',
      '```ts',
      '  const x = "你好 · 世界 —  \t"',
      '```',
      '   trailing  ',
    ].join('\n')
    invokeMock.mockResolvedValueOnce({ ...NOTE, content })

    const created = await repository.create({
      id: ID,
      title: 'Rich',
      content,
      createdAtMs: 100,
    })

    expect(created.content).toBe(content)
    expect(invokeMock.mock.calls[0]).toEqual([
      'note_create',
      { input: { id: ID, title: 'Rich', content, createdAtMs: 100 } },
    ])
  })

  test('rejects uppercase and malformed ids before invoking', async () => {
    const repository = createRepo()

    await expect(
      repository.create({
        id: '12345678-1234-4321-8000-0123456789AB',
        title: 'Note',
        content: 'body',
        createdAtMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ID', operation: 'create' })

    await expect(
      repository.getActiveById('not-a-uuid'),
    ).rejects.toMatchObject({ code: 'INVALID_ID', operation: 'getActiveById' })

    await expect(
      repository.updateNote({
        id: '12-34-56',
        title: 'Note',
        content: 'body',
        updatedAtMs: 200,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_ID', operation: 'updateNote' })

    await expect(
      repository.softDelete({ id: '12345678-1234-4321-8000-0123456789AB', updatedAtMs: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ID', operation: 'softDelete' })

    await expect(
      repository.restore({ id: 'not-a-uuid', updatedAtMs: 1 }),
    ).rejects.toMatchObject({ code: 'INVALID_ID', operation: 'restore' })

    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('rejects negative, fractional, and unsafe timestamps before invoking', async () => {
    const repository = createRepo()
    const unsafe = Number.MAX_SAFE_INTEGER + 1

    await expect(
      repository.create({ id: ID, title: 'Note', content: 'body', createdAtMs: -1 }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'create' })

    await expect(
      repository.create({ id: ID, title: 'Note', content: 'body', createdAtMs: 1.5 }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'create' })

    await expect(
      repository.create({ id: ID, title: 'Note', content: 'body', createdAtMs: unsafe }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'create' })

    await expect(
      repository.updateNote({ id: ID, title: 't', content: 'c', updatedAtMs: -1 }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'updateNote' })

    await expect(
      repository.softDelete({ id: ID, updatedAtMs: 1.25 }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'softDelete' })

    await expect(
      repository.restore({ id: ID, updatedAtMs: unsafe }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'restore' })

    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('getActiveById returns null on null without mapping to NOT_FOUND', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce(null)

    await expect(repository.getActiveById(ID)).resolves.toBeNull()
  })

  test('listActive preserves native ordering and rejects non-array payloads', async () => {
    const repository = createRepo()
    const first = { ...NOTE, id: '00000000-0000-0000-0000-000000000002' }
    const second = { ...NOTE, id: '00000000-0000-0000-0000-000000000001' }
    invokeMock
      .mockResolvedValueOnce([first, second])
      .mockResolvedValueOnce({ not: 'an array' })

    await expect(repository.listActive()).resolves.toEqual([first, second])
    await expect(repository.listActive()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'listActive',
    })
  })

  test('listActive rejects malformed member without leaking raw values', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce([{ id: 'not-a-uuid', title: 'x' }])

    await expect(repository.listActive()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'listActive',
    })
  })

  test('strictly parses Note DTOs and rejects malformed transport objects', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce(NOTE)
      .mockResolvedValueOnce({ ...NOTE, id: '12345678-1234-4321-8000-0123456789AB' })
      .mockResolvedValueOnce({ ...NOTE, title: 42 })
      .mockResolvedValueOnce({ ...NOTE, createdAtMs: -1 })
      .mockResolvedValueOnce({ ...NOTE, updatedAtMs: 1.5 })
      .mockResolvedValueOnce({ ...NOTE, deletedAtMs: -1 })
      .mockResolvedValueOnce({ ...NOTE, deletedAtMs: '0' })
      .mockResolvedValueOnce(null)

    await expect(
      repository.create({ id: ID, title: 'Note', content: 'body', createdAtMs: 100 }),
    ).resolves.toEqual(NOTE)

    for (let index = 0; index < 6; index += 1) {
      await expect(repository.getActiveById(ID)).rejects.toMatchObject({
        code: 'PERSISTENCE_ERROR',
        operation: 'getActiveById',
      })
    }

    await expect(repository.getActiveById(ID)).resolves.toBeNull()
  })

  test('maps known safe native domain errors without exposing internals', async () => {
    const repository = createRepo()
    invokeMock.mockRejectedValue({
      code: 'NOT_FOUND',
      message: 'C:\\secret\\zhixing.db SQL=UPDATE notes SET title=?',
    })

    const promise = repository.updateNote({
      id: ID,
      title: 'Renamed',
      content: 'body',
      updatedAtMs: 200,
    })
    await expect(promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Note not found.',
      operation: 'updateNote',
    })
    await expect(promise).rejects.not.toThrow(/secret|zhixing\.db|UPDATE notes/)
  })

  test('maps unknown native rejections to a safe PERSISTENCE_ERROR', async () => {
    const repository = createRepo()
    invokeMock.mockRejectedValue(
      new Error('token=secret SQL=SELECT * FROM notes WHERE id = ?'),
    )

    const promise = repository.listActive()
    await expect(promise).rejects.toEqual(
      new NoteRepositoryError('PERSISTENCE_ERROR', 'listActive'),
    )
    await expect(promise).rejects.not.toThrow(/token|SELECT/)
  })

  test('rejects non-string title and content before invoking', async () => {
    const repository = createRepo()

    await expect(
      repository.create({
        id: ID,
        title: 42 as never,
        content: 'body',
        createdAtMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TITLE', operation: 'create' })

    await expect(
      repository.updateNote({
        id: ID,
        title: 'Note',
        content: null as never,
        updatedAtMs: 200,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TITLE', operation: 'updateNote' })

    expect(invokeMock).not.toHaveBeenCalled()
  })
})
