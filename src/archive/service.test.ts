import { describe, expect, test, vi } from 'vitest'

import type { NoteService } from '@/note/service'
import type { TaskService } from '@/task/service'
import type { ArchiveItem } from '@/archive/model'
import { ArchiveRepositoryError } from '@/archive/model'
import {
  createArchiveService,
  ArchiveApplicationError,
  type ArchiveService,
} from '@/archive/service'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const NOTE_ID = '00000000-0000-4000-8000-000000000002'

const ITEMS: readonly ArchiveItem[] = [
  { entityType: 'task', entityId: TASK_ID, title: '任务', archivedAtMs: 300 },
  { entityType: 'note', entityId: NOTE_ID, title: '笔记', archivedAtMs: 200 },
]

interface Harness {
  readonly service: ArchiveService
  readonly repository: { list: ReturnType<typeof vi.fn> }
  readonly taskService: {
    unarchiveTask: ReturnType<typeof vi.fn>
    trashTask: ReturnType<typeof vi.fn>
  }
  readonly noteService: {
    unarchive: ReturnType<typeof vi.fn>
    softDelete: ReturnType<typeof vi.fn>
  }
}

function createHarness(
  items: readonly ArchiveItem[] = ITEMS,
  list: () => Promise<readonly ArchiveItem[]> = () => Promise.resolve(items),
): Harness {
  const repository = { list: vi.fn(list) }
  const taskService = {
    unarchiveTask: vi.fn(() => Promise.resolve()),
    trashTask: vi.fn(() => Promise.resolve()),
  }
  const noteService = {
    unarchive: vi.fn(() => Promise.resolve()),
    softDelete: vi.fn(() => Promise.resolve()),
  }

  const service = createArchiveService({
    repository,
    taskService: taskService as unknown as TaskService,
    noteService: noteService as unknown as NoteService,
  })

  return { service, repository, taskService, noteService }
}

describe('ArchiveService.list', () => {
  test('delegates to the archive repository and returns its projection', async () => {
    const harness = createHarness()

    await expect(harness.service.list()).resolves.toEqual(ITEMS)
    expect(harness.repository.list).toHaveBeenCalledOnce()
  })

  test('an empty persistence result resolves to an empty list', async () => {
    const harness = createHarness([], () => Promise.resolve([]))

    await expect(harness.service.list()).resolves.toEqual([])
  })

  test('maps a repository PERSISTENCE_ERROR to a safe UNAVAILABLE error', async () => {
    const harness = createHarness([], () =>
      Promise.reject(new ArchiveRepositoryError('PERSISTENCE_ERROR', 'list')),
    )

    const error = await harness.service.list().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ArchiveApplicationError)
    expect((error as ArchiveApplicationError).code).toBe('UNAVAILABLE')
    expect((error as Error).message).not.toMatch(/sqlite|OPFS|worker|table/i)
  })

  test('maps any non-repository failure to UNAVAILABLE', async () => {
    const harness = createHarness([], () =>
      Promise.reject(new Error('unexpected transport failure')),
    )

    const error = await harness.service.list().catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ArchiveApplicationError)
    expect((error as ArchiveApplicationError).code).toBe('UNAVAILABLE')
  })
})

describe('ArchiveService.unarchive dispatch', () => {
  test('unarchives a task through the canonical Task service only', async () => {
    const harness = createHarness()

    await harness.service.unarchive({ entityType: 'task', entityId: TASK_ID })

    expect(harness.taskService.unarchiveTask).toHaveBeenCalledWith(TASK_ID)
    expect(harness.noteService.unarchive).not.toHaveBeenCalled()
  })

  test('unarchives a note through the canonical Note service only', async () => {
    const harness = createHarness()

    await harness.service.unarchive({ entityType: 'note', entityId: NOTE_ID })

    expect(harness.noteService.unarchive).toHaveBeenCalledWith(NOTE_ID)
    expect(harness.taskService.unarchiveTask).not.toHaveBeenCalled()
  })

  test('forwards identity only: the source domain owns timestamps', async () => {
    const harness = createHarness()

    await harness.service.unarchive({ entityType: 'task', entityId: TASK_ID })
    await harness.service.unarchive({ entityType: 'note', entityId: NOTE_ID })

    for (const call of harness.taskService.unarchiveTask.mock.calls) {
      expect(call).toEqual([TASK_ID])
    }
    for (const call of harness.noteService.unarchive.mock.calls) {
      expect(call).toEqual([NOTE_ID])
    }
  })

  test('never touches the archive repository for unarchive', async () => {
    const harness = createHarness()

    await harness.service.unarchive({ entityType: 'note', entityId: NOTE_ID })

    expect(harness.repository.list).not.toHaveBeenCalled()
  })
})

describe('ArchiveService.moveToTrash dispatch', () => {
  test('moves a task to trash through the canonical Task service only', async () => {
    const harness = createHarness()

    await harness.service.moveToTrash({ entityType: 'task', entityId: TASK_ID })

    expect(harness.taskService.trashTask).toHaveBeenCalledWith(TASK_ID)
    expect(harness.noteService.softDelete).not.toHaveBeenCalled()
  })

  test('moves a note to trash through the canonical Note service only', async () => {
    const harness = createHarness()

    await harness.service.moveToTrash({ entityType: 'note', entityId: NOTE_ID })

    expect(harness.noteService.softDelete).toHaveBeenCalledWith(NOTE_ID)
    expect(harness.taskService.trashTask).not.toHaveBeenCalled()
  })

  test('forwards identity only', async () => {
    const harness = createHarness()

    await harness.service.moveToTrash({ entityType: 'task', entityId: TASK_ID })
    await harness.service.moveToTrash({ entityType: 'note', entityId: NOTE_ID })

    for (const call of harness.taskService.trashTask.mock.calls) {
      expect(call).toEqual([TASK_ID])
    }
    for (const call of harness.noteService.softDelete.mock.calls) {
      expect(call).toEqual([NOTE_ID])
    }
  })

  test('never touches the archive repository for move-to-trash', async () => {
    const harness = createHarness()

    await harness.service.moveToTrash({ entityType: 'note', entityId: NOTE_ID })

    expect(harness.repository.list).not.toHaveBeenCalled()
  })
})

describe('ArchiveService failures', () => {
  test('maps a source-service failure to UNAVAILABLE without leaking details', async () => {
    const harness = createHarness()
    harness.taskService.unarchiveTask.mockRejectedValue(
      new Error('rusqlite prepare failed: UPDATE tasks'),
    )

    const error = await harness.service
      .unarchive({ entityType: 'task', entityId: TASK_ID })
      .catch((value: unknown) => value)

    expect(error).toBeInstanceOf(ArchiveApplicationError)
    expect((error as ArchiveApplicationError).code).toBe('UNAVAILABLE')
    expect((error as Error).message).not.toMatch(/rusqlite|UPDATE|tasks/i)
  })

  test('maps an unexpected non-Error rejection to UNAVAILABLE', async () => {
    const harness = createHarness()
    harness.noteService.softDelete.mockRejectedValue('boom')

    const error = await harness.service
      .moveToTrash({ entityType: 'note', entityId: NOTE_ID })
      .catch((value: unknown) => value)

    expect((error as ArchiveApplicationError).code).toBe('UNAVAILABLE')
  })

  test('rejects a malformed identity with VALIDATION', async () => {
    const harness = createHarness()

    const emptyId = await harness.service
      .unarchive({ entityType: 'task', entityId: '' })
      .catch((value: unknown) => value)
    const unknownType = await harness.service
      .unarchive({
        entityType: 'canvas' as unknown as ArchiveItem['entityType'],
        entityId: TASK_ID,
      })
      .catch((value: unknown) => value)

    expect((emptyId as ArchiveApplicationError).code).toBe('VALIDATION')
    expect((unknownType as ArchiveApplicationError).code).toBe('VALIDATION')
    expect(harness.taskService.unarchiveTask).not.toHaveBeenCalled()
    expect(harness.noteService.unarchive).not.toHaveBeenCalled()
  })
})
