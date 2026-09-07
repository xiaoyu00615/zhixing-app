import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, test, vi } from 'vitest'

import { CanvasEdgeContextMenu } from '@/components/canvas/CanvasEdgeContextMenu'
import { createCanvasContextMenuModel } from '@/canvas/contextMenuRegistry'
import type { CanvasEdge } from '@/canvas/model'

const edge: CanvasEdge = {
  id: '00000000-0000-4000-8000-000000000604',
  canvasId: '00000000-0000-4000-8000-000000000601',
  sourceNodeId: '00000000-0000-4000-8000-000000000602',
  targetNodeId: '00000000-0000-4000-8000-000000000603',
  relationType: 'default',
  direction: 'forward',
  lineStyle: 'solid',
  membershipPosition: null,
  createdAtMs: 10,
  updatedAtMs: 10,
  deletedAtMs: null,
}

afterEach(() => vi.restoreAllMocks())

function renderMenu({
  value = edge,
  x = 120,
  y = 160,
  onCommand = vi.fn(() => Promise.resolve(true)),
  onClose = vi.fn(),
}: {
  readonly value?: CanvasEdge
  readonly x?: number
  readonly y?: number
  readonly onCommand?: ReturnType<typeof vi.fn<(command: import('@/canvas/commandRegistry').CanvasEdgeCommand) => Promise<boolean>>>
  readonly onClose?: ReturnType<typeof vi.fn<() => void>>
} = {}) {
  render(
    <CanvasEdgeContextMenu
      busy={false}
      model={createCanvasContextMenuModel({ type: 'edge', edge: value })}
      onClose={onClose}
      onCommand={onCommand}
      x={x}
      y={y}
    />,
  )
  return { onCommand, onClose }
}

describe('CanvasEdgeContextMenu', () => {
  test('renders grouped current state and executes one action before closing', async () => {
    const { onCommand, onClose } = renderMenu()
    expect(screen.getByRole('menu')).toHaveStyle({ left: '120px', top: '160px' })
    expect(screen.getByRole('menuitemradio', { name: '普通关系' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: '单向' })).toHaveAttribute('aria-checked', 'true')
    expect(screen.getByRole('menuitemradio', { name: '实线' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('menuitemradio', { name: '上下级' }))
    expect(onCommand).toHaveBeenCalledWith({
      id: 'update_edge_relation_type',
      edgeId: edge.id,
      relationType: 'hierarchy',
    })
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce())
  })

  test('closes on outside pointer and Escape without executing actions', () => {
    const outside = renderMenu()
    fireEvent.pointerDown(document.body)
    expect(outside.onClose).toHaveBeenCalledOnce()
    expect(outside.onCommand).not.toHaveBeenCalled()

    outside.onClose.mockClear()
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' })
    expect(outside.onClose).toHaveBeenCalledOnce()
    expect(outside.onCommand).not.toHaveBeenCalled()
  })

  test('clamps to the visible viewport and prevents WASD propagation', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 500 })
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 400 })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 300,
      height: 300,
      left: 0,
      right: 200,
      top: 0,
      width: 200,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    })
    const onWindowKeyDown = vi.fn()
    window.addEventListener('keydown', onWindowKeyDown)
    renderMenu({ x: 490, y: 390 })
    const menu = screen.getByRole('menu')
    expect(menu).toHaveStyle({ left: '292px', top: '92px' })
    fireEvent.keyDown(menu, { key: 'w' })
    expect(onWindowKeyDown).not.toHaveBeenCalled()
    window.removeEventListener('keydown', onWindowKeyDown)
  })

  test('keeps failed actions open and unknown relation semantics read-only while allowing delete', async () => {
    const onCommand = vi.fn(() => Promise.resolve(false))
    const failed = renderMenu({ onCommand })
    await userEvent.click(screen.getByRole('menuitemradio', { name: '虚线' }))
    await waitFor(() => expect(onCommand).toHaveBeenCalledOnce())
    expect(failed.onClose).not.toHaveBeenCalled()

    const unknown = renderMenu({
      value: {
        ...edge,
        relationType: 'future_relation' as CanvasEdge['relationType'],
      },
    })
    const unknownMenu = screen.getByRole('menu', { name: '关系菜单：未知关系' })
    expect(unknownMenu).toHaveTextContent('只读')
    expect(within(unknownMenu).queryByRole('menuitemradio')).not.toBeInTheDocument()
    await userEvent.click(within(unknownMenu).getByRole('menuitem', { name: '删除连线' }))
    expect(unknown.onCommand).toHaveBeenCalledWith({
      id: 'delete_edge',
      edgeId: edge.id,
    })
  })
})
