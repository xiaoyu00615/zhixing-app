import { describe, expect, test, vi } from 'vitest'

import type { DiaryEntry } from '@/diary/model'
import {
  DiaryRepositoryError,
  type ChangeDiaryDateInput,
  type CreateDiaryEntryInput,
  type DiaryRepository,
  type DiaryRepositoryErrorCode,
  type RestoreDiaryEntryInput,
  type SoftDeleteDiaryEntryInput,
  type UpdateDiaryEntryInput,
} from '@/diary/repository'
import {
  createDiaryService,
  DIARY_APPLICATION_ERROR_CODES,
  DiaryApplicationError,
  type DiaryApplicationErrorCode,
  type DiaryApplicationErrorField,
} from '@/diary/service'

const ID = '00000000-0000-4000-8000-000000000001'
const UPPERCASE_ID = '00000000-0000-4000-8000-00000000000A'
const TODAY = '2026-09-14'
const DIARY: DiaryEntry = {
  id: ID,
  diaryDate: TODAY,
  title: 'Diary',
  content: 'Content',
  createdAtMs: 100,
  updatedAtMs: 100,
  deletedAtMs: null,
}

function createFakeRepository() {
  const create = vi.fn((input: CreateDiaryEntryInput): Promise<DiaryEntry> =>
    Promise.resolve({
      id: input.id,
      diaryDate: input.diaryDate,
      title: input.title,
      content: input.content,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      deletedAtMs: null,
    }),
  )
  const getActiveById = vi.fn((id: string): Promise<DiaryEntry | null> =>
    Promise.resolve({ ...DIARY, id }),
  )
  const getActiveByDiaryDate = vi.fn(
    (diaryDate: string): Promise<DiaryEntry | null> =>
      Promise.resolve({ ...DIARY, diaryDate }),
  )
  const listActive = vi.fn((): Promise<DiaryEntry[]> => Promise.resolve([DIARY]))
  const updateDiaryEntry = vi.fn((input: UpdateDiaryEntryInput): Promise<DiaryEntry> =>
    Promise.resolve({
      ...DIARY,
      id: input.id,
      title: input.title,
      content: input.content,
      updatedAtMs: input.updatedAtMs,
    }),
  )
  const changeDiaryDate = vi.fn((input: ChangeDiaryDateInput): Promise<DiaryEntry> =>
    Promise.resolve({
      ...DIARY,
      id: input.id,
      diaryDate: input.diaryDate,
      updatedAtMs: input.updatedAtMs,
    }),
  )
  const softDelete = vi.fn((input: SoftDeleteDiaryEntryInput): Promise<void> => {
    void input
    return Promise.resolve()
  })
  const restore = vi.fn((input: RestoreDiaryEntryInput): Promise<void> => {
    void input
    return Promise.resolve()
  })
  const repository: DiaryRepository = {
    create,
    getActiveById,
    getActiveByDiaryDate,
    listActive,
    updateDiaryEntry,
    changeDiaryDate,
    softDelete,
    restore,
  }

  return {
    repository,
    create,
    getActiveById,
    getActiveByDiaryDate,
    listActive,
    updateDiaryEntry,
    changeDiaryDate,
    softDelete,
    restore,
  }
}

async function expectApplicationError(
  promise: Promise<unknown>,
  code: DiaryApplicationErrorCode,
  field?: DiaryApplicationErrorField,
): Promise<void> {
  const error = await promise.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(DiaryApplicationError)
  expect(error).toMatchObject({ code, field })
  expect((error as Error).message).not.toMatch(
    /SQL|sqlite|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
  )
}

test('DiaryService exposes only the approved business API and error codes', () => {
  const fake = createFakeRepository()
  const service = createDiaryService({ repository: fake.repository })

  expect(Object.keys(service)).toEqual([
    'createDiaryEntry',
    'getActiveById',
    'getActiveByDiaryDate',
    'listActive',
    'updateDiaryEntry',
    'changeDiaryDate',
    'softDelete',
    'restore',
  ])
  expect(DIARY_APPLICATION_ERROR_CODES).toEqual([
    'VALIDATION',
    'NOT_FOUND',
    'CONFLICT',
    'UNAVAILABLE',
  ])
})

describe('DiaryService createDiaryEntry', () => {
  test('owns UUID generation, today, and creation time', async () => {
    const fake = createFakeRepository()
    const generateDiaryId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId,
      nowMs,
      today,
    })

    await expect(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
    ).resolves.toEqual({
      id: ID,
      diaryDate: TODAY,
      title: 'Draft',
      content: 'Body',
      createdAtMs: 100,
      updatedAtMs: 100,
      deletedAtMs: null,
    })
    expect(generateDiaryId).toHaveBeenCalledOnce()
    expect(today).toHaveBeenCalledOnce()
    expect(nowMs).toHaveBeenCalledOnce()
    expect(fake.create).toHaveBeenCalledOnce()
    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      diaryDate: TODAY,
      title: 'Draft',
      content: 'Body',
      createdAtMs: 100,
    })
  })

  test('generates the diary id exactly once and reuses it for persistence', async () => {
    const fake = createFakeRepository()
    const generateDiaryId = vi.fn(() => ID)
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId,
      nowMs: () => 100,
      today: () => TODAY,
    })

    const entry = await service.createDiaryEntry({
      diaryDate: TODAY,
      title: 'Draft',
      content: 'Body',
    })

    expect(generateDiaryId).toHaveBeenCalledTimes(1)
    expect(entry.id).toBe(ID)
  })

  test('accepts empty title and empty content without inventing a default', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => TODAY,
    })

    await expect(
      service.createDiaryEntry({ diaryDate: TODAY, title: '', content: '' }),
    ).resolves.toMatchObject({ title: '', content: '' })
    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      diaryDate: TODAY,
      title: '',
      content: '',
      createdAtMs: 100,
    })
  })

  test('preserves leading and trailing whitespace exactly', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => TODAY,
    })
    const title = '   padded title   '
    const content = '\n\t  indented body  \t\n'

    await service.createDiaryEntry({ diaryDate: TODAY, title, content })

    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      diaryDate: TODAY,
      title,
      content,
      createdAtMs: 100,
    })
  })

  test('preserves multiple newlines and markdown exactly', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => TODAY,
    })
    const title = '# Heading'
    const content = '# Title\n\n\n- item **bold**\n\n```ts\nconst a = 1\n```\n'

    await service.createDiaryEntry({ diaryDate: TODAY, title, content })

    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      diaryDate: TODAY,
      title,
      content,
      createdAtMs: 100,
    })
  })

  test('preserves unicode content exactly', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => TODAY,
    })
    const title = '日记 📚'
    const content = '知行合一 · naïve · 日本語 · emoji 🎯'

    await service.createDiaryEntry({ diaryDate: TODAY, title, content })

    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      diaryDate: TODAY,
      title,
      content,
      createdAtMs: 100,
    })
  })

  test('rejects non-string title or content before generating an id, reading the clock, or reading today', async () => {
    const fake = createFakeRepository()
    const generateDiaryId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId,
      nowMs,
      today,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 1 as never, content: 'Body' }),
      'VALIDATION',
      'title',
    )
    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: null as never }),
      'VALIDATION',
      'content',
    )
    expect(generateDiaryId).not.toHaveBeenCalled()
    expect(nowMs).not.toHaveBeenCalled()
    expect(today).not.toHaveBeenCalled()
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('rejects an invalid public diaryDate before reading today or the clock', async () => {
    const fake = createFakeRepository()
    const generateDiaryId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId,
      nowMs,
      today,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: '2026-02-30', title: 'Draft', content: 'Body' }),
      'VALIDATION',
      'diaryDate',
    )
    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: 'not-a-date', title: 'Draft', content: 'Body' }),
      'VALIDATION',
      'diaryDate',
    )
    expect(today).not.toHaveBeenCalled()
    expect(generateDiaryId).not.toHaveBeenCalled()
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('rejects a future mutation diaryDate as a validation error', async () => {
    const fake = createFakeRepository()
    const generateDiaryId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId,
      nowMs,
      today,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: '2026-09-15', title: 'Draft', content: 'Body' }),
      'VALIDATION',
      'diaryDate',
    )
    expect(today).toHaveBeenCalledOnce()
    expect(generateDiaryId).not.toHaveBeenCalled()
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('fails safely when the injected id is not canonical lowercase', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => UPPERCASE_ID,
      nowMs: () => 100,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test.each(['', 'not-a-uuid', '00000000-0000-4000-8000-00000000000', ID + '0'])(
    'fails safely when the injected id %s is malformed',
    async (generatedId) => {
      const fake = createFakeRepository()
      const service = createDiaryService({
        repository: fake.repository,
        generateDiaryId: () => generatedId,
        nowMs: () => 100,
        today: () => TODAY,
      })

      await expectApplicationError(
        service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
        'UNAVAILABLE',
      )
      expect(fake.create).not.toHaveBeenCalled()
    },
  )

  test('fails safely when the id generator throws', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => {
        throw new Error('crypto unavailable / secret-token detail')
      },
      nowMs: () => 100,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('accepts a zero millisecond clock reading', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 0,
      today: () => TODAY,
    })

    await expect(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
    ).resolves.toMatchObject({ createdAtMs: 0, updatedAtMs: 0 })
    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      diaryDate: TODAY,
      title: 'Draft',
      content: 'Body',
      createdAtMs: 0,
    })
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'fails safely when the clock returns %s',
    async (timestamp) => {
      const fake = createFakeRepository()
      const service = createDiaryService({
        repository: fake.repository,
        generateDiaryId: () => ID,
        nowMs: () => timestamp,
        today: () => TODAY,
      })

      await expectApplicationError(
        service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
        'UNAVAILABLE',
      )
      expect(fake.create).not.toHaveBeenCalled()
    },
  )

  test('fails safely when the clock throws', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => {
        throw new Error('OPFS path C:\\private\\zhixing.db')
      },
      today: () => TODAY,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('fails safely when injected today() is invalid or throws', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => 'not-a-date',
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('fails safely when today() throws', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => {
        throw new Error('timezone secret detail')
      },
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test.each<[DiaryRepositoryErrorCode, DiaryApplicationErrorCode]>([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['DIARY_DATE_CONFLICT', 'CONFLICT'],
    ['INVALID_ID', 'UNAVAILABLE'],
    ['INVALID_TITLE', 'UNAVAILABLE'],
    ['INVALID_DIARY_DATE', 'UNAVAILABLE'],
    ['PERSISTENCE_ERROR', 'UNAVAILABLE'],
  ])('maps repository %s to %s', async (repositoryCode, applicationCode) => {
    const fake = createFakeRepository()
    fake.create.mockRejectedValueOnce(
      new DiaryRepositoryError(repositoryCode, 'create'),
    )
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      applicationCode,
    )
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.create.mockRejectedValueOnce(new Error('sqlite / OPFS / secret-token detail'))
    const service = createDiaryService({
      repository: fake.repository,
      generateDiaryId: () => ID,
      nowMs: () => 100,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.createDiaryEntry({ diaryDate: TODAY, title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
  })
})

describe('DiaryService getActiveById', () => {
  test('reads with the exact id and returns the repository entry unchanged', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({ repository: fake.repository })

    const result = await service.getActiveById(ID)

    expect(result).toEqual(DIARY)
    expect(fake.getActiveById).toHaveBeenCalledOnce()
    expect(fake.getActiveById).toHaveBeenCalledWith(ID)
  })

  test('returns null when the repository reports a missing or deleted entry', async () => {
    const fake = createFakeRepository()
    fake.getActiveById.mockResolvedValueOnce(null)
    const service = createDiaryService({ repository: fake.repository })

    await expect(service.getActiveById(ID)).resolves.toBeNull()
  })

  test('rejects an invalid id before reaching the repository', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({ repository: fake.repository })

    await expectApplicationError(service.getActiveById('not-a-uuid'), 'VALIDATION', 'id')
    await expectApplicationError(service.getActiveById(UPPERCASE_ID), 'VALIDATION', 'id')
    expect(fake.getActiveById).not.toHaveBeenCalled()
  })

  test.each<DiaryRepositoryErrorCode>([
    'NOT_FOUND',
    'INVALID_ID',
    'INVALID_TITLE',
    'INVALID_DIARY_DATE',
    'DIARY_DATE_CONFLICT',
    'PERSISTENCE_ERROR',
  ])('maps repository %s to the application boundary', async (repositoryCode) => {
    const fake = createFakeRepository()
    fake.getActiveById.mockRejectedValueOnce(
      new DiaryRepositoryError(repositoryCode, 'getActiveById'),
    )
    const service = createDiaryService({ repository: fake.repository })

    const expected: DiaryApplicationErrorCode =
      repositoryCode === 'NOT_FOUND'
        ? 'NOT_FOUND'
        : repositoryCode === 'DIARY_DATE_CONFLICT'
          ? 'CONFLICT'
          : 'UNAVAILABLE'
    await expectApplicationError(service.getActiveById(ID), expected)
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.getActiveById.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createDiaryService({ repository: fake.repository })

    await expectApplicationError(service.getActiveById(ID), 'UNAVAILABLE')
  })
})

describe('DiaryService getActiveByDiaryDate', () => {
  test('reads with the exact date and returns the repository entry unchanged', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({ repository: fake.repository })

    const result = await service.getActiveByDiaryDate(TODAY)

    expect(result).toEqual({ ...DIARY, diaryDate: TODAY })
    expect(fake.getActiveByDiaryDate).toHaveBeenCalledOnce()
    expect(fake.getActiveByDiaryDate).toHaveBeenCalledWith(TODAY)
  })

  test('returns null when no active entry exists for the date', async () => {
    const fake = createFakeRepository()
    fake.getActiveByDiaryDate.mockResolvedValueOnce(null)
    const service = createDiaryService({ repository: fake.repository })

    await expect(service.getActiveByDiaryDate(TODAY)).resolves.toBeNull()
  })

  test('allows a valid future date query without calling today()', async () => {
    const fake = createFakeRepository()
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({
      repository: fake.repository,
      today,
    })

    await service.getActiveByDiaryDate('2099-01-01')

    expect(today).not.toHaveBeenCalled()
    expect(fake.getActiveByDiaryDate).toHaveBeenCalledWith('2099-01-01')
  })

  test('rejects an invalid date before reaching the repository', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({ repository: fake.repository })

    await expectApplicationError(
      service.getActiveByDiaryDate('not-a-date'),
      'VALIDATION',
      'diaryDate',
    )
    await expectApplicationError(
      service.getActiveByDiaryDate('2026-02-30'),
      'VALIDATION',
      'diaryDate',
    )
    expect(fake.getActiveByDiaryDate).not.toHaveBeenCalled()
  })

  test('maps unknown repository failures to UNAVAILABLE', async () => {
    const fake = createFakeRepository()
    fake.getActiveByDiaryDate.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createDiaryService({ repository: fake.repository })

    await expectApplicationError(service.getActiveByDiaryDate(TODAY), 'UNAVAILABLE')
  })
})

describe('DiaryService listActive', () => {
  test('returns the repository array unchanged without reordering', async () => {
    const fake = createFakeRepository()
    const entries: DiaryEntry[] = [
      { ...DIARY, id: '00000000-0000-4000-8000-000000000002', updatedAtMs: 200 },
      DIARY,
    ]
    fake.listActive.mockResolvedValueOnce(entries)
    const service = createDiaryService({ repository: fake.repository })

    const result = await service.listActive()

    expect(result).toBe(entries)
    expect(result[0]).toBe(entries[0])
    expect(result[1]).toBe(entries[1])
    expect(fake.listActive).toHaveBeenCalledOnce()
  })

  test('returns an empty list unchanged', async () => {
    const fake = createFakeRepository()
    fake.listActive.mockResolvedValueOnce([])
    const service = createDiaryService({ repository: fake.repository })

    await expect(service.listActive()).resolves.toEqual([])
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.listActive.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createDiaryService({ repository: fake.repository })

    await expectApplicationError(service.listActive(), 'UNAVAILABLE')
  })
})

describe('DiaryService updateDiaryEntry', () => {
  test('owns the fresh updated time and passes the id, title and content through', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({ repository: fake.repository, nowMs, today })

    const result = await service.updateDiaryEntry({
      id: ID,
      title: 'Updated',
      content: 'Updated body',
    })

    expect(nowMs).toHaveBeenCalledOnce()
    expect(today).not.toHaveBeenCalled()
    expect(fake.updateDiaryEntry).toHaveBeenCalledOnce()
    expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
      id: ID,
      title: 'Updated',
      content: 'Updated body',
      updatedAtMs: 200,
    })
    expect(result).toMatchObject({
      id: ID,
      title: 'Updated',
      content: 'Updated body',
      createdAtMs: 100,
      updatedAtMs: 200,
    })
  })

  test('accepts empty title and empty content', async () => {
    const fake = createFakeRepository()
    const service = createDiaryService({
      repository: fake.repository,
      nowMs: () => 200,
      today: () => TODAY,
    })

    await service.updateDiaryEntry({ id: ID, title: '', content: '' })

    expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
      id: ID,
      title: '',
      content: '',
      updatedAtMs: 200,
    })
  })

  test.each<[DiaryRepositoryErrorCode, DiaryApplicationErrorCode]>([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['DIARY_DATE_CONFLICT', 'CONFLICT'],
    ['INVALID_ID', 'UNAVAILABLE'],
    ['INVALID_TITLE', 'UNAVAILABLE'],
    ['INVALID_DIARY_DATE', 'UNAVAILABLE'],
    ['PERSISTENCE_ERROR', 'UNAVAILABLE'],
  ])('maps repository %s to %s', async (repositoryCode, applicationCode) => {
    const fake = createFakeRepository()
    fake.updateDiaryEntry.mockRejectedValueOnce(
      new DiaryRepositoryError(repositoryCode, 'updateDiaryEntry'),
    )
    const service = createDiaryService({
      repository: fake.repository,
      nowMs: () => 200,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.updateDiaryEntry({ id: ID, title: 'Updated', content: 'Body' }),
      applicationCode,
    )
  })

  test('rejects an invalid public id before reading the clock', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createDiaryService({ repository: fake.repository, nowMs })

    await expectApplicationError(
      service.updateDiaryEntry({ id: 'not-a-uuid', title: 'Updated', content: 'Body' }),
      'VALIDATION',
      'id',
    )
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.updateDiaryEntry).not.toHaveBeenCalled()
  })

  test('rejects invalid title or content shape before reading the clock', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createDiaryService({ repository: fake.repository, nowMs })

    await expectApplicationError(
      service.updateDiaryEntry({ id: ID, title: undefined as never, content: 'Body' }),
      'VALIDATION',
      'title',
    )
    await expectApplicationError(
      service.updateDiaryEntry({ id: ID, title: 'Updated', content: 42 as never }),
      'VALIDATION',
      'content',
    )
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.updateDiaryEntry).not.toHaveBeenCalled()
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.updateDiaryEntry.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createDiaryService({
      repository: fake.repository,
      nowMs: () => 200,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.updateDiaryEntry({ id: ID, title: 'Updated', content: 'Body' }),
      'UNAVAILABLE',
    )
  })
})

describe('DiaryService changeDiaryDate', () => {
  test('owns today and the fresh updated time, passing id, diaryDate and updatedAtMs', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({ repository: fake.repository, nowMs, today })

    const result = await service.changeDiaryDate({ id: ID, diaryDate: '2026-09-13' })

    expect(today).toHaveBeenCalledOnce()
    expect(nowMs).toHaveBeenCalledOnce()
    expect(fake.changeDiaryDate).toHaveBeenCalledOnce()
    expect(fake.changeDiaryDate).toHaveBeenCalledWith({
      id: ID,
      diaryDate: '2026-09-13',
      updatedAtMs: 200,
    })
    expect(result).toMatchObject({
      id: ID,
      diaryDate: '2026-09-13',
      updatedAtMs: 200,
    })
  })

  test('rejects a future mutation date as a validation error before reading the clock', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({ repository: fake.repository, nowMs, today })

    await expectApplicationError(
      service.changeDiaryDate({ id: ID, diaryDate: '2026-09-15' }),
      'VALIDATION',
      'diaryDate',
    )
    expect(today).toHaveBeenCalledOnce()
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.changeDiaryDate).not.toHaveBeenCalled()
  })

  test('rejects an invalid public id before calling today()', async () => {
    const fake = createFakeRepository()
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({ repository: fake.repository, today })

    await expectApplicationError(
      service.changeDiaryDate({ id: 'not-a-uuid', diaryDate: TODAY }),
      'VALIDATION',
      'id',
    )
    expect(today).not.toHaveBeenCalled()
    expect(fake.changeDiaryDate).not.toHaveBeenCalled()
  })

  test('rejects an invalid diaryDate before calling today()', async () => {
    const fake = createFakeRepository()
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({ repository: fake.repository, today })

    await expectApplicationError(
      service.changeDiaryDate({ id: ID, diaryDate: '2026-02-30' }),
      'VALIDATION',
      'diaryDate',
    )
    expect(today).not.toHaveBeenCalled()
    expect(fake.changeDiaryDate).not.toHaveBeenCalled()
  })

  test('maps repository DIARY_DATE_CONFLICT to CONFLICT', async () => {
    const fake = createFakeRepository()
    fake.changeDiaryDate.mockRejectedValueOnce(
      new DiaryRepositoryError('DIARY_DATE_CONFLICT', 'changeDiaryDate'),
    )
    const service = createDiaryService({
      repository: fake.repository,
      nowMs: () => 200,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.changeDiaryDate({ id: ID, diaryDate: '2026-09-13' }),
      'CONFLICT',
    )
  })

  test.each<DiaryRepositoryErrorCode>(['NOT_FOUND', 'INVALID_ID', 'PERSISTENCE_ERROR'])(
    'maps repository %s to the application boundary',
    async (repositoryCode) => {
      const fake = createFakeRepository()
      fake.changeDiaryDate.mockRejectedValueOnce(
        new DiaryRepositoryError(repositoryCode, 'changeDiaryDate'),
      )
      const service = createDiaryService({
        repository: fake.repository,
        nowMs: () => 200,
        today: () => TODAY,
      })

      const expected =
        repositoryCode === 'NOT_FOUND' ? 'NOT_FOUND' : 'UNAVAILABLE'
      await expectApplicationError(
        service.changeDiaryDate({ id: ID, diaryDate: '2026-09-13' }),
        expected,
      )
    },
  )

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.changeDiaryDate.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createDiaryService({
      repository: fake.repository,
      nowMs: () => 200,
      today: () => TODAY,
    })

    await expectApplicationError(
      service.changeDiaryDate({ id: ID, diaryDate: '2026-09-13' }),
      'UNAVAILABLE',
    )
  })
})

describe('DiaryService softDelete and restore', () => {
  test('reads one timestamp per lifecycle call and never sends a deletion timestamp', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(300)
    const today = vi.fn(() => TODAY)
    const service = createDiaryService({ repository: fake.repository, nowMs, today })

    await expect(service.softDelete(ID)).resolves.toBeUndefined()
    await expect(service.restore(ID)).resolves.toBeUndefined()

    expect(today).not.toHaveBeenCalled()
    expect(fake.softDelete).toHaveBeenCalledOnce()
    expect(fake.softDelete).toHaveBeenCalledWith({ id: ID, updatedAtMs: 200 })
    expect(fake.restore).toHaveBeenCalledOnce()
    expect(fake.restore).toHaveBeenCalledWith({ id: ID, updatedAtMs: 300 })
    expect(nowMs).toHaveBeenCalledTimes(2)
  })

  test.each(['softDelete', 'restore'] as const)(
    '%s validates the canonical id before reading the clock',
    async (method) => {
      const fake = createFakeRepository()
      const nowMs = vi.fn(() => 200)
      const service = createDiaryService({ repository: fake.repository, nowMs })

      await expectApplicationError(service[method]('not-a-uuid'), 'VALIDATION', 'id')
      await expectApplicationError(service[method](UPPERCASE_ID), 'VALIDATION', 'id')
      expect(nowMs).not.toHaveBeenCalled()
      expect(fake[method]).not.toHaveBeenCalled()
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s fails safely on an invalid clock reading',
    async (method) => {
      const fake = createFakeRepository()
      const service = createDiaryService({
        repository: fake.repository,
        nowMs: () => -1,
        today: () => TODAY,
      })

      await expectApplicationError(service[method](ID), 'UNAVAILABLE')
      expect(fake[method]).not.toHaveBeenCalled()
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s maps NOT_FOUND to NOT_FOUND and persistence failures to UNAVAILABLE',
    async (method) => {
      const fake = createFakeRepository()
      const service = createDiaryService({
        repository: fake.repository,
        nowMs: () => 200,
        today: () => TODAY,
      })

      fake[method].mockRejectedValueOnce(
        new DiaryRepositoryError('NOT_FOUND', method),
      )
      await expectApplicationError(service[method](ID), 'NOT_FOUND')

      fake[method].mockRejectedValueOnce(
        new DiaryRepositoryError('PERSISTENCE_ERROR', method),
      )
      await expectApplicationError(service[method](ID), 'UNAVAILABLE')

      fake[method].mockRejectedValueOnce(
        new DiaryRepositoryError('INVALID_ID', method),
      )
      await expectApplicationError(service[method](ID), 'UNAVAILABLE')
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s maps DIARY_DATE_CONFLICT to CONFLICT',
    async (method) => {
      const fake = createFakeRepository()
      const service = createDiaryService({
        repository: fake.repository,
        nowMs: () => 200,
        today: () => TODAY,
      })

      fake[method].mockRejectedValueOnce(
        new DiaryRepositoryError('DIARY_DATE_CONFLICT', method),
      )
      await expectApplicationError(service[method](ID), 'CONFLICT')
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s contains unknown repository failures',
    async (method) => {
      const fake = createFakeRepository()
      fake[method].mockRejectedValueOnce(
        new Error('sqlite / OPFS / secret-token detail'),
      )
      const service = createDiaryService({
        repository: fake.repository,
        nowMs: () => 200,
        today: () => TODAY,
      })

      await expectApplicationError(service[method](ID), 'UNAVAILABLE')
    },
  )
})
