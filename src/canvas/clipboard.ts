import type { CanvasEdge, CanvasNode } from '@/canvas/model'

const PASTE_OFFSET_STEP = 32

/**
 * Application-local in-memory Canvas clipboard.
 *
 * Snapshot captures the data at copy time; subsequent mutations to source
 * nodes do not affect what Ctrl+V produces.
 *
 * Supported node types: text, sticky.
 * Node Box, unknown nodes, membership edges, and unknown ordinary edges
 * are all fail-closed — existing snapshot is preserved on failed copy.
 *
 * Paste offset increments by PASTE_OFFSET_STEP per consecutive paste.
 * A new Ctrl+C resets the sequence to 0.
 */

export interface CanvasClipboardNodeSnapshot {
  readonly id: string
  readonly type: 'text' | 'sticky'
  readonly nodeName: string
  readonly content: { readonly type: 'text'; readonly text: string }
    | { readonly type: 'sticky'; readonly text: string }
  readonly x: number
  readonly y: number
}

export interface CanvasClipboardEdgeSnapshot {
  readonly id: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: 'default' | 'hierarchy' | 'peer'
  readonly direction: 'forward' | 'bidirectional' | 'none'
  readonly lineStyle: 'solid' | 'dashed' | 'dotted'
}

export interface CanvasClipboardSnapshot {
  readonly sourceCanvasId: string
  readonly nodes: readonly CanvasClipboardNodeSnapshot[]
  readonly edges: readonly CanvasClipboardEdgeSnapshot[]
}

export class CanvasClipboardEmptyError extends Error {
  readonly code = 'CLIPBOARD_EMPTY' as const
  constructor() {
    super('Canvas clipboard is empty.')
    this.name = 'CanvasClipboardEmptyError'
  }
}

export class CanvasClipboardUnsupportedNodeError extends Error {
  readonly code = 'UNSUPPORTED_NODE' as const
  constructor() {
    super('Selection contains unsupported node type; copy rejected.')
    this.name = 'CanvasClipboardUnsupportedNodeError'
  }
}

export class CanvasClipboardUnsupportedEdgeError extends Error {
  readonly code = 'UNSUPPORTED_EDGE' as const
  constructor() {
    super('Selection contains unsupported edge; copy rejected.')
    this.name = 'CanvasClipboardUnsupportedEdgeError'
  }
}

function isSupportedNodeType(
  node: CanvasNode,
): boolean {
  return node.type === 'text' || node.type === 'sticky'
}

function isOrdinaryEdgeRelationType(
  type: string,
): type is 'default' | 'hierarchy' | 'peer' {
  return type === 'default' || type === 'hierarchy' || type === 'peer'
}

let currentSnapshot: CanvasClipboardSnapshot | null = null
let pasteOffsetSequence = 0

export function resetClipboardState(): void {
  currentSnapshot = null
  pasteOffsetSequence = 0
}

export function copyToClipboard(
  selectedNodes: readonly CanvasNode[],
  allEdges: readonly CanvasEdge[],
  canvasId: string,
): void {
  if (selectedNodes.length === 0) return

  for (const node of selectedNodes) {
    if (!isSupportedNodeType(node)) {
      // Node box or unknown node: fail-closed, preserve existing snapshot.
      throw new CanvasClipboardUnsupportedNodeError()
    }
  }

  const nodeIdSet = new Set(selectedNodes.map((n) => n.id))
  const snapshotNodes: CanvasClipboardNodeSnapshot[] = selectedNodes
    .map((node) => ({
      id: node.id,
      type: node.type as 'text' | 'sticky',
      nodeName: node.nodeName,
      content: node.content as Exclude<typeof node.content, { type: 'node_box' } | { type: 'unknown' }>,
      x: node.x,
      y: node.y,
    }))

  // Edge scope: only edges fully inside the copied selection are considered.
  // External edges (either endpoint outside the selection) are ignored
  // regardless of relation type, so legacy canvases containing membership
  // edges elsewhere are not blocked from copying supported selections.
  const snapshotEdges: CanvasClipboardEdgeSnapshot[] = []
  for (const edge of allEdges) {
    if (edge.deletedAtMs !== null) continue
    if (!nodeIdSet.has(edge.sourceNodeId) || !nodeIdSet.has(edge.targetNodeId)) {
      continue
    }
    if (!isOrdinaryEdgeRelationType(edge.relationType)) {
      // Internal unsupported relation (membership or unknown): fail-closed.
      throw new CanvasClipboardUnsupportedEdgeError()
    }
    snapshotEdges.push({
      id: edge.id,
      sourceNodeId: edge.sourceNodeId,
      targetNodeId: edge.targetNodeId,
      relationType: edge.relationType,
      direction: edge.direction,
      lineStyle: edge.lineStyle,
    })
  }

  currentSnapshot = { sourceCanvasId: canvasId, nodes: snapshotNodes, edges: snapshotEdges }
  pasteOffsetSequence = 0
}

export function getClipboardSnapshot(): CanvasClipboardSnapshot | null {
  return currentSnapshot
}

export function isClipboardEmpty(): boolean {
  return currentSnapshot === null
}

export function requestPasteOffset(): number {
  const offset = (pasteOffsetSequence + 1) * PASTE_OFFSET_STEP
  pasteOffsetSequence += 1
  return offset
}
