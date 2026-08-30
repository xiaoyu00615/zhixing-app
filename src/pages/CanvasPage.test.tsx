import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

import { CanvasPage } from '@/pages/CanvasPage'
import type { Canvas } from '@/canvas/model'
import type { CanvasService } from '@/canvas/service'
import type { OpenCanvasRuntime } from '@/canvas/runtime.types'

const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const SECOND_CANVAS_ID = '00000000-0000-4000-8000-000000000602'
const THIRD_CANVAS_ID = '00000000-0000-4000-8000-000000000603'

function createFixture(initial: readonly Canvas[] = []) {
  let canvases = [...initial]
  const createCanvasMock = vi.fn<CanvasService['createCanvas']>((title) => {
    const canvas: Canvas = {
      id: CANVAS_ID,
      title: title.trim(),
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAtMs: 10,
      updatedAtMs: 10,
    }
    canvases = [canvas]
    return Promise.resolve(canvas)
  })
  const renameCanvasMock = vi.fn<CanvasService['renameCanvas']>((id, title) => {
    const canvas = {
      ...canvases.find((item) => item.id === id)!,
      title: title.trim(),
      updatedAtMs: 20,
    }
    canvases = [canvas]
    return Promise.resolve(canvas)
  })
  const service: CanvasService = {
    createCanvas: createCanvasMock,
    listCanvases: vi.fn(() => Promise.resolve(canvases)),
    renameCanvas: renameCanvasMock,
    openCanvas: vi.fn(),
    updateViewport: vi.fn(),
    createCanvasNode: vi.fn(),
    createTextNode: vi.fn(),
    listCanvasNodes: vi.fn(),
    editTextNode: vi.fn(),
    updateCanvasNodeContent: vi.fn(),
    moveCanvasNode: vi.fn(),
    moveCanvasNodes: vi.fn(),
    createCanvasEdge: vi.fn(),
    listCanvasEdges: vi.fn(),
    updateCanvasEdgeDirection: vi.fn(),
    updateCanvasEdgeLineStyle: vi.fn(),
    deleteCanvasEdge: vi.fn(),
  }
  const dispose = vi.fn()
  const openRuntime: OpenCanvasRuntime = vi.fn(() =>
    Promise.resolve({ service, dispose }),
  )
  return { openRuntime, dispose, createCanvasMock, renameCanvasMock }
}

function renderPage(openRuntime: OpenCanvasRuntime) {
  return render(
    <MemoryRouter initialEntries={['/canvas']}>
      <Routes>
        <Route path="/canvas" element={<CanvasPage openRuntime={openRuntime} />} />
        <Route path="/canvas/:canvasId" element={<div>画布编辑器已打开</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CanvasPage', () => {
  test('loads the real list, renames a Canvas, and opens it', async () => {
    const canvas: Canvas = { id: CANVAS_ID, title: '产品构思', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10, updatedAtMs: 10 }
    const { openRuntime, renameCanvasMock } = createFixture([canvas])
    renderPage(openRuntime)
    expect(await screen.findByText('产品构思')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重命名 产品构思' }))
    const input = screen.getByRole('textbox', { name: '画布名称' })
    await userEvent.clear(input)
    await userEvent.type(input, '产品路线')
    await userEvent.click(screen.getByRole('button', { name: '保存' }))
    await waitFor(() => expect(renameCanvasMock).toHaveBeenCalledWith(CANVAS_ID, '产品路线'))
    await userEvent.click(await screen.findByRole('button', { name: /打开画布/ }))
    expect(await screen.findByText('画布编辑器已打开')).toBeInTheDocument()
  })

  test('renders the compact Page Toolbar without the removed Hero', async () => {
    const canvas: Canvas = { id: CANVAS_ID, title: '产品构思', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10, updatedAtMs: 10 }
    const { openRuntime } = createFixture([canvas])
    renderPage(openRuntime)

    expect(await screen.findByRole('heading', { name: '所有画布' })).toBeInTheDocument()
    expect(screen.getByRole('searchbox', { name: '搜索画布' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '新建画布' })).toBeInTheDocument()
    expect(screen.queryByText('CANVAS SPACE')).not.toBeInTheDocument()
    expect(screen.queryByText('把想法摊开，在自由空间里连接思考。')).not.toBeInTheDocument()
  })

  test('filters Canvas titles locally without changing the loaded list', async () => {
    const canvases: readonly Canvas[] = [
      { id: CANVAS_ID, title: 'Product Plan', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10, updatedAtMs: 10 },
      { id: SECOND_CANVAS_ID, title: '产品规划', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 20, updatedAtMs: 20 },
      { id: THIRD_CANVAS_ID, title: '会议记录', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 30, updatedAtMs: 30 },
    ]
    const { openRuntime } = createFixture(canvases)
    renderPage(openRuntime)
    const search = await screen.findByRole('searchbox', { name: '搜索画布' })

    expect(screen.getAllByRole('button', { name: /打开画布/ })).toHaveLength(3)
    await userEvent.type(search, '  product  ')
    expect(screen.getByText('Product Plan')).toBeInTheDocument()
    expect(screen.queryByText('产品规划')).not.toBeInTheDocument()

    await userEvent.click(screen.getByRole('button', { name: '清空画布搜索' }))
    expect(screen.getAllByRole('button', { name: /打开画布/ })).toHaveLength(3)
    await userEvent.type(search, '规划')
    expect(screen.getByText('产品规划')).toBeInTheDocument()
    expect(screen.queryByText('Product Plan')).not.toBeInTheDocument()

    await userEvent.clear(search)
    await userEvent.type(search, '不存在')
    expect(screen.getByText('没有找到匹配的画布')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '清空搜索' }))
    expect(screen.getAllByRole('button', { name: /打开画布/ })).toHaveLength(3)
  })

  test('creates a Canvas and opens the editor route', async () => {
    const { openRuntime, createCanvasMock } = createFixture()
    renderPage(openRuntime)
    await screen.findByText('还没有画布')
    await userEvent.click(screen.getByRole('button', { name: '新建画布' }))
    await userEvent.type(screen.getByRole('textbox', { name: '画布名称' }), '  灵感  ')
    fireEvent.submit(screen.getByRole('textbox', { name: '画布名称' }).closest('form')!)
    await waitFor(() => expect(createCanvasMock).toHaveBeenCalledWith('  灵感  '))
    expect(await screen.findByText('画布编辑器已打开')).toBeInTheDocument()
  })

  test('shows an explicit load error and retries', async () => {
    const fixture = createFixture()
    const openRuntime = vi.fn<OpenCanvasRuntime>()
      .mockRejectedValueOnce(new Error('private'))
      .mockImplementation(fixture.openRuntime)
    renderPage(openRuntime)
    expect(await screen.findByText('画布暂时无法加载')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByText('还没有画布')).toBeInTheDocument()
    expect(openRuntime).toHaveBeenCalledTimes(2)
  })
})
