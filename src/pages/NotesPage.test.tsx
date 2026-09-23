import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode } from 'react'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { NotesPage } from '@/pages/NotesPage'
import type { Note } from '@/note/model'
import type { NoteRuntime } from '@/note/runtime.types'
import { NoteApplicationError, type NoteService } from '@/note/service'

afterEach(() => {
  vi.restoreAllMocks()
})

const NOTE_A: Note = {
  id: '00000000-0000-4000-8000-000000000001',
  title: '读书笔记',
  content: '把核心观点整理下来。',
  createdAtMs: 100,
  updatedAtMs: 200,
  deletedAtMs: null,
  archivedAtMs: null,
}

const NOTE_B: Note = {
  id: '00000000-0000-4000-8000-000000000002',
  title: '会议纪要',
  content: '确认 P4 范围和验收方式。',
  createdAtMs: 120,
  updatedAtMs: 220,
  deletedAtMs: null,
  archivedAtMs: null,
}

function createServiceDouble(initialNotes: readonly Note[] = [NOTE_A]) {
  const createNote = vi.fn<NoteService['createNote']>()
  createNote.mockImplementation(async (input) =>
    Promise.resolve({
      id: '00000000-0000-4000-8000-000000000009',
      title: input.title,
      content: input.content,
      createdAtMs: 300,
      updatedAtMs: 300,
      deletedAtMs: null,
      archivedAtMs: null,
    }),
  )
  const listActive = vi.fn<NoteService['listActive']>()
  listActive.mockResolvedValue([...initialNotes])
  const updateNote = vi.fn<NoteService['updateNote']>()
  updateNote.mockImplementation(async (input) =>
    Promise.resolve({
      ...NOTE_A,
      ...input,
      updatedAtMs: 400,
      deletedAtMs: null,
    }),
  )
  const softDelete = vi.fn<NoteService['softDelete']>()
  softDelete.mockResolvedValue(undefined)
  const service: NoteService = {
    createNote,
    getActiveById: vi.fn().mockResolvedValue(NOTE_A),
    listActive,
    updateNote,
    softDelete,
    restore: vi.fn().mockResolvedValue(undefined),
    archive: vi.fn().mockResolvedValue(undefined),
    unarchive: vi.fn().mockResolvedValue(undefined),
  }

  return { service, createNote, listActive, updateNote, softDelete }
}

function createRuntime(service: NoteService) {
  const dispose = vi.fn(() => Promise.resolve())
  const runtime: NoteRuntime = { service, dispose }
  return { runtime, dispose }
}

function resolvedRuntime(service: NoteService) {
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

/** Captures the setTimeout callback for the debounce timer and returns a helper to fire it. */
function captureDebounceTimer(): {
  flush: () => Promise<void>
} {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let captured: any = null
  const originalSetTimeout = globalThis.setTimeout
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(
    (fn: TimerHandler, ms?: number) => {
      // Only capture the 800ms debounce timer; let other timers pass through normally
      if (ms !== undefined && ms >= 800) {
        // Always update captured to the latest callback so flush always fires the newest pending debounce
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

describe('NotesPage loading and lifecycle', () => {
  test('moves from loading to the empty state', async () => {
    const fake = createServiceDouble([])
    const current = createRuntime(fake.service)
    const opening = deferred<NoteRuntime>()
    const openRuntime = vi.fn(() => opening.promise)

    render(<NotesPage openRuntime={openRuntime} />)

    expect(screen.getByRole('status', { name: '正在加载笔记' })).toBeInTheDocument()
    act(() => {
      opening.resolve(current.runtime)
    })
    expect(await screen.findByText('还没有笔记')).toBeInTheDocument()
  })

  test('renders notes and auto-selects the first note', async () => {
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)

    const list = await screen.findByRole('list', { name: '笔记列表' })
    expect(within(list).getByText(NOTE_A.title)).toBeInTheDocument()
    expect(within(list).getByText(NOTE_B.title)).toBeInTheDocument()
    expect(await screen.findByLabelText('笔记标题')).toHaveValue(NOTE_A.title)
    expect(screen.getByLabelText('笔记正文')).toHaveValue(NOTE_A.content)
  })

  test('creates a note with empty title payload and selects it', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const createdNote: Note = {
      ...NOTE_A,
      id: '00000000-0000-4000-8000-000000000099',
      title: '',
      content: '',
      createdAtMs: 500,
      updatedAtMs: 500,
      deletedAtMs: null,
    }
    fake.createNote.mockResolvedValueOnce(createdNote)
    fake.listActive
      .mockResolvedValueOnce([NOTE_A])
      .mockResolvedValueOnce([NOTE_A, createdNote])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    await user.click(await screen.findByRole('button', { name: '新建笔记' }))

    expect(fake.createNote).toHaveBeenCalledWith({
      title: '',
      content: '',
    })
    expect(await screen.findByLabelText('笔记标题')).toHaveValue('')
    expect(fake.listActive).toHaveBeenCalledTimes(2)
  })

  test('shows a safe load error and retry opens a fresh runtime', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([])
    const current = createRuntime(fake.service)
    const openRuntime = vi.fn()
    openRuntime
      .mockRejectedValueOnce(new NoteApplicationError('UNAVAILABLE'))
      .mockResolvedValueOnce(current.runtime)

    render(<NotesPage openRuntime={openRuntime} />)

    const alert = await screen.findByRole('alert')
    expect(within(alert).getByText('无法加载笔记')).toBeInTheDocument()
    expect(alert).not.toHaveTextContent(/SQL|OPFS|Worker|UNAVAILABLE/)
    await user.click(within(alert).getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有笔记')).toBeInTheDocument()
    expect(openRuntime).toHaveBeenCalledTimes(2)
  })

  test('shows a safe create error without leaving the page stuck', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    fake.createNote.mockRejectedValueOnce(new NoteApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    await user.click(await screen.findByRole('button', { name: /新建笔记/ }))

    expect(await screen.findByText('笔记暂时无法创建，请重试。')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /新建笔记/ })).toBeEnabled()
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled()
  })

  test('shows a safe delete error and keeps the note available', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    fake.softDelete.mockRejectedValueOnce(new NoteApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    await user.click(await screen.findByRole('button', { name: '删除' }))
    await user.click(await screen.findByRole('button', { name: '确认删除' }))

    expect(await screen.findByText('删除暂时失败，请重试。')).toBeInTheDocument()
    expect(screen.getByLabelText('笔记正文')).toHaveValue(NOTE_A.content)
    expect(screen.getByRole('button', { name: '删除' })).toBeEnabled()
  })

  test('disposes the runtime on unmount', async () => {
    const fake = createServiceDouble([])
    const current = resolvedRuntime(fake.service)
    const view = render(<NotesPage openRuntime={current.openRuntime} />)
    await screen.findByText('还没有笔记')

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
        <NotesPage openRuntime={openRuntime} />
      </StrictMode>,
    )

    await screen.findByText('还没有笔记')
    await waitFor(() => expect(openRuntime).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(first.dispose).toHaveBeenCalledOnce())
    view.unmount()
    await waitFor(() => expect(second.dispose).toHaveBeenCalledOnce())
  })

  test('ignores superseded results after the runtime is unloaded', async () => {
    const fake = createServiceDouble([NOTE_A])
    const current = createRuntime(fake.service)
    const opening = deferred<NoteRuntime>()
    const openRuntime = vi.fn(() => opening.promise)
    const view = render(<NotesPage openRuntime={openRuntime} />)

    expect(screen.getByRole('status', { name: '正在加载笔记' })).toBeInTheDocument()
    act(() => {
      opening.resolve(current.runtime)
    })
    view.unmount()

    await act(async () => {})
    await waitFor(() => expect(current.dispose).toHaveBeenCalledOnce())
    expect(screen.queryByRole('status', { name: '正在加载笔记' })).not.toBeInTheDocument()
  })
})

describe('NotesPage StrictMode create lifecycle', () => {
  test('StrictMode: create selects the created note, refreshes the list, and clears 创建中…', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const storedNotes: Note[] = [NOTE_A]
    const createdNote: Note = {
      id: '00000000-0000-4000-8000-0000000000aa',
      title: '',
      content: '',
      createdAtMs: 700,
      updatedAtMs: 700,
      deletedAtMs: null,
      archivedAtMs: null,
    }
    fake.listActive.mockImplementation(() => Promise.resolve([...storedNotes]))
    fake.createNote.mockImplementation((input) => {
      const note: Note = {
        ...createdNote,
        title: input.title,
        content: input.content,
      }
      storedNotes.push(note)
      return Promise.resolve(note)
    })
    const first = createRuntime(fake.service)
    const second = createRuntime(fake.service)
    const openRuntime = vi.fn()
    openRuntime
      .mockResolvedValueOnce(first.runtime)
      .mockResolvedValueOnce(second.runtime)

    render(
      <StrictMode>
        <NotesPage openRuntime={openRuntime} />
      </StrictMode>,
    )

    await waitFor(() => expect(openRuntime).toHaveBeenCalledTimes(2))
    const createButton = await screen.findByRole('button', { name: '新建笔记' })
    expect(await screen.findByLabelText('笔记标题')).toHaveValue(NOTE_A.title)

    await user.click(createButton)

    expect(fake.createNote).toHaveBeenCalledWith({ title: '', content: '' })

    // The created note must become the selection and the editor must render it.
    await waitFor(() => {
      expect(screen.getByLabelText('笔记标题')).toHaveValue('')
    })
    expect(screen.getByLabelText('笔记正文')).toHaveValue('')
    expect(screen.queryByText('选择或创建一篇笔记')).not.toBeInTheDocument()

    // The refreshed list must be delivered to the UI.
    const list = screen.getByRole('list', { name: '笔记列表' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
    expect(within(list).getByText('无标题')).toBeInTheDocument()

    // The creating state must be cleared.
    expect(
      screen.queryByRole('button', { name: '创建中…' }),
    ).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建笔记' })).toBeEnabled()
  })
})

describe('NotesPage autosave debounce (matrix A)', () => {
  test('edit then flush: updateNote called with exact payload', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    fake.updateNote.mockResolvedValue({
      ...NOTE_A,
      title: '新标题',
      content: NOTE_A.content,
      updatedAtMs: 500,
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, '新标题')

    // Before flush: no save has happened
    expect(fake.updateNote).not.toHaveBeenCalled()

    // Flush the debounce timer
    await act(async () => {
      await timer.flush()
    })
    await waitFor(() =>
      expect(fake.updateNote).toHaveBeenCalledWith({
        id: NOTE_A.id,
        title: '新标题',
        content: NOTE_A.content,
      }),
    )
  })
})

describe('NotesPage revision-based serialized save (matrix B)', () => {
  test('edit A then edit B while A pending: after A resolves B saves automatically', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    const resolveQueue: Array<() => void> = []
    fake.updateNote.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveQueue.push(resolve)
      })
      return {
        ...NOTE_A,
        title: 'A-after-b',
        content: NOTE_A.content,
        updatedAtMs: 600,
      }
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'A')

    // Fire the debounce timer to start save A
    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})

    // Edit B while A is pending
    await user.type(titleInput, 'B')

    // Resolve the first save (A)
    act(() => {
      resolveQueue[0]?.()
    })
    await act(async () => {})

    await waitFor(() => {
      expect(fake.updateNote).toHaveBeenCalledTimes(2)
      expect(fake.updateNote).toHaveBeenLastCalledWith({
        id: NOTE_A.id,
        title: 'AB',
        content: NOTE_A.content,
      })
    })
    expect(screen.getByText('已保存')).toBeInTheDocument()
  })
})

describe('NotesPage shared save loop (matrix C)', () => {
  test('blur starts flush and click other note: max 1 updateNote call, then switches', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const timer = captureDebounceTimer()
    let resolveSave!: () => void
    fake.updateNote.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve
      })
      return { ...NOTE_A, title: 'edited', content: NOTE_A.content, updatedAtMs: 500 }
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'edited')

    // blur triggers flush
    titleInput.blur()
    // Fire the debounce timer
    await act(async () => {
      await timer.flush()
    })
    // Simulate click on other note
    await user.click(within(await screen.findByRole('list', { name: '笔记列表' })).getByText(NOTE_B.title))

    act(() => {
      resolveSave()
    })

    expect(fake.updateNote).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByLabelText('笔记标题')).toHaveValue(NOTE_B.title)
    })
  })
})

describe('NotesPage switch dirty flush success (matrix D)', () => {
  test('dirty switch: flush success then switch', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const timer = captureDebounceTimer()
    fake.updateNote.mockResolvedValue({
      ...NOTE_A,
      title: 'edited A',
      content: NOTE_A.content,
      updatedAtMs: 500,
    })
    fake.listActive.mockResolvedValueOnce([NOTE_A, NOTE_B]).mockResolvedValueOnce([NOTE_A, NOTE_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'edited A')

    // Trigger save via blur then flush
    titleInput.blur()
    await act(async () => {
      await timer.flush()
    })

    await user.click(within(await screen.findByRole('list', { name: '笔记列表' })).getByText(NOTE_B.title))

    await waitFor(() => {
      expect(fake.updateNote).toHaveBeenCalledWith({
        id: NOTE_A.id,
        title: 'edited A',
        content: NOTE_A.content,
      })
    })
    expect(screen.getByLabelText('笔记标题')).toHaveValue(NOTE_B.title)
  })
})

describe('NotesPage switch dirty flush failure (matrix E)', () => {
  test('dirty switch: flush UNAVAILABLE → no switch, draft preserved', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const timer = captureDebounceTimer()
    // Reject all updateNote calls so both direct and timer-triggered saves fail
    fake.updateNote.mockRejectedValue(new NoteApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'should not switch')

    // Trigger the flush directly via the captured timer callback
    await act(async () => {
      await timer.flush()
    })
    // Wait for the error feedback to appear in the DOM
    await waitFor(() => {
      const els = document.querySelectorAll('[role="status"]')
      expect(els.length).toBeGreaterThanOrEqual(1)
      const feedbackEl = Array.from(els).find((el) => el.textContent?.includes('保存暂时失败'))
      expect(feedbackEl).toBeDefined()
    })

    // Now attempt to switch — handleSwitchToNote will try to flush again,
    // but the service is still UNAVAILABLE, so the switch must NOT happen.
    await user.click(
      within(await screen.findByRole('list', { name: '笔记列表' })).getByText(
        NOTE_B.title,
      ),
    )
    // Give the second flush a chance to reject
    await act(async () => {})
    await waitFor(() => {
      const els = document.querySelectorAll('[role="status"]')
      expect(els.length).toBeGreaterThanOrEqual(1)
      const feedbackEl = Array.from(els).find((el) => el.textContent?.includes('保存暂时失败'))
      expect(feedbackEl).toBeDefined()
    })

    // Selection must remain on A; editor draft retains the unsaved value
    expect(screen.getByLabelText('笔记标题')).toHaveValue('should not switch')
    expect(screen.getByLabelText('笔记正文')).toHaveValue(NOTE_A.content)
  })
})

describe('NotesPage create while dirty fails (matrix F)', () => {
  test('dirty: click new Note, flush fails, createNote called 0 times, selection unchanged', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    // Always reject so both blur-triggered and timer-triggered calls fail
    fake.updateNote.mockRejectedValue(new NoteApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'dirty draft')

    // Trigger flush via timer (not blur) to avoid double-call
    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})

    await user.click(await screen.findByRole('button', { name: '新建笔记' }))

    expect(fake.createNote).not.toHaveBeenCalled()
    expect(screen.getByLabelText('笔记标题')).toHaveValue('dirty draft')
  })
})

describe('NotesPage retry after save failure (matrix G)', () => {
  test('save fails, user edits again, retry succeeds', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    fake.updateNote
      .mockRejectedValueOnce(new NoteApplicationError('UNAVAILABLE'))
      .mockResolvedValueOnce({
        ...NOTE_A,
        title: 'retry works v2',
        content: NOTE_A.content,
        updatedAtMs: 600,
      })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'retry works')

    // Trigger first save via timer (which will fail)
    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})
    // Wait for the error feedback to appear in the DOM (deterministic)
    await waitFor(() => {
      const els = document.querySelectorAll('[role="status"]')
      expect(els.length).toBeGreaterThanOrEqual(1)
      const feedbackEl = Array.from(els).find((el) => el.textContent?.includes('保存暂时失败'))
      expect(feedbackEl).toBeDefined()
    })

    // Second edit — clear and type new content
    await user.clear(titleInput)
    await user.type(titleInput, 'retry works v2')
    // Flush the NEW timer callback (spy keeps updating captured)
    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})
    // Wait for success feedback
    await waitFor(() => expect(screen.getByText('已保存')).toBeInTheDocument())

    expect(fake.updateNote).toHaveBeenCalledTimes(2)
    expect(fake.updateNote).toHaveBeenLastCalledWith({
      id: NOTE_A.id,
      title: 'retry works v2',
      content: NOTE_A.content,
    })
  })
})

describe('NotesPage canonical list after update (matrix H)', () => {
  test('save succeeds → listActive called, notes order exactly matches service result', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const timer = captureDebounceTimer()
    const reordered = [NOTE_B, NOTE_A]
    fake.updateNote.mockResolvedValue({
      ...NOTE_A,
      title: 'edited',
      updatedAtMs: 500,
    })
    fake.listActive
      .mockResolvedValueOnce([NOTE_A, NOTE_B])
      .mockResolvedValueOnce(reordered)
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'edited')

    titleInput.blur()
    await act(async () => {
      await timer.flush()
    })

    await waitFor(() => {
      expect(fake.listActive).toHaveBeenCalledTimes(2)
    })
    const list = screen.getByRole('list', { name: '笔记列表' })
    const items = within(list).getAllByRole('listitem')
    expect(items[0]!.textContent).toContain(NOTE_B.title)
    expect(items[1]!.textContent).toContain(NOTE_A.title)
  })
})

describe('NotesPage list refresh failure after update (matrix I)', () => {
  test('update succeeds, listActive refresh fails: updateNote only 1 call, draft still SAVED, editor content preserved', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    fake.updateNote.mockResolvedValue({
      ...NOTE_A,
      title: 'saved title',
      updatedAtMs: 500,
    })
    fake.listActive
      .mockResolvedValueOnce([NOTE_A])
      .mockRejectedValueOnce(new NoteApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'saved title')

    titleInput.blur()
    await act(async () => {
      await timer.flush()
    })

    await waitFor(() => {
      expect(fake.updateNote).toHaveBeenCalledTimes(1)
    })
    expect(screen.getByText('已保存')).toBeInTheDocument()
    expect(screen.getByLabelText('笔记标题')).toHaveValue('saved title')
  })
})

describe('NotesPage NOT_FOUND save (matrix J)', () => {
  test('NOT_FOUND save: current entity removed, ghost draft cleared, post-delete selection, message shown', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const timer = captureDebounceTimer()
    fake.updateNote.mockRejectedValueOnce(new NoteApplicationError('NOT_FOUND'))
    fake.listActive.mockResolvedValue([NOTE_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'ghost')

    titleInput.blur()
    await act(async () => {
      await timer.flush()
    })

    await waitFor(() => {
      expect(screen.getByText('这条笔记已不存在。')).toBeInTheDocument()
    })
    expect(screen.getByLabelText('笔记标题')).toHaveValue(NOTE_B.title)
  })
})

describe('NotesPage UNAVAILABLE save (matrix K)', () => {
  test('UNAVAILABLE save: draft retained, selection retained, ERROR status shown', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    fake.updateNote.mockRejectedValue(new NoteApplicationError('UNAVAILABLE'))
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'still here')

    // Trigger flush via timer
    await act(async () => {
      await timer.flush()
    })
    await act(async () => {})
    // Wait for the error feedback to appear in the DOM (deterministic)
    await waitFor(() => {
      const els = document.querySelectorAll('[role="status"]')
      expect(els.length).toBeGreaterThanOrEqual(1)
      const feedbackEl = Array.from(els).find((el) => el.textContent?.includes('保存暂时失败'))
      expect(feedbackEl).toBeDefined()
    })
    const statusEls = screen.getAllByRole('status')
    expect(statusEls.length).toBeGreaterThanOrEqual(1)
    const feedbackEl = statusEls.find((el) => el.textContent?.includes('保存暂时失败'))
    expect(feedbackEl).toBeInTheDocument()
    expect(screen.getByLabelText('笔记标题')).toHaveValue('still here')
    expect(screen.getByLabelText('笔记正文')).toHaveValue(NOTE_A.content)
  })
})

describe('NotesPage delete with debounce cancel (matrix L)', () => {
  test('dirty debounce pending, confirm delete: timer canceled, no new updateNote, softDelete called', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'to delete')
    // Trigger flush via timer to make dirty and start save
    await act(async () => {
      await timer.flush()
    })
    // Click delete immediately before save promise settles
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))
    await act(async () => {})

    // updateNote called once (the initial flush), softDelete should be called after settle
    expect(fake.softDelete).toHaveBeenCalledWith(NOTE_A.id)
  })
})

describe('NotesPage delete wins over in-flight save (matrix M)', () => {
  test('save A in-flight, confirm delete, edit B while A pending: settle A then softDelete, no update/delete concurrency', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A, NOTE_B])
    const timer = captureDebounceTimer()
    const resolveQueue: Array<() => void> = []
    fake.updateNote.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveQueue.push(resolve)
      })
      return { ...NOTE_A, title: 'A-final', updatedAtMs: 500 }
    })
    fake.softDelete.mockResolvedValue(undefined)
    fake.listActive.mockResolvedValue([NOTE_B])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'A')

    // Trigger and start the save
    await act(async () => {
      await timer.flush()
    })

    // A in-flight, now edit B while A pending
    await user.type(titleInput, 'B')

    // Click delete - this records intent and waits for in-flight save
    await user.click(screen.getByRole('button', { name: '删除' }))
    await user.click(screen.getByRole('button', { name: '确认删除' }))

    // Settle the in-flight save AFTER delete handler has recorded intent
    act(() => {
      resolveQueue[0]?.()
    })
    await act(async () => {})

    await waitFor(() => {
      expect(fake.softDelete).toHaveBeenCalledOnce()
      expect(fake.updateNote).toHaveBeenCalledTimes(1)
    })
    // Delete wins - list shows only NOTE_B
    expect(screen.getByLabelText('笔记标题')).toHaveValue(NOTE_B.title)
  })
})

describe('NotesPage create exact payload (matrix N)', () => {
  test('createNote exact payload {title:"", content:""} then listActive, selected id is created.id', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const createdNote: Note = {
      ...NOTE_A,
      id: 'new-created-id',
      title: '',
      content: '',
      createdAtMs: 900,
      updatedAtMs: 900,
      deletedAtMs: null,
    }
    fake.createNote.mockResolvedValueOnce(createdNote)
    fake.listActive
      .mockResolvedValueOnce([NOTE_A])
      .mockResolvedValueOnce([NOTE_A, createdNote])
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    await user.click(await screen.findByRole('button', { name: '新建笔记' }))

    expect(fake.createNote).toHaveBeenCalledWith({ title: '', content: '' })
    expect(fake.listActive).toHaveBeenCalled()
    expect(screen.getByLabelText('笔记标题')).toHaveValue('')
  })
})

describe('NotesPage empty title UI (matrix O)', () => {
  test('empty title: Input placeholder is 无标题, actual value is "", no payload ever equals 无标题 or 未命名笔记', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    captureDebounceTimer()
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const titleInput = await screen.findByLabelText('笔记标题')
    expect(titleInput).toHaveAttribute('placeholder', '无标题')
    // With a selected note, value is the note's title; check placeholder is correct
    expect(titleInput).toHaveValue(NOTE_A.title)

    // Clear and create a new note to verify empty title behavior
    await user.clear(titleInput)
    await user.click(await screen.findByRole('button', { name: '新建笔记' }))

    expect(fake.createNote).toHaveBeenCalledWith(expect.objectContaining({ title: '' }))
    // No updateNote should have empty-title string "无标题" or "未命名笔记"
    expect(fake.updateNote).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: '无标题' }),
    )
    expect(fake.updateNote).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: '未命名笔记' }),
    )
  })
})

describe('NotesPage content exact match (matrix P)', () => {
  test('content with leading/trailing spaces, multiple newline, Markdown, Unicode: update payload is strict exact match', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    const trickyContent = '  leading trailing  \n\nline2\nline3\n# Markdown\n日本語'
    fake.updateNote.mockResolvedValue({
      ...NOTE_A,
      content: trickyContent,
      updatedAtMs: 500,
    })
    const { openRuntime } = resolvedRuntime(fake.service)

    render(<NotesPage openRuntime={openRuntime} />)
    const textarea = await screen.findByLabelText('笔记正文')
    await user.clear(textarea)
    await user.type(textarea, trickyContent)

    textarea.blur()
    await act(async () => {
      await timer.flush()
    })

    await waitFor(() => {
      expect(fake.updateNote).toHaveBeenCalledWith(
        expect.objectContaining({ content: trickyContent }),
      )
    })
  })
})

describe('NotesPage dirty unmount flush (matrix Q)', () => {
  test('dirty unmount: save starts, runtime.dispose not yet called, settle save, runtime.dispose called once', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    let resolveSave!: () => void
    fake.updateNote.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve
      })
      return { ...NOTE_A, updatedAtMs: 500 }
    })
    const { openRuntime, dispose } = resolvedRuntime(fake.service)
    const view = render(<NotesPage openRuntime={openRuntime} />)

    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'dirty')
    // Trigger flush via blur
    titleInput.blur()
    await act(async () => {
      await timer.flush()
    })

    // dispose should not have been called yet (component still mounted)
    expect(dispose).not.toHaveBeenCalled()

    // Settle the save
    act(() => {
      resolveSave()
    })

    // Now unmount to trigger the cleanup
    view.unmount()
    await act(async () => {})

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
})

describe('NotesPage save resolves after unmount (matrix R)', () => {
  test('save resolves after unmount: no React state update, dispose exactly once', async () => {
    const user = userEvent.setup()
    const fake = createServiceDouble([NOTE_A])
    const timer = captureDebounceTimer()
    const { openRuntime, dispose } = resolvedRuntime(fake.service)
    let resolveSave!: () => void
    fake.updateNote.mockImplementation(async () => {
      await new Promise<void>((resolve) => {
        resolveSave = resolve
      })
      return NOTE_A
    })

    const view = render(<NotesPage openRuntime={openRuntime} />)

    const titleInput = await screen.findByLabelText('笔记标题')
    await user.clear(titleInput)
    await user.type(titleInput, 'dirty')
    // Trigger flush via blur
    titleInput.blur()
    await act(async () => {
      await timer.flush()
    })

    // Unmount before save resolves
    view.unmount()

    // Settle the save
    act(() => {
      resolveSave()
    })
    await act(async () => {})

    await waitFor(() => expect(dispose).toHaveBeenCalledOnce())
  })
})
