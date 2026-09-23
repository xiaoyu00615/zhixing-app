import { beforeEach, describe, expect, test, vi } from 'vitest'

import { openArchiveRuntime as openNativeArchiveRuntime } from '@/archive/runtime.native'
import { openArchiveRuntime as openWebArchiveRuntime } from '@/archive/runtime'
import { ArchiveApplicationError } from '@/archive/service'
import type { ArchiveItem } from '@/archive/model'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const NOTE_ID = '00000000-0000-4000-8000-000000000002'

const ITEMS: readonly ArchiveItem[] = [
  { entityType: 'task', entityId: TASK_ID, title: '任务', archivedAtMs: 300 },
  { entityType: 'note', entityId: NOTE_ID, title: '笔记', archivedAtMs: 200 },
]

const mocks = vi.hoisted(() => ({
  openWebTaskRepository: vi.fn(),
  nativeArchiveConstructed: vi.fn(),
  nativeTaskConstructed: vi.fn(),
  nativeNoteConstructed: vi.fn(),
  nativeArchiveList: vi.fn((): Promise<readonly ArchiveItem[]> => Promise.resolve([])),
  nativeTaskUnarchive: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  nativeTaskTrash: vi.fn((): Promise<undefined> => Promise.resolve(undefined)),
  nativeNoteUnarchive: vi.fn((): Promise<void> => Promise.resolve()),
  nativeNoteSoftDelete: vi.fn((): Promise<void> => Promise.resolve()),
}))

vi.mock('@/adapters/web', () => ({
  openWebTaskRepository: mocks.openWebTaskRepository,
}))

vi.mock('@/adapters/native', () => ({
  NativeArchiveRepository: class {
    constructor() {
      mocks.nativeArchiveConstructed()
    }
    list() {
      return mocks.nativeArchiveList()
    }
  },
  NativeTaskRepository: class {
    constructor() {
      mocks.nativeTaskConstructed()
    }
    unarchiveTask() {
      return mocks.nativeTaskUnarchive()
    }
    trashTask() {
      return mocks.nativeTaskTrash()
    }
  },
  NativeNoteRepository: class {
    constructor() {
      mocks.nativeNoteConstructed()
    }
    unarchive() {
      return mocks.nativeNoteUnarchive()
    }
    softDelete() {
      return mocks.nativeNoteSoftDelete()
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
  const archiveRepository = { list: vi.fn(() => Promise.resolve(ITEMS)) }
  const repository = {
    unarchiveTask: vi.fn(() => Promise.resolve(undefined)),
    trashTask: vi.fn(() => Promise.resolve(undefined)),
  }
  const noteRepository = {
    unarchive: vi.fn(() => Promise.resolve()),
    softDelete: vi.fn(() => Promise.resolve()),
  }
  return {
    dispose,
    archiveRepository,
    repository,
    noteRepository,
    result: {
      capability: { status: 'AVAILABLE' },
      archiveRepository,
      repository,
      noteRepository,
      dispose,
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.nativeArchiveList.mockResolvedValue(ITEMS)
  mocks.nativeTaskUnarchive.mockResolvedValue(undefined)
  mocks.nativeTaskTrash.mockResolvedValue(undefined)
  mocks.nativeNoteUnarchive.mockResolvedValue(undefined)
  mocks.nativeNoteSoftDelete.mockResolvedValue(undefined)
})

describe('Web archive runtime composition', () => {
  test('opens the shared Web persistence exactly once, without options', async () => {
    const { result, dispose } = webPersistenceResult()
    mocks.openWebTaskRepository.mockResolvedValue(result)

    const runtime = await openWebArchiveRuntime()

    expect(mocks.openWebTaskRepository).toHaveBeenCalledOnce()
    expect(mocks.openWebTaskRepository).toHaveBeenCalledWith()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('reads the archive through the repository from that same open', async () => {
    const { result, archiveRepository } = webPersistenceResult()
    mocks.openWebTaskRepository.mockResolvedValue(result)

    const runtime = await openWebArchiveRuntime()

    await expect(runtime.service.list()).resolves.toEqual(ITEMS)
    expect(archiveRepository.list).toHaveBeenCalledOnce()
  })

  test('builds canonical services from the same opened repositories', async () => {
    const { result, repository, noteRepository } = webPersistenceResult()
    mocks.openWebTaskRepository.mockResolvedValue(result)

    const runtime = await openWebArchiveRuntime()

    await runtime.service.unarchive({ entityType: 'task', entityId: TASK_ID })
    const taskInput = firstCallArg(repository.unarchiveTask.mock.calls)
    expect(taskInput.id).toBe(TASK_ID)
    expect(typeof taskInput.updatedAtMs).toBe('number')

    await runtime.service.unarchive({ entityType: 'note', entityId: NOTE_ID })
    const noteInput = firstCallArg(noteRepository.unarchive.mock.calls)
    expect(noteInput.id).toBe(NOTE_ID)
    expect(typeof noteInput.updatedAtMs).toBe('number')

    await runtime.service.moveToTrash({ entityType: 'task', entityId: TASK_ID })
    const trashInput = firstCallArg(repository.trashTask.mock.calls)
    expect(trashInput.id).toBe(TASK_ID)
    expect(typeof trashInput.updatedAtMs).toBe('number')

    await runtime.service.moveToTrash({ entityType: 'note', entityId: NOTE_ID })
    const softInput = firstCallArg(noteRepository.softDelete.mock.calls)
    expect(softInput.id).toBe(NOTE_ID)
    expect(typeof softInput.updatedAtMs).toBe('number')

    expect(mocks.openWebTaskRepository).toHaveBeenCalledOnce()
  })

  test('maps a persistence result without archiveRepository to UNAVAILABLE', async () => {
    mocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })

    await expect(openWebArchiveRuntime()).rejects.toBeInstanceOf(
      ArchiveApplicationError,
    )
    await expect(openWebArchiveRuntime()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  test('contains raw shared-persistence failures', async () => {
    mocks.openWebTaskRepository.mockRejectedValue(
      new Error('worker / OPFS / sqlite-wasm detail'),
    )

    const error = await openWebArchiveRuntime().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ArchiveApplicationError)
    expect((error as Error).message).not.toMatch(/worker|OPFS|sqlite/i)
  })
})

describe('Native archive runtime composition', () => {
  test('constructs the Native archive repository and canonical domain services', async () => {
    const runtime = await openNativeArchiveRuntime()

    expect(mocks.nativeArchiveConstructed).toHaveBeenCalledOnce()
    expect(mocks.nativeTaskConstructed).toHaveBeenCalledOnce()
    expect(mocks.nativeNoteConstructed).toHaveBeenCalledOnce()
    expect(mocks.openWebTaskRepository).not.toHaveBeenCalled()
    expect(runtime.dispose()).toBeUndefined()
  })

  test('dispatches unarchive and move-to-trash through canonical Native services', async () => {
    const runtime = await openNativeArchiveRuntime()

    await expect(runtime.service.list()).resolves.toEqual(ITEMS)

    await runtime.service.unarchive({ entityType: 'task', entityId: TASK_ID })
    await runtime.service.unarchive({ entityType: 'note', entityId: NOTE_ID })
    await runtime.service.moveToTrash({ entityType: 'task', entityId: TASK_ID })
    await runtime.service.moveToTrash({ entityType: 'note', entityId: NOTE_ID })

    expect(mocks.nativeTaskUnarchive).toHaveBeenCalledOnce()
    expect(mocks.nativeNoteUnarchive).toHaveBeenCalledOnce()
    expect(mocks.nativeTaskTrash).toHaveBeenCalledOnce()
    expect(mocks.nativeNoteSoftDelete).toHaveBeenCalledOnce()
  })
})
