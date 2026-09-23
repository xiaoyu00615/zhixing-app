import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { Note } from '@/note/model'
import { NoteApplicationError } from '@/note/service'
import { openNoteRuntime as openNativeNoteRuntime } from '@/note/runtime.native'
import { openNoteRuntime as openWebNoteRuntime } from '@/note/runtime'

const NOTE: Note = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Note',
  content: 'Content',
  createdAtMs: 100,
  updatedAtMs: 100,
  deletedAtMs: null,
  archivedAtMs: null,
}

const runtimeMocks = vi.hoisted(() => ({
  openWebTaskRepository: vi.fn(),
  nativeConstructed: vi.fn(),
  nativeListActive: vi.fn(),
}))

vi.mock('@/adapters/web', () => ({
  openWebTaskRepository: runtimeMocks.openWebTaskRepository,
}))

vi.mock('@/adapters/native', () => ({
  NativeNoteRepository: class {
    constructor() {
      runtimeMocks.nativeConstructed()
    }

    create(): Promise<Note> {
      return Promise.resolve(NOTE)
    }

    getActiveById(): Promise<Note | null> {
      return Promise.resolve(NOTE)
    }

    listActive(): Promise<Note[]> {
      return runtimeMocks.nativeListActive() as Promise<Note[]>
    }

    updateNote(): Promise<Note> {
      return Promise.resolve(NOTE)
    }

    softDelete(): Promise<void> {
      return Promise.resolve()
    }

    restore(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

describe('Note runtime composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.nativeListActive.mockResolvedValue([NOTE])
  })

  test('Web composition opens only Web persistence and preserves disposal', async () => {
    const dispose = vi.fn(() => Promise.resolve())
    const noteRepository = {
      create: vi.fn(),
      getActiveById: vi.fn(),
      listActive: vi.fn(() => Promise.resolve([NOTE])),
      updateNote: vi.fn(),
      softDelete: vi.fn(),
      restore: vi.fn(),
    }
    runtimeMocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'AVAILABLE' },
      noteRepository,
      dispose,
    })

    const runtime = await openWebNoteRuntime()

    await expect(runtime.service.listActive()).resolves.toEqual([NOTE])
    expect(noteRepository.listActive).toHaveBeenCalledOnce()
    expect(runtimeMocks.openWebTaskRepository).toHaveBeenCalledOnce()
    expect(runtimeMocks.nativeConstructed).not.toHaveBeenCalled()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('Web composition fails safely when OPFS capability is unavailable', async () => {
    runtimeMocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })

    await expect(openWebNoteRuntime()).rejects.toEqual(
      new NoteApplicationError('UNAVAILABLE'),
    )
    expect(runtimeMocks.nativeConstructed).not.toHaveBeenCalled()
  })

  test('Web composition contains raw factory failures', async () => {
    runtimeMocks.openWebTaskRepository.mockRejectedValue(
      new Error('worker / OPFS / secret-token detail'),
    )

    await expect(openWebNoteRuntime()).rejects.toEqual(
      new NoteApplicationError('UNAVAILABLE'),
    )
  })

  test('Native composition selects only Native persistence', async () => {
    const runtime = await openNativeNoteRuntime()

    await expect(runtime.service.listActive()).resolves.toEqual([NOTE])
    expect(runtimeMocks.nativeConstructed).toHaveBeenCalledOnce()
    expect(runtimeMocks.openWebTaskRepository).not.toHaveBeenCalled()
    expect(runtime.dispose()).toBeUndefined()
  })
})