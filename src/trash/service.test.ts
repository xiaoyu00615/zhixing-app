import { describe, expect, test, vi } from 'vitest'

import type { DiaryService } from '@/diary/service'
import type { NoteService } from '@/note/service'
import type { TaskService } from '@/task/service'
import type { TrashItem } from '@/trash/model'
import {
  createTrashService,
  TrashApplicationError,
  type TrashService,
} from '@/trash/service'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const NOTE_ID = '00000000-0000-4000-8000-000000000002'
const DIARY_ID = '00000000-0000-4000-8000-000000000003'

const ITEMS: readonly TrashItem[] = [
  { entityType: 'task', entityId: TASK_ID, title: '任务', deletedAtMs: 300 },
  { entityType: 'note', entityId: NOTE_ID, title: '笔记', deletedAtMs: 200 },
  { entityType: 'diary', entityId: DIARY_ID, title: '日记', deletedAtMs: 100 },
]

interface Harness {
  readonly service: TrashService
  readonly repository: { list: ReturnType<typeof vi.fn> }
  readonly taskService: { restoreTask: ReturnType<typeof vi.fn> }
  readonly noteService: { restore: ReturnType<typeof vi.fn> }
  readonly diaryService: { restore: ReturnType<typeof vi.fn> }
}

function createHarness(
  items: readonly TrashItem[] = ITEMS,
  list: () => Promise<readonly TrashItem[]> = () => Promise.resolve(items),
): Harness {
  const repository = { list: vi.fn(list) }
  const taskService = { restoreTask: vi.fn(() => Promise.resolve()) }
  const noteService = { restore: vi.fn(() => Promise.resolve()) }
  const diaryService = { restore: vi.fn(() => Promise.resolve()) }

  const service = createTrashService({
    repository,
    taskService: taskService as unknown as TaskService,
    noteService: noteService as unknown as NoteService,
    diaryService: diaryService as unknown as DiaryService,
  })

  return { service, repository, taskService, noteService, diaryService }
}

describe('TrashService.list', () => {
  test('delegates to the trash repository and returns its projection', async () => {
    const harness = createHarness()

    await expect(harness.service.list()).resolves.toEqual(ITEMS)
    expect(harness.repository.list).toHaveBeenCalledOnce()
  })

  test('an empty persistence result resolves to an empty list', async () => {
    const harness = createHarness([], () => Promise.resolve([]))

    await expect(harness.service.list()).resolves.toEqual([])
  })

  test('maps a persistence failure to a safe UNAVAILABLE error', async () => {
    const harness = createHarness([], () =>
      Promise.reject(new Error('sqlite OPFS worker failure: no such table')),
    )

    const error = await harness.service.list().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(TrashApplicationError)
    expect((error as TrashApplicationError).code).toBe('UNAVAILABLE')
    expect((error as Error).message).not.toMatch(/sqlite|OPFS|worker|table/i)
  })
})

describe('TrashService.restore dispatch', () => {
  test('restores a task through the canonical Task service only', async () => {
    const harness = createHarness()

    await harness.service.restore({ entityType: 'task', entityId: TASK_ID })

    expect(harness.taskService.restoreTask).toHaveBeenCalledWith(TASK_ID)
    expect(harness.noteService.restore).not.toHaveBeenCalled()
    expect(harness.diaryService.restore).not.toHaveBeenCalled()
  })

  test('restores a note through the canonical Note service only', async () => {
    const harness = createHarness()

    await harness.service.restore({ entityType: 'note', entityId: NOTE_ID })

    expect(harness.noteService.restore).toHaveBeenCalledWith(NOTE_ID)
    expect(harness.taskService.restoreTask).not.toHaveBeenCalled()
    expect(harness.diaryService.restore).not.toHaveBeenCalled()
  })

  test('restores a diary entry through the canonical Diary service only', async () => {
    const harness = createHarness()

    await harness.service.restore({ entityType: 'diary', entityId: DIARY_ID })

    expect(harness.diaryService.restore).toHaveBeenCalledWith(DIARY_ID)
    expect(harness.taskService.restoreTask).not.toHaveBeenCalled()
    expect(harness.noteService.restore).not.toHaveBeenCalled()
  })

  test('forwards identity only: the source domain owns timestamps', async () => {
    const harness = createHarness()

    await harness.service.restore({ entityType: 'task', entityId: TASK_ID })
    await harness.service.restore({ entityType: 'note', entityId: NOTE_ID })
    await harness.service.restore({ entityType: 'diary', entityId: DIARY_ID })

    for (const call of harness.taskService.restoreTask.mock.calls) {
      expect(call).toEqual([TASK_ID])
    }
    for (const call of harness.noteService.restore.mock.calls) {
      expect(call).toEqual([NOTE_ID])
    }
    for (const call of harness.diaryService.restore.mock.calls) {
      expect(call).toEqual([DIARY_ID])
    }
  })

  test('never touches the trash repository for restore', async () => {
    const harness = createHarness()

    await harness.service.restore({ entityType: 'note', entityId: NOTE_ID })

    expect(harness.repository.list).not.toHaveBeenCalled()
  })
})

describe('TrashService.restore failures', () => {
  test('maps a source-service failure to UNAVAILABLE without leaking details', async () => {
    const harness = createHarness()
    harness.taskService.restoreTask.mockRejectedValue(
      new Error('rusqlite prepare failed: UPDATE tasks'),
    )

    const error = await harness.service
      .restore({ entityType: 'task', entityId: TASK_ID })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(TrashApplicationError)
    expect((error as TrashApplicationError).code).toBe('UNAVAILABLE')
    expect((error as Error).message).not.toMatch(/rusqlite|UPDATE|tasks/i)
  })

  test('maps an unexpected non-Error rejection to UNAVAILABLE', async () => {
    const harness = createHarness()
    harness.diaryService.restore.mockRejectedValue('boom')

    const error = await harness.service
      .restore({ entityType: 'diary', entityId: DIARY_ID })
      .catch((value: unknown) => value)

    expect((error as TrashApplicationError).code).toBe('UNAVAILABLE')
  })

  test('rejects a malformed restore identity with VALIDATION', async () => {
    const harness = createHarness()

    const emptyId = await harness.service
      .restore({ entityType: 'task', entityId: '' })
      .catch((value: unknown) => value)
    const unknownType = await harness.service
      .restore({
        entityType: 'canvas' as unknown as TrashItem['entityType'],
        entityId: TASK_ID,
      })
      .catch((value: unknown) => value)

    expect((emptyId as TrashApplicationError).code).toBe('VALIDATION')
    expect((unknownType as TrashApplicationError).code).toBe('VALIDATION')
    expect(harness.taskService.restoreTask).not.toHaveBeenCalled()
    expect(harness.noteService.restore).not.toHaveBeenCalled()
    expect(harness.diaryService.restore).not.toHaveBeenCalled()
  })
})
