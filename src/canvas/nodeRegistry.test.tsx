import { describe, expect, test } from 'vitest'

import { canvasNodeRegistry, createCanvasNodeRegistry, toCanvasFlowNode, withCanvasNodeRuntimeData } from '@/canvas/nodeRegistry'

describe('Canvas node registry', () => {
  test('resolves Text, Sticky, and Node Box renderers and defaults', () => {
    expect(canvasNodeRegistry.byType.get('text')?.createDefaultData()).toEqual({ type: 'text', text: '' })
    expect(canvasNodeRegistry.byType.get('sticky')?.createDefaultData()).toEqual({ type: 'sticky', text: '' })
    expect(canvasNodeRegistry.nodeTypes).toHaveProperty('textCanvas')
    expect(canvasNodeRegistry.nodeTypes).toHaveProperty('stickyCanvas')
    expect(canvasNodeRegistry.byType.get('node_box')?.createDefaultData()).toEqual({ type: 'node_box' })
    expect(canvasNodeRegistry.nodeTypes).toHaveProperty('nodeBoxCanvas')
  })

  test('hydrates Node Box sections from live edge and node-name projections', () => {
    const onRename = () => Promise.resolve(true)
    const nodes = [
      toCanvasFlowNode({ id: 'member', canvasId: 'c', type: 'text', nodeName: 'Live name', content: { type: 'text', text: '' }, x: 0, y: 0, createdAtMs: 0, updatedAtMs: 0 }, () => undefined, onRename),
      toCanvasFlowNode({ id: 'box', canvasId: 'c', type: 'node_box', nodeName: 'Box', content: { type: 'node_box' }, x: 0, y: 0, createdAtMs: 0, updatedAtMs: 0 }, () => undefined, onRename),
    ]
    const hydrated = withCanvasNodeRuntimeData(nodes, [{ id: 'edge', canvasId: 'c', sourceNodeId: 'member', targetNodeId: 'box', relationType: 'ordered_box_member', direction: 'forward', lineStyle: 'solid', membershipPosition: 4, createdAtMs: 0, updatedAtMs: 0, deletedAtMs: null }], () => undefined)
    expect(hydrated[1]?.data.orderedMembers).toEqual([{ edgeId: 'edge', nodeName: 'Live name' }])
    expect(hydrated[1]?.data.unorderedMembers).toEqual([])
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
