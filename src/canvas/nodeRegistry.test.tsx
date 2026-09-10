import { describe, expect, test } from 'vitest'

import { canvasNodeRegistry, canvasFlowNodeToCanvasNode, createCanvasNodeRegistry, orderedMembershipDisplayNumbers, toCanvasFlowNode, withCanvasNodeRuntimeData } from '@/canvas/nodeRegistry'

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
    const hydrated = withCanvasNodeRuntimeData(nodes, [{ id: 'edge', canvasId: 'c', sourceNodeId: 'member', targetNodeId: 'box', relationType: 'ordered_box_member', direction: 'forward', lineStyle: 'solid', membershipPosition: 4, createdAtMs: 0, updatedAtMs: 0, deletedAtMs: null }], () => undefined, () => undefined, false)
    expect(hydrated[1]?.data.orderedMembers).toEqual([{ edgeId: 'edge', nodeName: 'Live name' }])
    expect(hydrated[1]?.data.unorderedMembers).toEqual([])
  })

  test('derives continuous ordered Edge numbers per Node Box despite position gaps', () => {
    const edge = (id: string, targetNodeId: string, membershipPosition: number) => ({
      id,
      canvasId: 'canvas',
      sourceNodeId: `source-${id}`,
      targetNodeId,
      relationType: 'ordered_box_member' as const,
      direction: 'forward' as const,
      lineStyle: 'solid' as const,
      membershipPosition,
      createdAtMs: 0,
      updatedAtMs: 0,
      deletedAtMs: null,
    })
    const numbers = orderedMembershipDisplayNumbers([
      edge('a', 'box-a', 0),
      edge('c', 'box-a', 5),
      edge('d', 'box-b', 7),
    ])
    expect([...numbers.entries()]).toEqual([
      ['a', 1],
      ['c', 2],
      ['d', 1],
    ])
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

  describe('canvasFlowNodeToCanvasNode', () => {
    type FlowNode = import('@/canvas/nodeRegistry').CanvasFlowNode
    const makeFlowNode = (type: string, data: Record<string, unknown>): FlowNode => ({
      id: 'node-1', type, position: { x: 100, y: 200 }, data, selected: false,
    })

    test('textCanvas → CanvasNode type=text with correct fields', () => {
      const fn = makeFlowNode('textCanvas', { nodeName: 'My Text', text: 'hello world' })
      const node = canvasFlowNodeToCanvasNode(fn, 'canvas-id', 42)
      expect(node.type).toBe('text')
      expect(node.id).toBe('node-1')
      expect(node.canvasId).toBe('canvas-id')
      expect(node.nodeName).toBe('My Text')
      expect(node.content).toEqual({ type: 'text', text: 'hello world' })
      expect(node.x).toBe(100)
      expect(node.y).toBe(200)
    })

    test('stickyCanvas → CanvasNode type=sticky with correct fields', () => {
      const fn = makeFlowNode('stickyCanvas', { nodeName: 'My Sticky', text: 'note content' })
      const node = canvasFlowNodeToCanvasNode(fn, 'canvas-id', 42)
      expect(node.type).toBe('sticky')
      expect(node.content).toEqual({ type: 'sticky', text: 'note content' })
    })

    test('nodeBoxCanvas → CanvasNode type=node_box', () => {
      const fn = makeFlowNode('nodeBoxCanvas', { nodeName: 'My Box' })
      const node = canvasFlowNodeToCanvasNode(fn, 'canvas-id', 42)
      expect(node.type).toBe('node_box')
      expect(node.content).toEqual({ type: 'node_box' })
    })

    test('unsupportedCanvas → CanvasNode type=unknown with originalType preserved', () => {
      const fn = makeFlowNode('unsupportedCanvas', { nodeName: 'Lost Node', originalType: 'future_type' })
      const node = canvasFlowNodeToCanvasNode(fn, 'canvas-id', 42) as import('@/canvas/model').CanvasUnknownNode
      expect(node.type).toBe('unknown')
      expect(node.originalType).toBe('future_type')
    })

    test('cannot forge type via as-cast — textCanvas must become text not sticky', () => {
      const fn = makeFlowNode('textCanvas', { nodeName: 'A', text: 'X' })
      const node = canvasFlowNodeToCanvasNode(fn, 'canvas-id', 42)
      expect(node.type).toBe('text')
      expect(node.content).toEqual({ type: 'text', text: 'X' })
    })
  })
})
