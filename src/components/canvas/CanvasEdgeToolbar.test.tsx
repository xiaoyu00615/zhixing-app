import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, test, vi } from 'vitest'

import { CanvasEdgeToolbar } from '@/components/canvas/CanvasEdgeToolbar'
import type { CanvasEdge } from '@/canvas/model'

const edge: CanvasEdge = {
  id: '00000000-0000-4000-8000-000000000604',
  canvasId: '00000000-0000-4000-8000-000000000601',
  sourceNodeId: '00000000-0000-4000-8000-000000000602',
  targetNodeId: '00000000-0000-4000-8000-000000000603',
  relationType: 'default',
  direction: 'forward',
  lineStyle: 'solid',
  createdAtMs: 10,
  updatedAtMs: 10,
  deletedAtMs: null,
}

function renderToolbar(value: CanvasEdge = edge) {
  const onRelationTypeChange = vi.fn()
  const onDirectionChange = vi.fn()
  const onLineStyleChange = vi.fn()
  render(
    <CanvasEdgeToolbar
      busy={false}
      edge={value}
      onDelete={vi.fn()}
      onDirectionChange={onDirectionChange}
      onLineStyleChange={onLineStyleChange}
      onRelationTypeChange={onRelationTypeChange}
    />,
  )
  return { onRelationTypeChange, onDirectionChange, onLineStyleChange }
}

describe('CanvasEdgeToolbar', () => {
  test('shows and selects only the three active semantic relation types', async () => {
    const callbacks = renderToolbar()
    expect(screen.getByRole('button', { name: '普通关系' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '上下级' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '同级' })).toBeInTheDocument()
    expect(screen.queryByText(/Node Box/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: '上下级' }))
    expect(callbacks.onRelationTypeChange).toHaveBeenCalledWith('hierarchy')
    await userEvent.click(screen.getByRole('button', { name: '同级' }))
    expect(callbacks.onRelationTypeChange).toHaveBeenCalledWith('peer')
  })

  test('keeps direction and line style as independent controls', async () => {
    const callbacks = renderToolbar({ ...edge, relationType: 'hierarchy' })
    await userEvent.click(screen.getByRole('button', { name: '双向' }))
    await userEvent.click(screen.getByRole('button', { name: '点线' }))
    expect(callbacks.onDirectionChange).toHaveBeenCalledWith('bidirectional')
    expect(callbacks.onLineStyleChange).toHaveBeenCalledWith('dotted')
  })

  test('renders unknown semantics neutrally and keeps the semantic selector read-only', () => {
    renderToolbar({
      ...edge,
      relationType: 'future_relation' as CanvasEdge['relationType'],
      direction: 'bidirectional',
      lineStyle: 'dotted',
    })
    expect(screen.getByText('未知关系')).toBeInTheDocument()
    expect(screen.getByText('原始类型：future_relation')).toBeInTheDocument()
    expect(screen.getByText('未知关系保持只读，不会自动转换。')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '普通关系' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: '双向' })).toHaveAttribute('aria-pressed', 'true')
    expect(screen.getByRole('button', { name: '点线' })).toHaveAttribute('aria-pressed', 'true')
  })
})
