import { describe, expect, test } from 'vitest'

import {
  TASK_STATUSES,
  TASK_STATUS_OPERATIONS,
  type Task,
  type TaskStatus,
  type TaskStatusOperation,
} from '@/task/model'
import {
  TASK_REPOSITORY_ERROR_CODES,
  TaskRepositoryError,
  type ChangeTaskStatusInput,
  type AddTaskTagInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type RemoveTaskTagInput,
  type RestoreTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
  type TaskRepository,
  type TaskRepositoryErrorCode,
  type TaskRepositoryOperation,
  type TrashTaskInput,
} from '@/task/repository'

export const TASK_CONTRACT_IDS = {
  a: '00000000-0000-4000-8000-000000000001',
  b: '00000000-0000-4000-8000-000000000002',
  c: '00000000-0000-4000-8000-000000000003',
  missing: '00000000-0000-4000-8000-000000000099',
} as const

export interface TaskStatusTransitionVector {
  readonly current: TaskStatus
  readonly operation: TaskStatusOperation
  readonly target: TaskStatus
}

export const LEGAL_TASK_STATUS_TRANSITIONS: readonly TaskStatusTransitionVector[] =
  [
    { current: 'todo', operation: 'start', target: 'doing' },
    { current: 'todo', operation: 'complete', target: 'completed' },
    { current: 'doing', operation: 'complete', target: 'completed' },
    { current: 'todo', operation: 'cancel', target: 'cancelled' },
    { current: 'doing', operation: 'cancel', target: 'cancelled' },
    { current: 'completed', operation: 'reopen', target: 'todo' },
    { current: 'cancelled', operation: 'reopen', target: 'todo' },
  ]

export const INVALID_TASK_STATUS_TRANSITIONS = TASK_STATUSES.flatMap(
  (current) =>
    TASK_STATUS_OPERATIONS.filter(
      (operation) =>
        !LEGAL_TASK_STATUS_TRANSITIONS.some(
          (vector) =>
            vector.current === current && vector.operation === operation,
        ),
    ).map((operation) => ({ current, operation })),
)

export class TaskContractBackendError extends Error {
  readonly code: TaskRepositoryErrorCode
  readonly rawDetails: string

  constructor(code: TaskRepositoryErrorCode, rawDetails: string) {
    super(rawDetails)
    this.name = 'TaskContractBackendError'
    this.code = code
    this.rawDetails = rawDetails
  }
}

export class TaskRepositoryContractBackend {
  readonly #tasks = new Map<string, Task>()
  readonly #tags = new Set([
    '00000000-0000-4000-8000-000000000101',
    '00000000-0000-4000-8000-000000000102',
  ])
  #nextFailure: TaskContractBackendError | null = null

  failNext(code: TaskRepositoryErrorCode, rawDetails: string): void {
    this.#nextFailure = new TaskContractBackendError(code, rawDetails)
  }

  createTask(input: CreateTaskInput): Task {
    this.consumeFailure()
    if (this.#tasks.has(input.id)) {
      throw new TaskContractBackendError(
        'PERSISTENCE_FAILED',
        'UNIQUE constraint failed: tasks.id SQL=INSERT INTO tasks',
      )
    }
    if (input.tagIds?.some((tagId) => !this.#tags.has(tagId))) {
      throw new TaskContractBackendError('NOT_FOUND', 'missing tag')
    }
    const task: Task = {
      id: input.id,
      title: input.title,
      status: 'todo',
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
      isImportant: input.isImportant ?? false,
      isUrgent: input.isUrgent ?? false,
      dueDate: input.dueDate ?? null,
      projectId: input.projectId ?? null,
      tagIds: input.tagIds ?? [],
      deletedAtMs: null,
    }
    this.#tasks.set(task.id, task)
    return { ...task }
  }

  listTasks(): readonly Task[] {
    this.consumeFailure()
    return [...this.#tasks.values()]
      .filter((task) => task.deletedAtMs === null)
      .sort(
        (left, right) =>
          right.updatedAtMs - left.updatedAtMs ||
          left.id.localeCompare(right.id),
      )
      .map((task) => ({ ...task }))
  }

  listTrashedTasks(): readonly Task[] {
    this.consumeFailure()
    return [...this.#tasks.values()]
      .filter((task) => task.deletedAtMs !== null)
      .sort(
        (left, right) =>
          right.deletedAtMs! - left.deletedAtMs! ||
          left.id.localeCompare(right.id),
      )
      .map((task) => ({ ...task }))
  }

  trashTask(input: TrashTaskInput): Task {
    this.consumeFailure()
    const current = this.requireActive(input.id)
    const changed = {
      ...current,
      deletedAtMs: input.updatedAtMs,
      updatedAtMs: input.updatedAtMs,
    }
    this.#tasks.set(input.id, changed)
    return { ...changed }
  }

  restoreTask(input: RestoreTaskInput): Task {
    this.consumeFailure()
    const current = this.#tasks.get(input.id)
    if (current?.deletedAtMs === null || current === undefined) {
      throw new TaskContractBackendError('NOT_FOUND', 'task not trashed')
    }
    const changed = {
      ...current,
      deletedAtMs: null,
      updatedAtMs: input.updatedAtMs,
    }
    this.#tasks.set(input.id, changed)
    return { ...changed }
  }

  renameTask(input: RenameTaskInput): Task {
    this.consumeFailure()
    const current = this.#tasks.get(input.id)
    if (current === undefined || current.deletedAtMs !== null) {
      throw new TaskContractBackendError(
        'NOT_FOUND',
        'C:\\private\\zhixing.db SQL=UPDATE tasks',
      )
    }
    const renamed = {
      ...current,
      title: input.title,
      updatedAtMs: input.updatedAtMs,
    }
    this.#tasks.set(input.id, renamed)
    return { ...renamed }
  }

  changeTaskStatus(input: ChangeTaskStatusInput): Task {
    this.consumeFailure()
    const current = this.#tasks.get(input.id)
    if (current === undefined || current.deletedAtMs !== null) {
      throw new TaskContractBackendError(
        'NOT_FOUND',
        '/private/opfs/zhixing.db SQL=SELECT status FROM tasks',
      )
    }
    const target = LEGAL_TASK_STATUS_TRANSITIONS.find(
      (vector) =>
        vector.current === current.status &&
        vector.operation === input.operation,
    )?.target
    if (target === undefined) {
      throw new TaskContractBackendError(
        'STATUS_CONFLICT',
        'WASM stack SQL=UPDATE tasks SET status',
      )
    }
    const changed = {
      ...current,
      status: target,
      updatedAtMs: input.updatedAtMs,
    }
    this.#tasks.set(input.id, changed)
    return { ...changed }
  }

  setTaskImportance(input: SetTaskImportanceInput): Task {
    return this.updatePlanning(input.id, input.updatedAtMs, {
      isImportant: input.isImportant,
    })
  }

  setTaskUrgency(input: SetTaskUrgencyInput): Task {
    return this.updatePlanning(input.id, input.updatedAtMs, {
      isUrgent: input.isUrgent,
    })
  }

  setTaskDeadline(input: SetTaskDeadlineInput): Task {
    return this.updatePlanning(input.id, input.updatedAtMs, {
      dueDate: input.dueDate,
    })
  }

  clearTaskDeadline(input: ClearTaskDeadlineInput): Task {
    return this.updatePlanning(input.id, input.updatedAtMs, { dueDate: null })
  }

  setTaskProject(input: import('@/task/repository').SetTaskProjectInput): Task {
    return this.updatePlanning(input.id, input.updatedAtMs, {
      projectId: input.projectId,
    })
  }

  clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Task {
    return this.updatePlanning(input.id, input.updatedAtMs, { projectId: null })
  }

  addTaskTag(input: AddTaskTagInput): Task {
    this.consumeFailure()
    const task = this.#tasks.get(input.id)
    if (
      task === undefined ||
      task.deletedAtMs !== null ||
      !this.#tags.has(input.tagId)
    ) {
      throw new TaskContractBackendError('NOT_FOUND', 'missing task or tag')
    }
    if (task.tagIds.includes(input.tagId)) {
      throw new TaskContractBackendError('PERSISTENCE_FAILED', 'duplicate link')
    }
    const changed = {
      ...task,
      tagIds: [...task.tagIds, input.tagId].sort(),
      updatedAtMs: input.updatedAtMs,
    }
    this.#tasks.set(input.id, changed)
    return { ...changed }
  }

  removeTaskTag(input: RemoveTaskTagInput): Task {
    this.consumeFailure()
    const task = this.#tasks.get(input.id)
    if (
      task === undefined ||
      task.deletedAtMs !== null ||
      !task.tagIds.includes(input.tagId)
    ) {
      throw new TaskContractBackendError('NOT_FOUND', 'missing task tag')
    }
    const changed = {
      ...task,
      tagIds: task.tagIds.filter((tagId) => tagId !== input.tagId),
      updatedAtMs: input.updatedAtMs,
    }
    this.#tasks.set(input.id, changed)
    return { ...changed }
  }

  private updatePlanning(
    id: string,
    updatedAtMs: number,
    change: Partial<
      Pick<Task, 'isImportant' | 'isUrgent' | 'dueDate' | 'projectId'>
    >,
  ): Task {
    this.consumeFailure()
    const current = this.#tasks.get(id)
    if (current === undefined || current.deletedAtMs !== null) {
      throw new TaskContractBackendError(
        'NOT_FOUND',
        '/private/task planning SQL=UPDATE tasks',
      )
    }
    const changed = { ...current, ...change, updatedAtMs }
    this.#tasks.set(id, changed)
    return { ...changed }
  }

  private requireActive(id: string): Task {
    const task = this.#tasks.get(id)
    if (task === undefined || task.deletedAtMs !== null) {
      throw new TaskContractBackendError('NOT_FOUND', 'task not active')
    }
    return task
  }

  private consumeFailure(): void {
    if (this.#nextFailure === null) {
      return
    }
    const failure = this.#nextFailure
    this.#nextFailure = null
    throw failure
  }
}

export interface TaskRepositoryContractFixture {
  readonly repository: TaskRepository
  readonly backend: TaskRepositoryContractBackend
}

export type TaskRepositoryContractFixtureFactory =
  () => TaskRepositoryContractFixture

async function expectSafeError(
  promise: Promise<unknown>,
  code: TaskRepositoryErrorCode,
  operation: TaskRepositoryOperation,
): Promise<void> {
  const error = await promise.catch((value: unknown) => value)
  expect(error).toBeInstanceOf(TaskRepositoryError)
  expect(error).toMatchObject({ code, operation })
  expect((error as Error).message).not.toMatch(
    /SQL|constraint|private|opfs|WASM|stack|DOMException|token|secret/i,
  )
}

async function createTask(
  repository: TaskRepository,
  id: string,
  createdAtMs = 100,
): Promise<Task> {
  return repository.createTask({ id, title: `Task ${id.at(-1)}`, createdAtMs })
}

async function moveTaskToStatus(
  repository: TaskRepository,
  id: string,
  status: TaskStatus,
): Promise<void> {
  const setupOperation: Partial<Record<TaskStatus, TaskStatusOperation>> = {
    doing: 'start',
    completed: 'complete',
    cancelled: 'cancel',
  }
  const operation = setupOperation[status]
  if (operation !== undefined) {
    await repository.changeTaskStatus({
      id,
      operation,
      updatedAtMs: 200,
    })
  }
}

export function defineTaskRepositoryContract(
  adapterName: string,
  createFixture: TaskRepositoryContractFixtureFactory,
): void {
  describe(`${adapterName} shared TaskRepository contract`, () => {
    test('creates a complete todo Task and maps duplicate id to PERSISTENCE_FAILED', async () => {
      const { repository } = createFixture()
      const created = await repository.createTask({
        id: TASK_CONTRACT_IDS.a,
        title: 'Created',
        createdAtMs: 100,
      })
      expect(created).toEqual({
        id: TASK_CONTRACT_IDS.a,
        title: 'Created',
        status: 'todo',
        createdAtMs: 100,
        updatedAtMs: 100,
        isImportant: false,
        isUrgent: false,
        dueDate: null,
        projectId: null,
        tagIds: [],
        deletedAtMs: null,
      })
      await expectSafeError(
        repository.createTask({
          id: TASK_CONTRACT_IDS.a,
          title: 'Duplicate',
          createdAtMs: 200,
        }),
        'PERSISTENCE_FAILED',
        'createTask',
      )
    })

    test('lists by updatedAtMs DESC and id ASC without adapter reordering', async () => {
      const { repository } = createFixture()
      await createTask(repository, TASK_CONTRACT_IDS.c, 50)
      await createTask(repository, TASK_CONTRACT_IDS.b, 100)
      await createTask(repository, TASK_CONTRACT_IDS.a, 100)

      const tasks = await repository.listTasks()
      expect(tasks.map((task) => task.id)).toEqual([
        TASK_CONTRACT_IDS.a,
        TASK_CONTRACT_IDS.b,
        TASK_CONTRACT_IDS.c,
      ])
    })

    test('renames only title and updatedAtMs and persists the result', async () => {
      const { repository } = createFixture()
      const before = await createTask(repository, TASK_CONTRACT_IDS.a)
      const renamed = await repository.renameTask({
        id: TASK_CONTRACT_IDS.a,
        title: 'Renamed',
        updatedAtMs: 300,
      })

      expect(renamed).toEqual({
        ...before,
        title: 'Renamed',
        updatedAtMs: 300,
      })
      await expect(repository.listTasks()).resolves.toEqual([renamed])
    })

    test('creates planning values atomically and preserves them through rename and status', async () => {
      const { repository } = createFixture()
      const created = await repository.createTask({
        id: TASK_CONTRACT_IDS.a,
        title: 'Planned',
        createdAtMs: 100,
        isImportant: true,
        isUrgent: true,
        dueDate: '2026-08-23',
      })
      expect(created).toMatchObject({
        isImportant: true,
        isUrgent: true,
        dueDate: '2026-08-23',
      })
      const renamed = await repository.renameTask({
        id: created.id,
        title: 'Renamed',
        updatedAtMs: 200,
      })
      expect(renamed).toMatchObject({
        isImportant: true,
        isUrgent: true,
        dueDate: '2026-08-23',
      })
      const started = await repository.changeTaskStatus({
        id: created.id,
        operation: 'start',
        updatedAtMs: 300,
      })
      expect(started).toMatchObject({
        status: 'doing',
        isImportant: true,
        isUrgent: true,
        dueDate: '2026-08-23',
      })
    })

    test('updates planning fields independently and clears deadline', async () => {
      const { repository } = createFixture()
      const created = await createTask(repository, TASK_CONTRACT_IDS.a)
      const important = await repository.setTaskImportance({
        id: created.id,
        isImportant: true,
        updatedAtMs: 200,
      })
      expect(important).toMatchObject({ isImportant: true, isUrgent: false })
      const urgent = await repository.setTaskUrgency({
        id: created.id,
        isUrgent: true,
        updatedAtMs: 300,
      })
      expect(urgent).toMatchObject({ isImportant: true, isUrgent: true })
      const deadline = await repository.setTaskDeadline({
        id: created.id,
        dueDate: '2026-08-23',
        updatedAtMs: 400,
      })
      expect(deadline).toMatchObject({ dueDate: '2026-08-23' })
      const cleared = await repository.clearTaskDeadline({
        id: created.id,
        updatedAtMs: 500,
      })
      expect(cleared).toMatchObject({
        isImportant: true,
        isUrgent: true,
        dueDate: null,
        updatedAtMs: 500,
      })
      await expect(repository.listTasks()).resolves.toEqual([cleared])
    })

    test('creates with project atomically and supports set and clear project', async () => {
      const { repository } = createFixture()
      const projectId = '00000000-0000-4000-8000-000000000101'
      const created = await repository.createTask({
        id: TASK_CONTRACT_IDS.a,
        title: 'Project task',
        createdAtMs: 100,
        projectId,
      })
      expect(created.projectId).toBe(projectId)
      const changed = await repository.setTaskProject({
        id: created.id,
        projectId: '00000000-0000-4000-8000-000000000102',
        updatedAtMs: 200,
      })
      expect(changed).toMatchObject({
        projectId: '00000000-0000-4000-8000-000000000102',
        updatedAtMs: 200,
      })
      const cleared = await repository.clearTaskProject({
        id: created.id,
        updatedAtMs: 300,
      })
      expect(cleared).toMatchObject({ projectId: null, updatedAtMs: 300 })
    })

    test('creates with tags atomically and supports add and remove tag', async () => {
      const { repository } = createFixture()
      const tagA = '00000000-0000-4000-8000-000000000101'
      const tagB = '00000000-0000-4000-8000-000000000102'
      const created = await repository.createTask({
        id: TASK_CONTRACT_IDS.a,
        title: 'Tagged task',
        createdAtMs: 100,
        tagIds: [tagB],
      })
      expect(created.tagIds).toEqual([tagB])
      const added = await repository.addTaskTag({
        id: created.id,
        tagId: tagA,
        updatedAtMs: 200,
      })
      expect(added).toMatchObject({ tagIds: [tagA, tagB], updatedAtMs: 200 })
      const removed = await repository.removeTaskTag({
        id: created.id,
        tagId: tagB,
        updatedAtMs: 300,
      })
      expect(removed).toMatchObject({ tagIds: [tagA], updatedAtMs: 300 })
      await expectSafeError(
        repository.addTaskTag({
          id: created.id,
          tagId: tagA,
          updatedAtMs: 400,
        }),
        'PERSISTENCE_FAILED',
        'addTaskTag',
      )
    })

    test('maps missing planning operations to NOT_FOUND', async () => {
      const { repository } = createFixture()
      await expectSafeError(
        repository.setTaskImportance({
          id: TASK_CONTRACT_IDS.missing,
          isImportant: true,
          updatedAtMs: 200,
        }),
        'NOT_FOUND',
        'setTaskImportance',
      )
      await expectSafeError(
        repository.clearTaskDeadline({
          id: TASK_CONTRACT_IDS.missing,
          updatedAtMs: 200,
        }),
        'NOT_FOUND',
        'clearTaskDeadline',
      )
    })

    test('trashes and restores without losing status, planning, project, or tags', async () => {
      const { repository } = createFixture()
      const tagId = '00000000-0000-4000-8000-000000000101'
      const created = await repository.createTask({
        id: TASK_CONTRACT_IDS.a,
        title: 'Recoverable task',
        createdAtMs: 100,
        isImportant: true,
        isUrgent: true,
        dueDate: '2026-08-23',
        projectId: '00000000-0000-4000-8000-000000000102',
        tagIds: [tagId],
      })
      const started = await repository.changeTaskStatus({
        id: created.id,
        operation: 'start',
        updatedAtMs: 150,
      })
      const trashed = await repository.trashTask({
        id: created.id,
        updatedAtMs: 200,
      })
      expect(trashed).toEqual({
        ...started,
        updatedAtMs: 200,
        deletedAtMs: 200,
      })
      await expect(repository.listTasks()).resolves.toEqual([])
      await expect(repository.listTrashedTasks()).resolves.toEqual([trashed])

      await expectSafeError(
        repository.renameTask({
          id: created.id,
          title: 'Hidden mutation',
          updatedAtMs: 250,
        }),
        'NOT_FOUND',
        'renameTask',
      )
      await expectSafeError(
        repository.changeTaskStatus({
          id: created.id,
          operation: 'complete',
          updatedAtMs: 250,
        }),
        'NOT_FOUND',
        'changeTaskStatus',
      )
      await expectSafeError(
        repository.setTaskImportance({
          id: created.id,
          isImportant: false,
          updatedAtMs: 250,
        }),
        'NOT_FOUND',
        'setTaskImportance',
      )
      await expectSafeError(
        repository.clearTaskProject({ id: created.id, updatedAtMs: 250 }),
        'NOT_FOUND',
        'clearTaskProject',
      )
      await expectSafeError(
        repository.removeTaskTag({
          id: created.id,
          tagId,
          updatedAtMs: 250,
        }),
        'NOT_FOUND',
        'removeTaskTag',
      )
      await expectSafeError(
        repository.trashTask({ id: created.id, updatedAtMs: 250 }),
        'NOT_FOUND',
        'trashTask',
      )

      const restored = await repository.restoreTask({
        id: created.id,
        updatedAtMs: 300,
      })
      expect(restored).toEqual({
        ...started,
        updatedAtMs: 300,
        deletedAtMs: null,
      })
      await expect(repository.listTasks()).resolves.toEqual([restored])
      await expect(repository.listTrashedTasks()).resolves.toEqual([])
      await expectSafeError(
        repository.restoreTask({ id: created.id, updatedAtMs: 350 }),
        'NOT_FOUND',
        'restoreTask',
      )
    })

    test('orders trash by deletedAtMs DESC and id ASC', async () => {
      const { repository } = createFixture()
      await createTask(repository, TASK_CONTRACT_IDS.c, 30)
      await createTask(repository, TASK_CONTRACT_IDS.b, 20)
      await createTask(repository, TASK_CONTRACT_IDS.a, 10)
      await repository.trashTask({
        id: TASK_CONTRACT_IDS.c,
        updatedAtMs: 200,
      })
      await repository.trashTask({
        id: TASK_CONTRACT_IDS.b,
        updatedAtMs: 300,
      })
      await repository.trashTask({
        id: TASK_CONTRACT_IDS.a,
        updatedAtMs: 300,
      })

      const trashed = await repository.listTrashedTasks()
      expect(trashed.map((task) => task.id)).toEqual([
        TASK_CONTRACT_IDS.a,
        TASK_CONTRACT_IDS.b,
        TASK_CONTRACT_IDS.c,
      ])
    })

    test('maps missing rename and status operations to NOT_FOUND', async () => {
      const { repository } = createFixture()
      await expectSafeError(
        repository.renameTask({
          id: TASK_CONTRACT_IDS.missing,
          title: 'Missing',
          updatedAtMs: 300,
        }),
        'NOT_FOUND',
        'renameTask',
      )
      await expectSafeError(
        repository.changeTaskStatus({
          id: TASK_CONTRACT_IDS.missing,
          operation: 'start',
          updatedAtMs: 300,
        }),
        'NOT_FOUND',
        'changeTaskStatus',
      )
    })

    test.each(LEGAL_TASK_STATUS_TRANSITIONS)(
      '$current + $operation persists $target',
      async ({ current, operation, target }) => {
        const { repository } = createFixture()
        const before = await createTask(repository, TASK_CONTRACT_IDS.a)
        await moveTaskToStatus(repository, before.id, current)

        const changed = await repository.changeTaskStatus({
          id: before.id,
          operation,
          updatedAtMs: 300,
        })
        expect(changed).toMatchObject({
          id: before.id,
          status: target,
          createdAtMs: before.createdAtMs,
          updatedAtMs: 300,
        })
        await expect(repository.listTasks()).resolves.toEqual([changed])
      },
    )

    test.each(INVALID_TASK_STATUS_TRANSITIONS)(
      '$current + $operation maps to STATUS_CONFLICT',
      async ({ current, operation }) => {
        const { repository } = createFixture()
        const before = await createTask(repository, TASK_CONTRACT_IDS.a)
        await moveTaskToStatus(repository, before.id, current)
        const currentTask = (await repository.listTasks())[0]

        await expectSafeError(
          repository.changeTaskStatus({
            id: before.id,
            operation,
            updatedAtMs: 300,
          }),
          'STATUS_CONFLICT',
          'changeTaskStatus',
        )
        await expect(repository.listTasks()).resolves.toEqual([currentTask])
      },
    )

    test('maps backend unavailability to the safe public error', async () => {
      const { repository, backend } = createFixture()
      backend.failNext(
        'PERSISTENCE_UNAVAILABLE',
        'DOMException /private/opfs/zhixing.db token=secret',
      )
      await expectSafeError(
        repository.listTasks(),
        'PERSISTENCE_UNAVAILABLE',
        'listTasks',
      )
    })

    test('keeps the public repository error code set frozen', () => {
      expect(TASK_REPOSITORY_ERROR_CODES).toEqual([
        'NOT_FOUND',
        'STATUS_CONFLICT',
        'PERSISTENCE_UNAVAILABLE',
        'PERSISTENCE_FAILED',
      ])
    })
  })
}
