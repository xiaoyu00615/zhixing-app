import { describe, expect, test, beforeEach } from 'vitest'

import type { CanvasEdge, CanvasNode } from '@/canvas/model'
import {
  copyToClipboard,
  getClipboardSnapshot,
  requestPasteOffset,
  resetClipboardState,
} from './clipboard'

const CANVAS_ID = '00000000-0000-4000-8000-000000000001'
const TEXT_NODE_ID = '00000000-0000-4000-8000-000000000002'
const STICKY_NODE_ID = '00000000-0000-4000-8000-000000000003'
const BOX_NODE_ID = '00000000-0000-4000-8000-000000000004'
const UNKNOWN_NODE_ID = '00000000-0000-4000-8000-000000000005'
const INTERNAL_EDGE_ID = '00000000-0000-4000-8000-000000000006'
const EXTERNAL_EDGE_ID = '00000000-0000-4000-8000-000000000007'
const MEMBERSHIP_EDGE_ID = '00000000-0000-4000-8000-000000000008'
const UNKNOWN_RELATION_EDGE_ID = '00000000-0000-4000-8000-000000000009'

function makeTextNode(id: string, nodeName: string, text: string, x: number, y: number): CanvasNode {
  return { id, canvasId: CANVAS_ID, type: 'text', nodeName, content: { type: 'text', text }, x, y, createdAtMs: 1, updatedAtMs: 1 }
}

function makeStickyNode(id: string, nodeName: string, text: string, x: number, y: number): CanvasNode {
  return { id, canvasId: CANVAS_ID, type: 'sticky', nodeName, content: { type: 'sticky', text }, x, y, createdAtMs: 1, updatedAtMs: 1 }
}

function makeBoxNode(id: string): CanvasNode {
  return { id, canvasId: CANVAS_ID, type: 'node_box', nodeName: '', content: { type: 'node_box' }, x: 0, y: 0, createdAtMs: 1, updatedAtMs: 1 }
}

function makeUnknownNode(id: string): CanvasNode {
  return { id, canvasId: CANVAS_ID, type: 'unknown', nodeName: '', content: { type: 'unknown', raw: null }, originalType: 'future', x: 0, y: 0, createdAtMs: 1, updatedAtMs: 1 }
}

function makeEdge(id: string, source: string, target: string, relationType: string, direction: string, lineStyle: string): CanvasEdge {
  return { id, canvasId: CANVAS_ID, sourceNodeId: source, targetNodeId: target, relationType: relationType as CanvasEdge['relationType'], direction: direction as CanvasEdge['direction'], lineStyle: lineStyle as CanvasEdge['lineStyle'], membershipPosition: null, createdAtMs: 1, updatedAtMs: 1, deletedAtMs: null }
}

beforeEach(() => {
  resetClipboardState()
})

function assertSnapshot() {
  const s = getClipboardSnapshot()
  expect(s).not.toBeNull()
  return s!
}

describe('clipboard copy', () => {
  test('single Text node creates a valid snapshot', () => {
    const node = makeTextNode(TEXT_NODE_ID, 'Hello', 'Hello world', 10, 20)
    copyToClipboard([node], [], CANVAS_ID)
    const snap = assertSnapshot()
    expect(snap.sourceCanvasId).toBe(CANVAS_ID)
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!).toMatchObject({ id: TEXT_NODE_ID, type: 'text', nodeName: 'Hello', content: { type: 'text', text: 'Hello world' }, x: 10, y: 20 })
    expect(snap.edges).toHaveLength(0)
  })

  test('single Sticky node creates a valid snapshot', () => {
    const node = makeStickyNode(STICKY_NODE_ID, 'Note', 'Remember this', 30, 40)
    copyToClipboard([node], [], CANVAS_ID)
    const snap = assertSnapshot()
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!).toMatchObject({ type: 'sticky', nodeName: 'Note', content: { type: 'sticky', text: 'Remember this' }, x: 30, y: 40 })
  })

  test('Text + Sticky multi-select snapshot preserves both nodes', () => {
    const textNode = makeTextNode(TEXT_NODE_ID, 'A', 'Text A', 100, 100)
    const stickyNode = makeStickyNode(STICKY_NODE_ID, 'B', 'Sticky B', 200, 200)
    copyToClipboard([textNode, stickyNode], [], CANVAS_ID)
    const snap = assertSnapshot()
    expect(snap.nodes).toHaveLength(2)
    expect(snap.nodes.map((n) => n.id)).toEqual([TEXT_NODE_ID, STICKY_NODE_ID])
    expect(snap.nodes[0]!).toMatchObject({ nodeName: 'A', content: { type: 'text', text: 'Text A' }, x: 100, y: 100 })
    expect(snap.nodes[1]).toMatchObject({ nodeName: 'B', content: { type: 'sticky', text: 'Sticky B' }, x: 200, y: 200 })
  })

  test('preserves relative positions', () => {
    const a = makeTextNode(TEXT_NODE_ID, 'A', 'a', 10, 10)
    const b = makeStickyNode(STICKY_NODE_ID, 'B', 'b', 50, 60)
    copyToClipboard([a, b], [], CANVAS_ID)
    const snap = assertSnapshot()
    const dx = snap.nodes[1]!.x - snap.nodes[0]!.x
    const dy = snap.nodes[1]!.y - snap.nodes[0]!.y
    expect(dx).toBe(40)
    expect(dy).toBe(50)
  })

  test('copies internal ordinary edges and preserves their semantics', () => {
    const a = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    const b = makeStickyNode(STICKY_NODE_ID, 'B', 'b', 10, 10)
    void makeTextNode('ext-id', 'Ext', 'e', 100, 100)
    const edgeList: CanvasEdge[] = [
      makeEdge(INTERNAL_EDGE_ID, TEXT_NODE_ID, STICKY_NODE_ID, 'hierarchy', 'bidirectional', 'dashed'),
      makeEdge(EXTERNAL_EDGE_ID, STICKY_NODE_ID, 'ext-id', 'default', 'forward', 'solid'),
    ]
    copyToClipboard([a, b], edgeList, CANVAS_ID)
    const snap = assertSnapshot()
    expect(snap.edges).toHaveLength(1)
    expect(snap.edges[0]!).toMatchObject({
      id: INTERNAL_EDGE_ID,
      sourceNodeId: TEXT_NODE_ID,
      targetNodeId: STICKY_NODE_ID,
      relationType: 'hierarchy',
      direction: 'bidirectional',
      lineStyle: 'dashed',
    })
  })

  test('omits external edges where only one endpoint is selected', () => {
    const a = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    const b = makeStickyNode(STICKY_NODE_ID, 'B', 'b', 10, 10)
    const allEdges: CanvasEdge[] = [
      makeEdge(INTERNAL_EDGE_ID, TEXT_NODE_ID, STICKY_NODE_ID, 'peer', 'none', 'dotted'),
      makeEdge(EXTERNAL_EDGE_ID, TEXT_NODE_ID, 'foreign-node', 'default', 'forward', 'solid'),
    ]
    copyToClipboard([a, b], allEdges, CANVAS_ID)
    const snap = assertSnapshot()
    expect(snap.edges).toHaveLength(1)
    expect(snap.edges[0]!.id).toBe(INTERNAL_EDGE_ID)
  })

  test('fails-closed on Node Box selection, preserves existing clipboard', () => {
    const box = makeBoxNode(BOX_NODE_ID)
    const existing = makeTextNode(TEXT_NODE_ID, 'Existing', 'e', 0, 0)
    copyToClipboard([existing], [], CANVAS_ID)
    expect(getClipboardSnapshot()).not.toBeNull()
    expect(() => copyToClipboard([box], [], CANVAS_ID)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_NODE' }))
    const snap = assertSnapshot()
    expect(snap.nodes[0]!.id).toBe(TEXT_NODE_ID)
  })

  test('fails-closed on Unknown Node, preserves existing clipboard', () => {
    const unknown = makeUnknownNode(UNKNOWN_NODE_ID)
    const existing = makeTextNode(TEXT_NODE_ID, 'Existing', 'e', 0, 0)
    copyToClipboard([existing], [], CANVAS_ID)
    expect(() => copyToClipboard([unknown], [], CANVAS_ID)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_NODE' }))
    const snap = assertSnapshot()
    expect(snap.nodes[0]!.id).toBe(TEXT_NODE_ID)
  })

  test('fails-closed on membership edge in selected subgraph, preserves clipboard', () => {
    const a = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    const box = makeBoxNode(BOX_NODE_ID)
    const allEdges: CanvasEdge[] = [
      makeEdge(MEMBERSHIP_EDGE_ID, BOX_NODE_ID, TEXT_NODE_ID, 'ordered_box_member', 'forward', 'solid'),
    ]
    copyToClipboard([a], [], CANVAS_ID)
    expect(() => copyToClipboard([a, box], allEdges, CANVAS_ID)).toThrow()
    const snap = assertSnapshot()
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!.id).toBe(TEXT_NODE_ID)
  })

  test('fails-closed on unknown relation edge in selected subgraph', () => {
    const a = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    const b = makeStickyNode(STICKY_NODE_ID, 'B', 'b', 10, 10)
    const allEdges: CanvasEdge[] = [
      makeEdge(UNKNOWN_RELATION_EDGE_ID, TEXT_NODE_ID, STICKY_NODE_ID, 'future_relation', 'forward', 'solid'),
    ]
    copyToClipboard([a], [], CANVAS_ID)
    expect(() => copyToClipboard([a, b], allEdges, CANVAS_ID)).toThrow(expect.objectContaining({ code: 'UNSUPPORTED_EDGE' }))
  })

  test('empty selection is no-op, does not clear clipboard', () => {
    const existing = makeTextNode(TEXT_NODE_ID, 'Existing', 'e', 0, 0)
    copyToClipboard([existing], [], CANVAS_ID)
    copyToClipboard([], [], CANVAS_ID)
    const snap = assertSnapshot()
    expect(snap.nodes[0]!.id).toBe(TEXT_NODE_ID)
  })
})

describe('legacy canvas compatibility (real-world fixture from user data)', () => {
  // Mirrors the real legacy canvas 新测试 (3d2516e1): a Slice 9.x era canvas
  // with a live Node Box plus ordered/unordered membership edges. Under the
  // desired behavior, a selection of only text/sticky nodes must still copy,
  // regardless of membership edges that exist elsewhere in the canvas.
  function legacyFixture(): { textA: CanvasNode; textC: CanvasNode; stickyB: CanvasNode; allEdges: CanvasEdge[] } {
    const textA = makeTextNode(TEXT_NODE_ID, '文字节点', '21额企鹅请问', 512.67, 388.09)
    const textC = makeTextNode('00000000-0000-4000-8000-00000000000a', '', '', 1054.86, 299.80)
    const stickyB = makeStickyNode(STICKY_NODE_ID, 'asd', '2323423', 733.73, 595.14)
    const allEdges: CanvasEdge[] = [
      // Internal ordinary edge between the two selected members.
      makeEdge('00000000-0000-4000-8000-00000000000b', TEXT_NODE_ID, STICKY_NODE_ID, 'hierarchy', 'forward', 'solid'),
      // External ordinary edge to an unselected member C.
      makeEdge('00000000-0000-4000-8000-00000000000c', STICKY_NODE_ID, '00000000-0000-4000-8000-00000000000a', 'hierarchy', 'forward', 'solid'),
      // Membership edges: selected members -> unselected Node Box X.
      makeEdge('00000000-0000-4000-8000-00000000000d', TEXT_NODE_ID, BOX_NODE_ID, 'ordered_box_member', 'forward', 'solid'),
      makeEdge('00000000-0000-4000-8000-00000000000e', STICKY_NODE_ID, BOX_NODE_ID, 'unordered_box_member', 'forward', 'solid'),
      // Membership edge entirely outside any selection (C -> X).
      makeEdge('00000000-0000-4000-8000-00000000000f', '00000000-0000-4000-8000-00000000000a', BOX_NODE_ID, 'ordered_box_member', 'forward', 'solid'),
    ]
    return { textA, textC, stickyB, allEdges }
  }

  test('CASE A: copying a single member succeeds; snapshot has the node and zero edges', () => {
    const { textA, allEdges } = legacyFixture()
    expect(() => copyToClipboard([textA], allEdges, CANVAS_ID)).not.toThrow()
    const snap = assertSnapshot()
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!.id).toBe(TEXT_NODE_ID)
    expect(snap.edges).toHaveLength(0)
  })

  test('CASE B+C: copying members without the box keeps only internal ordinary edges', () => {
    const { textA, stickyB, allEdges } = legacyFixture()
    expect(() => copyToClipboard([textA, stickyB], allEdges, CANVAS_ID)).not.toThrow()
    const snap = assertSnapshot()
    expect(snap.nodes.map((n) => n.id)).toEqual([TEXT_NODE_ID, STICKY_NODE_ID])
    // Only the internal A->B hierarchy edge is kept; membership edges
    // (internal-unsupported-relation targets outside the selection) and
    // external edges are ignored entirely.
    expect(snap.edges).toHaveLength(1)
    expect(snap.edges[0]!.id).toBe('00000000-0000-4000-8000-00000000000b')
  })
})

describe('clipboard paste offset', () => {
  test('first paste returns offset 32', () => {
    const node = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    copyToClipboard([node], [], CANVAS_ID)
    expect(requestPasteOffset()).toBe(32)
  })

  test('second consecutive paste returns offset 64', () => {
    const node = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    copyToClipboard([node], [], CANVAS_ID)
    requestPasteOffset()
    expect(requestPasteOffset()).toBe(64)
  })

  test('new copy resets paste sequence', () => {
    const node = makeTextNode(TEXT_NODE_ID, 'A', 'a', 0, 0)
    copyToClipboard([node], [], CANVAS_ID)
    requestPasteOffset()
    requestPasteOffset()
    const node2 = makeTextNode(STICKY_NODE_ID, 'B', 'b', 0, 0)
    copyToClipboard([node2], [], CANVAS_ID)
    expect(requestPasteOffset()).toBe(32)
  })
})

describe('snapshot immutability', () => {
  test('modifying source nodes after copy does not affect snapshot', () => {
    const node = makeTextNode(TEXT_NODE_ID, 'A', 'original', 0, 0)
    copyToClipboard([node], [], CANVAS_ID)
    ;(node as unknown as Record<string, unknown>).content = { type: 'text', text: 'modified' }
    const snap = assertSnapshot()
    expect(snap.nodes).toHaveLength(1)
    expect(snap.nodes[0]!.content).toMatchObject({ type: 'text', text: 'original' })
  })
})
