import type { Node, NodeTypes } from '@xyflow/react'

import { StickyCanvasNode } from '@/components/canvas/StickyCanvasNode'
import { TextCanvasNode } from '@/components/canvas/TextCanvasNode'
import { UnsupportedCanvasNode } from '@/components/canvas/UnsupportedCanvasNode'
import type { CanvasNode, RegisteredCanvasNodeContent, RegisteredCanvasNodeType } from '@/canvas/model'

export interface CanvasNodeRegistryEntry {
  readonly type: RegisteredCanvasNodeType
  readonly displayName: string
  readonly flowNodeType: string
  readonly renderer: NonNullable<NodeTypes[string]>
  parseData(content: RegisteredCanvasNodeContent): { readonly text: string }
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
  return { id: node.id, type: entry.flowNodeType, position: { x: node.x, y: node.y }, data: { ...data, nodeName: node.nodeName, renameRequest: 0, onRename, onCommit: (id: string, text: string) => onCommit(id, node.type, text) } }
}
