import { beforeEach, describe, expect, test, vi } from 'vitest'

import { openTrashRuntime as openNativeTrashRuntime } from '@/trash/runtime.native'
import { openTrashRuntime as openWebTrashRuntime } from '@/trash/runtime'
import { TrashApplicationError } from '@/trash/service'
import type { TrashItem } from '@/trash/model'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const NOTE_ID = '00000000-0000-4000-8000-000000000002'
const DIARY_ID = '00000000-0000-4000-8000-000000000003'

const ITEMS: readonly TrashItem[] = [
  { entityType: 'task', entityId: TASK_ID, title: '任务', deletedAtMs: 300 },
  { entityType: 'note', entityId: NOTE_ID, title: '笔记', deletedAtMs: 200 },
  { entityType: 'diary', entityId: DIARY_ID, title: '日记', deletedAtMs: 100 },
]

const mocks = vi.hoisted(() => ({
  openWebTaskRepository: vi.fn(),
  nativeTrashConstructed: vi.fn(),
  nativeTaskConstructed: vi.fn(),
  nativeNoteConstructed: vi.fn(),
  nativeDiaryConstructed: vi.fn(),
  nativeTrashList: vi.fn((): Promise<readonly TrashItem[]> => Promise.resolve([])),
  nativeTaskRestore: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  nativeNoteRestore: vi.fn((): Promise<void> => Promise.resolve()),
  nativeDiaryRestore: vi.fn((): Promise<void> => Promise.resolve()),
}))

vi.mock('@/adapters/web', () => ({
  openWebTaskRepository: mocks.openWebTaskRepository,
}))

vi.mock('@/adapters/native', () => ({
  NativeTrashRepository: class {
    constructor() {
      mocks.nativeTrashConstructed()
    }
    list() {
      return mocks.nativeTrashList()
    }
  },
  NativeTaskRepository: class {
    constructor() {
      mocks.nativeTaskConstructed()
    }
    restoreTask() {
      return mocks.nativeTaskRestore()
    }
  },
  NativeNoteRepository: class {
    constructor() {
      mocks.nativeNoteConstructed()
    }
    restore() {
      return mocks.nativeNoteRestore()
    }
  },
  NativeDiaryRepository: class {
    constructor() {
      mocks.nativeDiaryConstructed()
    }
    restore() {
      return mocks.nativeDiaryRestore()
    }
  },
}))

/** First argument of the first recorded call, without widening to `any`. */
function firstCallArg(calls: readonly unknown[][]): Record<string, unknown> {
  const first = calls[0]
  return (first?.[0] ?? {}) as Record<string, unknown>
}

function webPersistenceResult() {
  const dispose = vi.fn(() => Promise.resolve())
  const trashRepository = { list: vi.fn(() => Promise.resolve(ITEMS)) }
  const repository = { restoreTask: vi.fn(() => Promise.resolve(undefined)) }
  const noteRepository = { restore: vi.fn(() => Promise.resolve()) }
  const diaryRepository = { restore: vi.fn(() => Promise.resolve()) }
  return {
    dispose,
    trashRepository,
    repository,
    noteRepository,
    diaryRepository,
    result: {
      capability: { status: 'AVAILABLE' },
      trashRepository,
      repository,
      noteRepository,
      diaryRepository,
      dispose,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.nativeTrashList.mockResolvedValue(ITEMS)
  mocks.nativeTaskRestore.mockResolvedValue(undefined)
  mocks.nativeNoteRestore.mockResolvedValue(undefined)
  mocks.nativeDiaryRestore.mockResolvedValue(undefined)
})

describe('Web trash runtime composition', () => {
  test('opens the shared Web persistence exactly once, without options', async () => {
    const { result, dispose } = webPersistenceResult()
    mocks.openWebTaskRepository.mockResolvedValue(result)

    const runtime = await openWebTrashRuntime()

    expect(mocks.openWebTaskRepository).toHaveBeenCalledOnce()
    expect(mocks.openWebTaskRepository).toHaveBeenCalledWith()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('reads trash through the repository from that same open', async () => {
    const { result, trashRepository } = webPersistenceResult()
    mocks.openWebTaskRepository.mockResolvedValue(result)

    const runtime = await openWebTrashRuntime()

    await expect(runtime.service.list()).resolves.toEqual(ITEMS)
    expect(trashRepository.list).toHaveBeenCalledOnce()
  })

  test('builds canonical restore services from the same opened repositories', async () => {
    const { result, repository, noteRepository, diaryRepository } =
      webPersistenceResult()
    mocks.openWebTaskRepository.mockResolvedValue(result)

    const runtime = await openWebTrashRuntime()

    await runtime.service.restore({ entityType: 'task', entityId: TASK_ID })
    const taskInput = firstCallArg(repository.restoreTask.mock.calls)
    expect(taskInput.id).toBe(TASK_ID)
    expect(typeof taskInput.updatedAtMs).toBe('number')

    await runtime.service.restore({ entityType: 'note', entityId: NOTE_ID })
    const noteInput = firstCallArg(noteRepository.restore.mock.calls)
    expect(noteInput.id).toBe(NOTE_ID)
    expect(typeof noteInput.updatedAtMs).toBe('number')

    await runtime.service.restore({ entityType: 'diary', entityId: DIARY_ID })
    const diaryInput = firstCallArg(diaryRepository.restore.mock.calls)
    expect(diaryInput.id).toBe(DIARY_ID)
    expect(typeof diaryInput.updatedAtMs).toBe('number')

    expect(mocks.openWebTaskRepository).toHaveBeenCalledOnce()
  })

  test('maps an unavailable persistence capability to UNAVAILABLE', async () => {
    mocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })

    await expect(openWebTrashRuntime()).rejects.toBeInstanceOf(
      TrashApplicationError,
    )
    await expect(openWebTrashRuntime()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  test('contains raw shared-persistence failures', async () => {
    mocks.openWebTaskRepository.mockRejectedValue(
      new Error('worker / OPFS / sqlite-wasm detail'),
    )

    const error = await openWebTrashRuntime().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(TrashApplicationError)
    expect((error as Error).message).not.toMatch(/worker|OPFS|sqlite/i)
  })
})

describe('Native trash runtime composition', () => {
  test('constructs the Native trash repository and canonical domain services', async () => {
    const runtime = await openNativeTrashRuntime()

    expect(mocks.nativeTrashConstructed).toHaveBeenCalledOnce()
    expect(mocks.nativeTaskConstructed).toHaveBeenCalledOnce()
    expect(mocks.nativeNoteConstructed).toHaveBeenCalledOnce()
    expect(mocks.nativeDiaryConstructed).toHaveBeenCalledOnce()
    expect(mocks.openWebTaskRepository).not.toHaveBeenCalled()
    expect(runtime.dispose()).toBeUndefined()
  })

  test('dispatches restore through the canonical Native domain services', async () => {
    const runtime = await openNativeTrashRuntime()

    await expect(runtime.service.list()).resolves.toEqual(ITEMS)

    await runtime.service.restore({ entityType: 'task', entityId: TASK_ID })
    await runtime.service.restore({ entityType: 'note', entityId: NOTE_ID })
    await runtime.service.restore({ entityType: 'diary', entityId: DIARY_ID })

    expect(mocks.nativeTaskRestore).toHaveBeenCalledOnce()
    expect(mocks.nativeNoteRestore).toHaveBeenCalledOnce()
    expect(mocks.nativeDiaryRestore).toHaveBeenCalledOnce()
  })
})
