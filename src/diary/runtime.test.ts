import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { DiaryEntry } from '@/diary/model'
import { DiaryApplicationError } from '@/diary/service'
import { openDiaryRuntime as openNativeDiaryRuntime } from '@/diary/runtime.native'
import { openDiaryRuntime as openWebDiaryRuntime } from '@/diary/runtime'

const DIARY: DiaryEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  diaryDate: '2026-09-14',
  title: 'Diary',
  content: 'Content',
  createdAtMs: 100,
  updatedAtMs: 100,
  deletedAtMs: null,
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
  NativeDiaryRepository: class {
    constructor() {
      runtimeMocks.nativeConstructed()
    }

    create(): Promise<DiaryEntry> {
      return Promise.resolve(DIARY)
    }

    getActiveById(): Promise<DiaryEntry | null> {
      return Promise.resolve(DIARY)
    }

    getActiveByDiaryDate(): Promise<DiaryEntry | null> {
      return Promise.resolve(DIARY)
    }

    listActive(): Promise<DiaryEntry[]> {
      return runtimeMocks.nativeListActive() as Promise<DiaryEntry[]>
    }

    updateDiaryEntry(): Promise<DiaryEntry> {
      return Promise.resolve(DIARY)
    }

    changeDiaryDate(): Promise<DiaryEntry> {
      return Promise.resolve(DIARY)
    }

    softDelete(): Promise<void> {
      return Promise.resolve()
    }

    restore(): Promise<void> {
      return Promise.resolve()
    }
  },
}))

describe('Diary runtime composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.nativeListActive.mockResolvedValue([DIARY])
  })

  test('Web composition opens only Web persistence and preserves disposal', async () => {
    const dispose = vi.fn(() => Promise.resolve())
    const diaryRepository = {
      create: vi.fn(),
      getActiveById: vi.fn(),
      getActiveByDiaryDate: vi.fn(),
      listActive: vi.fn(() => Promise.resolve([DIARY])),
      updateDiaryEntry: vi.fn(),
      changeDiaryDate: vi.fn(),
      softDelete: vi.fn(),
      restore: vi.fn(),
    }
    runtimeMocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'AVAILABLE' },
      diaryRepository,
      dispose,
    })

    const runtime = await openWebDiaryRuntime()

    await expect(runtime.service.listActive()).resolves.toEqual([DIARY])
    expect(diaryRepository.listActive).toHaveBeenCalledOnce()
    expect(runtimeMocks.openWebTaskRepository).toHaveBeenCalledOnce()
    expect(runtimeMocks.nativeConstructed).not.toHaveBeenCalled()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('Web composition fails safely when OPFS capability is unavailable', async () => {
    runtimeMocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })

    await expect(openWebDiaryRuntime()).rejects.toEqual(
      new DiaryApplicationError('UNAVAILABLE'),
    )
    expect(runtimeMocks.nativeConstructed).not.toHaveBeenCalled()
  })

  test('Web composition contains raw factory failures', async () => {
    runtimeMocks.openWebTaskRepository.mockRejectedValue(
      new Error('worker / OPFS / secret-token detail'),
    )

    await expect(openWebDiaryRuntime()).rejects.toEqual(
      new DiaryApplicationError('UNAVAILABLE'),
    )
  })

  test('Native composition selects only Native persistence', async () => {
    const runtime = await openNativeDiaryRuntime()

    await expect(runtime.service.listActive()).resolves.toEqual([DIARY])
    expect(runtimeMocks.nativeConstructed).toHaveBeenCalledOnce()
    expect(runtimeMocks.openWebTaskRepository).not.toHaveBeenCalled()
    expect(runtime.dispose()).toBeUndefined()
  })
})
