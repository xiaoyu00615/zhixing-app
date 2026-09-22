import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { type Mock, describe, expect, test, vi } from 'vitest'

import { TrashPage } from '@/pages/TrashPage'
import type { TrashItem } from '@/trash/model'
import type { OpenTrashRuntime } from '@/trash/runtime.types'
import type { TrashService } from '@/trash/service'

const TASK_ID = '00000000-0000-4000-8000-000000000001'
const NOTE_ID = '00000000-0000-4000-8000-000000000002'
const DIARY_ID = '00000000-0000-4000-8000-000000000003'

const TASK_ROW: TrashItem = {
  entityType: 'task',
  entityId: TASK_ID,
  title: '整理季度计划',
  deletedAtMs: 300,
}
const NOTE_ROW: TrashItem = {
  entityType: 'note',
  entityId: NOTE_ID,
  title: '会议纪要',
  deletedAtMs: 200,
}
const DIARY_ROW: TrashItem = {
  entityType: 'diary',
  entityId: DIARY_ID,
  title: '复盘一天',
  deletedAtMs: 100,
}

interface FakeRuntime {
  readonly openRuntime: OpenTrashRuntime
  readonly list: Mock<TrashService['list']>
  readonly restore: Mock<TrashService['restore']>
  readonly dispose: Mock<() => void>
}

function createRuntime(
  items: readonly TrashItem[] = [TASK_ROW, NOTE_ROW, DIARY_ROW],
): FakeRuntime {
  const list = vi.fn<TrashService['list']>()
  list.mockResolvedValue(items)
  const restore = vi.fn<TrashService['restore']>()
  restore.mockResolvedValue(undefined)
  const dispose = vi.fn<() => void>()
  const service = { list, restore } as unknown as TrashService
  const openRuntime: OpenTrashRuntime = vi.fn().mockResolvedValue({
    service,
    dispose,
  })
  return { openRuntime, list, restore, dispose }
}

function restoreButtons(): HTMLElement[] {
  return screen.getAllByRole('button', { name: '恢复' })
}

describe('Unified TrashPage', () => {
  test('shows the loading skeleton before the runtime resolves', () => {
    const fake = createRuntime([])
    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(screen.getByLabelText('正在加载回收站')).toBeInTheDocument()
    expect(screen.queryByText('回收站是空的')).not.toBeInTheDocument()
  })

  test('shows the loading skeleton while the trash list is still loading', async () => {
    const fake = createRuntime([])
    let resolveList: (value: readonly TrashItem[]) => void = () => {}
    fake.list.mockImplementation(
      () =>
        new Promise<readonly TrashItem[]>((resolve) => {
          resolveList = resolve
        }),
    )

    render(<TrashPage openRuntime={fake.openRuntime} />)

    await waitFor(() => expect(fake.list).toHaveBeenCalledOnce())
    expect(screen.getByLabelText('正在加载回收站')).toBeInTheDocument()

    resolveList([])
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
  })

  test('shows an empty state when persistence returns no rows', async () => {
    const fake = createRuntime([])
    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByLabelText('正在加载回收站')).not.toBeInTheDocument()
  })

  test('reports a runtime initialization failure and offers retry', async () => {
    const user = userEvent.setup()
    const fake = createRuntime([])
    vi.mocked(fake.openRuntime)
      .mockRejectedValueOnce(new Error('worker / OPFS / sqlite detail'))
      .mockResolvedValueOnce({
        service: { list: fake.list, restore: fake.restore },
        dispose: fake.dispose,
      })

    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText('无法加载回收站')).toBeInTheDocument()
    expect(screen.queryByText(/worker|OPFS|sqlite/)).not.toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(fake.openRuntime).toHaveBeenCalledTimes(2)
  })

  test('offers retry after an isolated trash list failure', async () => {
    const user = userEvent.setup()
    const fake = createRuntime([])
    fake.list
      .mockRejectedValueOnce(new Error('trash read failed'))
      .mockResolvedValueOnce([])

    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText('无法加载回收站')).toBeInTheDocument()

    await user.click(screen.getByRole('button', { name: '重试' }))

    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(fake.list).toHaveBeenCalledTimes(2)
    expect(fake.openRuntime).toHaveBeenCalledTimes(1)
  })

  test('renders one row per entity type with the correct label and title', async () => {
    const fake = createRuntime()
    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText(TASK_ROW.title)).toBeInTheDocument()
    expect(screen.getByText(NOTE_ROW.title)).toBeInTheDocument()
    expect(screen.getByText(DIARY_ROW.title)).toBeInTheDocument()
    expect(screen.getAllByText('任务')).toHaveLength(1)
    expect(screen.getAllByText('笔记')).toHaveLength(1)
    expect(screen.getAllByText('日记')).toHaveLength(1)
  })

  test('falls back to a safe Note title without mutating source data', async () => {
    const fake = createRuntime([
      { entityType: 'note', entityId: NOTE_ID, title: '   ', deletedAtMs: 10 },
    ])
    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText('未命名笔记')).toBeInTheDocument()
    expect(fake.list).toHaveBeenCalledOnce()
  })

  test('falls back to a safe Diary title without mutating source data', async () => {
    const fake = createRuntime([
      { entityType: 'diary', entityId: DIARY_ID, title: '', deletedAtMs: 10 },
    ])
    render(<TrashPage openRuntime={fake.openRuntime} />)

    expect(await screen.findByText('未命名日记')).toBeInTheDocument()
  })

  test('renders the deleted time for every row', async () => {
    const fake = createRuntime()
    render(<TrashPage openRuntime={fake.openRuntime} />)

    await screen.findByText(TASK_ROW.title)
    expect(screen.getAllByText(/删除于/)).toHaveLength(3)
  })

  test('offers exactly one restore action per row and no destructive actions', async () => {
    const fake = createRuntime()
    render(<TrashPage openRuntime={fake.openRuntime} />)

    await screen.findByText(TASK_ROW.title)
    expect(restoreButtons()).toHaveLength(3)
    expect(screen.queryByText(/永久删除|清空回收站/)).not.toBeInTheDocument()
    expect(screen.queryByText('画布')).not.toBeInTheDocument()
  })

  test('restores a row through the service and removes it after success', async () => {
    const user = userEvent.setup()
    const fake = createRuntime([NOTE_ROW])
    render(<TrashPage openRuntime={fake.openRuntime} />)

    await user.click(await screen.findByRole('button', { name: '恢复' }))

    expect(fake.restore).toHaveBeenCalledWith({
      entityType: 'note',
      entityId: NOTE_ID,
    })
    expect(await screen.findByText('回收站是空的')).toBeInTheDocument()
    expect(screen.queryByText(NOTE_ROW.title)).not.toBeInTheDocument()
  })

  test('keeps the row visible and shows a safe message when restore fails', async () => {
    const user = userEvent.setup()
    const fake = createRuntime([DIARY_ROW])
    fake.restore.mockRejectedValue(new Error('rusqlite UPDATE diary_entries'))

    render(<TrashPage openRuntime={fake.openRuntime} />)

    await user.click(await screen.findByRole('button', { name: '恢复' }))

    expect(await screen.findByText('恢复失败，请重试')).toBeInTheDocument()
    expect(screen.getByText(DIARY_ROW.title)).toBeInTheDocument()
    expect(screen.queryByText(/rusqlite|UPDATE|diary_entries/)).not.toBeInTheDocument()
  })

  test('disables the restore action of a row while its restore is pending', async () => {
    const user = userEvent.setup()
    const fake = createRuntime([TASK_ROW, NOTE_ROW])
    fake.restore.mockImplementation(() => new Promise<void>(() => {}))

    render(<TrashPage openRuntime={fake.openRuntime} />)

    await screen.findByText(TASK_ROW.title)
    const [button] = restoreButtons()
    if (button === undefined) {
      throw new Error('expected at least one restore button')
    }
    await user.click(button)

    expect(button).toBeDisabled()
    expect(restoreButtons()).toHaveLength(1)
  })

  test('disposes the runtime on unmount', async () => {
    const fake = createRuntime([])
    const { unmount } = render(<TrashPage openRuntime={fake.openRuntime} />)

    await screen.findByText('回收站是空的')
    unmount()

    await waitFor(() => expect(fake.dispose).toHaveBeenCalledOnce())
  })
})
