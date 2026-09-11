import {
  isCanvasMembershipRelationType,
  isCanvasOrdinaryEdgeRelationType,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeBoxNode,
  type CanvasStickyNode,
  type CanvasTextNode,
  type RegisteredCanvasNodeContent,
  type RegisteredCanvasNodeType,
} from '@/canvas/model'

const PASTE_OFFSET_STEP = 32

/**
 * Application-local in-memory Canvas clipboard.
 *
 * Snapshot captures the data at copy time; subsequent mutations to source
 * nodes do not affect what Ctrl+V produces.
 *
 * Supported node types: text, sticky, node_box. Unknown nodes are
 * fail-closed. Ordinary edges (default/hierarchy/peer) and membership edges
 * (ordered_box_member/unordered_box_member) are kept in separate sections.
 * External edges (either endpoint outside the selection) are ignored.
 * Internal unknown relations and non-canonical memberships are fail-closed.
 * The existing snapshot is preserved on every failed copy.
 *
 * Paste offset increments by PASTE_OFFSET_STEP per consecutive paste.
 * A new Ctrl+C resets the sequence to 0.
 */

export interface CanvasClipboardNodeSnapshot {
  readonly id: string
  readonly type: RegisteredCanvasNodeType
  readonly nodeName: string
  readonly content: RegisteredCanvasNodeContent
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

export interface CanvasClipboardMembershipSnapshot {
  readonly id: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: 'ordered_box_member' | 'unordered_box_member'
  readonly membershipPosition: number
}

export interface CanvasClipboardSnapshot {
  readonly sourceCanvasId: string
  readonly nodes: readonly CanvasClipboardNodeSnapshot[]
  readonly edges: readonly CanvasClipboardEdgeSnapshot[]
  readonly memberships: readonly CanvasClipboardMembershipSnapshot[]
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

type SupportedClipboardNode = CanvasTextNode | CanvasStickyNode | CanvasNodeBoxNode

function isSupportedNodeType(node: CanvasNode): node is SupportedClipboardNode {
  return node.type === 'text' || node.type === 'sticky' || node.type === 'node_box'
}

/**
 * Membership presentation is canonical at the schema level: direction is
 * always forward, line style is always solid, and membership_position is a
 * non-negative integer. A copy must never normalize a non-canonical row.
 */
function isCanonicalMembership(
  edge: CanvasEdge,
): edge is CanvasEdge & { readonly membershipPosition: number } {
  return (
    edge.direction === 'forward' &&
    edge.lineStyle === 'solid' &&
    typeof edge.membershipPosition === 'number' &&
    Number.isSafeInteger(edge.membershipPosition) &&
    edge.membershipPosition >= 0
  )
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

  const supportedNodes: SupportedClipboardNode[] = []
  for (const node of selectedNodes) {
    if (!isSupportedNodeType(node)) {
      // Unknown node: fail-closed, preserve existing snapshot.
      throw new CanvasClipboardUnsupportedNodeError()
    }
    supportedNodes.push(node)
  }

  const nodeIdSet = new Set(supportedNodes.map((n) => n.id))
  const nodeById = new Map<string, SupportedClipboardNode>(
    supportedNodes.map((node) => [node.id, node]),
  )
  const snapshotNodes: CanvasClipboardNodeSnapshot[] = supportedNodes.map((node) => ({
    id: node.id,
    type: node.type,
    nodeName: node.nodeName,
    content: node.content,
    x: node.x,
    y: node.y,
  }))

  // Edge scope: only edges fully inside the copied selection are considered.
  // External edges (either endpoint outside the selection) are ignored
  // regardless of relation type, so canvases containing membership edges
  // elsewhere are not blocked from copying supported selections.
  const snapshotEdges: CanvasClipboardEdgeSnapshot[] = []
  const snapshotMemberships: CanvasClipboardMembershipSnapshot[] = []
  const membershipPairs = new Set<string>()
  const membershipPositionKeys = new Set<string>()

  for (const edge of allEdges) {
    if (edge.deletedAtMs !== null) continue
    if (!nodeIdSet.has(edge.sourceNodeId) || !nodeIdSet.has(edge.targetNodeId)) {
      continue
    }

    if (isCanvasOrdinaryEdgeRelationType(edge.relationType)) {
      snapshotEdges.push({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        relationType: edge.relationType,
        direction: edge.direction,
        lineStyle: edge.lineStyle,
      })
      continue
    }

    if (isCanvasMembershipRelationType(edge.relationType)) {
      const source = nodeById.get(edge.sourceNodeId)
      const target = nodeById.get(edge.targetNodeId)
      // Membership must run member -> Node Box; Node Box nesting is rejected.
      if (
        source === undefined ||
        target === undefined ||
        source.type === 'node_box' ||
        target.type !== 'node_box' ||
        !isCanonicalMembership(edge)
      ) {
        throw new CanvasClipboardUnsupportedEdgeError()
      }
      const pairKey = `${edge.sourceNodeId} ${edge.targetNodeId}`
      const positionKey = `${edge.targetNodeId} ${edge.relationType} ${edge.membershipPosition}`
      if (membershipPairs.has(pairKey) || membershipPositionKeys.has(positionKey)) {
        throw new CanvasClipboardUnsupportedEdgeError()
      }
      membershipPairs.add(pairKey)
      membershipPositionKeys.add(positionKey)
      snapshotMemberships.push({
        id: edge.id,
        sourceNodeId: edge.sourceNodeId,
        targetNodeId: edge.targetNodeId,
        relationType: edge.relationType,
        membershipPosition: edge.membershipPosition,
      })
      continue
    }

    // Internal unknown relation: fail-closed.
    throw new CanvasClipboardUnsupportedEdgeError()
  }

  currentSnapshot = {
    sourceCanvasId: canvasId,
    nodes: snapshotNodes,
    edges: snapshotEdges,
    memberships: snapshotMemberships,
  }
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
