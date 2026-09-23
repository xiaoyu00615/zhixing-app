import { describe, expect, test, vi } from 'vitest'

import type { Note } from '@/note/model'
import {
  NoteRepositoryError,
  type ArchiveNoteInput,
  type CreateNoteInput,
  type NoteRepository,
  type NoteRepositoryErrorCode,
  type RestoreNoteInput,
  type SoftDeleteNoteInput,
  type UnarchiveNoteInput,
  type UpdateNoteInput,
} from '@/note/repository'
import {
  createNoteService,
  NOTE_APPLICATION_ERROR_CODES,
  NoteApplicationError,
  type NoteApplicationErrorCode,
  type NoteApplicationErrorField,
} from '@/note/service'

const ID = '00000000-0000-4000-8000-000000000001'
const UPPERCASE_ID = '00000000-0000-4000-8000-00000000000A'
const NOTE: Note = {
  id: ID,
  title: 'Note',
  content: 'Content',
  createdAtMs: 100,
  updatedAtMs: 100,
  deletedAtMs: null,
  archivedAtMs: null,
}

function createFakeRepository() {
  const create = vi.fn((input: CreateNoteInput): Promise<Note> =>
    Promise.resolve({
      id: input.id,
      title: input.title,
      content: input.content,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      deletedAtMs: null,
      archivedAtMs: null,
    }),
  )
  const getActiveById = vi.fn((id: string): Promise<Note | null> =>
    Promise.resolve({ ...NOTE, id }),
  )
  const listActive = vi.fn((): Promise<Note[]> => Promise.resolve([NOTE]))
  const updateNote = vi.fn((input: UpdateNoteInput): Promise<Note> =>
    Promise.resolve({
      ...NOTE,
      id: input.id,
      title: input.title,
      content: input.content,
      updatedAtMs: input.updatedAtMs,
    }),
  )
  const softDelete = vi.fn((input: SoftDeleteNoteInput): Promise<void> => {
    void input
    return Promise.resolve()
  })
  const restore = vi.fn((input: RestoreNoteInput): Promise<void> => {
    void input
    return Promise.resolve()
  })
  const archive = vi.fn((input: ArchiveNoteInput): Promise<void> => {
    void input
    return Promise.resolve()
  })
  const unarchive = vi.fn((input: UnarchiveNoteInput): Promise<void> => {
    void input
    return Promise.resolve()
  })
  const repository: NoteRepository = {
    create,
    getActiveById,
    listActive,
    updateNote,
    softDelete,
    restore,
    archive,
    unarchive,
  }

  return {
    repository,
    create,
    getActiveById,
    listActive,
    updateNote,
    softDelete,
    restore,
    archive,
    unarchive,
  }
}

async function expectApplicationError(
  promise: Promise<unknown>,
  code: NoteApplicationErrorCode,
  field?: NoteApplicationErrorField,
): Promise<void> {
  const error = await promise.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(NoteApplicationError)
  expect(error).toMatchObject({ code, field })
  expect((error as Error).message).not.toMatch(
    /SQL|sqlite|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
  )
}

test('NoteService exposes only the approved business API and error codes', () => {
  const fake = createFakeRepository()
  const service = createNoteService({ repository: fake.repository })

  expect(Object.keys(service)).toEqual([
    'createNote',
    'getActiveById',
    'listActive',
    'updateNote',
    'softDelete',
    'restore',
    'archive',
    'unarchive',
  ])
  expect(NOTE_APPLICATION_ERROR_CODES).toEqual([
    'VALIDATION',
    'NOT_FOUND',
    'UNAVAILABLE',
  ])
})

describe('NoteService createNote', () => {
  test('owns UUID generation and creation time', async () => {
    const fake = createFakeRepository()
    const generateNoteId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId,
      nowMs,
    })

    await expect(
      service.createNote({ title: 'Draft', content: 'Body' }),
    ).resolves.toEqual({
      id: ID,
      title: 'Draft',
      content: 'Body',
      createdAtMs: 100,
      updatedAtMs: 100,
      deletedAtMs: null,
      archivedAtMs: null,
    })
    expect(generateNoteId).toHaveBeenCalledOnce()
    expect(nowMs).toHaveBeenCalledOnce()
    expect(fake.create).toHaveBeenCalledOnce()
    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      title: 'Draft',
      content: 'Body',
      createdAtMs: 100,
    })
  })

  test('generates the note id exactly once and reuses it for persistence', async () => {
    const fake = createFakeRepository()
    const generateNoteId = vi.fn(() => ID)
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId,
      nowMs: () => 100,
    })

    const note = await service.createNote({ title: 'Draft', content: 'Body' })

    expect(generateNoteId).toHaveBeenCalledTimes(1)
    expect(note.id).toBe(ID)
  })

  test('accepts empty title and empty content without inventing a default title', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => 100,
    })

    await expect(
      service.createNote({ title: '', content: '' }),
    ).resolves.toMatchObject({ title: '', content: '' })
    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      title: '',
      content: '',
      createdAtMs: 100,
    })
  })

  test('preserves leading and trailing whitespace exactly', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => 100,
    })
    const title = '   padded title   '
    const content = '\n\t  indented body  \t\n'

    await service.createNote({ title, content })

    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      title,
      content,
      createdAtMs: 100,
    })
  })

  test('preserves multiple newlines and markdown exactly', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => 100,
    })
    const title = '# Heading'
    const content = '# Title\n\n\n- item **bold**\n\n```ts\nconst a = 1\n```\n'

    await service.createNote({ title, content })

    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      title,
      content,
      createdAtMs: 100,
    })
  })

  test('preserves unicode content exactly', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => 100,
    })
    const title = '读书笔记 📚'
    const content = '知行合一 · naïve · 日本語 · emoji 🎯'

    await service.createNote({ title, content })

    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      title,
      content,
      createdAtMs: 100,
    })
  })

  test('rejects non-string title or content before generating an id or reading the clock', async () => {
    const fake = createFakeRepository()
    const generateNoteId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId,
      nowMs,
    })

    await expectApplicationError(
      service.createNote({ title: 1 as never, content: 'Body' }),
      'VALIDATION',
      'title',
    )
    await expectApplicationError(
      service.createNote({ title: 'Draft', content: null as never }),
      'VALIDATION',
      'content',
    )
    expect(generateNoteId).not.toHaveBeenCalled()
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('fails safely when the injected id is not canonical lowercase', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => UPPERCASE_ID,
      nowMs: () => 100,
    })

    await expectApplicationError(
      service.createNote({ title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test.each(['', 'not-a-uuid', '00000000-0000-4000-8000-00000000000', ID + '0'])(
    'fails safely when the injected id %s is malformed',
    async (generatedId) => {
      const fake = createFakeRepository()
      const service = createNoteService({
        repository: fake.repository,
        generateNoteId: () => generatedId,
        nowMs: () => 100,
      })

      await expectApplicationError(
        service.createNote({ title: 'Draft', content: 'Body' }),
        'UNAVAILABLE',
      )
      expect(fake.create).not.toHaveBeenCalled()
    },
  )

  test('fails safely when the id generator throws', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => {
        throw new Error('crypto unavailable / secret-token detail')
      },
      nowMs: () => 100,
    })

    await expectApplicationError(
      service.createNote({ title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test('accepts a zero millisecond clock reading', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => 0,
    })

    await expect(
      service.createNote({ title: 'Draft', content: 'Body' }),
    ).resolves.toMatchObject({ createdAtMs: 0, updatedAtMs: 0 })
    expect(fake.create).toHaveBeenCalledWith({
      id: ID,
      title: 'Draft',
      content: 'Body',
      createdAtMs: 0,
    })
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'fails safely when the clock returns %s',
    async (timestamp) => {
      const fake = createFakeRepository()
      const service = createNoteService({
        repository: fake.repository,
        generateNoteId: () => ID,
        nowMs: () => timestamp,
      })

      await expectApplicationError(
        service.createNote({ title: 'Draft', content: 'Body' }),
        'UNAVAILABLE',
      )
      expect(fake.create).not.toHaveBeenCalled()
    },
  )

  test('fails safely when the clock throws', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => {
        throw new Error('OPFS path C:\\private\\zhixing.db')
      },
    })

    await expectApplicationError(
      service.createNote({ title: 'Draft', content: 'Body' }),
      'UNAVAILABLE',
    )
    expect(fake.create).not.toHaveBeenCalled()
  })

  test.each<[NoteRepositoryErrorCode, NoteApplicationErrorCode]>([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['INVALID_ID', 'UNAVAILABLE'],
    ['INVALID_TITLE', 'UNAVAILABLE'],
    ['PERSISTENCE_ERROR', 'UNAVAILABLE'],
  ])('maps repository %s to %s', async (repositoryCode, applicationCode) => {
    const fake = createFakeRepository()
    fake.create.mockRejectedValueOnce(
      new NoteRepositoryError(repositoryCode, 'create'),
    )
    const service = createNoteService({
      repository: fake.repository,
      generateNoteId: () => ID,
      nowMs: () => 100,
    })

    await expectApplicationError(
      service.createNote({ title: 'Draft', content: 'Body' }),
      applicationCode,
    )
  })
})

describe('NoteService getActiveById', () => {
  test('reads with the exact id and returns the repository note unchanged', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({ repository: fake.repository })

    const result = await service.getActiveById(ID)

    expect(result).toEqual(NOTE)
    expect(fake.getActiveById).toHaveBeenCalledOnce()
    expect(fake.getActiveById).toHaveBeenCalledWith(ID)
  })

  test('returns null when the repository reports a missing or deleted note', async () => {
    const fake = createFakeRepository()
    fake.getActiveById.mockResolvedValueOnce(null)
    const service = createNoteService({ repository: fake.repository })

    await expect(service.getActiveById(ID)).resolves.toBeNull()
  })

  test('rejects an invalid id before reaching the repository', async () => {
    const fake = createFakeRepository()
    const service = createNoteService({ repository: fake.repository })

    await expectApplicationError(
      service.getActiveById('not-a-uuid'),
      'VALIDATION',
      'id',
    )
    await expectApplicationError(
      service.getActiveById(UPPERCASE_ID),
      'VALIDATION',
      'id',
    )
    expect(fake.getActiveById).not.toHaveBeenCalled()
  })

  test.each<NoteRepositoryErrorCode>([
    'INVALID_ID',
    'INVALID_TITLE',
    'PERSISTENCE_ERROR',
  ])('maps repository %s to UNAVAILABLE', async (repositoryCode) => {
    const fake = createFakeRepository()
    fake.getActiveById.mockRejectedValueOnce(
      new NoteRepositoryError(repositoryCode, 'getActiveById'),
    )
    const service = createNoteService({ repository: fake.repository })

    await expectApplicationError(service.getActiveById(ID), 'UNAVAILABLE')
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.getActiveById.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createNoteService({ repository: fake.repository })

    await expectApplicationError(service.getActiveById(ID), 'UNAVAILABLE')
  })
})

describe('NoteService listActive', () => {
  test('returns the repository array unchanged without reordering', async () => {
    const fake = createFakeRepository()
    const notes: Note[] = [
      { ...NOTE, id: '00000000-0000-4000-8000-000000000002', updatedAtMs: 200 },
      NOTE,
    ]
    fake.listActive.mockResolvedValueOnce(notes)
    const service = createNoteService({ repository: fake.repository })

    const result = await service.listActive()

    expect(result).toBe(notes)
    expect(result[0]).toBe(notes[0])
    expect(result[1]).toBe(notes[1])
    expect(fake.listActive).toHaveBeenCalledOnce()
  })

  test('returns an empty list unchanged', async () => {
    const fake = createFakeRepository()
    fake.listActive.mockResolvedValueOnce([])
    const service = createNoteService({ repository: fake.repository })

    await expect(service.listActive()).resolves.toEqual([])
  })

  test.each<NoteRepositoryErrorCode>([
    'INVALID_ID',
    'INVALID_TITLE',
    'PERSISTENCE_ERROR',
  ])('maps repository %s to UNAVAILABLE', async (repositoryCode) => {
    const fake = createFakeRepository()
    fake.listActive.mockRejectedValueOnce(
      new NoteRepositoryError(repositoryCode, 'listActive'),
    )
    const service = createNoteService({ repository: fake.repository })

    await expectApplicationError(service.listActive(), 'UNAVAILABLE')
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.listActive.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createNoteService({ repository: fake.repository })

    await expectApplicationError(service.listActive(), 'UNAVAILABLE')
  })
})

describe('NoteService updateNote', () => {
  test('owns the fresh updated time and passes the id, title and content through', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createNoteService({ repository: fake.repository, nowMs })

    const result = await service.updateNote({
      id: ID,
      title: 'Updated',
      content: 'Updated body',
    })

    expect(nowMs).toHaveBeenCalledOnce()
    expect(fake.updateNote).toHaveBeenCalledOnce()
    expect(fake.updateNote).toHaveBeenCalledWith({
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
    const service = createNoteService({
      repository: fake.repository,
      nowMs: () => 200,
    })

    await service.updateNote({ id: ID, title: '', content: '' })

    expect(fake.updateNote).toHaveBeenCalledWith({
      id: ID,
      title: '',
      content: '',
      updatedAtMs: 200,
    })
  })

  test.each<[NoteRepositoryErrorCode, NoteApplicationErrorCode]>([
    ['NOT_FOUND', 'NOT_FOUND'],
    ['INVALID_ID', 'UNAVAILABLE'],
    ['INVALID_TITLE', 'UNAVAILABLE'],
    ['PERSISTENCE_ERROR', 'UNAVAILABLE'],
  ])('maps repository %s to %s', async (repositoryCode, applicationCode) => {
    const fake = createFakeRepository()
    fake.updateNote.mockRejectedValueOnce(
      new NoteRepositoryError(repositoryCode, 'updateNote'),
    )
    const service = createNoteService({
      repository: fake.repository,
      nowMs: () => 200,
    })

    await expectApplicationError(
      service.updateNote({ id: ID, title: 'Updated', content: 'Body' }),
      applicationCode,
    )
  })

  test('rejects an invalid public id before reading the clock', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createNoteService({ repository: fake.repository, nowMs })

    await expectApplicationError(
      service.updateNote({ id: 'not-a-uuid', title: 'Updated', content: 'Body' }),
      'VALIDATION',
      'id',
    )
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.updateNote).not.toHaveBeenCalled()
  })

  test('rejects invalid title or content shape before reading the clock', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createNoteService({ repository: fake.repository, nowMs })

    await expectApplicationError(
      service.updateNote({ id: ID, title: undefined as never, content: 'Body' }),
      'VALIDATION',
      'title',
    )
    await expectApplicationError(
      service.updateNote({ id: ID, title: 'Updated', content: 42 as never }),
      'VALIDATION',
      'content',
    )
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.updateNote).not.toHaveBeenCalled()
  })

  test('contains unknown repository failures', async () => {
    const fake = createFakeRepository()
    fake.updateNote.mockRejectedValueOnce(
      new Error('sqlite / OPFS / secret-token detail'),
    )
    const service = createNoteService({
      repository: fake.repository,
      nowMs: () => 200,
    })

    await expectApplicationError(
      service.updateNote({ id: ID, title: 'Updated', content: 'Body' }),
      'UNAVAILABLE',
    )
  })
})

describe('NoteService softDelete and restore', () => {
  test('reads one timestamp per lifecycle call and never sends a deletion timestamp', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn().mockReturnValueOnce(200).mockReturnValueOnce(300)
    const service = createNoteService({ repository: fake.repository, nowMs })

    await expect(service.softDelete(ID)).resolves.toBeUndefined()
    await expect(service.restore(ID)).resolves.toBeUndefined()

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
      const service = createNoteService({ repository: fake.repository, nowMs })

      await expectApplicationError(
        service[method]('not-a-uuid'),
        'VALIDATION',
        'id',
      )
      await expectApplicationError(
        service[method](UPPERCASE_ID),
        'VALIDATION',
        'id',
      )
      expect(nowMs).not.toHaveBeenCalled()
      expect(fake[method]).not.toHaveBeenCalled()
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s fails safely on an invalid clock reading',
    async (method) => {
      const fake = createFakeRepository()
      const service = createNoteService({
        repository: fake.repository,
        nowMs: () => -1,
      })

      await expectApplicationError(service[method](ID), 'UNAVAILABLE')
      expect(fake[method]).not.toHaveBeenCalled()
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s maps NOT_FOUND to NOT_FOUND and persistence failures to UNAVAILABLE',
    async (method) => {
      const fake = createFakeRepository()
      const service = createNoteService({
        repository: fake.repository,
        nowMs: () => 200,
      })

      fake[method].mockRejectedValueOnce(
        new NoteRepositoryError('NOT_FOUND', method),
      )
      await expectApplicationError(service[method](ID), 'NOT_FOUND')

      fake[method].mockRejectedValueOnce(
        new NoteRepositoryError('PERSISTENCE_ERROR', method),
      )
      await expectApplicationError(service[method](ID), 'UNAVAILABLE')

      fake[method].mockRejectedValueOnce(
        new NoteRepositoryError('INVALID_ID', method),
      )
      await expectApplicationError(service[method](ID), 'UNAVAILABLE')
    },
  )

  test.each(['softDelete', 'restore'] as const)(
    '%s contains unknown repository failures',
    async (method) => {
      const fake = createFakeRepository()
      fake[method].mockRejectedValueOnce(
        new Error('sqlite / OPFS / secret-token detail'),
      )
      const service = createNoteService({
        repository: fake.repository,
        nowMs: () => 200,
      })

      await expectApplicationError(service[method](ID), 'UNAVAILABLE')
    },
  )
})