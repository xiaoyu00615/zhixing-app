import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { TrashPage } from '@/pages/TrashPage'
import type { ProjectService } from '@/project/service'
import type { TagService } from '@/tag/service'
import type { Task } from '@/task/model'
import type { OpenTaskRuntime } from '@/task/runtime.types'
import type { TaskService } from '@/task/service'

const TASK: Task = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '整理季度计划',
  status: 'doing',
  createdAtMs: 100,
  updatedAtMs: 200,
  isImportant: true,
  isUrgent: true,
  dueDate: '2026-08-31',
  projectId: '00000000-0000-4000-8000-000000000101',
  tagIds: ['00000000-0000-4000-8000-000000000201'],
  deletedAtMs: 200,
}

function createRuntime(initialTasks: readonly Task[] = [TASK]) {
  const listTrashedTasks = vi.fn<TaskService['listTrashedTasks']>()
  listTrashedTasks.mockResolvedValue(initialTasks)
  const restoreTask = vi.fn<TaskService['restoreTask']>()
  restoreTask.mockResolvedValue({ ...TASK, deletedAtMs: null })
  const service = {
    listTrashedTasks,
    restoreTask,
  } as unknown as TaskService
  const projectService = {
    listProjects: vi.fn().mockResolvedValue([
      {
        id: TASK.projectId,
        name: '知行产品',
        createdAtMs: 100,
        updatedAtMs: 100,
      },
    ]),
  } as unknown as ProjectService
  const tagService = {
    listTags: vi.fn().mockResolvedValue([
      {
        id: TASK.tagIds[0],
        name: '规划',
        createdAtMs: 100,
        updatedAtMs: 100,
      },
    ]),
  } as unknown as TagService
  const dispose = vi.fn()
  const openRuntime: OpenTaskRuntime = vi.fn().mockResolvedValue({
    service,
    projectService,
    tagService,
    dispose,
  })
  return { openRuntime, listTrashedTasks, restoreTask }
}

describe('TrashPage', () => {
  test('shows loading and then an empty Task-only trash state', async () => {
    const fake = createRuntime([])
    render(<TrashPage openRuntime={fake.openRuntime} />)
    expect(screen.getByLabelText('正在加载回收站')).toBeInTheDocument()
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByText(/永久删除|清空回收站/)).not.toBeInTheDocument()
  })

  test('shows retained status, project, tags, deadline, and deleted time', async () => {
    const fake = createRuntime()
    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText(TASK.title)).toBeInTheDocument()
    expect(screen.getByText('进行中')).toBeInTheDocument()
    expect(screen.getByText('知行产品')).toBeInTheDocument()
    expect(screen.getByText('规划')).toBeInTheDocument()
    expect(screen.getByText(TASK.dueDate!)).toBeInTheDocument()
    expect(screen.getByText(/删除于/)).toBeInTheDocument()
    expect(screen.queryByText('已逾期')).not.toBeInTheDocument()
  })

  test('restores a Task, reloads trash, and reports recovery', async () => {
    const user = userEvent.setup()
    const fake = createRuntime()
    fake.listTrashedTasks
      .mockResolvedValueOnce([TASK])
      .mockResolvedValueOnce([])
    render(<TrashPage openRuntime={fake.openRuntime} />)

    await user.click(await screen.findByRole('button', { name: '恢复任务' }))

    expect(fake.restoreTask).toHaveBeenCalledWith(TASK.id)
    await waitFor(() => expect(fake.listTrashedTasks).toHaveBeenCalledTimes(2))
    expect(
      screen.getByText(`“${TASK.title}”已恢复到任务列表。`),
    ).toBeInTheDocument()
    expect(screen.getByText('回收站是空的')).toBeInTheDocument()
  })

  test('offers retry after an isolated load failure', async () => {
    const user = userEvent.setup()
    const fake = createRuntime([])
    vi.mocked(fake.openRuntime)
      .mockRejectedValueOnce(new Error('isolated failure'))
      .mockResolvedValueOnce({
        service: {
          listTrashedTasks: fake.listTrashedTasks,
        } as unknown as TaskService,
        projectService: {
          listProjects: vi.fn().mockResolvedValue([]),
        } as unknown as ProjectService,
        tagService: {
          listTags: vi.fn().mockResolvedValue([]),
        } as unknown as TagService,
        dispose: vi.fn(),
      })
    render(<TrashPage openRuntime={fake.openRuntime} />)

    await user.click(await screen.findByRole('button', { name: '重试' }))
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(fake.openRuntime).toHaveBeenCalledTimes(2)
  })
})
