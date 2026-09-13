import { describe, expect, test, vi } from 'vitest'

import type { CanvasService } from '@/canvas/service'
import type { CanvasNode } from '@/canvas/model'
import type { CanvasMutationAction } from '@/canvas/repository'
import type { CanvasHistoryEntry } from './model'
import { createCanvasHistoryService } from './service'
import { getCanvasHistorySession } from './session'

// ─── helpers ─────────────────────────────────────────────────────────────────

const EDGE_ID = '00000000-0000-4000-8000-00000000ff03'
let canvasIdCounter = 0

function nextCanvasId(): string {
  canvasIdCounter += 1
  return `00000000-0000-4000-8000-00000000ff${String(canvasIdCounter).padStart(2, '0')}`
}

function makeEntry(
  commandId: string,
  forward: readonly CanvasMutationAction[] = [],
  inverse: readonly CanvasMutationAction[] = [],
): CanvasHistoryEntry {
  return { commandId, timestamp: 0, forward, inverse }
}

function mockNode(id: string, canvasId: string, x = 0, y = 0): CanvasNode {
  return {
    id,
    canvasId,
    type: 'text' as const,
    nodeName: 'Node',
    content: { type: 'text', text: '' },
    x,
    y,
    createdAtMs: 0,
    updatedAtMs: 0,
  }
}

function buildMockInner(opts: {
  failMove?: boolean
  failApply?: boolean
  nodes?: CanvasNode[]
}): CanvasService {
  const { failMove = false, failApply = false, nodes = [] } = opts
  return {
    createCanvas:                  vi.fn(),
    listCanvases:                  vi.fn(),
    renameCanvas:                  vi.fn(),
    openCanvas:                  vi.fn().mockResolvedValue({ nodes, edges: [] }),
    updateViewport:                vi.fn(),
    createCanvasNode:              vi.fn(),
    createTextNode:                vi.fn(),
    listCanvasNodes:               vi.fn(),
    updateCanvasNodeContent:       vi.fn(),
    renameCanvasNode:              vi.fn(),
    editTextNode:                  vi.fn(),
    moveCanvasNode:                vi.fn((id: string, x: number, y: number) => {
      if (failMove) return Promise.reject(new Error('simulated move failure'))
      return Promise.resolve({ ...nodes.find(n => n.id === id)!, x, y, updatedAtMs: 999 })
    }),
    moveCanvasNodes:               vi.fn((_canvasId: string, moves: { nodeId: string; x: number; y: number }[]) => {
      if (failMove) return Promise.reject(new Error('simulated move failure'))
      return Promise.resolve(moves.map(m => ({ ...nodes.find(n => n.id === m.nodeId)!, x: m.x, y: m.y, updatedAtMs: 999 })))
    }),
    deleteCanvasNode:              vi.fn(),
    createCanvasEdge:              vi.fn(),
    addNodeBoxMember:              vi.fn(),
    reorderNodeBoxMemberships:     vi.fn(),
    listCanvasEdges:               vi.fn(),
    updateCanvasEdgeDirection:     vi.fn(),
    updateCanvasEdgeLineStyle:     vi.fn(),
    updateCanvasEdgeRelationType:  vi.fn(),
    deleteCanvasEdge:              vi.fn(),
    pasteCanvasSubgraph:           vi.fn(),
    applyCanvasMutationBatch:      vi.fn(() => {
      if (failApply) return Promise.reject(new Error('simulated batch failure'))
      return Promise.resolve()
    }),
    undo:                          vi.fn(),
    redo:                          vi.fn(),
    canUndo:                       vi.fn(),
    canRedo:                       vi.fn(),
  }
}

// ─── tests ───────────────────────────────────────────────────────────────────

describe('createCanvasHistoryService', () => {
  test('undo failure leaves entry in past and canUndo stays true', async () => {
    const cid = nextCanvasId()
    const inner = buildMockInner({ failApply: true })
    const svc = createCanvasHistoryService(inner)
    const session = getCanvasHistorySession(cid)
    session.push(makeEntry('e1', [], [
      { kind: 'soft_delete_edges', edgeIds: [EDGE_ID] },
    ]))

    await svc.undo(cid)
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
    expect(session.peekUndo()?.commandId).toBe('e1')
  })

  test('redo failure leaves entry in future and canRedo stays true', async () => {
    const cid = nextCanvasId()
    const inner = buildMockInner({ failApply: true })
    const svc = createCanvasHistoryService(inner)

    const session = getCanvasHistorySession(cid)
    session.push(makeEntry('e1', [
      { kind: 'soft_delete_edges', edgeIds: [EDGE_ID] },
    ], []))
    session.commitUndo()

    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(true)
    expect(session.peekRedo()?.commandId).toBe('e1')

    await svc.redo(cid)
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(true)
    expect(session.peekRedo()?.commandId).toBe('e1')
  })

  test('single move pushes one History Entry with correct forward/inverse', async () => {
    const cid = nextCanvasId()
    const nodeId = '00000000-0000-4000-8000-00000000aa01'
    const inner = buildMockInner({
      nodes: [mockNode(nodeId, cid, 100, 200)],
    })
    const svc = createCanvasHistoryService(inner)

    await svc.openCanvas(cid)
    await svc.moveCanvasNode(nodeId, 300, 400)

    const session = getCanvasHistorySession(cid)
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
    const entry = session.peekUndo()!
    expect(entry.forward).toEqual([{
      kind: 'move_nodes',
      moves: [{ nodeId, x: 300, y: 400 }],
    }])
    expect(entry.inverse).toEqual([{
      kind: 'move_nodes',
      moves: [{ nodeId, x: 100, y: 200 }],
    }])
  })

  test('multi move produces ONE History Entry with all positions', async () => {
    const cid = nextCanvasId()
    const a = '00000000-0000-4000-8000-00000000aa02'
    const b = '00000000-0000-4000-8000-00000000aa03'
    const inner = buildMockInner({
      nodes: [mockNode(a, cid, 10, 20), mockNode(b, cid, 30, 40)],
    })
    const svc = createCanvasHistoryService(inner)

    await svc.openCanvas(cid)
    await svc.moveCanvasNodes(cid, [
      { nodeId: a, x: 110, y: 120 },
      { nodeId: b, x: 130, y: 140 },
    ])

    const session = getCanvasHistorySession(cid)
    expect(session.canUndo).toBe(true)
    const entry = session.peekUndo()!
    expect(entry.forward).toEqual([{
      kind: 'move_nodes',
      moves: [
        { nodeId: a, x: 110, y: 120 },
        { nodeId: b, x: 130, y: 140 },
      ],
    }])
    expect(entry.inverse).toEqual([{
      kind: 'move_nodes',
      moves: [
        { nodeId: a, x: 10, y: 20 },
        { nodeId: b, x: 30, y: 40 },
      ],
    }])
  })

  test('zero movement produces NO History Entry', async () => {
    const cid = nextCanvasId()
    const nodeId = '00000000-0000-4000-8000-00000000aa04'
    const inner = buildMockInner({
      nodes: [mockNode(nodeId, cid, 50, 60)],
    })
    const svc = createCanvasHistoryService(inner)

    await svc.openCanvas(cid)
    await svc.moveCanvasNode(nodeId, 50, 60) // same position

    const session = getCanvasHistorySession(cid)
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(false)
  })

  test('persistence failure produces NO History Entry and stack stays put', async () => {
    const cid = nextCanvasId()
    const nodeId = '00000000-0000-4000-8000-00000000aa05'
    const inner = buildMockInner({
      failMove: true,
      nodes: [mockNode(nodeId, cid, 10, 20)],
    })
    const svc = createCanvasHistoryService(inner)

    await svc.openCanvas(cid)
    // Pre-seed a history entry so we can verify stack doesn't change
    const session = getCanvasHistorySession(cid)
    session.push(makeEntry('existing', [], []))
    expect(session.canUndo).toBe(true)

    await expect(svc.moveCanvasNode(nodeId, 999, 999)).rejects.toThrow()
    // Stack unchanged
    expect(session.canUndo).toBe(true)
    expect(session.peekUndo()?.commandId).toBe('existing')
  })
})
