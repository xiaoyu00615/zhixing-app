import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router'
import { beforeEach, describe, expect, test, vi } from 'vitest'

import { CanvasEditorPage } from '@/pages/CanvasEditorPage'
import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
import { CanvasApplicationError, type CanvasService } from '@/canvas/service'
import type { OpenCanvasRuntime } from '@/canvas/runtime.types'

const reactFlowMocks = vi.hoisted(() => {
  let viewport = { x: 0, y: 0, zoom: 1 }
  return {
    getViewport: vi.fn(() => viewport),
    resetViewport: () => { viewport = { x: 0, y: 0, zoom: 1 } },
    setViewport: vi.fn((next: typeof viewport) => {
      viewport = next
      return Promise.resolve(true)
    }),
  }
})

vi.mock('@xyflow/react', () => {
  interface MockNode {
    readonly id: string
    readonly position: { readonly x: number; readonly y: number }
    readonly data: {
      readonly text: string
      readonly onCommit: (id: string, text: string) => void
    }
    readonly selected?: boolean
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
    readonly onNodeDragStart?: (
      event: null,
      node: MockNode,
      nodes: MockNode[],
    ) => void
    readonly onNodeDragStop?: (
      event: null,
      node: MockNode,
      nodes: MockNode[],
    ) => void
    readonly onNodesChange?: (changes: readonly Record<string, unknown>[]) => void
    readonly onMoveEnd?: (
      event: null,
      viewport: { readonly x: number; readonly y: number; readonly zoom: number },
    ) => void
    readonly panOnScroll?: boolean
    readonly selectionKeyCode?: string | null
    readonly multiSelectionKeyCode?: readonly string[]
    readonly selectionMode?: string
    readonly selectionOnDrag?: boolean
    readonly panOnDrag?: boolean | readonly number[]
    readonly zoomOnScroll?: boolean
  }
  return {
    ReactFlowProvider: ({ children }: { readonly children: import('react').ReactNode }) => <>{children}</>,
    ReactFlow: ({ children, nodes, edges, defaultViewport, onConnect, onEdgeClick, onNodeDragStart, onNodeDragStop, onNodesChange, onMoveEnd, selectionKeyCode, multiSelectionKeyCode, selectionMode, selectionOnDrag, panOnDrag, panOnScroll, zoomOnScroll }: MockFlowProps) => (
      <div
        role="application"
        data-multi-selection-keys={multiSelectionKeyCode?.join(',')}
        data-pan-on-drag={Array.isArray(panOnDrag) ? panOnDrag.join(',') : String(panOnDrag)}
        data-pan-on-scroll={String(panOnScroll)}
        data-selection-key={selectionKeyCode ?? 'none'}
        data-selection-mode={selectionMode}
        data-selection-on-drag={String(selectionOnDrag)}
        data-viewport={JSON.stringify(defaultViewport)}
        data-zoom-on-scroll={String(zoomOnScroll)}
      >
        {nodes.map((node) => (
          <textarea
            aria-label={`测试文字节点 ${node.id}`}
            data-position={`${node.position.x},${node.position.y}`}
            data-selected={node.selected === true ? 'true' : 'false'}
            defaultValue={node.data.text}
            key={`${node.id}-${node.data.text}`}
            onBlur={(event) => node.data.onCommit(node.id, event.currentTarget.value)}
          />
        ))}
        {nodes[0] !== undefined && (
          <button type="button" onClick={() => {
            onNodeDragStart?.(null, nodes[0]!, [nodes[0]!])
            onNodesChange?.([{ id: nodes[0]!.id, type: 'position', position: { x: 123, y: 456 } }])
            onNodeDragStop?.(null, { ...nodes[0]!, position: { x: 123, y: 456 } }, [{ ...nodes[0]!, position: { x: 123, y: 456 } }])
          }}>模拟拖动</button>
        )}
        {nodes.length >= 2 && (
          <>
            <button type="button" onClick={() => onNodesChange?.([
              { id: nodes[0]!.id, type: 'select', selected: true },
              { id: nodes[1]!.id, type: 'select', selected: false },
            ])}>模拟单选</button>
            <button type="button" onClick={() => onNodesChange?.([
              { id: nodes[0]!.id, type: 'select', selected: true },
              { id: nodes[1]!.id, type: 'select', selected: true },
            ])}>模拟框选</button>
            <button type="button" onClick={() => onNodesChange?.([
              { id: nodes[0]!.id, type: 'select', selected: true },
              { id: nodes[1]!.id, type: 'select', selected: true },
            ])}>模拟追加选择</button>
            <button type="button" onClick={() => onNodesChange?.([
              { id: nodes[0]!.id, type: 'select', selected: false },
              { id: nodes[1]!.id, type: 'select', selected: false },
            ])}>模拟空白点击</button>
            <button type="button" onClick={() => {
              const selected = nodes.slice(0, 2)
              onNodeDragStart?.(null, selected[0]!, selected)
              const moved = selected.map((item) => ({
                ...item,
                position: { x: item.position.x + 100, y: item.position.y + 60 },
              }))
              onNodesChange?.(moved.map((item) => ({ id: item.id, type: 'position', position: item.position })))
              onNodeDragStop?.(null, moved[0]!, moved)
            }}>模拟整体移动</button>
          </>
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
    applyNodeChanges: (changes: readonly Record<string, unknown>[], nodes: readonly MockNode[]) =>
      nodes.map((node) => changes.reduce((current, change) => {
        if (change.id !== current.id) return current
        if (change.type === 'select') {
          return { ...current, selected: change.selected === true }
        }
        if (change.type === 'position' && typeof change.position === 'object') {
          return { ...current, position: change.position as MockNode['position'] }
        }
        return current
      }, node)),
    useReactFlow: () => ({
      getViewport: reactFlowMocks.getViewport,
      screenToFlowPosition: () => ({ x: 300, y: 200 }),
      setViewport: reactFlowMocks.setViewport,
    }),
    MarkerType: { ArrowClosed: 'arrowclosed' },
    SelectionMode: { Partial: 'partial' },
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
  const moveCanvasNodesMock = vi.fn<CanvasService['moveCanvasNodes']>((_, moves) => Promise.resolve(moves.map((move) => ({ ...node, id: move.nodeId, x: move.x, y: move.y, updatedAtMs: 20 }))))
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
    moveCanvasNodes: moveCanvasNodesMock,
    createCanvasEdge: createCanvasEdgeMock, listCanvasEdges: vi.fn(),
    updateCanvasEdgeDirection: updateCanvasEdgeDirectionMock,
    updateCanvasEdgeLineStyle: updateCanvasEdgeLineStyleMock,
    deleteCanvasEdge: deleteCanvasEdgeMock,
  }
  const openRuntime: OpenCanvasRuntime = vi.fn(() => Promise.resolve({ service, dispose: vi.fn() }))
  return { canvas, service, openRuntime, openCanvasMock, createTextNodeMock, editTextNodeMock, moveCanvasNodeMock, moveCanvasNodesMock, updateViewportMock, createCanvasEdgeMock, updateCanvasEdgeDirectionMock, updateCanvasEdgeLineStyleMock, deleteCanvasEdgeMock }
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
  beforeEach(() => {
    reactFlowMocks.getViewport.mockClear()
    reactFlowMocks.setViewport.mockClear()
    reactFlowMocks.resetViewport()
  })

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

  test('uses React Flow selection for single, additive, box, and blank-clear behavior', async () => {
    const { openRuntime } = fixture()
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })
    const application = screen.getByRole('application')
    expect(application).toHaveAttribute('data-selection-key', 'none')
    expect(application).toHaveAttribute('data-multi-selection-keys', 'Control,Meta')
    expect(application).toHaveAttribute('data-selection-mode', 'partial')
    expect(application).toHaveAttribute('data-selection-on-drag', 'true')
    expect(application).toHaveAttribute('data-pan-on-drag', '1')
    expect(application).toHaveAttribute('data-pan-on-scroll', 'false')
    expect(application).toHaveAttribute('data-zoom-on-scroll', 'true')

    await userEvent.click(screen.getByRole('button', { name: '模拟单选' }))
    expect(screen.getByLabelText(`测试文字节点 ${NODE_ID}`)).toHaveAttribute('data-selected', 'true')
    expect(screen.getByLabelText(`测试文字节点 ${TARGET_NODE_ID}`)).toHaveAttribute('data-selected', 'false')

    await userEvent.click(screen.getByRole('button', { name: '模拟追加选择' }))
    expect(screen.getByLabelText(`测试文字节点 ${NODE_ID}`)).toHaveAttribute('data-selected', 'true')
    expect(screen.getByLabelText(`测试文字节点 ${TARGET_NODE_ID}`)).toHaveAttribute('data-selected', 'true')

    await userEvent.click(screen.getByRole('button', { name: '模拟空白点击' }))
    expect(screen.getByLabelText(`测试文字节点 ${NODE_ID}`)).toHaveAttribute('data-selected', 'false')
    expect(screen.getByLabelText(`测试文字节点 ${TARGET_NODE_ID}`)).toHaveAttribute('data-selected', 'false')

    await userEvent.click(screen.getByRole('button', { name: '模拟框选' }))
    expect(screen.getByLabelText(`测试文字节点 ${NODE_ID}`)).toHaveAttribute('data-selected', 'true')
    expect(screen.getByLabelText(`测试文字节点 ${TARGET_NODE_ID}`)).toHaveAttribute('data-selected', 'true')
  })

  test('moves on the first WASD frame without relying on keyboard repeat', async () => {
    const { openRuntime, updateViewportMock } = fixture()
    const frameState: { next: FrameRequestCallback | null } = { next: null }
    const now = vi.spyOn(performance, 'now').mockReturnValue(984)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameState.next = callback
      return 1
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', repeat: true }))
    expect(requestFrame).toHaveBeenCalledTimes(1)
    const runFrame = (time: number) => {
      const callback = frameState.next
      if (callback === null) throw new Error('animation frame was not scheduled')
      callback(time)
    }
    runFrame(1000)

    expect(reactFlowMocks.setViewport).toHaveBeenCalledTimes(1)
    expect(reactFlowMocks.setViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 0, y: 9.6, zoom: 1 }),
      { duration: 0 },
    )
    runFrame(1016)
    expect(reactFlowMocks.setViewport).toHaveBeenCalledTimes(2)
    expect(reactFlowMocks.setViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 0, y: 19.2, zoom: 1 }),
      { duration: 0 },
    )

    window.dispatchEvent(new Event('blur'))
    expect(cancelFrame).toHaveBeenCalled()
    await waitFor(() => expect(updateViewportMock).toHaveBeenCalledWith(
      CANVAS_ID,
      expect.objectContaining({ x: 0, y: 19.2, zoom: 1 }),
    ))
    now.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  test('keeps the first WASD displacement forward when the rAF timestamp trails performance.now', async () => {
    const { openRuntime } = fixture()
    const frameState: { next: FrameRequestCallback | null } = { next: null }
    const now = vi.spyOn(performance, 'now').mockReturnValue(1000)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameState.next = callback
      return 1
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    const callback = frameState.next
    if (callback === null) throw new Error('animation frame was not scheduled')
    callback(999.5)

    expect(reactFlowMocks.setViewport).toHaveBeenLastCalledWith(
      expect.objectContaining({ x: 10, y: 0, zoom: 1 }),
      { duration: 0 },
    )
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }))
    now.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  test('keeps a held WASD direction active when previous viewport persistence completes', async () => {
    const { canvas, openRuntime, updateViewportMock } = fixture()
    let resolvePersist!: (value: Canvas) => void
    updateViewportMock.mockImplementationOnce(() => new Promise((resolve) => {
      resolvePersist = resolve
    }))
    const frameState: { next: FrameRequestCallback | null } = { next: null }
    const now = vi.spyOn(performance, 'now').mockReturnValue(984)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameState.next = callback
      return 1
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {
      frameState.next = null
    })
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })

    const runFrame = (time: number) => {
      const callback = frameState.next
      if (callback === null) throw new Error('animation frame was not scheduled')
      callback(time)
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    runFrame(1000)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }))
    expect(cancelFrame).toHaveBeenCalledTimes(1)
    expect(updateViewportMock).toHaveBeenCalledTimes(1)

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    runFrame(1016)
    const beforePersistenceCompletion = reactFlowMocks.setViewport.mock.calls.at(-1)![0]

    await act(async () => {
      resolvePersist({ ...canvas, viewport: { x: -9.6, y: 0, zoom: 1 }, updatedAtMs: 20 })
      await Promise.resolve()
    })
    expect(cancelFrame).toHaveBeenCalledTimes(1)

    runFrame(1032)
    const afterPersistenceCompletion = reactFlowMocks.setViewport.mock.calls.at(-1)![0]
    expect(afterPersistenceCompletion.x).toBeGreaterThan(beforePersistenceCompletion.x)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }))
    expect(cancelFrame).toHaveBeenCalledTimes(2)
    now.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  test('keeps diagonal speed normalized and continues the remaining key after keyup', async () => {
    const { openRuntime } = fixture()
    const frameState: { next: FrameRequestCallback | null } = { next: null }
    const now = vi.spyOn(performance, 'now').mockReturnValue(984)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameState.next = callback
      return 1
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })

    const runFrame = (time: number) => {
      const callback = frameState.next
      if (callback === null) throw new Error('animation frame was not scheduled')
      callback(time)
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    runFrame(1000)
    const diagonal = reactFlowMocks.setViewport.mock.calls[0]![0]
    expect(diagonal.x).toBeCloseTo(-6.79, 1)
    expect(diagonal.y).toBeCloseTo(6.79, 1)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'w' }))
    runFrame(1016)
    const horizontal = reactFlowMocks.setViewport.mock.calls[1]![0]
    expect(horizontal.x).toBeCloseTo(-16.39, 1)
    expect(horizontal.y).toBeCloseTo(diagonal.y, 5)
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'd' }))
    expect(cancelFrame).toHaveBeenCalled()

    now.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  test.each([
    { first: 'd', opposite: 'a', axis: 'x', firstSign: -1, oppositeSign: 1 },
    { first: 'a', opposite: 'd', axis: 'x', firstSign: 1, oppositeSign: -1 },
    { first: 'w', opposite: 's', axis: 'y', firstSign: 1, oppositeSign: -1 },
    { first: 's', opposite: 'w', axis: 'y', firstSign: -1, oppositeSign: 1 },
  ] as const)(
    'lets the last input win for $first → $opposite and falls back on release',
    async ({ first, opposite, axis, firstSign, oppositeSign }) => {
      const { openRuntime } = fixture()
      const frameState: { next: FrameRequestCallback | null } = { next: null }
      const now = vi.spyOn(performance, 'now').mockReturnValue(984)
      const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
        frameState.next = callback
        return 1
      })
      const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
      renderEditor(openRuntime)
      await screen.findByRole('heading', { name: '产品构思' })

      const runFrame = (time: number) => {
        const callback = frameState.next
        if (callback === null) throw new Error('animation frame was not scheduled')
        callback(time)
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: first }))
      expect(requestFrame).toHaveBeenCalledTimes(1)
      runFrame(1000)
      const firstPosition = reactFlowMocks.setViewport.mock.calls[0]![0]
      expect(Math.sign(firstPosition[axis])).toBe(firstSign)

      window.dispatchEvent(new KeyboardEvent('keydown', { key: opposite }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: first, repeat: true }))
      expect(requestFrame).toHaveBeenCalledTimes(2)
      runFrame(1016)
      const reversedPosition = reactFlowMocks.setViewport.mock.calls[1]![0]
      expect(Math.sign(reversedPosition[axis] - firstPosition[axis])).toBe(oppositeSign)

      window.dispatchEvent(new KeyboardEvent('keyup', { key: opposite }))
      runFrame(1032)
      const fallbackPosition = reactFlowMocks.setViewport.mock.calls[2]![0]
      expect(Math.sign(fallbackPosition[axis] - reversedPosition[axis])).toBe(firstSign)
      window.dispatchEvent(new KeyboardEvent('keyup', { key: first }))
      expect(cancelFrame).toHaveBeenCalled()

      now.mockRestore()
      requestFrame.mockRestore()
      cancelFrame.mockRestore()
    },
  )

  test('reverses one diagonal axis on the next frame without a straight-only gap', async () => {
    const { openRuntime } = fixture()
    const frameState: { next: FrameRequestCallback | null } = { next: null }
    const now = vi.spyOn(performance, 'now').mockReturnValue(984)
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      frameState.next = callback
      return 1
    })
    const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined)
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })

    const runFrame = (time: number) => {
      const callback = frameState.next
      if (callback === null) throw new Error('animation frame was not scheduled')
      callback(time)
    }
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd' }))
    runFrame(1000)
    const rightUp = reactFlowMocks.setViewport.mock.calls[0]![0]

    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }))
    runFrame(1016)
    const leftUp = reactFlowMocks.setViewport.mock.calls[1]![0]
    expect(leftUp.x).toBeGreaterThan(rightUp.x)
    expect(leftUp.y).toBeGreaterThan(rightUp.y)

    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a' }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's' }))
    runFrame(1032)
    const rightDown = reactFlowMocks.setViewport.mock.calls[2]![0]
    expect(rightDown.x).toBeLessThan(leftUp.x)
    expect(rightDown.y).toBeLessThan(leftUp.y)

    window.dispatchEvent(new Event('blur'))
    expect(cancelFrame).toHaveBeenCalled()
    now.mockRestore()
    requestFrame.mockRestore()
    cancelFrame.mockRestore()
  })

  test('keeps WASD as text input and ignores modifier shortcuts', async () => {
    const { openRuntime } = fixture()
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame')
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })
    const input = screen.getByLabelText(`测试文字节点 ${NODE_ID}`)

    await userEvent.clear(input)
    await userEvent.type(input, 'WASD test')
    expect(input).toHaveValue('WASD test')
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'w', ctrlKey: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', altKey: true }))

    expect(requestFrame).not.toHaveBeenCalled()
    expect(reactFlowMocks.setViewport).not.toHaveBeenCalled()
    requestFrame.mockRestore()
  })

  test('persists a collective move once and keeps the existing Edge', async () => {
    const { openRuntime, moveCanvasNodesMock } = fixture()
    renderEditor(openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })
    await userEvent.click(screen.getByRole('button', { name: '模拟整体移动' }))
    await waitFor(() => expect(moveCanvasNodesMock).toHaveBeenCalledWith(CANVAS_ID, [
      { nodeId: NODE_ID, x: 120, y: 90 },
      { nodeId: TARGET_NODE_ID, x: 520, y: 140 },
    ]))
    expect(screen.getByRole('button', { name: `测试连线 ${EDGE_ID}` })).toBeInTheDocument()
  })

  test('rolls all dragged nodes back when collective persistence fails', async () => {
    const resolved = fixture()
    resolved.moveCanvasNodesMock.mockRejectedValueOnce(
      new CanvasApplicationError('UNAVAILABLE'),
    )
    renderEditor(resolved.openRuntime)
    await screen.findByRole('heading', { name: '产品构思' })
    await userEvent.click(screen.getByRole('button', { name: '模拟整体移动' }))
    expect(await screen.findByRole('status')).toHaveTextContent('已恢复移动前位置')
    expect(screen.getByLabelText(`测试文字节点 ${NODE_ID}`)).toHaveAttribute('data-position', '20,30')
    expect(screen.getByLabelText(`测试文字节点 ${TARGET_NODE_ID}`)).toHaveAttribute('data-position', '420,80')
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
