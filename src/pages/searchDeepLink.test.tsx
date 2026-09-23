/**
 * P5 S4 — `?id=` deep-link selection for the Task / Note / Diary workspaces.
 *
 * The pages receive the requested id through props (supplied by the route from
 * the URL) so they keep owning their existing selection mechanism and stay free
 * of router coupling.
 */

import { render, screen, waitFor } from '@testing-library/react'
import { StrictMode } from 'react'
import { describe, expect, test, vi } from 'vitest'

import type { DiaryEntry } from '@/diary/model'
import type { OpenDiaryRuntime } from '@/diary/runtime.types'
import type { DiaryRuntime } from '@/diary/runtime.types'
import type { DiaryService } from '@/diary/service'
import type { Note } from '@/note/model'
import type { NoteRuntime, OpenNoteRuntime } from '@/note/runtime.types'
import type { NoteService } from '@/note/service'
import type { Project } from '@/project/model'
import type { ProjectService } from '@/project/service'
import { DiaryPage } from '@/pages/DiaryPage'
import { NotesPage } from '@/pages/NotesPage'
import { TasksPage } from '@/pages/TasksPage'
import type { Tag } from '@/tag/model'
import type { TagService } from '@/tag/service'
import type { Task } from '@/task/model'
import type { OpenTaskRuntime, TaskRuntime } from '@/task/runtime.types'
import type { TaskService } from '@/task/service'

function uuid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`
}

function task(id: number, title: string): Task {
  return {
    id: uuid(id),
    title,
    status: 'todo',
    createdAtMs: 100,
    updatedAtMs: 100,
    isImportant: false,
    isUrgent: false,
    dueDate: null,
    projectId: null,
    tagIds: [],
    deletedAtMs: null,
    archivedAtMs: null,
  }
}

function note(id: number, title: string, content: string): Note {
  return {
    id: uuid(id),
    title,
    content,
    createdAtMs: 100,
    updatedAtMs: 100,
    deletedAtMs: null,
    archivedAtMs: null,
  }
}

function diaryEntry(id: number, title: string, date: string): DiaryEntry {
  return {
    id: uuid(id),
    title,
    content: `${title}正文`,
    diaryDate: date,
    createdAtMs: 100,
    updatedAtMs: 100,
    deletedAtMs: null,
  }
}

function createTaskService(tasks: readonly Task[]): TaskService {
  const first = tasks[0] ?? task(1, '占位任务')
  const resolved = () => Promise.resolve(first)
  return {
    createTask: vi.fn(resolved),
    listTasks: vi.fn(() => Promise.resolve(tasks)),
    listTrashedTasks: vi.fn(() => Promise.resolve([])),
    trashTask: vi.fn(resolved),
    restoreTask: vi.fn(resolved),
    archiveTask: vi.fn(resolved),
    unarchiveTask: vi.fn(resolved),
    renameTask: vi.fn(resolved),
    startTask: vi.fn(resolved),
    completeTask: vi.fn(resolved),
    cancelTask: vi.fn(resolved),
    reopenTask: vi.fn(resolved),
    setTaskImportance: vi.fn(resolved),
    setTaskUrgency: vi.fn(resolved),
    setTaskDeadline: vi.fn(resolved),
    clearTaskDeadline: vi.fn(resolved),
    setTaskProject: vi.fn(resolved),
    clearTaskProject: vi.fn(resolved),
    addTaskTag: vi.fn(resolved),
    removeTaskTag: vi.fn(resolved),
  }
}

function createTaskRuntime(tasks: readonly Task[]) {
  const dispose = vi.fn(() => Promise.resolve())
  const projectService: ProjectService = {
    createProject: vi.fn(() =>
      Promise.resolve({
        id: uuid(101),
        name: '项目',
        createdAtMs: 100,
        updatedAtMs: 100,
      }),
    ),
    listProjects: vi.fn(() => Promise.resolve([] as Project[])),
    renameProject: vi.fn(() =>
      Promise.resolve({
        id: uuid(101),
        name: '项目',
        createdAtMs: 100,
        updatedAtMs: 200,
      }),
    ),
  }
  const tagService: TagService = {
    createTag: vi.fn(() =>
      Promise.resolve({
        id: uuid(201),
        name: '标签',
        createdAtMs: 100,
        updatedAtMs: 100,
      }),
    ),
    listTags: vi.fn(() => Promise.resolve([] as Tag[])),
    renameTag: vi.fn(() =>
      Promise.resolve({
        id: uuid(201),
        name: '标签',
        createdAtMs: 100,
        updatedAtMs: 200,
      }),
    ),
  }
  const runtime: TaskRuntime = {
    service: createTaskService(tasks),
    projectService,
    tagService,
    dispose,
  }
  const openRuntime = vi.fn<OpenTaskRuntime>(() => Promise.resolve(runtime))
  return { openRuntime, dispose }
}

function createNoteRuntime(notes: Note[]) {
  const dispose = vi.fn(() => Promise.resolve())
  const first = notes[0] ?? note(1, '占位笔记', '正文')
  const service: NoteService = {
    createNote: vi.fn(() => Promise.resolve(first)),
    getActiveById: vi.fn(() => Promise.resolve(first)),
    listActive: vi.fn(() => Promise.resolve(notes)),
    updateNote: vi.fn(() => Promise.resolve(first)),
    softDelete: vi.fn(() => Promise.resolve()),
    restore: vi.fn(() => Promise.resolve()),
    archive: vi.fn(() => Promise.resolve()),
    unarchive: vi.fn(() => Promise.resolve()),
  }
  const runtime: NoteRuntime = { service, dispose }
  const openRuntime = vi.fn<OpenNoteRuntime>(() => Promise.resolve(runtime))
  return { openRuntime, dispose }
}

function createDiaryRuntime(entries: DiaryEntry[]) {
  const dispose = vi.fn(() => Promise.resolve())
  const first = entries[0] ?? diaryEntry(1, '占位日记', '2026-01-01')
  const service: DiaryService = {
    createDiaryEntry: vi.fn(() => Promise.resolve(first)),
    getActiveById: vi.fn(() => Promise.resolve(first)),
    getActiveByDiaryDate: vi.fn(() => Promise.resolve(first)),
    listActive: vi.fn(() => Promise.resolve(entries)),
    updateDiaryEntry: vi.fn(() => Promise.resolve(first)),
    changeDiaryDate: vi.fn(() => Promise.resolve(first)),
    softDelete: vi.fn(() => Promise.resolve()),
    restore: vi.fn(() => Promise.resolve()),
  }
  const runtime: DiaryRuntime = { service, dispose }
  const openRuntime = vi.fn<OpenDiaryRuntime>(() => Promise.resolve(runtime))
  return { openRuntime, dispose }
}

describe('TasksPage ?id= deep link', () => {
  test('opens the existing Task detail for a matching active id', async () => {
    const second = task(2, '第二项任务')
    const { openRuntime } = createTaskRuntime([task(1, '第一项任务'), second])

    render(<TasksPage openRuntime={openRuntime} requestedTaskId={second.id} />)

    expect(
      await screen.findByRole('dialog', { name: '任务详情：第二项任务' }),
    ).toBeInTheDocument()
  })

  test('without ?id the page behaves normally and no detail opens', async () => {
    const { openRuntime } = createTaskRuntime([task(1, '第一项任务')])

    render(<TasksPage openRuntime={openRuntime} />)

    await screen.findByText('第一项任务')
    expect(
      screen.queryByRole('dialog', { name: /任务详情/ }),
    ).not.toBeInTheDocument()
  })

  test('an unknown ?id fails gracefully and keeps the page usable', async () => {
    const { openRuntime } = createTaskRuntime([task(1, '第一项任务')])

    render(
      <TasksPage openRuntime={openRuntime} requestedTaskId="not-a-task-id" />,
    )

    await screen.findByText('第一项任务')
    expect(
      screen.queryByRole('dialog', { name: /任务详情/ }),
    ).not.toBeInTheDocument()
  })

  test('changing ?id while mounted selects the new active Task', async () => {
    const first = task(1, '第一项任务')
    const second = task(2, '第二项任务')
    const { openRuntime } = createTaskRuntime([first, second])

    const view = render(
      <TasksPage openRuntime={openRuntime} requestedTaskId={first.id} />,
    )
    await screen.findByRole('dialog', { name: '任务详情：第一项任务' })

    view.rerender(
      <TasksPage openRuntime={openRuntime} requestedTaskId={second.id} />,
    )

    expect(
      await screen.findByRole('dialog', { name: '任务详情：第二项任务' }),
    ).toBeInTheDocument()
  })

  test('selection still works under StrictMode', async () => {
    const second = task(2, '第二项任务')
    const { openRuntime } = createTaskRuntime([task(1, '第一项任务'), second])

    render(
      <StrictMode>
        <TasksPage openRuntime={openRuntime} requestedTaskId={second.id} />
      </StrictMode>,
    )

    expect(
      await screen.findByRole('dialog', { name: '任务详情：第二项任务' }),
    ).toBeInTheDocument()
  })
})

describe('NotesPage ?id= deep link', () => {
  test('selects the requested active Note', async () => {
    const second = note(2, '第二篇笔记', '第二篇正文')
    const { openRuntime } = createNoteRuntime([
      note(1, '第一篇笔记', '第一篇正文'),
      second,
    ])

    render(<NotesPage openRuntime={openRuntime} requestedNoteId={second.id} />)

    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('第二篇笔记'),
    )
  })

  test('without ?id the existing first-Note behavior is unchanged', async () => {
    const { openRuntime } = createNoteRuntime([
      note(1, '第一篇笔记', '第一篇正文'),
    ])

    render(<NotesPage openRuntime={openRuntime} />)

    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('第一篇笔记'),
    )
  })

  test('an unknown ?id fails gracefully', async () => {
    const { openRuntime } = createNoteRuntime([
      note(1, '第一篇笔记', '第一篇正文'),
    ])

    render(
      <NotesPage openRuntime={openRuntime} requestedNoteId="not-a-note-id" />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('第一篇笔记'),
    )
  })

  test('changing ?id while mounted selects the new Note', async () => {
    const first = note(1, '第一篇笔记', '第一篇正文')
    const second = note(2, '第二篇笔记', '第二篇正文')
    const { openRuntime } = createNoteRuntime([first, second])

    const view = render(
      <NotesPage openRuntime={openRuntime} requestedNoteId={first.id} />,
    )
    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('第一篇笔记'),
    )

    view.rerender(
      <NotesPage openRuntime={openRuntime} requestedNoteId={second.id} />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('第二篇笔记'),
    )
  })

  test('selection still works under StrictMode', async () => {
    const second = note(2, '第二篇笔记', '第二篇正文')
    const { openRuntime } = createNoteRuntime([
      note(1, '第一篇笔记', '第一篇正文'),
      second,
    ])

    render(
      <StrictMode>
        <NotesPage openRuntime={openRuntime} requestedNoteId={second.id} />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('笔记标题')).toHaveValue('第二篇笔记'),
    )
  })
})

describe('DiaryPage ?id= deep link', () => {
  test('selects the requested active Diary entry', async () => {
    const second = diaryEntry(2, '第二篇日记', '2026-01-02')
    const { openRuntime } = createDiaryRuntime([
      diaryEntry(1, '第一篇日记', '2026-01-01'),
      second,
    ])

    render(
      <DiaryPage openRuntime={openRuntime} requestedDiaryId={second.id} />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('日记标题')).toHaveValue('第二篇日记'),
    )
  })

  test('without ?id the existing Diary selection behavior is unchanged', async () => {
    const { openRuntime } = createDiaryRuntime([
      diaryEntry(1, '第一篇日记', '2026-01-01'),
    ])

    render(<DiaryPage openRuntime={openRuntime} />)

    await waitFor(() =>
      expect(screen.getByLabelText('日记标题')).toHaveValue('第一篇日记'),
    )
  })

  test('an unknown ?id fails gracefully', async () => {
    const { openRuntime } = createDiaryRuntime([
      diaryEntry(1, '第一篇日记', '2026-01-01'),
    ])

    render(
      <DiaryPage openRuntime={openRuntime} requestedDiaryId="not-a-diary-id" />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('日记标题')).toHaveValue('第一篇日记'),
    )
  })

  test('changing ?id while mounted selects the new Diary entry', async () => {
    const first = diaryEntry(1, '第一篇日记', '2026-01-01')
    const second = diaryEntry(2, '第二篇日记', '2026-01-02')
    const { openRuntime } = createDiaryRuntime([first, second])

    const view = render(
      <DiaryPage openRuntime={openRuntime} requestedDiaryId={first.id} />,
    )
    await waitFor(() =>
      expect(screen.getByLabelText('日记标题')).toHaveValue('第一篇日记'),
    )

    view.rerender(
      <DiaryPage openRuntime={openRuntime} requestedDiaryId={second.id} />,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('日记标题')).toHaveValue('第二篇日记'),
    )
  })

  test('selection still works under StrictMode', async () => {
    const second = diaryEntry(2, '第二篇日记', '2026-01-02')
    const { openRuntime } = createDiaryRuntime([
      diaryEntry(1, '第一篇日记', '2026-01-01'),
      second,
    ])

    render(
      <StrictMode>
        <DiaryPage openRuntime={openRuntime} requestedDiaryId={second.id} />
      </StrictMode>,
    )

    await waitFor(() =>
      expect(screen.getByLabelText('日记标题')).toHaveValue('第二篇日记'),
    )
  })
})
