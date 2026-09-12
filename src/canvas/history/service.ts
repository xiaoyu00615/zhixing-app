import type { CanvasService } from '@/canvas/service'
import type { CanvasMutationAction } from '@/canvas/repository'
import type { CanvasEdge, CanvasNode, RegisteredCanvasNodeContent } from '@/canvas/model'
import { getCanvasHistorySession } from './session'

function uuid(): string {
  return globalThis.crypto.randomUUID()
}

function toNodeSnapshot(node: CanvasNode): CanvasMutationAction extends { kind: 'insert_nodes'; nodes: infer T }
  ? T extends Array<infer N>
    ? N
    : never
  : never {
  return {
    id: node.id,
    canvasId: node.canvasId,
    type: node.type,
    nodeName: node.nodeName,
    content: node.content,
    x: node.x,
    y: node.y,
    createdAtMs: node.createdAtMs,
  } as CanvasMutationAction extends { kind: 'insert_nodes'; nodes: infer T }
    ? T extends Array<infer N>
      ? N
      : never
    : never
}

function softDeleteNodeId(id: string): CanvasMutationAction {
  return { kind: 'soft_delete_nodes', nodeIds: [id] }
}
function softDeleteEdgeId(id: string): CanvasMutationAction {
  return { kind: 'soft_delete_edges', edgeIds: [id] }
}

function pushEntry(
  canvasId: string,
  forward: readonly CanvasMutationAction[],
  inverse: readonly CanvasMutationAction[],
) {
  if (forward.length === 0 && inverse.length === 0) return
  getCanvasHistorySession(canvasId).push({
    commandId: uuid(),
    timestamp: Date.now(),
    forward,
    inverse,
  })
}

/** Wraps an inner CanvasService in a history layer.
 *
 * Supported (5 ops): create node, rename node, edit text content,
 * create edge, delete edge. Every other CanvasService method is forwarded
 * unchanged and never mutates the undo/redo stacks. Undo/redo execute a
 * single applyCanvasMutationBatch; if it fails the stacks stay put and the
 * caller should re-open the canvas to resync UI state. */
export function createCanvasHistoryService(
  inner: CanvasService,
): CanvasService {
  // Entity indexes exist ONLY to build inverse snapshots. They are NOT the
  // source of truth — openCanvas always re-syncs from the repository.
  const nodeById = new Map<string, CanvasNode>()
  const edgeById = new Map<string, CanvasEdge>()
  // Track which canvas each entity belongs to. Needed because editTextNode
  // and deleteCanvasEdge only receive a bare id, not a canvasId.
  const nodeCanvasId = new Map<string, string>()
  const edgeCanvasId = new Map<string, string>()

  async function syncIndex(id: string) {
    const workspace = await inner.openCanvas(id)
    nodeById.clear()
    edgeById.clear()
    nodeCanvasId.clear()
    edgeCanvasId.clear()
    for (const node of workspace.nodes) {
      nodeById.set(node.id, node)
      nodeCanvasId.set(node.id, node.canvasId)
    }
    for (const edge of workspace.edges) {
      edgeById.set(edge.id, edge)
      edgeCanvasId.set(edge.id, edge.canvasId)
    }
    return workspace
  }

  return {
    async createCanvas(title) { return inner.createCanvas(title) },
    listCanvases() { return inner.listCanvases() },
    async renameCanvas(id, title) { return inner.renameCanvas(id, title) },
    async openCanvas(id) { return syncIndex(id) },
    async updateViewport(id, viewport) { return inner.updateViewport(id, viewport) },

    async createCanvasNode(canvasId, type, content, position) {
      return inner.createCanvasNode(canvasId, type, content, position).then((node) => {
        nodeById.set(node.id, node)
        nodeCanvasId.set(node.id, canvasId)
        pushEntry(canvasId,
          [{ kind: 'insert_nodes', nodes: [toNodeSnapshot(node)] }],
          [softDeleteNodeId(node.id)],
        )
        return node
      })
    },
    async createTextNode(canvasId, text, position) {
      return inner.createTextNode(canvasId, text, position).then((node) => {
        nodeById.set(node.id, node)
        nodeCanvasId.set(node.id, canvasId)
        pushEntry(canvasId,
          [{ kind: 'insert_nodes', nodes: [toNodeSnapshot(node)] }],
          [softDeleteNodeId(node.id)],
        )
        return node
      })
    },
    listCanvasNodes(canvasId) { return inner.listCanvasNodes(canvasId) },

    async updateCanvasNodeContent(id, type, content) {
      // Bug fix: use nodeCanvasId.get(id) instead of bare `id`.
      const canvasId = nodeCanvasId.get(id)
      if (canvasId === undefined) return inner.updateCanvasNodeContent(id, type, content)
      const before = nodeById.get(id)
      if (before === undefined) return inner.updateCanvasNodeContent(id, type, content)
      return inner.updateCanvasNodeContent(id, type, content).then((node) => {
        nodeById.set(id, node)
        pushEntry(canvasId,
          [{ kind: 'set_node_content', nodeId: id, content }],
          [{ kind: 'set_node_content', nodeId: id, content: before.content as RegisteredCanvasNodeContent }],
        )
        return node
      })
    },
    async renameCanvasNode(canvasId, id, nodeName) {
      const before = nodeById.get(id)
      if (before === undefined) return inner.renameCanvasNode(canvasId, id, nodeName)
      return inner.renameCanvasNode(canvasId, id, nodeName).then((node) => {
        nodeById.set(id, node)
        pushEntry(canvasId,
          [{ kind: 'set_node_name', nodeId: id, nodeName }],
          [{ kind: 'set_node_name', nodeId: id, nodeName: before.nodeName }],
        )
        return node
      })
    },
    async editTextNode(id, text) {
      // Bug fix: use nodeCanvasId.get(id) instead of bare `id`.
      const canvasId = nodeCanvasId.get(id)
      if (canvasId === undefined) return inner.editTextNode(id, text)
      const before = nodeById.get(id)
      if (before === undefined) return inner.editTextNode(id, text)
      return inner.editTextNode(id, text).then((node) => {
        nodeById.set(id, node)
        pushEntry(canvasId,
          [{ kind: 'set_node_content', nodeId: id, content: { type: 'text', text } }],
          [{ kind: 'set_node_content', nodeId: id, content: before.content as RegisteredCanvasNodeContent }],
        )
        return node
      })
    },

    moveCanvasNode(id, x, y) { return inner.moveCanvasNode(id, x, y) },
    moveCanvasNodes(canvasId, moves) { return inner.moveCanvasNodes(canvasId, moves) },
    deleteCanvasNode(canvasId, id) { return inner.deleteCanvasNode(canvasId, id) },

    async createCanvasEdge(canvasId, sourceNodeId, targetNodeId) {
      return inner.createCanvasEdge(canvasId, sourceNodeId, targetNodeId).then((edge) => {
        edgeById.set(edge.id, edge)
        edgeCanvasId.set(edge.id, canvasId)
        pushEntry(canvasId,
          [{
            kind: 'insert_edges',
            edges: [{
              id: edge.id,
              canvasId,
              sourceNodeId: edge.sourceNodeId,
              targetNodeId: edge.targetNodeId,
              relationType: edge.relationType as import('@/canvas/model').CanvasEdgeRelationType,
              direction: edge.direction,
              lineStyle: edge.lineStyle,
              membershipPosition: edge.membershipPosition,
              createdAtMs: edge.createdAtMs,
            }],
          }],
          [softDeleteEdgeId(edge.id)],
        )
        return edge
      })
    },
    addNodeBoxMember(canvasId, sourceNodeId, targetNodeId, relationType) {
      return inner.addNodeBoxMember(canvasId, sourceNodeId, targetNodeId, relationType)
    },
    reorderNodeBoxMemberships(canvasId, nodeBoxId, orderedMembershipEdgeIds, unorderedMembershipEdgeIds) {
      return inner.reorderNodeBoxMemberships(canvasId, nodeBoxId, orderedMembershipEdgeIds, unorderedMembershipEdgeIds)
    },
    listCanvasEdges(canvasId) { return inner.listCanvasEdges(canvasId) },
    updateCanvasEdgeDirection(id, direction) { return inner.updateCanvasEdgeDirection(id, direction) },
    updateCanvasEdgeLineStyle(id, lineStyle) { return inner.updateCanvasEdgeLineStyle(id, lineStyle) },
    updateCanvasEdgeRelationType(id, relationType) { return inner.updateCanvasEdgeRelationType(id, relationType) },

    async deleteCanvasEdge(id) {
      // Bug fix: use edgeCanvasId.get(id) instead of bare `id`.
      const canvasId = edgeCanvasId.get(id)
      if (canvasId === undefined) return inner.deleteCanvasEdge(id)
      const before = edgeById.get(id)
      if (before === undefined) return inner.deleteCanvasEdge(id)
      return inner.deleteCanvasEdge(id).then((edge) => {
        edgeById.set(id, edge)
        pushEntry(canvasId,
          [softDeleteEdgeId(id)],
          [{
            kind: 'insert_edges',
            edges: [{
              id: before.id,
              canvasId: before.canvasId,
              sourceNodeId: before.sourceNodeId,
              targetNodeId: before.targetNodeId,
              relationType: before.relationType as import('@/canvas/model').CanvasEdgeRelationType,
              direction: before.direction,
              lineStyle: before.lineStyle,
              membershipPosition: before.membershipPosition,
              createdAtMs: before.createdAtMs,
            }],
          }],
        )
        return edge
      })
    },
    pasteCanvasSubgraph(canvasId, snapshot, offset) {
      return inner.pasteCanvasSubgraph(canvasId, snapshot, offset)
    },
    applyCanvasMutationBatch(canvasId, actions) {
      return inner.applyCanvasMutationBatch(canvasId, actions)
    },

    async undo(canvasId: string) {
      const session = getCanvasHistorySession(canvasId)
      if (!session.canUndo) return
      const entry = session.peekUndo()
      if (entry === undefined || entry.inverse.length === 0) return
      try {
        await inner.applyCanvasMutationBatch(canvasId, entry.inverse as CanvasMutationAction[])
        await syncIndex(canvasId)
      } catch {
        // Stack must not move on failure; caller should re-open canvas.
        return
      }
      session.commitUndo()
    },
    async redo(canvasId: string) {
      const session = getCanvasHistorySession(canvasId)
      if (!session.canRedo) return
      const entry = session.peekRedo()
      if (entry === undefined || entry.forward.length === 0) return
      try {
        await inner.applyCanvasMutationBatch(canvasId, entry.forward as CanvasMutationAction[])
        await syncIndex(canvasId)
      } catch {
        // Stack must not move on failure; caller should re-open canvas.
        return
      }
      session.commitRedo()
    },
    canUndo(canvasId: string) { return getCanvasHistorySession(canvasId).canUndo },
    canRedo(canvasId: string) { return getCanvasHistorySession(canvasId).canRedo },
  }
}
