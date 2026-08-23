import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { Task } from '@/task/model'
import { TaskApplicationError } from '@/task/service'
import { openTaskRuntime as openNativeTaskRuntime } from '@/task/runtime.native'
import { openTaskRuntime as openWebTaskRuntime } from '@/task/runtime'

const TASK: Task = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Task',
  status: 'todo',
  createdAtMs: 100,
  updatedAtMs: 100,
  isImportant: false,
  isUrgent: false,
  dueDate: null,
  projectId: null,
  tagIds: [],
  deletedAtMs: null,
}

const runtimeMocks = vi.hoisted(() => ({
  openWebTaskRepository: vi.fn(),
  nativeConstructed: vi.fn(),
  nativeListTasks: vi.fn(),
  nativeListProjects: vi.fn(),
  nativeListTags: vi.fn(),
}))

vi.mock('@/adapters/web', () => ({
  openWebTaskRepository: runtimeMocks.openWebTaskRepository,
}))

vi.mock('@/adapters/native', () => ({
  NativeTaskRepository: class {
    constructor() {
      runtimeMocks.nativeConstructed()
    }

    createTask(): Promise<Task> {
      return Promise.resolve(TASK)
    }

    listTasks(): Promise<readonly Task[]> {
      return runtimeMocks.nativeListTasks() as Promise<readonly Task[]>
    }

    renameTask(): Promise<Task> {
      return Promise.resolve(TASK)
    }

    changeTaskStatus(): Promise<Task> {
      return Promise.resolve(TASK)
    }
  },
  NativeProjectRepository: class {
    listProjects(): Promise<readonly never[]> {
      return runtimeMocks.nativeListProjects() as Promise<readonly never[]>
    }
  },
  NativeTagRepository: class {
    listTags(): Promise<readonly never[]> {
      return runtimeMocks.nativeListTags() as Promise<readonly never[]>
    }
  },
}))

describe('Task runtime composition', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    runtimeMocks.nativeListTasks.mockResolvedValue([TASK])
    runtimeMocks.nativeListProjects.mockResolvedValue([])
    runtimeMocks.nativeListTags.mockResolvedValue([])
  })

  test('Web composition opens only Web persistence and preserves disposal', async () => {
    const dispose = vi.fn(() => Promise.resolve())
    const repository = {
      createTask: vi.fn(),
      listTasks: vi.fn(() => Promise.resolve([TASK])),
      renameTask: vi.fn(),
      changeTaskStatus: vi.fn(),
    }
    runtimeMocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'AVAILABLE' },
      repository,
      projectRepository: {
        createProject: vi.fn(),
        listProjects: vi.fn(() => Promise.resolve([])),
        renameProject: vi.fn(),
      },
      tagRepository: {
        createTag: vi.fn(),
        listTags: vi.fn(() => Promise.resolve([])),
        renameTag: vi.fn(),
      },
      dispose,
    })

    const runtime = await openWebTaskRuntime()

    await expect(runtime.service.listTasks()).resolves.toEqual([TASK])
    expect(runtimeMocks.openWebTaskRepository).toHaveBeenCalledOnce()
    expect(runtimeMocks.nativeConstructed).not.toHaveBeenCalled()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('Web composition fails safely when OPFS capability is unavailable', async () => {
    runtimeMocks.openWebTaskRepository.mockResolvedValue({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })

    await expect(openWebTaskRuntime()).rejects.toEqual(
      new TaskApplicationError('UNAVAILABLE'),
    )
    expect(runtimeMocks.nativeConstructed).not.toHaveBeenCalled()
  })

  test('Native composition selects only Native persistence', async () => {
    const runtime = await openNativeTaskRuntime()

    await expect(runtime.service.listTasks()).resolves.toEqual([TASK])
    expect(runtimeMocks.nativeConstructed).toHaveBeenCalledOnce()
    expect(runtimeMocks.openWebTaskRepository).not.toHaveBeenCalled()
    expect(runtime.dispose()).toBeUndefined()
  })
})
