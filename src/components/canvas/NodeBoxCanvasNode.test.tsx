import { createEvent, fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { NodeBoxCanvasNode } from '@/components/canvas/NodeBoxCanvasNode'

vi.mock('@xyflow/react', () => ({
  Handle: ({ 'aria-label': label }: { readonly 'aria-label': string }) => <span aria-label={label} />,
  Position: { Left: 'left', Right: 'right' },
}))

describe('NodeBoxCanvasNode', () => {
  test('renders ordered and unordered live names and removes only membership', async () => {
    const onRemoveMembership = vi.fn()
    render(
      <NodeBoxCanvasNode
        id="box"
        selected
        dragging={false}
        draggable
        selectable
        deletable={false}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
        type="nodeBoxCanvas"
        data={{
          nodeName: 'Research Box',
          renameRequest: 0,
          onRename: () => Promise.resolve(true),
          orderedMembers: [{ edgeId: 'ordered', nodeName: 'First idea' }],
          unorderedMembers: [{ edgeId: 'unordered', nodeName: 'Reference' }],
          membershipReorderBusy: false,
          onRemoveMembership,
          onReorderMemberships: () => undefined,
        }}
      />,
    )
    expect(screen.getByText('Research Box')).toBeInTheDocument()
    expect(screen.getByText('First idea')).toBeInTheDocument()
    expect(screen.getByText('Reference')).toBeInTheDocument()
    expect(screen.getByText('1')).toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '移除成员 First idea' }))
    expect(onRemoveMembership).toHaveBeenCalledWith('ordered')
  })

  test('shows lightweight empty states for both sections', () => {
    render(
      <NodeBoxCanvasNode
        id="box"
        selected={false}
        dragging={false}
        draggable
        selectable
        deletable={false}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
        type="nodeBoxCanvas"
        data={{
          nodeName: '',
          renameRequest: 0,
          onRename: () => Promise.resolve(true),
          orderedMembers: [],
          unorderedMembers: [],
          membershipReorderBusy: false,
          onRemoveMembership: () => undefined,
          onReorderMemberships: () => undefined,
        }}
      />,
    )
    expect(screen.getAllByText('暂无成员')).toHaveLength(2)
    expect(screen.getByText('BOX')).toBeInTheDocument()
  })

  test('drags ordered and unordered rows into a new stable order', () => {
    const onReorderMemberships = vi.fn()
    const bounds = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      bottom: 20,
      height: 20,
      left: 0,
      right: 100,
      top: 0,
      width: 100,
      x: 0,
      y: 0,
      toJSON: () => undefined,
    })
    render(
      <NodeBoxCanvasNode
        id="box"
        selected
        dragging={false}
        draggable
        selectable
        deletable={false}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
        type="nodeBoxCanvas"
        data={{
          nodeName: 'Research',
          renameRequest: 0,
          onRename: () => Promise.resolve(true),
          orderedMembers: [
            { edgeId: 'a', nodeName: 'A' },
            { edgeId: 'b', nodeName: 'B' },
            { edgeId: 'c', nodeName: 'C' },
          ],
          unorderedMembers: [
            { edgeId: 'd', nodeName: 'D' },
            { edgeId: 'e', nodeName: 'E' },
          ],
          membershipReorderBusy: false,
          onRemoveMembership: () => undefined,
          onReorderMemberships,
        }}
      />,
    )
    const transfer = { effectAllowed: '', setData: vi.fn() }
    fireEvent.dragStart(screen.getByLabelText('拖动成员 C'), { dataTransfer: transfer })
    const orderedTarget = screen.getByLabelText('拖动成员 A')
    const orderedDragOver = createEvent.dragOver(orderedTarget)
    Object.defineProperty(orderedDragOver, 'clientY', { value: 1 })
    fireEvent(orderedTarget, orderedDragOver)
    const orderedDrop = createEvent.drop(orderedTarget)
    Object.defineProperty(orderedDrop, 'clientY', { value: 1 })
    fireEvent(orderedTarget, orderedDrop)
    expect(onReorderMemberships).toHaveBeenLastCalledWith(
      'box',
      ['c', 'a', 'b'],
      ['d', 'e'],
    )

    fireEvent.dragStart(screen.getByLabelText('拖动成员 E'), { dataTransfer: transfer })
    const unorderedTarget = screen.getByLabelText('拖动成员 D')
    const unorderedDragOver = createEvent.dragOver(unorderedTarget)
    Object.defineProperty(unorderedDragOver, 'clientY', { value: 1 })
    fireEvent(unorderedTarget, unorderedDragOver)
    const unorderedDrop = createEvent.drop(unorderedTarget)
    Object.defineProperty(unorderedDrop, 'clientY', { value: 1 })
    fireEvent(unorderedTarget, unorderedDrop)
    expect(onReorderMemberships).toHaveBeenLastCalledWith(
      'box',
      ['a', 'b', 'c'],
      ['e', 'd'],
    )
    bounds.mockRestore()
  })

  test('moves a member across sections including an empty drop zone', () => {
    const onReorderMemberships = vi.fn()
    render(
      <NodeBoxCanvasNode
        id="box"
        selected
        dragging={false}
        draggable
        selectable
        deletable={false}
        isConnectable
        positionAbsoluteX={0}
        positionAbsoluteY={0}
        zIndex={0}
        type="nodeBoxCanvas"
        data={{
          nodeName: 'Research',
          renameRequest: 0,
          onRename: () => Promise.resolve(true),
          orderedMembers: [{ edgeId: 'a', nodeName: 'A' }],
          unorderedMembers: [],
          membershipReorderBusy: false,
          onRemoveMembership: () => undefined,
          onReorderMemberships,
        }}
      />,
    )
    const transfer = { effectAllowed: '', setData: vi.fn() }
    fireEvent.dragStart(screen.getByLabelText('拖动成员 A'), { dataTransfer: transfer })
    const emptyDropZone = screen.getByLabelText('无序成员空白放置区')
    fireEvent.dragOver(emptyDropZone)
    expect(screen.getByText('放到这里')).toBeInTheDocument()
    fireEvent.drop(emptyDropZone)
    expect(onReorderMemberships).toHaveBeenCalledWith('box', [], ['a'])
    expect(screen.getByLabelText('拖动成员 A')).toHaveClass('nodrag', 'nopan')
  })
})
