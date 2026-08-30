import { describe, expect, test } from 'vitest'

import { canvasNodeRegistry, createCanvasNodeRegistry, toCanvasFlowNode } from '@/canvas/nodeRegistry'

describe('Canvas node registry', () => {
  test('resolves Text and Sticky renderers and defaults', () => {
    expect(canvasNodeRegistry.byType.get('text')?.createDefaultData()).toEqual({ type: 'text', text: '' })
    expect(canvasNodeRegistry.byType.get('sticky')?.createDefaultData()).toEqual({ type: 'sticky', text: '' })
    expect(canvasNodeRegistry.nodeTypes).toHaveProperty('textCanvas')
    expect(canvasNodeRegistry.nodeTypes).toHaveProperty('stickyCanvas')
  })

  test('rejects duplicate registered node types', () => {
    const entry = canvasNodeRegistry.byType.get('text')!
    expect(() => createCanvasNodeRegistry([entry, entry])).toThrow(/Duplicate/)
  })

  test('maps unknown nodes to a safe placeholder without exposing raw data', () => {
    const flowNode = toCanvasFlowNode({ id: '1', canvasId: '2', type: 'unknown', originalType: 'future', nodeName: 'Future node', content: { type: 'unknown', raw: { secret: 'opaque' } }, x: 1, y: 2, createdAtMs: 0, updatedAtMs: 0 }, () => undefined, () => Promise.resolve(false))
    expect(flowNode.type).toBe('unsupportedCanvas')
    expect(flowNode.data).toEqual({ originalType: 'future', nodeName: 'Future node' })
  })
})
