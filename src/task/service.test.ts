import { describe, expect, test, vi } from 'vitest'

import type { Task, TaskStatusOperation } from '@/task/model'
import {
  TaskRepositoryError,
  type ChangeTaskStatusInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
  type TaskRepository,
  type TaskRepositoryErrorCode,
} from '@/task/repository'
import {
  createTaskService,
  TASK_APPLICATION_ERROR_CODES,
  TaskApplicationError,
  type TaskApplicationErrorCode,
  type TaskApplicationErrorField,
} from '@/task/service'

const ID = '00000000-0000-4000-8000-000000000001'
const TASK: Task = {
  id: ID,
  title: 'Task',
  status: 'todo',
  createdAtMs: 100,
  updatedAtMs: 100,
  isImportant: false,
  isUrgent: false,
  dueDate: null,
  projectId: null,
}

function createFakeRepository() {
  const createTask = vi.fn((input: CreateTaskInput): Promise<Task> =>
    Promise.resolve({
      ...TASK,
      ...input,
      status: 'todo',
      updatedAtMs: input.createdAtMs,
    }),
  )
  const listTasks = vi.fn((): Promise<readonly Task[]> =>
    Promise.resolve([TASK]),
  )
  const renameTask = vi.fn((input: RenameTaskInput): Promise<Task> =>
    Promise.resolve({
      ...TASK,
      ...input,
    }),
  )
  const changeTaskStatus = vi.fn(
    (input: ChangeTaskStatusInput): Promise<Task> =>
      Promise.resolve({
        ...TASK,
        updatedAtMs: input.updatedAtMs,
      }),
  )
  const setTaskImportance = vi.fn(
    (input: SetTaskImportanceInput): Promise<Task> =>
      Promise.resolve({
        ...TASK,
        isImportant: input.isImportant,
        updatedAtMs: input.updatedAtMs,
      }),
  )
  const setTaskUrgency = vi.fn((input: SetTaskUrgencyInput): Promise<Task> =>
    Promise.resolve({
      ...TASK,
      isUrgent: input.isUrgent,
      updatedAtMs: input.updatedAtMs,
    }),
  )
  const setTaskDeadline = vi.fn((input: SetTaskDeadlineInput): Promise<Task> =>
    Promise.resolve({
      ...TASK,
      dueDate: input.dueDate,
      updatedAtMs: input.updatedAtMs,
    }),
  )
  const clearTaskDeadline = vi.fn(
    (input: ClearTaskDeadlineInput): Promise<Task> =>
      Promise.resolve({
        ...TASK,
        dueDate: null,
        updatedAtMs: input.updatedAtMs,
      }),
  )
  const setTaskProject = vi.fn(
    (input: import('@/task/repository').SetTaskProjectInput): Promise<Task> =>
      Promise.resolve({
        ...TASK,
        projectId: input.projectId,
        updatedAtMs: input.updatedAtMs,
      }),
  )
  const clearTaskProject = vi.fn(
    (input: import('@/task/repository').ClearTaskProjectInput): Promise<Task> =>
      Promise.resolve({
        ...TASK,
        projectId: null,
        updatedAtMs: input.updatedAtMs,
      }),
  )
  const repository: TaskRepository = {
    createTask,
    listTasks,
    renameTask,
    changeTaskStatus,
    setTaskImportance,
    setTaskUrgency,
    setTaskDeadline,
    clearTaskDeadline,
    setTaskProject,
    clearTaskProject,
  }
  return {
    repository,
    createTask,
    listTasks,
    renameTask,
    changeTaskStatus,
    setTaskImportance,
    setTaskUrgency,
    setTaskDeadline,
    clearTaskDeadline,
    setTaskProject,
    clearTaskProject,
  }
}

async function expectApplicationError(
  promise: Promise<unknown>,
  code: TaskApplicationErrorCode,
  field?: TaskApplicationErrorField,
): Promise<void> {
  const error = await promise.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(TaskApplicationError)
  expect(error).toMatchObject({ code, field })
  expect((error as Error).message).not.toMatch(
    /SQL|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
  )
}

test('TaskService exposes only the approved business API and error codes', () => {
  const fake = createFakeRepository()
  const service = createTaskService({ repository: fake.repository })

  expect(Object.keys(service)).toEqual([
    'createTask',
    'listTasks',
    'renameTask',
    'startTask',
    'completeTask',
    'cancelTask',
    'reopenTask',
    'setTaskImportance',
    'setTaskUrgency',
    'setTaskDeadline',
    'clearTaskDeadline',
    'setTaskProject',
    'clearTaskProject',
  ])
  expect(TASK_APPLICATION_ERROR_CODES).toEqual([
    'VALIDATION',
    'NOT_FOUND',
    'STATUS_CONFLICT',
    'UNAVAILABLE',
  ])
})

describe('TaskService createTask', () => {
  test('owns title normalization, UUID generation, and creation time', async () => {
    const fake = createFakeRepository()
    const generateTaskId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId,
      nowMs,
    })

    await expect(
      service.createTask({ title: '  Buy milk  ' }),
    ).resolves.toEqual({ ...TASK, title: 'Buy milk' })
    expect(generateTaskId).toHaveBeenCalledOnce()
    expect(nowMs).toHaveBeenCalledOnce()
    expect(fake.createTask).toHaveBeenCalledWith({
      id: ID,
      title: 'Buy milk',
      createdAtMs: 100,
      isImportant: false,
      isUrgent: false,
      dueDate: null,
      projectId: null,
    })
  })

  test('atomically passes approved planning values to repository creation', async () => {
    const fake = createFakeRepository()
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId: () => ID,
      nowMs: () => 100,
    })

    await service.createTask({
      title: 'Planned',
      isImportant: true,
      isUrgent: true,
      dueDate: '2024-02-29',
      projectId: null,
    })

    expect(fake.createTask).toHaveBeenCalledOnce()
    expect(fake.createTask).toHaveBeenCalledWith({
      id: ID,
      title: 'Planned',
      createdAtMs: 100,
      isImportant: true,
      isUrgent: true,
      dueDate: '2024-02-29',
      projectId: null,
    })
  })

  test('rejects invalid planning values before creating', async () => {
    const fake = createFakeRepository()
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId: () => ID,
      nowMs: () => 100,
    })

    await expectApplicationError(
      service.createTask({ title: 'Task', dueDate: '2025-02-29' }),
      'VALIDATION',
      'dueDate',
    )
    await expectApplicationError(
      service.createTask({ title: 'Task', isImportant: 'yes' as never }),
      'VALIDATION',
      'importance',
    )
    await expectApplicationError(
      service.createTask({ title: 'Task', isImportant: null as never }),
      'VALIDATION',
      'importance',
    )
    await expectApplicationError(
      service.createTask({ title: 'Task', isUrgent: 1 as never }),
      'VALIDATION',
      'urgency',
    )
    expect(fake.createTask).not.toHaveBeenCalled()
  })

  test('rejects a blank title before calling runtime dependencies or persistence', async () => {
    const fake = createFakeRepository()
    const generateTaskId = vi.fn(() => ID)
    const nowMs = vi.fn(() => 100)
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId,
      nowMs,
    })

    await expectApplicationError(
      service.createTask({ title: '     ' }),
      'VALIDATION',
      'title',
    )
    expect(generateTaskId).not.toHaveBeenCalled()
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.createTask).not.toHaveBeenCalled()
  })

  test('fails safely when the injected UUID is not canonical lowercase', async () => {
    const fake = createFakeRepository()
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId: () => '12345678-1234-4ABC-8DEF-0123456789AB',
      nowMs: () => 100,
    })

    await expectApplicationError(
      service.createTask({ title: 'Task' }),
      'UNAVAILABLE',
    )
    expect(fake.createTask).not.toHaveBeenCalled()
  })

  test.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    'fails safely when the clock returns %s',
    async (timestamp) => {
      const fake = createFakeRepository()
      const service = createTaskService({
        repository: fake.repository,
        generateTaskId: () => ID,
        nowMs: () => timestamp,
      })

      await expectApplicationError(
        service.createTask({ title: 'Task' }),
        'UNAVAILABLE',
      )
      expect(fake.createTask).not.toHaveBeenCalled()
    },
  )

  test('maps persistence failure to a safe unavailable error', async () => {
    const fake = createFakeRepository()
    fake.createTask.mockRejectedValueOnce(
      new TaskRepositoryError('PERSISTENCE_FAILED', 'createTask'),
    )
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId: () => ID,
      nowMs: () => 100,
    })

    await expectApplicationError(
      service.createTask({ title: 'Task' }),
      'UNAVAILABLE',
    )
  })
})

describe('TaskService renameTask', () => {
  test('owns title normalization and updated time', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createTaskService({
      repository: fake.repository,
      nowMs,
    })

    await expect(
      service.renameTask({ id: ID, title: '  Renamed  ' }),
    ).resolves.toEqual({ ...TASK, title: 'Renamed', updatedAtMs: 200 })
    expect(nowMs).toHaveBeenCalledOnce()
    expect(fake.renameTask).toHaveBeenCalledWith({
      id: ID,
      title: 'Renamed',
      updatedAtMs: 200,
    })
  })

  test('maps blank title and invalid id to field validation errors', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createTaskService({
      repository: fake.repository,
      nowMs,
    })

    await expectApplicationError(
      service.renameTask({ id: ID, title: '  ' }),
      'VALIDATION',
      'title',
    )
    await expectApplicationError(
      service.renameTask({ id: 'invalid', title: 'Task' }),
      'VALIDATION',
      'id',
    )
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.renameTask).not.toHaveBeenCalled()
  })

  test('maps repository NOT_FOUND without leaking persistence details', async () => {
    const fake = createFakeRepository()
    fake.renameTask.mockRejectedValueOnce(
      new TaskRepositoryError('NOT_FOUND', 'renameTask'),
    )
    const service = createTaskService({
      repository: fake.repository,
      nowMs: () => 200,
    })

    await expectApplicationError(
      service.renameTask({ id: ID, title: 'Renamed' }),
      'NOT_FOUND',
    )
  })
})

describe('TaskService status actions', () => {
  test.each<{
    method: 'startTask' | 'completeTask' | 'cancelTask' | 'reopenTask'
    operation: TaskStatusOperation
  }>([
    { method: 'startTask', operation: 'start' },
    { method: 'completeTask', operation: 'complete' },
    { method: 'cancelTask', operation: 'cancel' },
    { method: 'reopenTask', operation: 'reopen' },
  ])(
    '$method maps to $operation with service-owned time',
    async ({ method, operation }) => {
      const fake = createFakeRepository()
      const nowMs = vi.fn(() => 300)
      const service = createTaskService({
        repository: fake.repository,
        nowMs,
      })

      await service[method](ID)

      expect(nowMs).toHaveBeenCalledOnce()
      expect(fake.changeTaskStatus).toHaveBeenCalledWith({
        id: ID,
        operation,
        updatedAtMs: 300,
      })
    },
  )

  test.each<{
    repositoryCode: TaskRepositoryErrorCode
    applicationCode: TaskApplicationErrorCode
  }>([
    { repositoryCode: 'NOT_FOUND', applicationCode: 'NOT_FOUND' },
    {
      repositoryCode: 'STATUS_CONFLICT',
      applicationCode: 'STATUS_CONFLICT',
    },
    {
      repositoryCode: 'PERSISTENCE_UNAVAILABLE',
      applicationCode: 'UNAVAILABLE',
    },
    {
      repositoryCode: 'PERSISTENCE_FAILED',
      applicationCode: 'UNAVAILABLE',
    },
  ])(
    'maps $repositoryCode to $applicationCode',
    async ({ repositoryCode, applicationCode }) => {
      const fake = createFakeRepository()
      fake.changeTaskStatus.mockRejectedValueOnce(
        new TaskRepositoryError(repositoryCode, 'changeTaskStatus'),
      )
      const service = createTaskService({
        repository: fake.repository,
        nowMs: () => 300,
      })

      await expectApplicationError(service.startTask(ID), applicationCode)
    },
  )
})

describe('TaskService planning actions', () => {
  test('maps each narrow action with a service-owned timestamp', async () => {
    const fake = createFakeRepository()
    const nowMs = vi
      .fn<() => number>()
      .mockReturnValueOnce(200)
      .mockReturnValueOnce(300)
      .mockReturnValueOnce(400)
      .mockReturnValueOnce(500)
    const service = createTaskService({ repository: fake.repository, nowMs })

    await service.setTaskImportance(ID, true)
    await service.setTaskUrgency(ID, true)
    await service.setTaskDeadline(ID, '2026-08-23')
    await service.clearTaskDeadline(ID)

    expect(fake.setTaskImportance).toHaveBeenCalledWith({
      id: ID,
      isImportant: true,
      updatedAtMs: 200,
    })
    expect(fake.setTaskUrgency).toHaveBeenCalledWith({
      id: ID,
      isUrgent: true,
      updatedAtMs: 300,
    })
    expect(fake.setTaskDeadline).toHaveBeenCalledWith({
      id: ID,
      dueDate: '2026-08-23',
      updatedAtMs: 400,
    })
    expect(fake.clearTaskDeadline).toHaveBeenCalledWith({
      id: ID,
      updatedAtMs: 500,
    })
  })

  test('validates planning inputs before reading the clock', async () => {
    const fake = createFakeRepository()
    const nowMs = vi.fn(() => 200)
    const service = createTaskService({ repository: fake.repository, nowMs })

    await expectApplicationError(
      service.setTaskImportance(ID, 'yes' as never),
      'VALIDATION',
      'importance',
    )
    await expectApplicationError(
      service.setTaskUrgency(ID, 1 as never),
      'VALIDATION',
      'urgency',
    )
    await expectApplicationError(
      service.setTaskDeadline(ID, '2026-02-30'),
      'VALIDATION',
      'dueDate',
    )
    await expectApplicationError(
      service.clearTaskDeadline('invalid'),
      'VALIDATION',
      'id',
    )
    expect(nowMs).not.toHaveBeenCalled()
    expect(fake.setTaskImportance).not.toHaveBeenCalled()
    expect(fake.setTaskUrgency).not.toHaveBeenCalled()
    expect(fake.setTaskDeadline).not.toHaveBeenCalled()
    expect(fake.clearTaskDeadline).not.toHaveBeenCalled()
  })

  test.each<{
    repositoryCode: TaskRepositoryErrorCode
    applicationCode: TaskApplicationErrorCode
  }>([
    { repositoryCode: 'NOT_FOUND', applicationCode: 'NOT_FOUND' },
    {
      repositoryCode: 'PERSISTENCE_UNAVAILABLE',
      applicationCode: 'UNAVAILABLE',
    },
    {
      repositoryCode: 'PERSISTENCE_FAILED',
      applicationCode: 'UNAVAILABLE',
    },
  ])(
    'maps planning $repositoryCode to $applicationCode',
    async ({ repositoryCode, applicationCode }) => {
      const fake = createFakeRepository()
      fake.setTaskImportance.mockRejectedValueOnce(
        new TaskRepositoryError(repositoryCode, 'setTaskImportance'),
      )
      const service = createTaskService({
        repository: fake.repository,
        nowMs: () => 200,
      })

      await expectApplicationError(
        service.setTaskImportance(ID, true),
        applicationCode,
      )
    },
  )
})

describe('TaskService listTasks', () => {
  test('returns the repository array unchanged without reordering tasks', async () => {
    const fake = createFakeRepository()
    const tasks = [
      { ...TASK, id: '00000000-0000-4000-8000-000000000002' },
      TASK,
    ] as const
    fake.listTasks.mockResolvedValueOnce(tasks)
    const service = createTaskService({ repository: fake.repository })

    const result = await service.listTasks()

    expect(result).toBe(tasks)
    expect(result[0]).toBe(tasks[0])
    expect(fake.listTasks).toHaveBeenCalledOnce()
  })

  test.each<TaskRepositoryErrorCode>([
    'PERSISTENCE_UNAVAILABLE',
    'PERSISTENCE_FAILED',
  ])('maps %s to UNAVAILABLE', async (repositoryCode) => {
    const fake = createFakeRepository()
    fake.listTasks.mockRejectedValueOnce(
      new TaskRepositoryError(repositoryCode, 'listTasks'),
    )
    const service = createTaskService({ repository: fake.repository })

    await expectApplicationError(service.listTasks(), 'UNAVAILABLE')
  })

  test('maps an unknown repository rejection to a safe unavailable error', async () => {
    const fake = createFakeRepository()
    fake.listTasks.mockRejectedValueOnce(
      new Error('SQL=SELECT * FROM tasks C:\\private\\zhixing.db'),
    )
    const service = createTaskService({ repository: fake.repository })

    await expectApplicationError(service.listTasks(), 'UNAVAILABLE')
  })
})

describe('TaskService project assignment', () => {
  test('creates with project in the single repository create call', async () => {
    const fake = createFakeRepository()
    const service = createTaskService({
      repository: fake.repository,
      generateTaskId: () => ID,
      nowMs: () => 200,
    })
    const projectId = '00000000-0000-4000-8000-000000000101'
    await service.createTask({ title: ' Project task ', projectId })
    expect(fake.createTask).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        title: 'Project task',
        projectId,
        createdAtMs: 200,
      }),
    )
    expect(fake.createTask).toHaveBeenCalledOnce()
  })

  test('sets and clears project with fresh timestamps', async () => {
    const fake = createFakeRepository()
    const service = createTaskService({
      repository: fake.repository,
      nowMs: () => 300,
    })
    const projectId = '00000000-0000-4000-8000-000000000101'
    await service.setTaskProject(ID, projectId)
    expect(fake.setTaskProject).toHaveBeenCalledWith({
      id: ID,
      projectId,
      updatedAtMs: 300,
    })
    await service.clearTaskProject(ID)
    expect(fake.clearTaskProject).toHaveBeenCalledWith({
      id: ID,
      updatedAtMs: 300,
    })
  })

  test('rejects invalid project id before persistence', async () => {
    const fake = createFakeRepository()
    const service = createTaskService({ repository: fake.repository })
    await expectApplicationError(
      service.setTaskProject(ID, 'INVALID'),
      'VALIDATION',
      'projectId',
    )
    expect(fake.setTaskProject).not.toHaveBeenCalled()
  })
})
