import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { describe, expect, test, vi } from 'vitest'

import { TasksPage } from '@/pages/TasksPage'
import type { Task } from '@/task/model'
import type { OpenTaskRuntime, TaskRuntime } from '@/task/runtime.types'
import { TaskApplicationError, type TaskService } from '@/task/service'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const TASK: Task = {
  id: TASK_ID,
  title: '整理桌面',
  status: 'todo',
  createdAtMs: 100,
  updatedAtMs: 100,
  isImportant: false,
  isUrgent: false,
  dueDate: null,
}

function taskFixture(
  id: number,
  title: string,
  fields: Partial<Task> = {},
): Task {
  return {
    ...TASK,
    id: `00000000-0000-4000-8000-${id.toString().padStart(12, '0')}`,
    title,
    ...fields,
  }
}

function createServiceDouble(initialTasks: readonly Task[] = [TASK]) {
  const createTask = vi.fn<TaskService['createTask']>()
  createTask.mockResolvedValue(TASK)
  const listTasks = vi.fn<TaskService['listTasks']>()
  listTasks.mockResolvedValue(initialTasks)
  const renameTask = vi.fn<TaskService['renameTask']>()
  renameTask.mockResolvedValue(TASK)
  const startTask = vi.fn<TaskService['startTask']>()
  startTask.mockResolvedValue({ ...TASK, status: 'doing' })
  const completeTask = vi.fn<TaskService['completeTask']>()
  completeTask.mockResolvedValue({ ...TASK, status: 'completed' })
  const cancelTask = vi.fn<TaskService['cancelTask']>()
  cancelTask.mockResolvedValue({ ...TASK, status: 'cancelled' })
  const reopenTask = vi.fn<TaskService['reopenTask']>()
  reopenTask.mockResolvedValue(TASK)
  const setTaskImportance = vi.fn<TaskService['setTaskImportance']>()
  setTaskImportance.mockResolvedValue(TASK)
  const setTaskUrgency = vi.fn<TaskService['setTaskUrgency']>()
  setTaskUrgency.mockResolvedValue(TASK)
  const setTaskDeadline = vi.fn<TaskService['setTaskDeadline']>()
  setTaskDeadline.mockResolvedValue(TASK)
  const clearTaskDeadline = vi.fn<TaskService['clearTaskDeadline']>()
  clearTaskDeadline.mockResolvedValue(TASK)

  const service: TaskService = {
    createTask,
    listTasks,
    renameTask,
    startTask,
    completeTask,
    cancelTask,
    reopenTask,
    setTaskImportance,
    setTaskUrgency,
    setTaskDeadline,
    clearTaskDeadline,
  }
  return {
    service,
    createTask,
    listTasks,
    renameTask,
    startTask,
    completeTask,
    cancelTask,
    reopenTask,
    setTaskImportance,
    setTaskUrgency,
    setTaskDeadline,
    clearTaskDeadline,
  }
}

function createRuntime(service: TaskService) {
  const dispose = vi.fn(() => Promise.resolve())
  const runtime: TaskRuntime = { service, dispose }
  return { runtime, dispose }
}

function resolvedRuntime(service: TaskService) {
  const current = createRuntime(service)
  const openRuntime = vi.fn<OpenTaskRuntime>()
  openRuntime.mockResolvedValue(current.runtime)
  return { openRuntime, ...current }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

describe('TasksPage loading and lifecycle', () => {
  test('moves from loading to the empty state', async () => {
    const fake = createServiceDouble([])
    const current = createRuntime(fake.service)
    const opening = deferred<TaskRuntime>()
    const openRuntime = vi.fn<OpenTaskRuntime>(() => opening.promise)

    render(<TasksPage openRuntime={openRuntime} />)

    expect(
      screen.getByRole('status', { name: '正在加载任务' }),
    ).toBeInTheDocument()
    act(() => {
      opening.resolve(current.runtime)
    })
    expect(await screen.findByText('还没有任务')).toBeInTheDocument()
  })

  test('renders the repository task list and meaningful status actions', async () => {
    const fake = createServiceDouble()
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<TasksPage openRuntime={openRuntime} />)

    const list = await screen.findByRole('list', { name: '任务列表' })
    expect(within(list).getByText(TASK.title)).toBeInTheDocument()
    expect(within(list).getByText('待开始')).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: `开始任务：${TASK.title}` }),
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: `完成任务：${TASK.title}` }),
    ).toBeInTheDocument()
    expect(
      within(list).getByRole('button', { name: `取消任务：${TASK.title}` }),
    ).toBeInTheDocument()
  })

  test('shows a safe load error and retry opens a fresh runtime', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    const current = createRuntime(fake.service)
    const openRuntime = vi.fn<OpenTaskRuntime>()
    openRuntime
      .mockRejectedValueOnce(new TaskApplicationError('UNAVAILABLE'))
      .mockResolvedValueOnce(current.runtime)

    render(<TasksPage openRuntime={openRuntime} />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('无法加载任务')).toBeInTheDocument()
    expect(alert).not.toHaveTextContent(/SQL|OPFS|Worker|UNAVAILABLE/)
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有任务')).toBeInTheDocument()
    expect(openRuntime).toHaveBeenCalledTimes(2)
  })

  test('disposes the runtime on unmount', async () => {
    const fake = createServiceDouble([])
    const current = resolvedRuntime(fake.service)
    const view = render(<TasksPage openRuntime={current.openRuntime} />)
    await screen.findByText('还没有任务')

    view.unmount()

    await waitFor(() => expect(current.dispose).toHaveBeenCalledOnce())
  })

  test('StrictMode disposes the superseded runtime without leaking it', async () => {
    const fake = createServiceDouble([])
    const first = createRuntime(fake.service)
    const second = createRuntime(fake.service)
    const openRuntime = vi.fn<OpenTaskRuntime>()
    openRuntime
      .mockResolvedValueOnce(first.runtime)
      .mockResolvedValueOnce(second.runtime)

    const view = render(
      <StrictMode>
        <TasksPage openRuntime={openRuntime} />
      </StrictMode>,
    )

    await screen.findByText('还没有任务')
    await waitFor(() => expect(openRuntime).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
    view.unmount()
    await waitFor(() => expect(second.dispose).toHaveBeenCalledOnce())
  })
})

describe('TasksPage create and rename', () => {
  test('creates through TaskService and reloads repository ordering', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    fake.listTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([TASK])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText('还没有任务')

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(
      screen.getByRole('textbox', { name: '标题' }),
      '  整理桌面  ',
    )
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    expect(fake.createTask).toHaveBeenCalledWith({
      title: '  整理桌面  ',
      isImportant: false,
      isUrgent: false,
      dueDate: null,
    })
    expect(await screen.findByText(TASK.title)).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })

  test('creates important, urgent, and deadline planning values atomically', async () => {
    const user = userEvent.setup()
    const planned = {
      ...TASK,
      title: 'Planned',
      isImportant: true,
      isUrgent: true,
      dueDate: '2026-08-23',
    }
    const fake = createServiceDouble([])
    fake.createTask.mockResolvedValueOnce(planned)
    fake.listTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([planned])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText('还没有任务')

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByRole('textbox', { name: '标题' }), 'Planned')
    await user.click(screen.getByRole('checkbox', { name: '重要任务' }))
    await user.click(screen.getByRole('checkbox', { name: '基础紧急' }))
    fireEvent.change(screen.getByLabelText('截止日期'), {
      target: { value: '2026-08-23' },
    })
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    expect(fake.createTask).toHaveBeenCalledWith({
      title: 'Planned',
      isImportant: true,
      isUrgent: true,
      dueDate: '2026-08-23',
    })
    expect(await screen.findByText('Planned')).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })

  test('shows create VALIDATION beside the title input', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    fake.createTask.mockRejectedValueOnce(
      new TaskApplicationError('VALIDATION', 'title'),
    )
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText('还没有任务')

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.click(screen.getByRole('button', { name: '创建任务' }))

    const input = screen.getByRole('textbox', { name: '标题' })
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('请输入任务标题。')).toBeInTheDocument()
  })

  test('renames through TaskService and reloads the list', async () => {
    const user = userEvent.setup()
    const renamed = { ...TASK, title: '整理工作台', updatedAtMs: 200 }
    const fake = createServiceDouble()
    fake.renameTask.mockResolvedValueOnce(renamed)
    fake.listTasks
      .mockResolvedValueOnce([TASK])
      .mockResolvedValueOnce([renamed])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText(TASK.title)

    await user.click(
      screen.getByRole('button', { name: `重命名任务：${TASK.title}` }),
    )
    const input = screen.getByRole('textbox', { name: '标题' })
    await user.clear(input)
    await user.type(input, renamed.title)
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(fake.renameTask).toHaveBeenCalledWith({
      id: TASK_ID,
      title: renamed.title,
    })
    expect(await screen.findByText(renamed.title)).toBeInTheDocument()
  })

  test('shows rename VALIDATION beside the title input', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    fake.renameTask.mockRejectedValueOnce(
      new TaskApplicationError('VALIDATION', 'title'),
    )
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText(TASK.title)

    await user.click(
      screen.getByRole('button', { name: `重命名任务：${TASK.title}` }),
    )
    const input = screen.getByRole('textbox', { name: '标题' })
    await user.clear(input)
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(screen.getByText('请输入任务标题。')).toBeInTheDocument()
  })

  test('closes a missing rename and refreshes the list', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    fake.renameTask.mockRejectedValueOnce(new TaskApplicationError('NOT_FOUND'))
    fake.listTasks.mockResolvedValueOnce([TASK]).mockResolvedValueOnce([])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText(TASK.title)

    await user.click(
      screen.getByRole('button', { name: `重命名任务：${TASK.title}` }),
    )
    await user.click(screen.getByRole('button', { name: '保存修改' }))

    expect(
      await screen.findByText('任务已不存在，列表已刷新。'),
    ).toBeInTheDocument()
    expect(await screen.findByText('还没有任务')).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })

  test('prevents duplicate create submission while pending', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    const creating = deferred<Task>()
    fake.createTask.mockReturnValueOnce(creating.promise)
    fake.listTasks.mockResolvedValueOnce([]).mockResolvedValueOnce([TASK])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText('还没有任务')

    await user.click(screen.getByRole('button', { name: '新建任务' }))
    await user.type(screen.getByRole('textbox', { name: '标题' }), TASK.title)
    await user.click(screen.getByRole('button', { name: '创建任务' }))
    const pendingButton = screen.getByRole('button', { name: '正在创建…' })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(fake.createTask).toHaveBeenCalledOnce()

    act(() => {
      creating.resolve(TASK)
    })
    expect(await screen.findByText(TASK.title)).toBeInTheDocument()
  })
})

describe('TasksPage status actions and feedback', () => {
  test.each([
    {
      label: `开始任务：${TASK.title}`,
      task: TASK,
      method: 'startTask' as const,
      nextStatus: 'doing' as const,
    },
    {
      label: `完成任务：${TASK.title}`,
      task: TASK,
      method: 'completeTask' as const,
      nextStatus: 'completed' as const,
    },
    {
      label: `取消任务：${TASK.title}`,
      task: TASK,
      method: 'cancelTask' as const,
      nextStatus: 'cancelled' as const,
    },
    {
      label: `恢复任务：${TASK.title}`,
      task: { ...TASK, status: 'completed' as const },
      method: 'reopenTask' as const,
      nextStatus: 'todo' as const,
    },
  ])(
    '$method calls TaskService and reloads',
    async ({ label, task, method, nextStatus }) => {
      const user = userEvent.setup()
      const nextTask = { ...task, status: nextStatus, updatedAtMs: 200 }
      const fake = createServiceDouble([task])
      fake.listTasks
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([nextTask])
      const { openRuntime } = resolvedRuntime(fake.service)
      render(<TasksPage openRuntime={openRuntime} />)
      await screen.findByText(task.title)

      await user.click(screen.getByRole('button', { name: label }))

      expect(fake[method]).toHaveBeenCalledWith(task.id)
      expect(fake.listTasks).toHaveBeenCalledTimes(2)
    },
  )

  test('refreshes after STATUS_CONFLICT', async () => {
    const user = userEvent.setup()
    const doing = { ...TASK, status: 'doing' as const, updatedAtMs: 200 }
    const fake = createServiceDouble()
    fake.startTask.mockRejectedValueOnce(
      new TaskApplicationError('STATUS_CONFLICT'),
    )
    fake.listTasks.mockResolvedValueOnce([TASK]).mockResolvedValueOnce([doing])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText(TASK.title)

    await user.click(
      screen.getByRole('button', { name: `开始任务：${TASK.title}` }),
    )

    expect(
      await screen.findByText('任务状态已经发生变化，列表已刷新。'),
    ).toBeInTheDocument()
    expect(await screen.findByText('进行中')).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })

  test('shows safe UNAVAILABLE feedback and leaves the action retryable', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    fake.startTask.mockRejectedValueOnce(
      new TaskApplicationError('UNAVAILABLE'),
    )
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} />)
    await screen.findByText(TASK.title)

    const button = screen.getByRole('button', {
      name: `开始任务：${TASK.title}`,
    })
    await user.click(button)

    expect(
      await screen.findByText('操作暂时无法完成，请重试。'),
    ).toBeInTheDocument()
    expect(button).toBeEnabled()
    expect(document.body).not.toHaveTextContent(/SQL|OPFS|Worker|UNAVAILABLE/)
  })
})

describe('TasksPage planning actions and derived presentation', () => {
  test.each([
    {
      buttonName: `设为重要：${TASK.title}`,
      method: 'setTaskImportance' as const,
      value: true,
      changed: { ...TASK, isImportant: true, updatedAtMs: 200 },
    },
    {
      buttonName: `设为基础紧急：${TASK.title}`,
      method: 'setTaskUrgency' as const,
      value: true,
      changed: { ...TASK, isUrgent: true, updatedAtMs: 200 },
    },
  ])(
    '$method calls the narrow TaskService action and reloads',
    async ({ buttonName, method, value, changed }) => {
      const user = userEvent.setup()
      const fake = createServiceDouble()
      fake[method].mockResolvedValueOnce(changed)
      fake.listTasks
        .mockResolvedValueOnce([TASK])
        .mockResolvedValueOnce([changed])
      const { openRuntime } = resolvedRuntime(fake.service)
      render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
      await screen.findByText(TASK.title)

      await user.click(screen.getByRole('button', { name: buttonName }))

      expect(fake[method]).toHaveBeenCalledWith(TASK.id, value)
      expect(fake.listTasks).toHaveBeenCalledTimes(2)
    },
  )

  test('sets and clears a deadline through separate service actions', async () => {
    const user = userEvent.setup()
    const withDeadline = {
      ...TASK,
      dueDate: '2026-08-24',
      updatedAtMs: 200,
    }
    const cleared = { ...withDeadline, dueDate: null, updatedAtMs: 300 }
    const fake = createServiceDouble()
    fake.setTaskDeadline.mockResolvedValueOnce(withDeadline)
    fake.clearTaskDeadline.mockResolvedValueOnce(cleared)
    fake.listTasks
      .mockResolvedValueOnce([TASK])
      .mockResolvedValueOnce([withDeadline])
      .mockResolvedValueOnce([cleared])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(TASK.title)

    fireEvent.change(screen.getByLabelText(`任务截止日期：${TASK.title}`), {
      target: { value: '2026-08-24' },
    })
    await waitFor(() =>
      expect(fake.setTaskDeadline).toHaveBeenCalledWith(TASK.id, '2026-08-24'),
    )
    expect(fake.listTasks).toHaveBeenCalledTimes(2)

    await user.click(
      await screen.findByRole('button', {
        name: `清除截止日期：${TASK.title}`,
      }),
    )
    expect(fake.clearTaskDeadline).toHaveBeenCalledWith(TASK.id)
    await waitFor(() => expect(fake.listTasks).toHaveBeenCalledTimes(3))
  })

  test('shows overdue and overdue-driven urgency without changing base urgency', async () => {
    const overdue = { ...TASK, dueDate: '2026-08-22' }
    const fake = createServiceDouble([overdue])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)

    const list = await screen.findByRole('list', { name: '任务列表' })
    expect(within(list).getByText('已逾期')).toBeInTheDocument()
    expect(within(list).getByText('紧急（逾期）')).toBeInTheDocument()
    expect(
      within(list).getByRole('button', {
        name: `设为基础紧急：${TASK.title}`,
      }),
    ).toHaveTextContent('基础不紧急')
    expect(fake.setTaskUrgency).not.toHaveBeenCalled()
  })

  test.each([
    { title: 'Due today', status: 'todo', dueDate: '2026-08-23' },
    { title: 'Completed past due', status: 'completed', dueDate: '2026-08-22' },
    { title: 'Cancelled past due', status: 'cancelled', dueDate: '2026-08-22' },
  ] as const)('$title is not displayed as overdue', async (taskFields) => {
    const task = { ...TASK, ...taskFields }
    const fake = createServiceDouble([task])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)

    const list = await screen.findByRole('list', { name: '任务列表' })
    expect(within(list).queryByText('已逾期')).not.toBeInTheDocument()
    expect(within(list).queryByText('紧急（逾期）')).not.toBeInTheDocument()
  })

  test('moving an overdue deadline to the future removes derived urgency', async () => {
    const overdue = { ...TASK, dueDate: '2026-08-22' }
    const future = { ...TASK, dueDate: '2026-08-24', updatedAtMs: 200 }
    const fake = createServiceDouble([overdue])
    fake.setTaskDeadline.mockResolvedValueOnce(future)
    fake.listTasks
      .mockResolvedValueOnce([overdue])
      .mockResolvedValueOnce([future])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText('紧急（逾期）')

    fireEvent.change(screen.getByLabelText(`任务截止日期：${TASK.title}`), {
      target: { value: '2026-08-24' },
    })

    await waitFor(() =>
      expect(screen.queryByText('紧急（逾期）')).not.toBeInTheDocument(),
    )
    expect(screen.queryByText('已逾期')).not.toBeInTheDocument()
    expect(fake.setTaskUrgency).not.toHaveBeenCalled()
  })

  test('refreshes after planning NOT_FOUND', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    fake.setTaskImportance.mockRejectedValueOnce(
      new TaskApplicationError('NOT_FOUND'),
    )
    fake.listTasks.mockResolvedValueOnce([TASK]).mockResolvedValueOnce([])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(TASK.title)

    await user.click(
      screen.getByRole('button', { name: `设为重要：${TASK.title}` }),
    )

    expect(
      await screen.findByText('任务已不存在，列表已刷新。'),
    ).toBeInTheDocument()
    expect(await screen.findByText('还没有任务')).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })

  test('shows safe planning UNAVAILABLE feedback and remains retryable', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    fake.setTaskUrgency.mockRejectedValueOnce(
      new TaskApplicationError('UNAVAILABLE'),
    )
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(TASK.title)

    const button = screen.getByRole('button', {
      name: `设为基础紧急：${TASK.title}`,
    })
    await user.click(button)

    expect(
      await screen.findByText('操作暂时无法完成，请重试。'),
    ).toBeInTheDocument()
    expect(button).toBeEnabled()
    expect(document.body).not.toHaveTextContent(/SQL|OPFS|Worker|UNAVAILABLE/)
  })

  test('prevents duplicate planning submissions while the task is pending', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    const changing = deferred<Task>()
    fake.setTaskImportance.mockReturnValueOnce(changing.promise)
    fake.listTasks
      .mockResolvedValueOnce([TASK])
      .mockResolvedValueOnce([{ ...TASK, isImportant: true }])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(TASK.title)

    const button = screen.getByRole('button', {
      name: `设为重要：${TASK.title}`,
    })
    await user.click(button)
    expect(button).toBeDisabled()
    await user.click(button)
    expect(fake.setTaskImportance).toHaveBeenCalledOnce()

    act(() => {
      changing.resolve({ ...TASK, isImportant: true })
    })
    await waitFor(() => expect(fake.listTasks).toHaveBeenCalledTimes(2))
  })
})

describe('TasksPage date view', () => {
  test('derives today, upcoming, and overdue groups from active tasks', async () => {
    const user = userEvent.setup()
    const todayTodo = taskFixture(71, '今天到期的待办', {
      dueDate: '2026-08-23',
    })
    const todayDoing = taskFixture(72, '今天到期的进行中任务', {
      status: 'doing',
      dueDate: '2026-08-23',
    })
    const upcoming = taskFixture(73, '未来到期的任务', {
      dueDate: '2026-08-24',
    })
    const overdue = taskFixture(74, '已经逾期的任务', {
      dueDate: '2026-08-22',
    })
    const completedToday = taskFixture(75, '已完成的今日任务', {
      status: 'completed',
      dueDate: '2026-08-23',
    })
    const cancelledUpcoming = taskFixture(76, '已取消的未来任务', {
      status: 'cancelled',
      dueDate: '2026-08-24',
    })
    const withoutDeadline = taskFixture(77, '没有截止日期的任务')
    const fake = createServiceDouble([
      todayTodo,
      todayDoing,
      upcoming,
      overdue,
      completedToday,
      cancelledUpcoming,
      withoutDeadline,
    ])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByRole('list', { name: '任务列表' })

    await user.click(screen.getByRole('tab', { name: '日期' }))

    const dateView = screen.getByRole('region', { name: '任务日期视图' })
    expect(screen.getByRole('tab', { name: '日期' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      within(dateView).getByRole('button', { name: '今日，2 项任务' }),
    ).toHaveAttribute('aria-pressed', 'true')
    expect(within(dateView).getByText(todayTodo.title)).toBeInTheDocument()
    expect(within(dateView).getByText(todayDoing.title)).toBeInTheDocument()
    expect(within(dateView).queryByText(upcoming.title)).not.toBeInTheDocument()
    expect(
      within(dateView).queryByText(completedToday.title),
    ).not.toBeInTheDocument()

    await user.click(
      within(dateView).getByRole('button', {
        name: '即将到期，1 项任务',
      }),
    )
    expect(within(dateView).getByText(upcoming.title)).toBeInTheDocument()
    expect(
      within(dateView).queryByText(cancelledUpcoming.title),
    ).not.toBeInTheDocument()
    expect(
      within(dateView).queryByText(withoutDeadline.title),
    ).not.toBeInTheDocument()

    await user.click(
      within(dateView).getByRole('button', { name: '已逾期，1 项任务' }),
    )
    const overdueList = within(dateView).getByRole('list', {
      name: '任务列表',
    })
    expect(within(overdueList).getByText(overdue.title)).toBeInTheDocument()
    expect(within(overdueList).getByText('已逾期')).toBeInTheDocument()
  })

  test('re-derives the selected date group after a deadline change', async () => {
    const user = userEvent.setup()
    const todayTask = taskFixture(81, '需要改期的任务', {
      dueDate: '2026-08-23',
    })
    const movedTask = {
      ...todayTask,
      dueDate: '2026-08-24',
      updatedAtMs: 200,
    }
    const fake = createServiceDouble([todayTask])
    fake.setTaskDeadline.mockResolvedValueOnce(movedTask)
    fake.listTasks
      .mockResolvedValueOnce([todayTask])
      .mockResolvedValueOnce([movedTask])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(todayTask.title)
    await user.click(screen.getByRole('tab', { name: '日期' }))

    fireEvent.change(
      screen.getByLabelText(`任务截止日期：${todayTask.title}`),
      { target: { value: '2026-08-24' } },
    )

    expect(fake.setTaskDeadline).toHaveBeenCalledWith(
      todayTask.id,
      '2026-08-24',
    )
    expect(await screen.findByText('暂无今日任务')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '即将到期，1 项任务' }))
    expect(await screen.findByText(todayTask.title)).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })
})

describe('TasksPage calendar view', () => {
  test('renders active dated tasks in a real local month and navigates months', async () => {
    const user = userEvent.setup()
    const todayFirst = taskFixture(91, '今天的第一项任务', {
      dueDate: '2026-08-23',
    })
    const todaySecond = taskFixture(92, '今天的第二项任务', {
      status: 'doing',
      dueDate: '2026-08-23',
    })
    const nextMonth = taskFixture(93, '九月任务', {
      dueDate: '2026-09-02',
    })
    const withoutDeadline = taskFixture(94, '没有截止日期')
    const completed = taskFixture(95, '已完成任务', {
      status: 'completed',
      dueDate: '2026-08-23',
    })
    const cancelled = taskFixture(96, '已取消任务', {
      status: 'cancelled',
      dueDate: '2026-08-24',
    })
    const fake = createServiceDouble([
      todayFirst,
      todaySecond,
      nextMonth,
      withoutDeadline,
      completed,
      cancelled,
    ])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByRole('list', { name: '任务列表' })

    await user.click(screen.getByRole('tab', { name: '日历' }))

    const calendar = screen.getByRole('region', { name: '任务日历视图' })
    const agenda = within(calendar).getByRole('complementary', {
      name: '所选日期任务',
    })
    expect(screen.getByRole('tab', { name: '日历' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      within(calendar).getByRole('grid', { name: '2026年8月任务月历' }),
    ).toBeInTheDocument()
    expect(
      within(calendar).getByRole('button', {
        name: '选择2026年8月23日，2 项任务',
      }),
    ).toBeInTheDocument()
    expect(within(agenda).getByText(todayFirst.title)).toBeInTheDocument()
    expect(within(agenda).getByText(todaySecond.title)).toBeInTheDocument()
    expect(
      within(calendar).queryByText(withoutDeadline.title),
    ).not.toBeInTheDocument()
    expect(
      within(calendar).queryByText(completed.title),
    ).not.toBeInTheDocument()
    expect(
      within(calendar).queryByText(cancelled.title),
    ).not.toBeInTheDocument()

    await user.click(within(calendar).getByRole('button', { name: '上一月' }))
    expect(
      within(calendar).getByRole('grid', { name: '2026年7月任务月历' }),
    ).toBeInTheDocument()

    await user.click(within(calendar).getByRole('button', { name: '下一月' }))
    await user.click(within(calendar).getByRole('button', { name: '下一月' }))
    expect(
      within(calendar).getByRole('grid', { name: '2026年9月任务月历' }),
    ).toBeInTheDocument()
    expect(within(calendar).getByText(nextMonth.title)).toBeInTheDocument()

    await user.click(within(calendar).getByRole('button', { name: '今天' }))
    expect(
      within(calendar).getByRole('grid', { name: '2026年8月任务月历' }),
    ).toBeInTheDocument()
    expect(within(agenda).getByText(todayFirst.title)).toBeInTheDocument()
  })

  test('re-derives calendar placement after changing a deadline through TaskService', async () => {
    const user = userEvent.setup()
    const todayTask = taskFixture(97, '月历中改期的任务', {
      dueDate: '2026-08-23',
    })
    const movedTask = {
      ...todayTask,
      dueDate: '2026-08-24',
      updatedAtMs: 200,
    }
    const fake = createServiceDouble([todayTask])
    fake.setTaskDeadline.mockResolvedValueOnce(movedTask)
    fake.listTasks
      .mockResolvedValueOnce([todayTask])
      .mockResolvedValueOnce([movedTask])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(todayTask.title)
    await user.click(screen.getByRole('tab', { name: '日历' }))

    const calendar = screen.getByRole('region', { name: '任务日历视图' })
    const agenda = within(calendar).getByRole('complementary', {
      name: '所选日期任务',
    })
    fireEvent.change(
      within(agenda).getByLabelText(`任务截止日期：${todayTask.title}`),
      { target: { value: '2026-08-24' } },
    )

    expect(fake.setTaskDeadline).toHaveBeenCalledWith(
      todayTask.id,
      '2026-08-24',
    )
    expect(
      await within(agenda).findByText('当天暂无到期任务'),
    ).toBeInTheDocument()
    await user.click(
      within(calendar).getByRole('button', {
        name: '选择2026年8月24日，1 项任务',
      }),
    )
    expect(await within(agenda).findByText(todayTask.title)).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })
})

describe('TasksPage task detail panel', () => {
  test('opens the same detail panel from list, quadrant, date, and calendar views', async () => {
    const user = userEvent.setup()
    const task = taskFixture(101, '跨视图详情任务', {
      dueDate: '2026-08-23',
      isImportant: true,
    })
    const fake = createServiceDouble([task])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByRole('list', { name: '任务列表' })

    await user.click(
      screen.getByRole('button', {
        name: `查看任务详情：${task.title}`,
      }),
    )
    expect(
      screen.getByRole('dialog', { name: `任务详情：${task.title}` }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭' }))

    await user.click(screen.getByRole('tab', { name: '四象限' }))
    const quadrant = screen.getByRole('region', { name: '任务四象限' })
    await user.click(
      within(quadrant).getByRole('button', {
        name: `查看任务详情：${task.title}`,
      }),
    )
    expect(
      screen.getByRole('dialog', { name: `任务详情：${task.title}` }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭' }))

    await user.click(screen.getByRole('tab', { name: '日期' }))
    const dateView = screen.getByRole('region', { name: '任务日期视图' })
    await user.click(
      within(dateView).getByRole('button', {
        name: `查看任务详情：${task.title}`,
      }),
    )
    expect(
      screen.getByRole('dialog', { name: `任务详情：${task.title}` }),
    ).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: '关闭' }))

    await user.click(screen.getByRole('tab', { name: '日历' }))
    const calendarGrid = screen.getByRole('grid', {
      name: '2026年8月任务月历',
    })
    await user.click(
      within(calendarGrid).getByRole('button', {
        name: `查看任务详情：${task.title}，截止日期 2026-08-23`,
      }),
    )
    expect(
      screen.getByRole('dialog', { name: `任务详情：${task.title}` }),
    ).toBeInTheDocument()
  })

  test('re-derives planning fields from the latest reloaded Task', async () => {
    const user = userEvent.setup()
    const task = taskFixture(102, '详情规划任务', {
      dueDate: '2026-08-22',
    })
    const important = { ...task, isImportant: true, updatedAtMs: 200 }
    const urgent = { ...important, isUrgent: true, updatedAtMs: 300 }
    const moved = { ...urgent, dueDate: '2026-08-24', updatedAtMs: 400 }
    const cleared = { ...moved, dueDate: null, updatedAtMs: 500 }
    const fake = createServiceDouble([task])
    fake.setTaskImportance.mockResolvedValueOnce(important)
    fake.setTaskUrgency.mockResolvedValueOnce(urgent)
    fake.setTaskDeadline.mockResolvedValueOnce(moved)
    fake.clearTaskDeadline.mockResolvedValueOnce(cleared)
    fake.listTasks
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([important])
      .mockResolvedValueOnce([urgent])
      .mockResolvedValueOnce([moved])
      .mockResolvedValueOnce([cleared])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(task.title)
    await user.click(
      screen.getByRole('button', { name: `查看任务详情：${task.title}` }),
    )

    let detail = screen.getByRole('dialog', {
      name: `任务详情：${task.title}`,
    })
    expect(within(detail).getByText('已逾期')).toBeInTheDocument()
    expect(within(detail).getByText('由逾期产生')).toBeInTheDocument()

    await user.click(
      within(detail).getByRole('button', {
        name: `设为重要：${task.title}`,
      }),
    )
    await waitFor(() =>
      expect(
        within(detail).getByRole('button', {
          name: `取消重要：${task.title}`,
        }),
      ).toBeInTheDocument(),
    )

    await user.click(
      within(detail).getByRole('button', {
        name: `设为基础紧急：${task.title}`,
      }),
    )
    await waitFor(() =>
      expect(
        within(detail).getByRole('button', {
          name: `取消基础紧急：${task.title}`,
        }),
      ).toBeInTheDocument(),
    )

    fireEvent.change(
      within(detail).getByLabelText(`详情截止日期：${task.title}`),
      { target: { value: '2026-08-24' } },
    )
    await waitFor(() => {
      detail = screen.getByRole('dialog', {
        name: `任务详情：${task.title}`,
      })
      expect(within(detail).queryByText('已逾期')).not.toBeInTheDocument()
      expect(
        within(detail).getByLabelText(`详情截止日期：${task.title}`),
      ).toHaveValue('2026-08-24')
    })

    await user.click(
      within(detail).getByRole('button', {
        name: `清除详情截止日期：${task.title}`,
      }),
    )
    await waitFor(() =>
      expect(
        within(detail).getByLabelText(`详情截止日期：${task.title}`),
      ).toHaveValue(''),
    )
    expect(fake.listTasks).toHaveBeenCalledTimes(5)
  })

  test('keeps detail open and current through status transitions', async () => {
    const user = userEvent.setup()
    const task = taskFixture(103, '详情状态任务')
    const doing = { ...task, status: 'doing' as const, updatedAtMs: 200 }
    const cancelled = {
      ...doing,
      status: 'cancelled' as const,
      updatedAtMs: 300,
    }
    const reopened = { ...cancelled, status: 'todo' as const, updatedAtMs: 400 }
    const completed = {
      ...reopened,
      status: 'completed' as const,
      updatedAtMs: 500,
    }
    const fake = createServiceDouble([task])
    fake.startTask.mockResolvedValueOnce(doing)
    fake.cancelTask.mockResolvedValueOnce(cancelled)
    fake.reopenTask.mockResolvedValueOnce(reopened)
    fake.completeTask.mockResolvedValueOnce(completed)
    fake.listTasks
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([doing])
      .mockResolvedValueOnce([cancelled])
      .mockResolvedValueOnce([reopened])
      .mockResolvedValueOnce([completed])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(task.title)
    await user.click(
      screen.getByRole('button', { name: `查看任务详情：${task.title}` }),
    )

    const detail = screen.getByRole('dialog', {
      name: `任务详情：${task.title}`,
    })
    await user.click(within(detail).getByRole('button', { name: '开始' }))
    expect(await within(detail).findByText('进行中')).toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: '取消' }))
    expect(await within(detail).findByText('已取消')).toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: '恢复' }))
    expect(await within(detail).findByText('待开始')).toBeInTheDocument()

    await user.click(within(detail).getByRole('button', { name: '完成' }))
    expect(await within(detail).findByText('已完成')).toBeInTheDocument()
    expect(
      screen.getByRole('dialog', { name: `任务详情：${task.title}` }),
    ).toBeInTheDocument()
    expect(fake.listTasks).toHaveBeenCalledTimes(5)
  })

  test('opens the existing rename flow and displays the reloaded title', async () => {
    const user = userEvent.setup()
    const task = taskFixture(104, '详情原始标题')
    const renamed = { ...task, title: '详情更新标题', updatedAtMs: 200 }
    const fake = createServiceDouble([task])
    fake.renameTask.mockResolvedValueOnce(renamed)
    fake.listTasks
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([renamed])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(task.title)
    await user.click(
      screen.getByRole('button', { name: `查看任务详情：${task.title}` }),
    )

    const detail = screen.getByRole('dialog', {
      name: `任务详情：${task.title}`,
    })
    await user.click(
      within(detail).getByRole('button', {
        name: `重命名任务：${task.title}`,
      }),
    )
    const renameDialog = screen.getByRole('dialog', { name: '重命名任务' })
    const input = within(renameDialog).getByLabelText('标题')
    await user.clear(input)
    await user.type(input, renamed.title)
    await user.click(
      within(renameDialog).getByRole('button', { name: '保存修改' }),
    )

    expect(
      await screen.findByRole('dialog', {
        name: `任务详情：${renamed.title}`,
      }),
    ).toBeInTheDocument()
    expect(fake.renameTask).toHaveBeenCalledWith({
      id: task.id,
      title: renamed.title,
    })
    expect(fake.listTasks).toHaveBeenCalledTimes(2)
  })
})

describe('TasksPage quadrant view', () => {
  test('defaults to list and switches to correctly grouped quadrants', async () => {
    const user = userEvent.setup()
    const q1Overdue = taskFixture(11, '逾期的重要任务', {
      isImportant: true,
      isUrgent: false,
      dueDate: '2026-08-22',
    })
    const q2 = taskFixture(12, '重要的计划任务', { isImportant: true })
    const q3 = taskFixture(13, '紧急的小任务', { isUrgent: true })
    const q4 = taskFixture(14, '稍后处理的任务', { status: 'doing' })
    const completed = taskFixture(15, '已经完成的任务', {
      status: 'completed',
      isImportant: true,
      isUrgent: true,
    })
    const cancelled = taskFixture(16, '已经取消的任务', {
      status: 'cancelled',
    })
    const fake = createServiceDouble([
      q1Overdue,
      q2,
      q3,
      q4,
      completed,
      cancelled,
    ])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)

    expect(
      await screen.findByRole('list', { name: '任务列表' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: '列表' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    expect(
      screen.queryByRole('region', { name: '任务四象限' }),
    ).not.toBeInTheDocument()

    await user.click(screen.getByRole('tab', { name: '四象限' }))

    const board = screen.getByRole('region', { name: '任务四象限' })
    expect(screen.getByRole('tab', { name: '四象限' })).toHaveAttribute(
      'aria-selected',
      'true',
    )
    for (const [title, taskTitle] of [
      ['重要且紧急', q1Overdue.title],
      ['重要不紧急', q2.title],
      ['不重要但紧急', q3.title],
      ['不重要不紧急', q4.title],
    ] as const) {
      const quadrant = within(board).getByRole('region', { name: title })
      expect(within(quadrant).getByText(taskTitle)).toBeInTheDocument()
      expect(
        within(quadrant).getByLabelText(`${title}任务数量 1`),
      ).toBeInTheDocument()
    }
    const urgentQuadrant = within(board).getByRole('region', {
      name: '重要且紧急',
    })
    expect(within(urgentQuadrant).getByText('已逾期')).toBeInTheDocument()
    expect(within(urgentQuadrant).getByText('紧急（逾期）')).toBeInTheDocument()
    expect(within(board).queryByText(completed.title)).not.toBeInTheDocument()
    expect(within(board).queryByText(cancelled.title)).not.toBeInTheDocument()
  })

  test('keeps all quadrants visible when there are no active tasks', async () => {
    const user = userEvent.setup()
    const completed = taskFixture(21, '已完成', { status: 'completed' })
    const cancelled = taskFixture(22, '已取消', { status: 'cancelled' })
    const fake = createServiceDouble([completed, cancelled])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByRole('list', { name: '任务列表' })

    await user.click(screen.getByRole('tab', { name: '四象限' }))

    expect(screen.getByText('当前没有待开始或进行中的任务')).toBeInTheDocument()
    expect(screen.getAllByText('暂无任务')).toHaveLength(4)
    for (const title of [
      '重要且紧急',
      '重要不紧急',
      '不重要但紧急',
      '不重要不紧急',
    ]) {
      expect(screen.getByRole('region', { name: title })).toBeInTheDocument()
      expect(screen.getByLabelText(`${title}任务数量 0`)).toBeInTheDocument()
    }
  })

  test.each([
    {
      label: 'importance',
      buttonName: '设为重要',
      method: 'setTaskImportance' as const,
      value: true,
      changed: { isImportant: true },
      from: '不重要不紧急',
      to: '重要不紧急',
    },
    {
      label: 'base urgency',
      buttonName: '设为基础紧急',
      method: 'setTaskUrgency' as const,
      value: true,
      changed: { isUrgent: true },
      from: '不重要不紧急',
      to: '不重要但紧急',
    },
  ])(
    'reloads and re-derives the quadrant after changing $label',
    async ({ buttonName, method, value, changed, from, to }) => {
      const user = userEvent.setup()
      const task = taskFixture(31, '跨象限任务')
      const changedTask = { ...task, ...changed, updatedAtMs: 200 }
      const fake = createServiceDouble([task])
      fake[method].mockResolvedValueOnce(changedTask)
      fake.listTasks
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([changedTask])
      const { openRuntime } = resolvedRuntime(fake.service)
      render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
      await screen.findByText(task.title)
      await user.click(screen.getByRole('tab', { name: '四象限' }))

      const source = screen.getByRole('region', { name: from })
      expect(within(source).getByText(task.title)).toBeInTheDocument()
      await user.click(
        within(source).getByRole('button', {
          name: `${buttonName}：${task.title}`,
        }),
      )

      expect(fake[method]).toHaveBeenCalledWith(task.id, value)
      await waitFor(() =>
        expect(
          within(screen.getByRole('region', { name: to })).getByText(
            task.title,
          ),
        ).toBeInTheDocument(),
      )
      expect(
        within(screen.getByRole('region', { name: from })).queryByText(
          task.title,
        ),
      ).not.toBeInTheDocument()
      expect(fake.listTasks).toHaveBeenCalledTimes(2)
    },
  )

  test('reloads and moves a task when a deadline creates overdue urgency', async () => {
    const task = taskFixture(41, '截止日期跨象限', { isImportant: true })
    const overdue = {
      ...task,
      dueDate: '2026-08-22',
      updatedAtMs: 200,
    }
    const fake = createServiceDouble([task])
    fake.setTaskDeadline.mockResolvedValueOnce(overdue)
    fake.listTasks
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([overdue])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(task.title)
    fireEvent.click(screen.getByRole('tab', { name: '四象限' }))

    fireEvent.change(screen.getByLabelText(`任务截止日期：${task.title}`), {
      target: { value: '2026-08-22' },
    })

    await waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: '重要且紧急' })).getByText(
          task.title,
        ),
      ).toBeInTheDocument(),
    )
    expect(fake.setTaskDeadline).toHaveBeenCalledWith(task.id, '2026-08-22')
    expect(screen.getByText('紧急（逾期）')).toBeInTheDocument()
    expect(fake.setTaskUrgency).not.toHaveBeenCalled()
  })

  test.each([
    { action: '完成', method: 'completeTask' as const, status: 'completed' },
    { action: '取消', method: 'cancelTask' as const, status: 'cancelled' },
  ] as const)(
    '$action removes the refreshed task from all quadrants',
    async ({ action, method, status }) => {
      const user = userEvent.setup()
      const task = taskFixture(51, `${action}后退出象限`)
      const inactive = { ...task, status, updatedAtMs: 200 }
      const fake = createServiceDouble([task])
      fake[method].mockResolvedValueOnce(inactive)
      fake.listTasks
        .mockResolvedValueOnce([task])
        .mockResolvedValueOnce([inactive])
      const { openRuntime } = resolvedRuntime(fake.service)
      render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
      await screen.findByText(task.title)
      await user.click(screen.getByRole('tab', { name: '四象限' }))

      await user.click(
        screen.getByRole('button', { name: `${action}任务：${task.title}` }),
      )

      await waitFor(() =>
        expect(screen.queryByText(task.title)).not.toBeInTheDocument(),
      )
      expect(fake[method]).toHaveBeenCalledWith(task.id)
      expect(
        screen.getByText('当前没有待开始或进行中的任务'),
      ).toBeInTheDocument()
      expect(fake.listTasks).toHaveBeenCalledTimes(2)
    },
  )

  test('disables quadrant actions and prevents duplicate operations while pending', async () => {
    const user = userEvent.setup()
    const task = taskFixture(61, '防止重复操作')
    const changed = { ...task, isImportant: true, updatedAtMs: 200 }
    const changing = deferred<Task>()
    const fake = createServiceDouble([task])
    fake.setTaskImportance.mockReturnValueOnce(changing.promise)
    fake.listTasks
      .mockResolvedValueOnce([task])
      .mockResolvedValueOnce([changed])
    const { openRuntime } = resolvedRuntime(fake.service)
    render(<TasksPage openRuntime={openRuntime} today="2026-08-23" />)
    await screen.findByText(task.title)
    await user.click(screen.getByRole('tab', { name: '四象限' }))

    const button = screen.getByRole('button', {
      name: `设为重要：${task.title}`,
    })
    await user.click(button)
    expect(button).toBeDisabled()
    await user.click(button)
    expect(fake.setTaskImportance).toHaveBeenCalledOnce()

    act(() => {
      changing.resolve(changed)
    })
    await waitFor(() => expect(fake.listTasks).toHaveBeenCalledTimes(2))
  })
})
