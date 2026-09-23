import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { ArchivePage } from '@/pages/ArchivePage'
import type { ArchiveItem } from '@/archive/model'
import type { ArchiveService } from '@/archive/service'
import type { ArchiveRuntime, OpenArchiveRuntime } from '@/archive/runtime.types'

const TASK_ITEM: ArchiveItem = {
  entityType: 'task',
  entityId: '00000000-0000-4000-8000-000000000001',
  title: '归档任务',
  archivedAtMs: 300,
}
const NOTE_ITEM: ArchiveItem = {
  entityType: 'note',
  entityId: '00000000-0000-4000-8000-000000000002',
  title: '归档笔记',
  archivedAtMs: 200,
}
const EMPTY_TITLE_TASK: ArchiveItem = {
  entityType: 'task',
  entityId: '00000000-0000-4000-8000-000000000003',
  title: '',
  archivedAtMs: 100,
}

const LIST_LABEL = '归档条目'

function createServiceDouble(
  items: readonly ArchiveItem[] = [TASK_ITEM, NOTE_ITEM],
) {
  const list = vi.fn(() => Promise.resolve(items))
  const unarchive = vi.fn(() => Promise.resolve())
  const moveToTrash = vi.fn(() => Promise.resolve())
  const service: ArchiveService = { list, unarchive, moveToTrash }
  return { service, list, unarchive, moveToTrash }
}

function resolvedRuntime(service: ArchiveService) {
  const dispose = vi.fn(() => Promise.resolve())
  const runtime: ArchiveRuntime = { service, dispose }
  const openRuntime = vi.fn<OpenArchiveRuntime>(() => Promise.resolve(runtime))
  return { openRuntime, dispose, runtime }
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

/** The <li> row for a given archive title. */
function rowFor(title: string): HTMLElement {
  const list = screen.getByRole('list', { name: LIST_LABEL })
  const heading = within(list).getByText(title)
  const row = heading.closest('li')
  if (row === null) {
    throw new Error(`No archive row for title: ${title}`)
  }
  return row
}

describe('ArchivePage loading and empty state', () => {
  test('shows the loading skeleton then the real list with entity labels and timestamps', async () => {
    const fake = createServiceDouble([TASK_ITEM, NOTE_ITEM, EMPTY_TITLE_TASK])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)

    expect(
      screen.getByRole('status', { name: '正在加载归档' }),
    ).toBeInTheDocument()

    const list = await screen.findByRole('list', { name: LIST_LABEL })
    expect(list).toBeInTheDocument()
    expect(within(list).getByText('归档任务')).toBeInTheDocument()
    expect(within(list).getByText('归档笔记')).toBeInTheDocument()
    // Empty-title fallback (UI-owned) is shown, not a blank heading.
    expect(within(list).getByText('未命名任务')).toBeInTheDocument()
    // archivedAt timestamp is rendered on every row.
    expect(within(list).getAllByText(/归档于/)).toHaveLength(3)
    // Entity labels: 2 tasks (TASK_ITEM + EMPTY_TITLE_TASK) and 1 note.
    expect(within(list).getAllByText('任务', { exact: true })).toHaveLength(2)
    expect(within(list).getAllByText('笔记', { exact: true })).toHaveLength(1)
    // Every row offers exactly one unarchive + one move-to-trash action.
    expect(
      within(list).getAllByRole('button', { name: '取消归档' }),
    ).toHaveLength(3)
    expect(
      within(list).getAllByRole('button', { name: '移入回收站' }),
    ).toHaveLength(3)
  })

  test('empty archive renders the empty state with no destructive affordances', async () => {
    const fake = createServiceDouble([])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)

    expect(
      await screen.findByRole('heading', { name: '归档是空的' }),
    ).toBeInTheDocument()
    // No permanent delete / clear archive / bulk destructive controls exist.
    expect(
      screen.queryByRole('button', { name: '永久删除' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '清空归档' }),
    ).not.toBeInTheDocument()
  })
})

describe('ArchivePage runtime and list errors', () => {
  test('runtime open failure: safe error and retry opens a fresh runtime', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    const openRuntime = vi.fn<OpenArchiveRuntime>()
    openRuntime.mockRejectedValueOnce(new Error('OPFS worker unavailable'))
    openRuntime.mockResolvedValueOnce({
      service: fake.service,
      dispose: vi.fn(() => Promise.resolve()),
    })

    render(<ArchivePage openRuntime={openRuntime} />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('无法加载归档')).toBeInTheDocument()
    expect(alert).not.toHaveTextContent(/SQL|OPFS|Worker/)

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    await screen.findByRole('list', { name: LIST_LABEL })
    expect(openRuntime).toHaveBeenCalledTimes(2)
  })

  test('list failure: safe error and retry reloads the list', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble()
    fake.list.mockRejectedValueOnce(new Error('database closed'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('无法加载归档')).toBeInTheDocument()

    await user.click(within(alert).getByRole('button', { name: '重试' }))
    await screen.findByRole('list', { name: LIST_LABEL })
    expect(fake.list).toHaveBeenCalledTimes(2)
  })
})

describe('ArchivePage unarchive', () => {
  test('unarchive a task: dispatches and removes only that row (note row stays)', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM, NOTE_ITEM])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    const list = await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '取消归档' }),
    )

    await waitFor(() =>
      expect(fake.unarchive).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: TASK_ITEM.entityId,
      }),
    )
    await waitFor(() =>
      expect(within(list).queryByText('归档任务')).not.toBeInTheDocument(),
    )
    expect(within(list).getByText('归档笔记')).toBeInTheDocument()
  })

  test('unarchive a note: dispatches and removes only that row (task row stays)', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM, NOTE_ITEM])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    const list = await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档笔记')).getByRole('button', { name: '取消归档' }),
    )

    await waitFor(() =>
      expect(fake.unarchive).toHaveBeenCalledWith({
        entityType: 'note',
        entityId: NOTE_ITEM.entityId,
      }),
    )
    await waitFor(() =>
      expect(within(list).queryByText('归档笔记')).not.toBeInTheDocument(),
    )
    expect(within(list).getByText('归档任务')).toBeInTheDocument()
  })

  test('unarchive failure: row is retained and an error is shown', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM, NOTE_ITEM])
    fake.unarchive.mockRejectedValueOnce(new Error('repository unavailable'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '取消归档' }),
    )

    await waitFor(() =>
      expect(screen.getByText('取消归档失败，请重试')).toBeInTheDocument(),
    )
    expect(within(rowFor('归档任务')).getByText('归档任务')).toBeInTheDocument()
    expect(
      within(rowFor('归档任务')).getByRole('button', { name: '取消归档' }),
    ).toBeEnabled()
  })

  test('per-row pending prevents a duplicate unarchive action', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM])
    const unarchiveDeferred = deferred<void>()
    fake.unarchive.mockReturnValue(unarchiveDeferred.promise)
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '取消归档' }),
    )
    const pendingButton = within(rowFor('归档任务')).getByRole('button', {
      name: '处理中…',
    })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(fake.unarchive).toHaveBeenCalledOnce()

    act(() => {
      unarchiveDeferred.resolve()
    })
    await waitFor(() => expect(fake.unarchive).toHaveBeenCalledOnce())
  })
})

describe('ArchivePage move to Trash', () => {
  test('opens a confirmation, cancel closes it without calling the service', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '移入回收站' }),
    )
    expect(
      within(rowFor('归档任务')).getAllByText(/移入回收站/),
    ).toHaveLength(2)
    expect(
      within(rowFor('归档任务')).getByRole('button', {
        name: '确认移入回收站',
      }),
    ).toBeInTheDocument()

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '取消' }),
    )
    expect(
      within(rowFor('归档任务')).queryByRole('button', {
        name: '确认移入回收站',
      }),
    ).not.toBeInTheDocument()
    expect(fake.moveToTrash).not.toHaveBeenCalled()
  })

  test('confirm move to Trash: dispatches and removes the row', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM, NOTE_ITEM])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    const list = await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '移入回收站' }),
    )
    await user.click(
      within(rowFor('归档任务')).getByRole('button', {
        name: '确认移入回收站',
      }),
    )

    await waitFor(() =>
      expect(fake.moveToTrash).toHaveBeenCalledWith({
        entityType: 'task',
        entityId: TASK_ITEM.entityId,
      }),
    )
    await waitFor(() =>
      expect(within(list).queryByText('归档任务')).not.toBeInTheDocument(),
    )
    expect(within(list).getByText('归档笔记')).toBeInTheDocument()
  })

  test('move to Trash failure: row is retained and an error is shown', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM])
    fake.moveToTrash.mockRejectedValueOnce(new Error('repository unavailable'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '移入回收站' }),
    )
    await user.click(
      within(rowFor('归档任务')).getByRole('button', {
        name: '确认移入回收站',
      }),
    )

    await waitFor(() =>
      expect(screen.getByText('移入回收站失败，请重试')).toBeInTheDocument(),
    )
    expect(within(rowFor('归档任务')).getByText('归档任务')).toBeInTheDocument()
  })

  test('per-row pending prevents a duplicate move-to-trash confirmation', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([TASK_ITEM])
    const trashDeferred = deferred<void>()
    fake.moveToTrash.mockReturnValue(trashDeferred.promise)
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    await screen.findByRole('list', { name: LIST_LABEL })

    await user.click(
      within(rowFor('归档任务')).getByRole('button', { name: '移入回收站' }),
    )
    await user.click(
      within(rowFor('归档任务')).getByRole('button', {
        name: '确认移入回收站',
      }),
    )
    const pendingButton = within(rowFor('归档任务')).getByRole('button', {
      name: '移入中…',
    })
    expect(pendingButton).toBeDisabled()
    await user.click(pendingButton)
    expect(fake.moveToTrash).toHaveBeenCalledOnce()

    act(() => {
      trashDeferred.resolve()
    })
    await waitFor(() => expect(fake.moveToTrash).toHaveBeenCalledOnce())
  })
})

describe('ArchivePage destructive-control guardrails', () => {
  test('exposes no permanent delete or clear-archive control anywhere in the page', async () => {
    const fake = createServiceDouble([TASK_ITEM, NOTE_ITEM])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<ArchivePage openRuntime={openRuntime} />)
    await screen.findByRole('list', { name: LIST_LABEL })

    expect(
      screen.queryByRole('button', { name: '永久删除' }),
    ).not.toBeInTheDocument()
    expect(
      screen.queryByRole('button', { name: '清空归档' }),
    ).not.toBeInTheDocument()
  })
})
