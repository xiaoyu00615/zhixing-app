import { describe, expect, test, vi } from 'vitest'

import type { CanvasService } from '@/canvas/service'
import type { CanvasMutationAction } from '@/canvas/repository'
import type { CanvasHistoryEntry } from './model'
import { createCanvasHistoryService } from './service'
import { getCanvasHistorySession } from './session'

// ─── helpers ─────────────────────────────────────────────────────────────────

const EDGE_ID  = '00000000-0000-4000-8000-00000000ff03'
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

function mockInner(failUndo = false, failRedo = false): CanvasService {
  return {
    createCanvas:                  vi.fn(),
    listCanvases:                  vi.fn(),
    renameCanvas:                  vi.fn(),
    openCanvas:                    vi.fn().mockResolvedValue({ nodes: [], edges: [] }),
    updateViewport:                vi.fn(),
    createCanvasNode:              vi.fn(),
    createTextNode:                vi.fn(),
    listCanvasNodes:               vi.fn(),
    updateCanvasNodeContent:       vi.fn(),
    renameCanvasNode:              vi.fn(),
    editTextNode:                  vi.fn(),
    moveCanvasNode:                vi.fn(),
    moveCanvasNodes:               vi.fn(),
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
    applyCanvasMutationBatch: vi.fn((cid: string) => {
      if (cid === _activeUndoCanvas && failUndo) return Promise.reject(new Error('simulated batch failure'))
      if (cid === _activeRedoCanvas && failRedo) return Promise.reject(new Error('simulated batch failure'))
      return Promise.resolve()
    }),
    undo: vi.fn(),
    redo: vi.fn(),
    canUndo: vi.fn(),
    canRedo: vi.fn(),
  }
}

// Per-test active canvas so the mock can target the right one.
let _activeUndoCanvas = ''
let _activeRedoCanvas = ''

// ─── tests ───────────────────────────────────────────────────────────────────

describe('createCanvasHistoryService', () => {
  test('undo failure leaves entry in past and canUndo stays true', async () => {
    const cid = nextCanvasId()
    _activeUndoCanvas = cid
    const inner = mockInner(true, false)
    const svc = createCanvasHistoryService(inner)

    const session = getCanvasHistorySession(cid)
    session.push(makeEntry('e1', [], [
      { kind: 'soft_delete_edges', edgeIds: [EDGE_ID] },
    ]))

    // undo() swallows the error internally — verify stack state after call.
    await svc.undo(cid)
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
    expect(session.peekUndo()?.commandId).toBe('e1')
  })

  test('redo failure leaves entry in future and canRedo stays true', async () => {
    const cid = nextCanvasId()
    _activeRedoCanvas = cid
    const inner = mockInner(false, true)
    const svc = createCanvasHistoryService(inner)

    const session = getCanvasHistorySession(cid)
    session.push(makeEntry('e1', [
      { kind: 'soft_delete_edges', edgeIds: [EDGE_ID] },
    ], []))
    session.commitUndo() // move e1 from past → future

    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(true)
    expect(session.peekRedo()?.commandId).toBe('e1')

    await svc.redo(cid)
    // Stack unchanged after failure
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(true)
    expect(session.peekRedo()?.commandId).toBe('e1')
  })
})
