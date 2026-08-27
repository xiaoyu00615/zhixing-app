import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { describe, expect, test, vi } from 'vitest'

import { CanvasEditorPage } from '@/pages/CanvasEditorPage'
import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
import { CanvasApplicationError, type CanvasService } from '@/canvas/service'
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
    readonly edges: readonly {
      readonly id: string
      readonly markerStart?: unknown
      readonly markerEnd?: unknown
      readonly style?: { readonly strokeDasharray?: string }
    }[]
    readonly defaultViewport: { readonly x: number; readonly y: number; readonly zoom: number }
    readonly onConnect?: (connection: { readonly source: string; readonly target: string }) => void
    readonly onEdgeClick?: (event: null, edge: { readonly id: string }) => void
    readonly onNodeDragStop?: (event: null, node: MockNode) => void
    readonly onMoveEnd?: (
      event: null,
      viewport: { readonly x: number; readonly y: number; readonly zoom: number },
    ) => void
  }
  return {
    ReactFlowProvider: ({ children }: { readonly children: import('react').ReactNode }) => <>{children}</>,
    ReactFlow: ({ children, nodes, edges, defaultViewport, onConnect, onEdgeClick, onNodeDragStop, onMoveEnd }: MockFlowProps) => (
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
        {nodes.length >= 2 && (
          <button type="button" onClick={() => onConnect?.({ source: nodes[0]!.id, target: nodes[1]!.id })}>模拟连线</button>
        )}
        {edges.map((edge) => (
          <button
            data-dash={edge.style?.strokeDasharray ?? 'solid'}
            data-marker-end={edge.markerEnd === undefined ? 'none' : 'arrow'}
            data-marker-start={edge.markerStart === undefined ? 'none' : 'arrow'}
            key={edge.id}
            onClick={() => onEdgeClick?.(null, edge)}
            type="button"
          >
            {`测试连线 ${edge.id}`}
          </button>
        ))}
        <button type="button" onClick={() => onMoveEnd?.(null, { x: 10, y: 20, zoom: 1.5 })}>模拟视口</button>
        {children}
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    applyNodeChanges: (_changes: unknown, nodes: readonly MockNode[]) => nodes,
    useReactFlow: () => ({ screenToFlowPosition: () => ({ x: 300, y: 200 }) }),
    MarkerType: { ArrowClosed: 'arrowclosed' },
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
  }
})

const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const NODE_ID = '00000000-0000-4000-8000-000000000602'
const CREATED_NODE_ID = '00000000-0000-4000-8000-000000000603'
const TARGET_NODE_ID = '00000000-0000-4000-8000-000000000604'
const EDGE_ID = '00000000-0000-4000-8000-000000000605'

function fixture() {
  const canvas: Canvas = { id: CANVAS_ID, title: '产品构思', viewport: { x: 45, y: -30, zoom: 1.2 }, createdAtMs: 10, updatedAtMs: 10 }
  const node: CanvasNode = { id: NODE_ID, canvasId: CANVAS_ID, type: 'text', content: { type: 'text', text: '初始文字' }, x: 20, y: 30, createdAtMs: 10, updatedAtMs: 10 }
  const targetNode: CanvasNode = { ...node, id: TARGET_NODE_ID, content: { type: 'text', text: '目标文字' }, x: 420, y: 80 }
  const createdNode: CanvasNode = { ...node, id: CREATED_NODE_ID, content: { type: 'text', text: '' }, x: 300, y: 200 }
  const edge: CanvasEdge = { id: EDGE_ID, canvasId: CANVAS_ID, sourceNodeId: NODE_ID, targetNodeId: TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 10, updatedAtMs: 10, deletedAtMs: null }
  const openCanvasMock = vi.fn<CanvasService['openCanvas']>(() => Promise.resolve({ canvas, nodes: [node, targetNode], edges: [edge] }))
  const createTextNodeMock = vi.fn<CanvasService['createTextNode']>(() => Promise.resolve(createdNode))
  const editTextNodeMock = vi.fn<CanvasService['editTextNode']>((id, text) => Promise.resolve({ ...node, id, content: { type: 'text', text }, updatedAtMs: 20 }))
  const moveCanvasNodeMock = vi.fn<CanvasService['moveCanvasNode']>((id, x, y) => Promise.resolve({ ...node, id, x, y, updatedAtMs: 20 }))
  const updateViewportMock = vi.fn<CanvasService['updateViewport']>((id, viewport) => Promise.resolve({ ...canvas, id, viewport, updatedAtMs: 20 }))
  const createCanvasEdgeMock = vi.fn<CanvasService['createCanvasEdge']>(() => Promise.resolve({ ...edge, id: '00000000-0000-4000-8000-000000000606' }))
  const updateCanvasEdgeDirectionMock = vi.fn<CanvasService['updateCanvasEdgeDirection']>((id, direction) => Promise.resolve({ ...edge, id, direction, updatedAtMs: 20 }))
  const updateCanvasEdgeLineStyleMock = vi.fn<CanvasService['updateCanvasEdgeLineStyle']>((id, lineStyle) => Promise.resolve({ ...edge, id, lineStyle, updatedAtMs: 20 }))
  const deleteCanvasEdgeMock = vi.fn<CanvasService['deleteCanvasEdge']>(() => Promise.resolve({ ...edge, deletedAtMs: 20, updatedAtMs: 20 }))
  const service: CanvasService = {
    createCanvas: vi.fn(), listCanvases: vi.fn(), renameCanvas: vi.fn(),
    openCanvas: openCanvasMock, updateViewport: updateViewportMock,
    createTextNode: createTextNodeMock, listCanvasNodes: vi.fn(),
    editTextNode: editTextNodeMock, moveCanvasNode: moveCanvasNodeMock,
    createCanvasEdge: createCanvasEdgeMock, listCanvasEdges: vi.fn(),
    updateCanvasEdgeDirection: updateCanvasEdgeDirectionMock,
    updateCanvasEdgeLineStyle: updateCanvasEdgeLineStyleMock,
    deleteCanvasEdge: deleteCanvasEdgeMock,
  }
  const openRuntime: OpenCanvasRuntime = vi.fn(() => Promise.resolve({ service, dispose: vi.fn() }))
  return { canvas, service, openRuntime, openCanvasMock, createTextNodeMock, editTextNodeMock, moveCanvasNodeMock, updateViewportMock, createCanvasEdgeMock, updateCanvasEdgeDirectionMock, updateCanvasEdgeLineStyleMock, deleteCanvasEdgeMock }
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

  test('restores, creates, configures, and soft-deletes persistent edges', async () => {
    const {
      openRuntime,
      createCanvasEdgeMock,
      updateCanvasEdgeDirectionMock,
      updateCanvasEdgeLineStyleMock,
      deleteCanvasEdgeMock,
    } = fixture()
    renderEditor(openRuntime)
    const restoredEdge = await screen.findByRole('button', { name: `测试连线 ${EDGE_ID}` })
    expect(restoredEdge).toHaveAttribute('data-marker-end', 'arrow')
    expect(restoredEdge).toHaveAttribute('data-marker-start', 'none')
    expect(restoredEdge).toHaveAttribute('data-dash', 'solid')

    await userEvent.click(screen.getByRole('button', { name: '模拟连线' }))
    await waitFor(() => expect(createCanvasEdgeMock).toHaveBeenCalledWith(CANVAS_ID, NODE_ID, TARGET_NODE_ID))

    await userEvent.click(restoredEdge)
    expect(screen.getByRole('complementary', { name: '连线设置' })).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '双向' }))
    await waitFor(() => expect(updateCanvasEdgeDirectionMock).toHaveBeenCalledWith(EDGE_ID, 'bidirectional'))
    await userEvent.click(screen.getByRole('button', { name: '虚线' }))
    await waitFor(() => expect(updateCanvasEdgeLineStyleMock).toHaveBeenCalledWith(EDGE_ID, 'dashed'))
    await userEvent.click(screen.getByRole('button', { name: '删除连线' }))
    await waitFor(() => expect(deleteCanvasEdgeMock).toHaveBeenCalledWith(EDGE_ID))
    expect(screen.queryByRole('button', { name: `测试连线 ${EDGE_ID}` })).not.toBeInTheDocument()
  })

  test('keeps the persisted Edge set unchanged when a duplicate connect conflicts', async () => {
    const resolved = fixture()
    resolved.createCanvasEdgeMock.mockRejectedValueOnce(
      new CanvasApplicationError('CONFLICT'),
    )
    renderEditor(resolved.openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })
    await userEvent.click(screen.getByRole('button', { name: '模拟连线' }))
    expect(await screen.findByRole('status')).toHaveTextContent('这条关系已经存在')
    expect(screen.getAllByRole('button', { name: /测试连线/ })).toHaveLength(1)
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
