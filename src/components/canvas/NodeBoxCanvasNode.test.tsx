import { render, screen } from '@testing-library/react'
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
          onRemoveMembership,
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
          onRemoveMembership: () => undefined,
        }}
      />,
    )
    expect(screen.getAllByText('暂无成员')).toHaveLength(2)
    expect(screen.getByText('BOX')).toBeInTheDocument()
  })
})
