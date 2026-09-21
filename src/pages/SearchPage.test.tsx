import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, test, vi } from 'vitest'

import type { SearchEntityType, SearchResult } from '@/search/model'
import { SearchPage } from '@/pages/SearchPage'
import type { OpenSearchRuntime } from '@/search/runtime.types'
import { SearchApplicationError, type SearchService } from '@/search/service'

afterEach(() => {
  vi.restoreAllMocks()
})

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeResult(
  entityType: SearchEntityType,
  entityId: string,
  overrides: Partial<SearchResult> = {},
): SearchResult {
  return {
    entityType,
    entityId,
    title: `${entityType}标题`,
    snippet: '摘要内容',
    updatedAtMs: 1_700_000_000_000,
    ...overrides,
  }
}

function createService(search: SearchService['search']): SearchService {
  return { search }
}

function resolvedRuntime(service: SearchService) {
  const dispose = vi.fn(() => Promise.resolve())
  const openRuntime = vi.fn<OpenSearchRuntime>(() =>
    Promise.resolve({ service, dispose }),
  )
  return { openRuntime, dispose }
}

function renderPage(openRuntime: OpenSearchRuntime) {
  return render(
    <MemoryRouter>
      <SearchPage openRuntime={openRuntime} />
    </MemoryRouter>,
  )
}

async function renderReadyPage(service: SearchService) {
  const { openRuntime } = resolvedRuntime(service)
  const view = renderPage(openRuntime)
  await screen.findByText('输入关键词搜索任务、笔记、日记和画布')
  return view
}

async function submitQuery(text: string) {
  const user = userEvent.setup()
  await user.type(screen.getByLabelText('搜索关键词'), text)
  await user.click(screen.getByRole('button', { name: '搜索' }))
  return user
}

describe('SearchPage', () => {
  test('shows the empty-query prompt before any submission', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([]),
    )
    await renderReadyPage(createService(search))

    expect(
      screen.getByText('输入关键词搜索任务、笔记、日记和画布'),
    ).toBeInTheDocument()
    expect(search).not.toHaveBeenCalled()
  })

  test('keeps the typed draft in the input', async () => {
    await renderReadyPage(
      createService(vi.fn<SearchService['search']>(() => Promise.resolve([]))),
    )
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('搜索关键词'), '任务')

    expect(screen.getByLabelText('搜索关键词')).toHaveValue('任务')
  })

  test('Enter submits the query', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([makeResult('task', 'task-1')]),
    )
    await renderReadyPage(createService(search))
    const user = userEvent.setup()

    await user.type(screen.getByLabelText('搜索关键词'), '任务')
    await user.keyboard('{Enter}')

    expect(search).toHaveBeenCalledWith('任务')
    expect(await screen.findByRole('list', { name: '搜索结果' })).toBeVisible()
  })

  test('the search button submits the query', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([makeResult('task', 'task-1')]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('任务')

    expect(search).toHaveBeenCalledWith('任务')
  })

  test('a whitespace-only query does not call the service', async () => {
    const search = vi.fn<SearchService['search']>(() => Promise.resolve([]))
    await renderReadyPage(createService(search))

    await submitQuery('   ')

    expect(search).not.toHaveBeenCalled()
    expect(
      screen.getByText('输入关键词搜索任务、笔记、日记和画布'),
    ).toBeInTheDocument()
  })

  test('shows a loading state while the query is pending', async () => {
    const pending = deferred<SearchResult[]>()
    await renderReadyPage(
      createService(vi.fn<SearchService['search']>(() => pending.promise)),
    )

    await submitQuery('任务')

    expect(await screen.findByRole('status', { name: '正在搜索' })).toBeVisible()
    expect(screen.getByLabelText('搜索关键词')).toHaveValue('任务')

    act(() => {
      pending.resolve([])
    })
    await act(async () => {})
  })

  test('renders the unified ranked result list', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([
        makeResult('task', 'task-1'),
        makeResult('note', 'note-1'),
      ]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('关键词')

    const list = await screen.findByRole('list', { name: '搜索结果' })
    expect(within(list).getAllByRole('listitem')).toHaveLength(2)
  })

  test('renders all four entity labels', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([
        makeResult('task', 'task-1'),
        makeResult('note', 'note-1'),
        makeResult('diary', 'diary-1'),
        makeResult('canvas', 'canvas-1'),
      ]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('关键词')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(screen.getAllByText('任务').length).toBeGreaterThan(0)
    expect(screen.getAllByText('笔记').length).toBeGreaterThan(0)
    expect(screen.getAllByText('日记').length).toBeGreaterThan(0)
    expect(screen.getAllByText('画布').length).toBeGreaterThan(0)
  })

  test('falls back to a visible title for empty Note and Diary titles', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([
        makeResult('note', 'note-1', { title: '' }),
        makeResult('diary', 'diary-1', { title: '   ' }),
      ]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('关键词')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(screen.getByText('未命名笔记')).toBeInTheDocument()
    expect(screen.getByText('未命名日记')).toBeInTheDocument()
  })

  test('renders the snippet as plain text', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([
        makeResult('note', 'note-1', { snippet: '<b>不是标记</b>' }),
      ]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('关键词')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(screen.getByText('<b>不是标记</b>')).toBeInTheDocument()
    expect(document.querySelector('b')).toBeNull()
  })

  test('shows an explicit no-results state containing the query', async () => {
    const search = vi.fn<SearchService['search']>(() => Promise.resolve([]))
    await renderReadyPage(createService(search))

    await submitQuery('不存在')

    expect(
      await screen.findByText('没有找到与“不存在”匹配的结果'),
    ).toBeInTheDocument()
  })

  test('shows a VALIDATION error without persistence details', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.reject(new SearchApplicationError('VALIDATION')),
    )
    await renderReadyPage(createService(search))

    await submitQuery('任务')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('搜索关键词无效')
    expect(alert).not.toHaveTextContent(/SQL|OPFS|Worker|UNAVAILABLE/)
  })

  test('shows an UNAVAILABLE error without persistence details', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.reject(new SearchApplicationError('UNAVAILABLE')),
    )
    await renderReadyPage(createService(search))

    await submitQuery('任务')

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('搜索暂时不可用')
    expect(alert).not.toHaveTextContent(/SQL|OPFS|Worker|INVALID_QUERY/)
  })

  test('retries the submitted query after an UNAVAILABLE error', async () => {
    const search = vi
      .fn<SearchService['search']>()
      .mockRejectedValueOnce(new SearchApplicationError('UNAVAILABLE'))
      .mockResolvedValueOnce([makeResult('task', 'task-1')])
    await renderReadyPage(createService(search))

    await submitQuery('任务')
    const alert = await screen.findByRole('alert')

    await userEvent.click(within(alert).getByRole('button', { name: '重试' }))

    expect(search).toHaveBeenCalledTimes(2)
    expect(await screen.findByRole('list', { name: '搜索结果' })).toBeVisible()
  })

  test('a newer submitted query wins over a stale response', async () => {
    const first = deferred<SearchResult[]>()
    const second = deferred<SearchResult[]>()
    const search = vi
      .fn<SearchService['search']>()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
    await renderReadyPage(createService(search))
    const user = userEvent.setup()
    const input = screen.getByLabelText('搜索关键词')

    await user.type(input, 'A')
    await user.click(screen.getByRole('button', { name: '搜索' }))
    await user.clear(input)
    await user.type(input, 'B')
    await user.click(screen.getByRole('button', { name: '搜索' }))

    act(() => {
      second.resolve([makeResult('note', 'note-b', { title: '第二个结果' })])
    })
    await act(async () => {})
    act(() => {
      first.resolve([makeResult('task', 'task-a', { title: '第一个结果' })])
    })
    await act(async () => {})

    expect(await screen.findByText('第二个结果')).toBeInTheDocument()
    expect(screen.queryByText('第一个结果')).not.toBeInTheDocument()
  })

  test('builds the Task navigation target', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([makeResult('task', 'task-1', { title: '任务标题' })]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('任务')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(
      screen.getByRole('link', { name: '打开任务：任务标题' }),
    ).toHaveAttribute('href', '/tasks?id=task-1')
  })

  test('builds the Note navigation target', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([makeResult('note', 'note-1', { title: '笔记标题' })]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('笔记')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(
      screen.getByRole('link', { name: '打开笔记：笔记标题' }),
    ).toHaveAttribute('href', '/notes?id=note-1')
  })

  test('builds the Diary navigation target', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([makeResult('diary', 'diary-1', { title: '日记标题' })]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('日记')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(
      screen.getByRole('link', { name: '打开日记：日记标题' }),
    ).toHaveAttribute('href', '/diary?id=diary-1')
  })

  test('builds the Canvas navigation target', async () => {
    const search = vi.fn<SearchService['search']>(() =>
      Promise.resolve([
        makeResult('canvas', 'canvas-1', { title: '画布标题' }),
      ]),
    )
    await renderReadyPage(createService(search))

    await submitQuery('画布')
    await screen.findByRole('list', { name: '搜索结果' })

    expect(
      screen.getByRole('link', { name: '打开画布：画布标题' }),
    ).toHaveAttribute('href', '/canvas/canvas-1')
  })

  test('retries the runtime when it cannot be opened', async () => {
    const dispose = vi.fn(() => Promise.resolve())
    const openRuntime = vi
      .fn<OpenSearchRuntime>()
      .mockRejectedValueOnce(new Error('worker unavailable'))
      .mockResolvedValueOnce({
        service: createService(
          vi.fn<SearchService['search']>(() => Promise.resolve([])),
        ),
        dispose,
      })

    renderPage(openRuntime)

    const alert = await screen.findByRole('alert')
    expect(alert).toHaveTextContent('无法使用搜索')
    await userEvent.click(within(alert).getByRole('button', { name: '重试' }))
    expect(
      await screen.findByText('输入关键词搜索任务、笔记、日记和画布'),
    ).toBeInTheDocument()
    await waitFor(() => expect(openRuntime).toHaveBeenCalledTimes(2))
  })
})
