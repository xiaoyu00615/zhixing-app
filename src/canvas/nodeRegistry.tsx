import type { Node, NodeTypes } from '@xyflow/react'

import { StickyCanvasNode } from '@/components/canvas/StickyCanvasNode'
import { TextCanvasNode } from '@/components/canvas/TextCanvasNode'
import { NodeBoxCanvasNode } from '@/components/canvas/NodeBoxCanvasNode'
import { UnsupportedCanvasNode } from '@/components/canvas/UnsupportedCanvasNode'
import { isCanvasMembershipRelationType, type CanvasEdge, type CanvasNode, type RegisteredCanvasNodeContent, type RegisteredCanvasNodeType } from '@/canvas/model'

export interface CanvasNodeRegistryEntry {
  readonly type: RegisteredCanvasNodeType
  readonly displayName: string
  readonly flowNodeType: string
  readonly renderer: NonNullable<NodeTypes[string]>
  parseData(content: RegisteredCanvasNodeContent): Record<string, unknown>
  createDefaultData(): RegisteredCanvasNodeContent
}

export function createCanvasNodeRegistry(entries: readonly CanvasNodeRegistryEntry[]) {
  const byType = new Map<RegisteredCanvasNodeType, CanvasNodeRegistryEntry>()
  const nodeTypes: NodeTypes = { unsupportedCanvas: UnsupportedCanvasNode }
  for (const entry of entries) {
    if (byType.has(entry.type) || nodeTypes[entry.flowNodeType] !== undefined) {
      throw new Error(`Duplicate canvas node registry entry: ${entry.type}`)
    }
    byType.set(entry.type, entry)
    nodeTypes[entry.flowNodeType] = entry.renderer
  }
  return { byType, nodeTypes }
}

export const canvasNodeRegistry = createCanvasNodeRegistry([
  { type: 'text', displayName: '文字节点', flowNodeType: 'textCanvas', renderer: TextCanvasNode, parseData: (content) => ({ text: content.type === 'text' ? content.text : '' }), createDefaultData: () => ({ type: 'text', text: '' }) },
  { type: 'sticky', displayName: '便签节点', flowNodeType: 'stickyCanvas', renderer: StickyCanvasNode, parseData: (content) => ({ text: content.type === 'sticky' ? content.text : '' }), createDefaultData: () => ({ type: 'sticky', text: '' }) },
  { type: 'node_box', displayName: '节点盒', flowNodeType: 'nodeBoxCanvas', renderer: NodeBoxCanvasNode, parseData: () => ({ orderedMembers: [], unorderedMembers: [] }), createDefaultData: () => ({ type: 'node_box' }) },
])

export type CanvasFlowNode = Node<Record<string, unknown>, string>

export function toCanvasFlowNode(
  node: CanvasNode,
  onCommit: (id: string, type: RegisteredCanvasNodeType, text: string) => void,
  onRename: (id: string, nodeName: string) => Promise<boolean>,
): CanvasFlowNode {
  if (node.type === 'unknown') {
    return { id: node.id, type: 'unsupportedCanvas', position: { x: node.x, y: node.y }, data: { originalType: node.originalType, nodeName: node.nodeName } }
  }
  const entry = canvasNodeRegistry.byType.get(node.type)!
  const data = entry.parseData(node.content)
  return { id: node.id, type: entry.flowNodeType, position: { x: node.x, y: node.y }, data: { ...data, nodeName: node.nodeName, renameRequest: 0, onRename, onCommit: (id: string, text: string) => onCommit(id, node.type, text), membershipReorderBusy: false, onRemoveMembership: () => undefined, onReorderMemberships: () => undefined } }
}

export function withCanvasNodeRuntimeData(
  nodes: readonly CanvasFlowNode[],
  edges: readonly CanvasEdge[],
  onRemoveMembership: (edgeId: string) => void,
  onReorderMemberships: (
    nodeBoxId: string,
    orderedMembershipEdgeIds: readonly string[],
    unorderedMembershipEdgeIds: readonly string[],
  ) => void,
  membershipReorderBusy: boolean,
): CanvasFlowNode[] {
  const nodeNames = new Map(
    nodes.map((node) => [
      node.id,
      typeof node.data.nodeName === 'string' ? node.data.nodeName : '',
    ]),
  )
  return nodes.map((node) => {
    const entry = [...canvasNodeRegistry.byType.values()].find(
      (candidate) => candidate.flowNodeType === node.type,
    )
    if (entry?.type !== 'node_box') return node
    const memberships = edges
      .filter((edge) =>
        edge.targetNodeId === node.id &&
        isCanvasMembershipRelationType(edge.relationType),
      )
      .sort((left, right) =>
        (left.membershipPosition ?? 0) - (right.membershipPosition ?? 0) ||
        left.id.localeCompare(right.id),
      )
    const toView = (edge: CanvasEdge) => ({
      edgeId: edge.id,
      nodeName: nodeNames.get(edge.sourceNodeId) ?? '',
    })
    return {
      ...node,
      data: {
        ...node.data,
        orderedMembers: memberships
          .filter((edge) => edge.relationType === 'ordered_box_member')
          .map(toView),
        unorderedMembers: memberships
          .filter((edge) => edge.relationType === 'unordered_box_member')
          .map(toView),
        membershipReorderBusy,
        onRemoveMembership,
        onReorderMemberships,
      },
    }
  })
}

export function orderedMembershipDisplayNumbers(
  edges: readonly CanvasEdge[],
): ReadonlyMap<string, number> {
  const byNodeBox = new Map<string, CanvasEdge[]>()
  for (const edge of edges) {
    if (edge.relationType !== 'ordered_box_member') continue
    const memberships = byNodeBox.get(edge.targetNodeId) ?? []
    memberships.push(edge)
    byNodeBox.set(edge.targetNodeId, memberships)
  }
  const numbers = new Map<string, number>()
  for (const memberships of byNodeBox.values()) {
    memberships
      .sort((left, right) =>
        (left.membershipPosition ?? 0) - (right.membershipPosition ?? 0) ||
        left.id.localeCompare(right.id),
      )
      .forEach((edge, index) => numbers.set(edge.id, index + 1))
  }
  return numbers
}
