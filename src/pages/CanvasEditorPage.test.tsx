import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

import { CanvasEditorPage } from '@/pages/CanvasEditorPage'
import type { Canvas, CanvasNode } from '@/canvas/model'
import type { CanvasService } from '@/canvas/service'
import type { OpenCanvasRuntime } from '@/canvas/runtime.types'

vi.mock('@xyflow/react', () => {
  interface MockNode {
    readonly id: string
    readonly position: { readonly x: number; readonly y: number }
    readonly data: {
      readonly text: string
      readonly onCommit: (id: string, text: string) => void
    }
  }
  interface MockFlowProps {
    readonly children?: import('react').ReactNode
    readonly nodes: readonly MockNode[]
    readonly defaultViewport: { readonly x: number; readonly y: number; readonly zoom: number }
    readonly onNodeDragStop?: (event: null, node: MockNode) => void
    readonly onMoveEnd?: (
      event: null,
      viewport: { readonly x: number; readonly y: number; readonly zoom: number },
    ) => void
  }
  return {
    ReactFlowProvider: ({ children }: { readonly children: import('react').ReactNode }) => <>{children}</>,
    ReactFlow: ({ children, nodes, defaultViewport, onNodeDragStop, onMoveEnd }: MockFlowProps) => (
      <div role="application" data-viewport={JSON.stringify(defaultViewport)}>
        {nodes.map((node) => (
          <textarea
            aria-label={`测试文字节点 ${node.id}`}
            defaultValue={node.data.text}
            key={`${node.id}-${node.data.text}`}
            onBlur={(event) => node.data.onCommit(node.id, event.currentTarget.value)}
          />
        ))}
        {nodes[0] !== undefined && (
          <button type="button" onClick={() => onNodeDragStop?.(null, { ...nodes[0]!, position: { x: 123, y: 456 } })}>模拟拖动</button>
        )}
        <button type="button" onClick={() => onMoveEnd?.(null, { x: 10, y: 20, zoom: 1.5 })}>模拟视口</button>
        {children}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    applyNodeChanges: (_changes: unknown, nodes: readonly MockNode[]) => nodes,
    useReactFlow: () => ({ screenToFlowPosition: () => ({ x: 300, y: 200 }) }),
  }
})

const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const NODE_ID = '00000000-0000-4000-8000-000000000602'
const CREATED_NODE_ID = '00000000-0000-4000-8000-000000000603'

function fixture() {
  const canvas: Canvas = { id: CANVAS_ID, title: '产品构思', viewport: { x: 45, y: -30, zoom: 1.2 }, createdAtMs: 10, updatedAtMs: 10 }
  const node: CanvasNode = { id: NODE_ID, canvasId: CANVAS_ID, type: 'text', content: { type: 'text', text: '初始文字' }, x: 20, y: 30, createdAtMs: 10, updatedAtMs: 10 }
  const createdNode: CanvasNode = { ...node, id: CREATED_NODE_ID, content: { type: 'text', text: '' }, x: 300, y: 200 }
  const openCanvasMock = vi.fn<CanvasService['openCanvas']>(() => Promise.resolve({ canvas, nodes: [node] }))
  const createTextNodeMock = vi.fn<CanvasService['createTextNode']>(() => Promise.resolve(createdNode))
  const editTextNodeMock = vi.fn<CanvasService['editTextNode']>((id, text) => Promise.resolve({ ...node, id, content: { type: 'text', text }, updatedAtMs: 20 }))
  const moveCanvasNodeMock = vi.fn<CanvasService['moveCanvasNode']>((id, x, y) => Promise.resolve({ ...node, id, x, y, updatedAtMs: 20 }))
  const updateViewportMock = vi.fn<CanvasService['updateViewport']>((id, viewport) => Promise.resolve({ ...canvas, id, viewport, updatedAtMs: 20 }))
  const service: CanvasService = {
    createCanvas: vi.fn(), listCanvases: vi.fn(), renameCanvas: vi.fn(),
    openCanvas: openCanvasMock, updateViewport: updateViewportMock,
    createTextNode: createTextNodeMock, listCanvasNodes: vi.fn(),
    editTextNode: editTextNodeMock, moveCanvasNode: moveCanvasNodeMock,
  }
  const openRuntime: OpenCanvasRuntime = vi.fn(() => Promise.resolve({ service, dispose: vi.fn() }))
  return { canvas, service, openRuntime, openCanvasMock, createTextNodeMock, editTextNodeMock, moveCanvasNodeMock, updateViewportMock }
}

function renderEditor(openRuntime: OpenCanvasRuntime) {
  return render(
    <MemoryRouter initialEntries={[`/canvas/${CANVAS_ID}`]}>
      <Routes>
        <Route path="/canvas/:canvasId" element={<CanvasEditorPage openRuntime={openRuntime} />} />
        <Route path="/canvas" element={<div>画布列表</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('CanvasEditorPage', () => {
  test('shows loading then restores the Canvas, text, position, and viewport', async () => {
    const { openRuntime, openCanvasMock, canvas } = fixture()
    renderEditor(openRuntime)
    expect(screen.getByRole('status')).toHaveTextContent('正在打开画布')
    expect(await screen.findByRole('heading', { name: '产品构思' })).toBeInTheDocument()
    expect(screen.getByRole('application')).toHaveAttribute('data-viewport', JSON.stringify(canvas.viewport))
    expect(screen.getByLabelText(`测试文字节点 ${NODE_ID}`)).toHaveValue('初始文字')
    expect(openCanvasMock).toHaveBeenCalledWith(CANVAS_ID)
  })

  test('creates and edits text, saves drag-stop position, and saves move-end viewport', async () => {
    const { openRuntime, createTextNodeMock, editTextNodeMock, moveCanvasNodeMock, updateViewportMock } = fixture()
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })
    await userEvent.click(screen.getByRole('button', { name: '文字节点' }))
    expect(createTextNodeMock).toHaveBeenCalledWith(CANVAS_ID, '', { x: 300, y: 200 })
    const input = screen.getByLabelText(`测试文字节点 ${NODE_ID}`)
    await userEvent.clear(input)
    await userEvent.type(input, '编辑后的文字')
    await userEvent.tab()
    await waitFor(() => expect(editTextNodeMock).toHaveBeenCalledWith(NODE_ID, '编辑后的文字'))
    await userEvent.click(screen.getByRole('button', { name: '模拟拖动' }))
    await waitFor(() => expect(moveCanvasNodeMock).toHaveBeenCalledWith(NODE_ID, 123, 456))
    await userEvent.click(screen.getByRole('button', { name: '模拟视口' }))
    await waitFor(() => expect(updateViewportMock).toHaveBeenCalledWith(CANVAS_ID, { x: 10, y: 20, zoom: 1.5 }))
  })

  test('shows an error and retries the editor load', async () => {
    const resolved = fixture()
    const openRuntime = vi.fn<OpenCanvasRuntime>()
      .mockRejectedValueOnce(new Error('private'))
      .mockImplementation(resolved.openRuntime)
    renderEditor(openRuntime)
    expect(await screen.findByText('画布无法打开')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(await screen.findByRole('heading', { name: '产品构思' })).toBeInTheDocument()
    expect(openRuntime).toHaveBeenCalledTimes(2)
  })
})
