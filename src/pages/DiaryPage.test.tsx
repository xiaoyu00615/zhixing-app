import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { DiaryPage } from '@/pages/DiaryPage'
import type { DiaryDate, DiaryEntry } from '@/diary/model'
import type { DiaryRuntime } from '@/diary/runtime.types'
import { DiaryApplicationError, type DiaryService } from '@/diary/service'
import { localDateFromDate } from '@/shared/validation'
import { MaintenanceCoordinator } from '@/maintenance/coordinator'
import { MaintenanceCoordinatorProvider } from '@/maintenance/context'

afterEach(() => {
  vi.restoreAllMocks()
})

const TODAY = localDateFromDate(new Date())

const DIARY_TODAY: DiaryEntry = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '今日日记',
  content: '今天发生的事。',
  diaryDate: TODAY,
  createdAtMs: 100,
  updatedAtMs: 200,
  deletedAtMs: null,
}

const DIARY_A: DiaryEntry = {
  id: '00000000-0000-4000-8000-000000000002',
  title: '登山日记',
  content: '今天爬上了山顶。',
  diaryDate: '2026-09-18',
  createdAtMs: 120,
  updatedAtMs: 220,
  deletedAtMs: null,
}

const DIARY_B: DiaryEntry = {
  id: '00000000-0000-4000-8000-000000000003',
  title: '读书日记',
  content: '读完了第三章。',
  diaryDate: '2026-09-17',
  createdAtMs: 140,
  updatedAtMs: 240,
  deletedAtMs: null,
}

function createServiceDouble(initial: readonly DiaryEntry[] = [DIARY_A, DIARY_B]) {
  const store: DiaryEntry[] = initial.map((entry) => ({ ...entry }))
  const listActive = vi.fn<DiaryService['listActive']>()
  listActive.mockImplementation(() =>
    Promise.resolve(store.map((entry) => ({ ...entry }))),
  )
  const getActiveByDiaryDate = vi.fn<DiaryService['getActiveByDiaryDate']>()
  getActiveByDiaryDate.mockImplementation((date: DiaryDate) => {
    const found = store.find((entry) => entry.diaryDate === date)
    return Promise.resolve(found ? { ...found } : null)
  })
  let createCounter = 100
  const createDiaryEntry = vi.fn<DiaryService['createDiaryEntry']>()
  createDiaryEntry.mockImplementation((input) => {
    const id = `00000000-0000-4000-8000-0000000000${createCounter++}`
    const entry: DiaryEntry = {
      id,
      title: input.title,
      content: input.content,
      diaryDate: input.diaryDate,
      createdAtMs: 300,
      updatedAtMs: 300,
      deletedAtMs: null,
    }
    store.push(entry)
    return Promise.resolve({ ...entry })
  })
  const updateDiaryEntry = vi.fn<DiaryService['updateDiaryEntry']>()
  updateDiaryEntry.mockImplementation((input) => {
    const index = store.findIndex((entry) => entry.id === input.id)
    const found = index >= 0 ? store[index] : undefined
    const base = found ?? DIARY_A
    const updated: DiaryEntry = {
      id: input.id,
      title: input.title,
      content: input.content,
      diaryDate: base.diaryDate,
      createdAtMs: base.createdAtMs,
      updatedAtMs: 400,
      deletedAtMs: base.deletedAtMs,
    }
    if (index >= 0) store[index] = updated
    return Promise.resolve(updated)
  })
  const changeDiaryDate = vi.fn<DiaryService['changeDiaryDate']>()
  changeDiaryDate.mockImplementation((input) => {
    const index = store.findIndex((entry) => entry.id === input.id)
    const found = index >= 0 ? store[index] : undefined
    const base = found ?? DIARY_A
    const updated: DiaryEntry = {
      ...base,
      diaryDate: input.diaryDate,
      updatedAtMs: 500,
    }
    if (index >= 0) store[index] = updated
    return Promise.resolve(updated)
  })
  const softDelete = vi.fn<DiaryService['softDelete']>()
  softDelete.mockImplementation((id: string) => {
    const index = store.findIndex((entry) => entry.id === id)
    if (index >= 0) store.splice(index, 1)
    return Promise.resolve(undefined)
  })
  const service: DiaryService = {
    createDiaryEntry,
    getActiveById: vi.fn().mockImplementation((id) =>
      Promise.resolve(store.find((e) => e.id === id) ?? null),
    ),
    getActiveByDiaryDate,
    listActive,
    updateDiaryEntry,
    changeDiaryDate,
    softDelete,
    restore: vi.fn().mockResolvedValue(undefined),
  }

  return {
    service,
    store,
    createDiaryEntry,
    getActiveByDiaryDate,
    listActive,
    updateDiaryEntry,
    changeDiaryDate,
    softDelete,
  }
}

function createRuntime(service: DiaryService) {
  const dispose = vi.fn(() => Promise.resolve())
  const runtime: DiaryRuntime = { service, dispose }
  return { runtime, dispose }
}

function resolvedRuntime(service: DiaryService) {
  const current = createRuntime(service)
  const openRuntime = vi.fn(() => Promise.resolve(current.runtime))
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

type PrepareOutcome =
  | { ok: true; lease: unknown }
  | { ok: false; error: unknown }

/**
 * Drain pending promise continuations inside `act()`. Deliberately NOT a timer:
 * nothing in the maintenance proofs waits on wall-clock time.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
  })
}

/** Captures the setTimeout callback for the 800ms debounce timer and returns a helper to fire it. */
function captureDebounceTimer(): { flush: () => Promise<void> } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null
  const originalSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (fn: TimerHandler, ms?: number) => {
      if (ms !== undefined && ms >= 800) {
        captured = typeof fn === 'function' ? fn : null
      }
      return originalSetTimeout(fn, ms ?? 0)
    },
  )
  return {
    flush: async () => {
      if (captured) {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-call
        await captured()
        captured = null
      }
    },
  }
}

describe('DiaryPage lifecycle', () => {
  test('loading state then ready with entries', async () => {
    const fake = createServiceDouble()
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)

    expect(screen.getByRole('status', { name: '正在加载日记' })).toBeInTheDocument()
    const list = await screen.findByRole('list', { name: '日记列表' })
    expect(within(list).getByText(DIARY_A.title)).toBeInTheDocument()
    expect(within(list).getByText(DIARY_B.title)).toBeInTheDocument()
  })

  test('moves to empty state when no entries', async () => {
    const fake = createServiceDouble([])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)

    expect(await screen.findByText('还没有日记')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建今日日记' })).toBeInTheDocument()
  })

  test('disposes the runtime on unmount', async () => {
    const fake = createServiceDouble([])
    const current = resolvedRuntime(fake.service)
    const view = render(<DiaryPage openRuntime={current.openRuntime} />)
    await screen.findByText('还没有日记')

    view.unmount()

    await waitFor(() => expect(current.dispose).toHaveBeenCalledOnce())
  })

  test('StrictMode disposes the superseded runtime without leaking it', async () => {
    const fake = createServiceDouble([])
    const first = createRuntime(fake.service)
    const second = createRuntime(fake.service)
    const openRuntime = vi.fn()
    openRuntime
      .mockResolvedValueOnce(first.runtime)
      .mockResolvedValueOnce(second.runtime)

    const view = render(
      <StrictMode>
        <DiaryPage openRuntime={openRuntime} />
      </StrictMode>,
    )

    await screen.findByText('还没有日记')
    await waitFor(() => expect(openRuntime).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
    view.unmount()
    await waitFor(() => expect(second.dispose).toHaveBeenCalledOnce())
  })

  test('shows a safe load error and retry opens a fresh runtime', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    const current = createRuntime(fake.service)
    const openRuntime = vi.fn()
    openRuntime
      .mockRejectedValueOnce(new DiaryApplicationError('UNAVAILABLE'))
      .mockResolvedValueOnce(current.runtime)

    render(<DiaryPage openRuntime={openRuntime} />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('无法加载日记')).toBeInTheDocument()
    expect(alert).not.toHaveTextContent(/SQL|OPFS|Worker|UNAVAILABLE/)
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有日记')).toBeInTheDocument()
    expect(openRuntime).toHaveBeenCalledTimes(2)
  })

  test('ignores superseded results after the runtime is unloaded', async () => {
    const fake = createServiceDouble([DIARY_A])
    const current = createRuntime(fake.service)
    const opening = deferred<DiaryRuntime>()
    const openRuntime = vi.fn(() => opening.promise)
    const view = render(<DiaryPage openRuntime={openRuntime} />)

    expect(screen.getByRole('status', { name: '正在加载日记' })).toBeInTheDocument()
    act(() => {
      opening.resolve(current.runtime)
    })
    view.unmount()

    await act(async () => {})
    await waitFor(() => expect(current.dispose).toHaveBeenCalledOnce())
  })
})

describe('DiaryPage default selection', () => {
  test('selects today entry when one exists', async () => {
    const fake = createServiceDouble([DIARY_TODAY, DIARY_A])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)

    const titleInput = await screen.findByLabelText('日记标题')
    expect(titleInput).toHaveValue(DIARY_TODAY.title)
    const contentInput = screen.getByLabelText('日记正文')
    expect(contentInput).toHaveValue(DIARY_TODAY.content)
  })

  test('falls back to the first repository-ordered entry when no today entry', async () => {
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)

    const titleInput = await screen.findByLabelText('日记标题')
    expect(titleInput).toHaveValue(DIARY_A.title)
  })

  test('opens an existing entry when its list item is clicked', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(
      within(await screen.findByRole('list', { name: '日记列表' })).getByText(
        DIARY_B.title,
      ),
    )

    expect(await screen.findByLabelText('日记标题')).toHaveValue(DIARY_B.title)
    expect(screen.getByLabelText('日记正文')).toHaveValue(DIARY_B.content)
  })
})

describe('DiaryPage create entry', () => {
  test('opens the date picker with today as default and max=today', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByText('还没有日记')

    await user.click(screen.getByRole('button', { name: '新建今日日记' }))
    const dateInput = await screen.findByLabelText('选择日记日期')
    expect(dateInput).toHaveValue(TODAY)
    expect(dateInput).toHaveAttribute('max', TODAY)
    expect(dateInput).toHaveAttribute('type', 'date')
  })

  test('creates today entry with empty payload and selects it', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '新建日记' }))
    const dateInput = await screen.findByLabelText('选择日记日期')
    expect(dateInput).toHaveValue(TODAY)
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() =>
      expect(fake.createDiaryEntry).toHaveBeenCalledWith({
        diaryDate: TODAY,
        title: '',
        content: '',
      }),
    )
    const titleInput = await screen.findByLabelText('日记标题')
    expect(titleInput).toHaveValue('')
    expect(fake.updateDiaryEntry).not.toHaveBeenCalled()
  })

  test('creates a past-date entry', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '新建日记' }))
    const dateInput = await screen.findByLabelText('选择日记日期')
    fireEvent.change(dateInput, { target: { value: '2026-09-10' } })
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() =>
      expect(fake.createDiaryEntry).toHaveBeenCalledWith({
        diaryDate: '2026-09-10',
        title: '',
        content: '',
      }),
    )
    expect(await screen.findByLabelText('日记标题')).toHaveValue('')
  })

  test('prevents future date at the UI boundary', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '新建日记' }))
    const dateInput = await screen.findByLabelText('选择日记日期')
    fireEvent.change(dateInput, { target: { value: '2099-01-01' } })
    await user.click(screen.getByRole('button', { name: '创建' }))

    expect(
      await screen.findByText('不能选择未来日期。'),
    ).toBeInTheDocument()
    expect(fake.createDiaryEntry).not.toHaveBeenCalled()
  })

  test('precheck opens an existing entry for the chosen date instead of creating', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '新建日记' }))
    const dateInput = await screen.findByLabelText('选择日记日期')
    fireEvent.change(dateInput, { target: { value: DIARY_B.diaryDate } })
    await user.click(screen.getByRole('button', { name: '创建' }))

    expect(fake.createDiaryEntry).not.toHaveBeenCalled()
    expect(await screen.findByLabelText('日记标题')).toHaveValue(DIARY_B.title)
  })

  test('create CONFLICT shows a safe message and does not corrupt selection', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    fake.createDiaryEntry.mockRejectedValueOnce(new DiaryApplicationError('CONFLICT'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '新建日记' }))
    const dateInput = await screen.findByLabelText('选择日记日期')
    fireEvent.change(dateInput, { target: { value: '2026-09-10' } })
    await user.click(screen.getByRole('button', { name: '创建' }))

    expect(
      await screen.findByText('该日期已有日记。'),
    ).toBeInTheDocument()
    expect(fake.createDiaryEntry).toHaveBeenCalledWith({
      diaryDate: '2026-09-10',
      title: '',
      content: '',
    })
    expect(screen.getByRole('button', { name: '新建日记' })).toBeEnabled()
  })

  test('empty title/content entry does not trigger an immediate autosave', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '新建日记' }))
    await user.click(screen.getByRole('button', { name: '创建' }))

    await waitFor(() => expect(fake.createDiaryEntry).toHaveBeenCalled())
    await act(async () => {})
    expect(fake.updateDiaryEntry).not.toHaveBeenCalled()
  })
})

describe('DiaryPage autosave (title/content only)', () => {
  test('edit then flush: updateDiaryEntry called with exact payload', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const timer = captureDebounceTimer()
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, '新标题')

    expect(fake.updateDiaryEntry).not.toHaveBeenCalled()

    await act(async () => {
      await timer.flush()
    })
    await waitFor(() =>
      expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
        id: DIARY_A.id,
        title: '新标题',
        content: DIARY_A.content,
      }),
    )
  })

  test('rapid edits while a save is pending save the latest draft', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const timer = captureDebounceTimer()
    const resolveQueue: Array<() => void> = []
    fake.updateDiaryEntry.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveQueue.push(resolve)
      })
      return { ...DIARY_A, title: 'AB', content: DIARY_A.content, updatedAtMs: 600 }
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'A')

    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})

    await user.type(titleInput, 'B')
    act(() => {
      resolveQueue[0]?.()
    })
    await act(async () => {})

    await waitFor(() => {
      expect(fake.updateDiaryEntry).toHaveBeenCalledTimes(2)
      expect(fake.updateDiaryEntry).toHaveBeenLastCalledWith({
        id: DIARY_A.id,
        title: 'AB',
        content: DIARY_A.content,
      })
    })
  })

  test('blur flushes the pending draft', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const timer = captureDebounceTimer()
    fake.updateDiaryEntry.mockResolvedValue({
      ...DIARY_A,
      title: 'blurred',
      content: DIARY_A.content,
      updatedAtMs: 500,
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'blurred')
    titleInput.blur()

    await act(async () => {
      await timer.flush()
    })

    await waitFor(() =>
      expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
        id: DIARY_A.id,
        title: 'blurred',
        content: DIARY_A.content,
      }),
    )
  })

  test('switching flushes the dirty draft before selecting the next entry', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const timer = captureDebounceTimer()
    fake.updateDiaryEntry.mockResolvedValue({
      ...DIARY_A,
      title: 'edited A',
      content: DIARY_A.content,
      updatedAtMs: 500,
    })
    fake.listActive
      .mockResolvedValueOnce([DIARY_A, DIARY_B])
      .mockResolvedValueOnce([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'edited A')
    titleInput.blur()

    await act(async () => {
      await timer.flush()
    })

    await user.click(
      within(await screen.findByRole('list', { name: '日记列表' })).getByText(
        DIARY_B.title,
      ),
    )

    await waitFor(() =>
      expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
        id: DIARY_A.id,
        title: 'edited A',
        content: DIARY_A.content,
      }),
    )
    expect(screen.getByLabelText('日记标题')).toHaveValue(DIARY_B.title)
  })

  test('switch while save pending does not let the stale save mutate the new selection', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const timer = captureDebounceTimer()
    let resolveSave!: () => void
    fake.updateDiaryEntry.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve
      })
      return { ...DIARY_A, title: 'A-final', updatedAtMs: 500 }
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'A')

    await act(async () => {
      await timer.flush()
    })

    await user.click(
      within(await screen.findByRole('list', { name: '日记列表' })).getByText(
        DIARY_B.title,
      ),
    )

    act(() => {
      resolveSave()
    })
    await act(async () => {})

    await waitFor(() => expect(fake.updateDiaryEntry).toHaveBeenCalledTimes(1))
    expect(screen.getByLabelText('日记标题')).toHaveValue(DIARY_B.title)
  })

  test('canonical list is refreshed from the service after a successful save', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const timer = captureDebounceTimer()
    const reordered = [DIARY_B, DIARY_A]
    fake.updateDiaryEntry.mockResolvedValue({
      ...DIARY_A,
      title: 'edited',
      updatedAtMs: 500,
    })
    fake.listActive
      .mockResolvedValueOnce([DIARY_A, DIARY_B])
      .mockResolvedValueOnce(reordered)
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'edited')
    titleInput.blur()

    await act(async () => {
      await timer.flush()
    })

    await waitFor(() => expect(fake.listActive).toHaveBeenCalledTimes(2))
    const list = screen.getByRole('list', { name: '日记列表' })
    const items = within(list).getAllByRole('listitem')
    const firstItem = items[0]
    const secondItem = items[1]
    if (firstItem !== undefined) {
      expect(firstItem.textContent).toContain(DIARY_B.title)
    }
    if (secondItem !== undefined) {
      expect(secondItem.textContent).toContain(DIARY_A.title)
    }
  })

  test('update NOT_FOUND recovers by switching to another entry', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const timer = captureDebounceTimer()
    fake.updateDiaryEntry.mockRejectedValueOnce(new DiaryApplicationError('NOT_FOUND'))
    fake.listActive.mockResolvedValue([DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'ghost')
    titleInput.blur()

    await act(async () => {
      await timer.flush()
    })

    expect(
      await screen.findByText('这条日记已不存在。'),
    ).toBeInTheDocument()
    expect(screen.getByLabelText('日记标题')).toHaveValue(DIARY_B.title)
  })

  test('update UNAVAILABLE keeps the draft and shows safe feedback', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const timer = captureDebounceTimer()
    fake.updateDiaryEntry.mockRejectedValue(new DiaryApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'still here')
    titleInput.blur()

    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})

    await waitFor(() => {
      const els = document.querySelectorAll('[role="status"]')
      const feedbackEl = Array.from(els).find((el) =>
        el.textContent?.includes('保存暂时失败'),
      )
      expect(feedbackEl).toBeDefined()
    })
    expect(screen.getByLabelText('日记标题')).toHaveValue('still here')
    expect(screen.getByLabelText('日记正文')).toHaveValue(DIARY_A.content)
  })

  test('content autosave preserves exact strings (spaces, newlines, unicode)', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const timer = captureDebounceTimer()
    const tricky = '  leading trailing  \n\nline2\n# Markdown\n日本語'
    fake.updateDiaryEntry.mockResolvedValue({
      ...DIARY_A,
      content: tricky,
      updatedAtMs: 500,
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    const textarea = await screen.findByLabelText('日记正文')
    await user.clear(textarea)
    await user.type(textarea, tricky)
    textarea.blur()

    await act(async () => {
      await timer.flush()
    })

    await waitFor(() =>
      expect(fake.updateDiaryEntry).toHaveBeenCalledWith(
        expect.objectContaining({ content: tricky }),
      ),
    )
  })

  test('dirty unmount flush settles before dispose', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const timer = captureDebounceTimer()
    let resolveSave!: () => void
    fake.updateDiaryEntry.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve
      })
      return { ...DIARY_A, updatedAtMs: 500 }
    })
    const { openRuntime, dispose } = resolvedRuntime(fake.service)
    const view = render(<DiaryPage openRuntime={openRuntime} />)

    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'dirty')
    titleInput.blur()

    await act(async () => {
      await timer.flush()
    })

    expect(dispose).not.toHaveBeenCalled()
    act(() => {
      resolveSave()
    })
    view.unmount()
    await act(async () => {})

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
})

describe('DiaryPage change date (distinct mutation)', () => {
  test('change date success updates the entry and keeps the editor open', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '更改日期' }))
    const dateInput = await screen.findByLabelText('日记日期')
    fireEvent.change(dateInput, { target: { value: '2026-09-15' } })
    await user.click(screen.getByRole('button', { name: '确认更改' }))

    await waitFor(() =>
      expect(fake.changeDiaryDate).toHaveBeenCalledWith({
        id: DIARY_A.id,
        diaryDate: '2026-09-15',
      }),
    )
    expect(screen.queryByText('确认更改')).not.toBeInTheDocument()
    expect(screen.getByLabelText('当前日记日期')).toHaveTextContent('2026年9月15日')
    expect(screen.getByLabelText('日记标题')).toHaveValue(DIARY_A.title)
  })

  test('changing to the same date is allowed by the service', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '更改日期' }))
    const dateInput = await screen.findByLabelText('日记日期')
    fireEvent.change(dateInput, { target: { value: DIARY_A.diaryDate } })
    await user.click(screen.getByRole('button', { name: '确认更改' }))

    await waitFor(() =>
      expect(fake.changeDiaryDate).toHaveBeenCalledWith({
        id: DIARY_A.id,
        diaryDate: DIARY_A.diaryDate,
      }),
    )
    expect(screen.queryByText('确认更改')).not.toBeInTheDocument()
  })

  test('change date CONFLICT preserves original selection and date', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    fake.changeDiaryDate.mockRejectedValueOnce(new DiaryApplicationError('CONFLICT'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '更改日期' }))
    const dateInput = await screen.findByLabelText('日记日期')
    fireEvent.change(dateInput, { target: { value: DIARY_B.diaryDate } })
    await user.click(screen.getByRole('button', { name: '确认更改' }))

    expect(
      await screen.findByText('该日期已有日记，无法移动到此日期。'),
    ).toBeInTheDocument()
    expect(fake.changeDiaryDate).toHaveBeenCalledWith({
      id: DIARY_A.id,
      diaryDate: DIARY_B.diaryDate,
    })
    expect(screen.getByLabelText('当前日记日期')).toHaveTextContent(
      '2026年9月18日',
    )
    expect(screen.getByLabelText('日记标题')).toHaveValue(DIARY_A.title)
  })

  test('change date to a future date is prevented at the UI boundary', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '更改日期' }))
    const dateInput = await screen.findByLabelText('日记日期')
    fireEvent.change(dateInput, { target: { value: '2099-01-01' } })
    await user.click(screen.getByRole('button', { name: '确认更改' }))

    expect(
      await screen.findByText('不能选择未来日期。'),
    ).toBeInTheDocument()
    expect(fake.changeDiaryDate).not.toHaveBeenCalled()
    expect(screen.getByText('确认更改')).toBeInTheDocument()
  })
})

describe('DiaryPage delete', () => {
  test('delete confirmation copy does not promise restore', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '删除' }))

    const dialog = screen.getByRole('dialog')
    expect(within(dialog).getByText('删除这篇日记？')).toBeInTheDocument()
    const description = within(dialog).getByText(
      '删除后，这篇日记将从日记列表中移除。',
    )
    expect(description).toBeInTheDocument()
    expect(dialog.textContent).not.toContain('回收站')
    expect(dialog.textContent).not.toContain('恢复')
  })

  test('delete success selects an adjacent entry', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))

    await waitFor(() => expect(fake.softDelete).toHaveBeenCalledWith(DIARY_A.id))
    expect(await screen.findByLabelText('日记标题')).toHaveValue(DIARY_B.title)
    expect(screen.queryByText('删除这篇日记？')).not.toBeInTheDocument()
  })

  test('delete NOT_FOUND recovers gracefully', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    fake.softDelete.mockRejectedValueOnce(new DiaryApplicationError('NOT_FOUND'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))

    expect(
      await screen.findByText('这条日记已不存在。'),
    ).toBeInTheDocument()
  })

  test('no Restore affordance is exposed in the D6 workspace', async () => {
    const fake = createServiceDouble([DIARY_A, DIARY_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<DiaryPage openRuntime={openRuntime} />)
    await screen.findByLabelText('日记标题')

    expect(
      screen.queryByRole('button', { name: /恢复/ }),
    ).not.toBeInTheDocument()
    expect(screen.queryByText('回收站')).not.toBeInTheDocument()
  })
})

describe('DiaryPage StrictMode create lifecycle', () => {
  test('StrictMode: create selects the created entry and refreshes the list', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_A])
    const first = createRuntime(fake.service)
    const second = createRuntime(fake.service)
    const openRuntime = vi.fn()
    openRuntime
      .mockResolvedValueOnce(first.runtime)
      .mockResolvedValueOnce(second.runtime)

    render(
      <StrictMode>
        <DiaryPage openRuntime={openRuntime} />
      </StrictMode>,
    )

    await waitFor(() => expect(openRuntime).toHaveBeenCalledTimes(2))
    const createButton = await screen.findByRole('button', { name: '新建日记' })
    expect(await screen.findByLabelText('日记标题')).toHaveValue(DIARY_A.title)

  await user.click(createButton)
  const confirmCreateBtn = await screen.findByRole('button', { name: '创建' })
  await user.click(confirmCreateBtn)

  await waitFor(() => {
    expect(screen.getByLabelText('日记标题')).toHaveValue('')
  })
  expect(screen.getByLabelText('日记正文')).toHaveValue('')
  const list = screen.getByRole('list', { name: '日记列表' })
  expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  expect(screen.getByRole('button', { name: '新建日记' })).toBeEnabled()
  })
})

describe('DiaryPage maintenance coordination (P6-S2)', () => {
  test('edit without 800ms debounce wait; prepare explicitly flushes latest draft and resolves after', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_TODAY])
    // Capture the 800ms debounce timer but never fire it: the draft must be
    // persisted through explicit maintenance preparation, not through a timer.
    captureDebounceTimer()
    fake.updateDiaryEntry.mockResolvedValue({
      ...DIARY_TODAY,
      title: '最新日记标题',
      content: DIARY_TODAY.content,
      updatedAtMs: 500,
    })
    const { openRuntime } = resolvedRuntime(fake.service)
    const coordinator = new MaintenanceCoordinator()

    render(
      <MaintenanceCoordinatorProvider instance={coordinator}>
        <DiaryPage openRuntime={openRuntime} />
      </MaintenanceCoordinatorProvider>,
    )

    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, '最新日记标题')

    // Do NOT advance the debounce timer.
    await act(async () => {
      await coordinator.prepareForMaintenance()
    })

    expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
      id: DIARY_TODAY.id,
      title: '最新日记标题',
      content: DIARY_TODAY.content,
    })
    expect(coordinator.getState()).toBe('PREPARED')
  })

  test('route unmount does not lose quiesce visibility: retiring flush is awaited by prepare', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_TODAY])
    captureDebounceTimer()
    const resolveQueue: Array<() => void> = []
    fake.updateDiaryEntry.mockImplementation(async () => {
      await new Promise<void>((resolve) => resolveQueue.push(resolve))
      return {
        ...DIARY_TODAY,
        title: 'unmount draft',
        content: DIARY_TODAY.content,
        updatedAtMs: 500,
      }
    })
    const { openRuntime } = resolvedRuntime(fake.service)
    const coordinator = new MaintenanceCoordinator()

    const view = render(
      <MaintenanceCoordinatorProvider instance={coordinator}>
        <DiaryPage openRuntime={openRuntime} />
      </MaintenanceCoordinatorProvider>,
    )
    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'unmount draft')

    // Simulate a route change: DiaryPage unmounts, its flush+dispose retirement
    // is still pending.
    act(() => {
      view.unmount()
    })

    const outcomes: Array<Promise<PrepareOutcome>> = []
    let resolved = false
    outcomes.push(
      coordinator.prepareForMaintenance().then<PrepareOutcome, PrepareOutcome>(
        (lease) => {
          resolved = true
          return { ok: true, lease }
        },
        (error: unknown) => ({ ok: false, error }),
      ),
    )
    await act(async () => {
      await Promise.resolve()
    })
    // Preparation must still be pending while the retiring flush is in flight.
    expect(resolved).toBe(false)
    expect(coordinator.getRetiringCount()).toBeGreaterThan(0)

    act(() => {
      resolveQueue[0]?.()
    })
    await act(async () => {
      await outcomes[0]
    })

    expect(resolved).toBe(true)
    expect(fake.updateDiaryEntry).toHaveBeenCalledWith({
      id: DIARY_TODAY.id,
      title: 'unmount draft',
      content: DIARY_TODAY.content,
    })
    expect(coordinator.getRetiringCount()).toBe(0)
    expect(coordinator.getState()).toBe('PREPARED')
  })

  test('in-flight A + newer B + unmount: latest revision B is persisted before prepare succeeds', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_TODAY])
    // The 800ms debounce is captured and never fired.
    captureDebounceTimer()
    const writes: Array<{ title: string; content: string }> = []
    const resolvers: Array<() => void> = []
    const rejecters: Array<(reason: unknown) => void> = []
    fake.updateDiaryEntry.mockImplementation(async (input) => {
      writes.push({ title: input.title, content: input.content })
      await new Promise<void>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
      return { ...DIARY_TODAY, ...input, updatedAtMs: 500 }
    })
    const { openRuntime } = resolvedRuntime(fake.service)
    const coordinator = new MaintenanceCoordinator()

    const view = render(
      <MaintenanceCoordinatorProvider instance={coordinator}>
        <DiaryPage openRuntime={openRuntime} />
      </MaintenanceCoordinatorProvider>,
    )

    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'A 日记')

    // Revision A: the write starts through explicit preparation, not a timer.
    let resolved = false
    const outcomes: Array<Promise<PrepareOutcome>> = []
    await act(async () => {
      outcomes.push(
        coordinator.prepareForMaintenance().then<PrepareOutcome, PrepareOutcome>(
          (lease) => {
            resolved = true
            return { ok: true, lease }
          },
          (error: unknown) => ({ ok: false, error }),
        ),
      )
      await settle()
    })
    expect(writes).toHaveLength(1)
    expect(writes[0]?.title).toBe('A 日记')
    expect(resolved).toBe(false)

    // While A is still in flight the user keeps typing -> revision B.
    await user.clear(titleInput)
    await user.type(titleInput, 'B 日记')
    await settle()
    expect(writes).toHaveLength(1)

    // Route away while A is still pending: the retirement must stay visible.
    act(() => {
      view.unmount()
    })
    await settle()
    expect(resolved).toBe(false)
    expect(coordinator.getRetiringCount()).toBe(1)

    // A succeeds. The NEWEST revision (B) must now be written too.
    await act(async () => {
      resolvers[0]?.()
      await settle()
    })
    expect(writes).toHaveLength(2)
    expect(writes[1]?.title).toBe('B 日记')
    // Still pending: B is not persisted yet, so quiesce is NOT reached.
    expect(resolved).toBe(false)

    await act(async () => {
      resolvers[1]?.()
      await settle()
    })
    expect(resolved).toBe(true)
    expect(coordinator.getRetiringCount()).toBe(0)
    expect(coordinator.getState()).toBe('PREPARED')
    expect((await outcomes[0])?.ok).toBe(true)
    expect(writes[1]).toEqual({
      title: 'B 日记',
      content: DIARY_TODAY.content,
    })
  })

  test('newer revision B fails after A succeeded: preparation must NOT succeed', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_TODAY])
    captureDebounceTimer()
    const writes: Array<{ title: string; content: string }> = []
    const resolvers: Array<() => void> = []
    const rejecters: Array<(reason: unknown) => void> = []
    fake.updateDiaryEntry.mockImplementation(async (input) => {
      writes.push({ title: input.title, content: input.content })
      await new Promise<void>((resolve, reject) => {
        resolvers.push(resolve)
        rejecters.push(reject)
      })
      return { ...DIARY_TODAY, ...input, updatedAtMs: 500 }
    })
    const { openRuntime } = resolvedRuntime(fake.service)
    const coordinator = new MaintenanceCoordinator()

    const view = render(
      <MaintenanceCoordinatorProvider instance={coordinator}>
        <DiaryPage openRuntime={openRuntime} />
      </MaintenanceCoordinatorProvider>,
    )

    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'A 日记')

    // Handlers are attached eagerly so the rejection is never unhandled.
    const outcomes: Array<Promise<PrepareOutcome>> = []
    await act(async () => {
      outcomes.push(
        coordinator.prepareForMaintenance().then<PrepareOutcome, PrepareOutcome>(
          (lease) => ({ ok: true, lease }),
          (error: unknown) => ({ ok: false, error }),
        ),
      )
      await settle()
    })
    await user.clear(titleInput)
    await user.type(titleInput, 'B 日记')
    act(() => {
      view.unmount()
    })
    await settle()

    await act(async () => {
      resolvers[0]?.()
      await settle()
    })
    expect(writes).toHaveLength(2)

    await act(async () => {
      rejecters[1]?.(new DiaryApplicationError('UNAVAILABLE'))
      await settle()
    })

    const outcome = (await outcomes[0]) ?? { ok: false, error: undefined }
    expect(outcome.ok).toBe(false)
    expect(coordinator.getState()).toBe('IDLE')
    expect(coordinator.getRetiredFailureCount()).toBeGreaterThan(0)
    const second = await coordinator.prepareForMaintenance().then(
      () => 'resolved',
      () => 'rejected',
    )
    expect(second).toBe('rejected')
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('retiring flush failure is not swallowed: prepare fails instead of silently succeeding', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([DIARY_TODAY])
    captureDebounceTimer()
    fake.updateDiaryEntry.mockRejectedValue(
      new DiaryApplicationError('UNAVAILABLE'),
    )
    const { openRuntime } = resolvedRuntime(fake.service)
    const coordinator = new MaintenanceCoordinator()

    const view = render(
      <MaintenanceCoordinatorProvider instance={coordinator}>
        <DiaryPage openRuntime={openRuntime} />
      </MaintenanceCoordinatorProvider>,
    )

    const titleInput = await screen.findByLabelText('日记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'unmount fails')

    act(() => {
      view.unmount()
    })
    await settle()

    expect(fake.updateDiaryEntry).toHaveBeenCalled()
    await expect(coordinator.prepareForMaintenance()).rejects.toBeInstanceOf(Error)
    expect(coordinator.getState()).toBe('IDLE')
  })
})
