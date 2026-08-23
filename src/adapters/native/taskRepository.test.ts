import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeTaskRepository } from '@/adapters/native/taskRepository'
import {
  TaskRepositoryError,
  type ChangeTaskStatusInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
} from '@/task/repository'
import {
  defineTaskRepositoryContract,
  TaskRepositoryContractBackend,
  type TaskRepositoryContractFixture,
} from '@/test/taskRepositoryContract'

const invokeMock = vi.hoisted(() => vi.fn())

vi.mock('@tauri-apps/api/core', () => ({
  invoke: invokeMock,
}))

const ID = '12345678-1234-4321-8000-0123456789ab'
const TASK = {
  id: ID,
  title: 'Task',
  status: 'todo',
  createdAtMs: 100,
  updatedAtMs: 100,
  isImportant: false,
  isUrgent: false,
  dueDate: null,
} as const

function createNativeContractFixture(): TaskRepositoryContractFixture {
  invokeMock.mockReset()
  const backend = new TaskRepositoryContractBackend()
  invokeMock.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      switch (command) {
        case 'task_create':
          return backend.createTask(args?.input as CreateTaskInput)
        case 'task_list':
          return backend.listTasks()
        case 'task_rename':
          return backend.renameTask(args?.input as RenameTaskInput)
        case 'task_change_status':
          return backend.changeTaskStatus(args?.input as ChangeTaskStatusInput)
        case 'task_set_importance':
          return backend.setTaskImportance(
            args?.input as SetTaskImportanceInput,
          )
        case 'task_set_urgency':
          return backend.setTaskUrgency(args?.input as SetTaskUrgencyInput)
        case 'task_set_deadline':
          return backend.setTaskDeadline(args?.input as SetTaskDeadlineInput)
        case 'task_clear_deadline':
          return backend.clearTaskDeadline(
            args?.input as ClearTaskDeadlineInput,
          )
        default:
          throw new Error(`Unexpected native command: ${command}`)
      }
    },
  )
  return { repository: new NativeTaskRepository(), backend }
}

describe('NativeTaskRepository', () => {
  beforeEach(() => {
    invokeMock.mockReset()
  })

  test('uses capability-specific commands and camelCase DTOs', async () => {
    const repository = new NativeTaskRepository()
    invokeMock
      .mockResolvedValueOnce(TASK)
      .mockResolvedValueOnce([{ ...TASK, title: 'Renamed', updatedAtMs: 200 }])
      .mockResolvedValueOnce({ ...TASK, title: 'Renamed', updatedAtMs: 200 })
      .mockResolvedValueOnce({
        ...TASK,
        status: 'doing',
        updatedAtMs: 300,
      })
      .mockResolvedValueOnce({ ...TASK, isImportant: true, updatedAtMs: 400 })
      .mockResolvedValueOnce({ ...TASK, isUrgent: true, updatedAtMs: 500 })
      .mockResolvedValueOnce({
        ...TASK,
        dueDate: '2026-08-23',
        updatedAtMs: 600,
      })
      .mockResolvedValueOnce({ ...TASK, updatedAtMs: 700 })

    await repository.createTask({ id: ID, title: 'Task', createdAtMs: 100 })
    await repository.listTasks()
    await repository.renameTask({ id: ID, title: 'Renamed', updatedAtMs: 200 })
    await repository.changeTaskStatus({
      id: ID,
      operation: 'start',
      updatedAtMs: 300,
    })
    await repository.setTaskImportance({
      id: ID,
      isImportant: true,
      updatedAtMs: 400,
    })
    await repository.setTaskUrgency({
      id: ID,
      isUrgent: true,
      updatedAtMs: 500,
    })
    await repository.setTaskDeadline({
      id: ID,
      dueDate: '2026-08-23',
      updatedAtMs: 600,
    })
    await repository.clearTaskDeadline({ id: ID, updatedAtMs: 700 })

    expect(invokeMock.mock.calls).toEqual([
      [
        'task_create',
        {
          input: {
            id: ID,
            title: 'Task',
            createdAtMs: 100,
            isImportant: false,
            isUrgent: false,
            dueDate: null,
          },
        },
      ],
      ['task_list', undefined],
      [
        'task_rename',
        { input: { id: ID, title: 'Renamed', updatedAtMs: 200 } },
      ],
      [
        'task_change_status',
        { input: { id: ID, operation: 'start', updatedAtMs: 300 } },
      ],
      [
        'task_set_importance',
        { input: { id: ID, isImportant: true, updatedAtMs: 400 } },
      ],
      [
        'task_set_urgency',
        { input: { id: ID, isUrgent: true, updatedAtMs: 500 } },
      ],
      [
        'task_set_deadline',
        { input: { id: ID, dueDate: '2026-08-23', updatedAtMs: 600 } },
      ],
      ['task_clear_deadline', { input: { id: ID, updatedAtMs: 700 } }],
    ])
  })

  test('strictly parses Task DTOs', async () => {
    const repository = new NativeTaskRepository()
    invokeMock
      .mockResolvedValueOnce(TASK)
      .mockResolvedValueOnce({ ...TASK, updatedAtMs: -1 })
      .mockResolvedValueOnce({ ...TASK, isImportant: 1 })
      .mockResolvedValueOnce({ ...TASK, isUrgent: 'true' })
      .mockResolvedValueOnce({ ...TASK, dueDate: '2025-02-29' })

    await expect(
      repository.createTask({ id: ID, title: 'Task', createdAtMs: 100 }),
    ).resolves.toEqual(TASK)
    for (let index = 0; index < 4; index += 1) {
      await expect(repository.listTasks()).rejects.toMatchObject({
        code: 'PERSISTENCE_FAILED',
        operation: 'listTasks',
      })
    }
  })

  test('maps known safe errors without exposing the native message', async () => {
    const repository = new NativeTaskRepository()
    invokeMock.mockRejectedValue({
      code: 'NOT_FOUND',
      message: 'C:\\secret\\zhixing.db SQL=UPDATE tasks',
    })

    const promise = repository.renameTask({
      id: ID,
      title: 'Renamed',
      updatedAtMs: 200,
    })
    await expect(promise).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Task not found.',
    })
    await expect(promise).rejects.not.toThrow(/secret|UPDATE tasks/)
  })

  test('maps unknown rejections to a safe availability error', async () => {
    const repository = new NativeTaskRepository()
    invokeMock.mockRejectedValue(
      new Error('token=secret SQL=SELECT * FROM tasks'),
    )

    const promise = repository.listTasks()
    await expect(promise).rejects.toEqual(
      new TaskRepositoryError('PERSISTENCE_UNAVAILABLE', 'listTasks'),
    )
    await expect(promise).rejects.not.toThrow(/token|SELECT/)
  })

  test('does not reorder the list returned by the native persistence contract', async () => {
    const repository = new NativeTaskRepository()
    const first = { ...TASK, id: '00000000-0000-0000-0000-000000000002' }
    const second = { ...TASK, id: '00000000-0000-0000-0000-000000000001' }
    invokeMock.mockResolvedValue([first, second])

    await expect(repository.listTasks()).resolves.toEqual([first, second])
  })

  test('rejects invalid persistence input before invoking native code', async () => {
    const repository = new NativeTaskRepository()

    await expect(
      repository.createTask({ id: 'invalid', title: 'Task', createdAtMs: 0 }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    await expect(
      repository.renameTask({ id: ID, title: '   ', updatedAtMs: 1 }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    await expect(
      repository.changeTaskStatus({
        id: ID,
        operation: 'pause' as never,
        updatedAtMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    await expect(
      repository.setTaskImportance({
        id: ID,
        isImportant: 'yes' as never,
        updatedAtMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    await expect(
      repository.setTaskDeadline({
        id: ID,
        dueDate: '2026-02-30',
        updatedAtMs: 1,
      }),
    ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    expect(invokeMock).not.toHaveBeenCalled()
  })
})

defineTaskRepositoryContract(
  'NativeTaskRepository',
  createNativeContractFixture,
)
