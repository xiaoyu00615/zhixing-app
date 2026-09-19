import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeDiaryRepository } from '@/adapters/native/NativeDiaryRepository'
import { DiaryRepositoryError } from '@/diary/repository'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const ID = '12345678-1234-4321-8000-0123456789ab'
const DIARY_DATE = '2026-09-18'

const ENTRY = {
  id: ID,
  title: 'Day',
  content: 'body',
  diaryDate: DIARY_DATE,
  createdAtMs: 100,
  updatedAtMs: 200,
  deletedAtMs: null,
} as const

function createRepo(): NativeDiaryRepository {
  return new NativeDiaryRepository()
}

describe('NativeDiaryRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('uses capability-specific commands and camelCase DTOs without extra fields', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce(ENTRY)
      .mockResolvedValueOnce(ENTRY)
      .mockResolvedValueOnce(ENTRY)
      .mockResolvedValueOnce([ENTRY])
      .mockResolvedValueOnce({ ...ENTRY, title: 'Updated', updatedAtMs: 300 })
      .mockResolvedValueOnce({ ...ENTRY, diaryDate: '2026-09-19' })

    await repository.create({
      id: ID,
      diaryDate: DIARY_DATE,
      title: 'Day',
      content: 'body',
      createdAtMs: 100,
    })
    await repository.getActiveById(ID)
    await repository.getActiveByDiaryDate(DIARY_DATE)
    await repository.listActive()
    await repository.updateDiaryEntry({
      id: ID,
      title: 'Updated',
      content: 'body',
      updatedAtMs: 300,
    })
    await repository.changeDiaryDate({
      id: ID,
      diaryDate: '2026-09-19',
      updatedAtMs: 400,
    })

    expect(invokeMock.mock.calls).toEqual([
      [
        'diary_create',
        {
          input: {
            id: ID,
            diaryDate: DIARY_DATE,
            title: 'Day',
            content: 'body',
            createdAtMs: 100,
          },
        },
      ],
      ['diary_get_active_by_id', { id: ID }],
      ['diary_get_active_by_diary_date', { diaryDate: DIARY_DATE }],
      ['diary_list_active', undefined],
      [
        'diary_update',
        {
          input: {
            id: ID,
            title: 'Updated',
            content: 'body',
            updatedAtMs: 300,
          },
        },
      ],
      [
        'diary_change_date',
        {
          input: { id: ID, diaryDate: '2026-09-19', updatedAtMs: 400 },
        },
      ],
    ])
  })

  test('softDelete and restore send only id and updatedAtMs', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce(undefined)

    await repository.softDelete({ id: ID, updatedAtMs: 300 })
    await repository.restore({ id: ID, updatedAtMs: 400 })

    expect(invokeMock.mock.calls).toEqual([
      ['diary_soft_delete', { input: { id: ID, updatedAtMs: 300 } }],
      ['diary_restore', { input: { id: ID, updatedAtMs: 400 } }],
    ])
  })

  test('read commands return null for missing active entries', async () => {
    const repository = createRepo()
    invokeMock.mockResolvedValueOnce(null).mockResolvedValueOnce(null)

    await expect(repository.getActiveById(ID)).resolves.toBeNull()
    await expect(repository.getActiveByDiaryDate(DIARY_DATE)).resolves.toBeNull()
  })

  test('maps DIARY_DATE_CONFLICT from the structured native error', async () => {
    const repository = createRepo()
    invokeMock.mockRejectedValueOnce({
      code: 'DIARY_DATE_CONFLICT',
      message: 'A diary entry already exists for this date.',
    })

    await expect(
      repository.create({
        id: ID,
        diaryDate: DIARY_DATE,
        title: 'Day',
        content: 'body',
        createdAtMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'DIARY_DATE_CONFLICT', operation: 'create' })
  })

  test('maps NOT_FOUND and INVALID_DIARY_DATE from the structured native error', async () => {
    const repository = createRepo()
    invokeMock
      .mockRejectedValueOnce({ code: 'NOT_FOUND' })
      .mockRejectedValueOnce({ code: 'INVALID_DIARY_DATE' })

    await expect(
      repository.changeDiaryDate({
        id: ID,
        diaryDate: DIARY_DATE,
        updatedAtMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'changeDiaryDate' })

    await expect(
      repository.changeDiaryDate({
        id: ID,
        diaryDate: DIARY_DATE,
        updatedAtMs: 100,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_DIARY_DATE',
      operation: 'changeDiaryDate',
    })
  })

  test('contains unknown invoke failures as PERSISTENCE_ERROR', async () => {
    const repository = createRepo()
    invokeMock
      .mockRejectedValueOnce(new Error('raw rusqlite failure'))
      .mockRejectedValueOnce({ code: 'SQLITE_CONSTRAINT_UNIQUE' })
      .mockRejectedValueOnce('boom')

    await expect(repository.getActiveById(ID)).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'getActiveById',
    })
    await expect(repository.listActive()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'listActive',
    })
    await expect(repository.getActiveById(ID)).rejects.toBeInstanceOf(
      DiaryRepositoryError,
    )
  })

  test('rejects invalid ids and diary dates before invoking', async () => {
    const repository = createRepo()

    await expect(
      repository.getActiveById('12345678-1234-4321-8000-0123456789AB'),
    ).rejects.toMatchObject({ code: 'INVALID_ID', operation: 'getActiveById' })
    await expect(repository.getActiveById('not-a-uuid')).rejects.toMatchObject({
      code: 'INVALID_ID',
    })
    await expect(
      repository.getActiveByDiaryDate('2026-02-30'),
    ).rejects.toMatchObject({
      code: 'INVALID_DIARY_DATE',
      operation: 'getActiveByDiaryDate',
    })
    await expect(
      repository.getActiveByDiaryDate('18-09-2026'),
    ).rejects.toMatchObject({ code: 'INVALID_DIARY_DATE' })

    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('rejects malformed records returned by the native layer', async () => {
    const repository = createRepo()
    invokeMock
      .mockResolvedValueOnce({ ...ENTRY, diaryDate: '2026-02-30' })
      .mockResolvedValueOnce([{ ...ENTRY, createdAtMs: -1 }])

    await expect(repository.getActiveById(ID)).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'getActiveById',
    })
    await expect(repository.listActive()).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'listActive',
    })
  })

  test('preserves exact text and empty fields through the native boundary', async () => {
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
    invokeMock.mockResolvedValueOnce({ ...ENTRY, title: '', content })

    const created = await repository.create({
      id: ID,
      diaryDate: DIARY_DATE,
      title: '',
      content,
      createdAtMs: 100,
    })

    expect(created.title).toBe('')
    expect(created.content).toBe(content)
    expect(invokeMock.mock.calls[0]).toEqual([
      'diary_create',
      { input: { id: ID, diaryDate: DIARY_DATE, title: '', content, createdAtMs: 100 } },
    ])
  })

  test('rejects non-string title and content before invoking', async () => {
    const repository = createRepo()

    await expect(
      repository.create({
        id: ID,
        diaryDate: DIARY_DATE,
        title: 42 as never,
        content: 'body',
        createdAtMs: 100,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TITLE', operation: 'create' })

    await expect(
      repository.updateDiaryEntry({
        id: ID,
        title: 'Day',
        content: null as never,
        updatedAtMs: 200,
      }),
    ).rejects.toMatchObject({
      code: 'INVALID_TITLE',
      operation: 'updateDiaryEntry',
    })

    expect(invokeMock).not.toHaveBeenCalled()
  })

  test('rejects negative, fractional, and unsafe timestamps before invoking', async () => {
    const repository = createRepo()
    const unsafe = Number.MAX_SAFE_INTEGER + 1

    await expect(
      repository.create({
        id: ID,
        diaryDate: DIARY_DATE,
        title: 'Day',
        content: 'body',
        createdAtMs: -1,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'create' })

    await expect(
      repository.create({
        id: ID,
        diaryDate: DIARY_DATE,
        title: 'Day',
        content: 'body',
        createdAtMs: 1.5,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'create' })

    await expect(
      repository.create({
        id: ID,
        diaryDate: DIARY_DATE,
        title: 'Day',
        content: 'body',
        createdAtMs: unsafe,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_ERROR', operation: 'create' })

    await expect(
      repository.updateDiaryEntry({
        id: ID,
        title: 'Day',
        content: 'body',
        updatedAtMs: -1,
      }),
    ).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'updateDiaryEntry',
    })

    await expect(
      repository.changeDiaryDate({
        id: ID,
        diaryDate: DIARY_DATE,
        updatedAtMs: unsafe,
      }),
    ).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'changeDiaryDate',
    })

    await expect(
      repository.softDelete({ id: ID, updatedAtMs: 1.25 }),
    ).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'softDelete',
    })

    await expect(
      repository.restore({ id: ID, updatedAtMs: unsafe }),
    ).rejects.toMatchObject({
      code: 'PERSISTENCE_ERROR',
      operation: 'restore',
    })

    expect(invokeMock).not.toHaveBeenCalled()
  })
})
