import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

import { CanvasNodeHeader } from '@/components/canvas/CanvasNodeHeader'

export interface UnsupportedCanvasNodeData extends Record<string, unknown> {
  readonly originalType: string
  readonly nodeName: string
}

export type UnsupportedFlowNode = Node<UnsupportedCanvasNodeData, 'unsupportedCanvas'>

export const UnsupportedCanvasNode = memo(function UnsupportedCanvasNode({ id, data, selected }: NodeProps<UnsupportedFlowNode>) {
  return (
    <div className={`group relative w-64 rounded-xl border bg-surface p-4 shadow-sm ${selected ? 'border-primary ring-2 ring-primary/10' : 'border-dashed border-border'}`}>
      <Handle aria-label="连接到此节点" position={Position.Left} type="target" />
      <CanvasNodeHeader nodeId={id} nodeName={data.nodeName} typeLabel="UNKNOWN" badgeClassName="bg-surface-secondary text-foreground-tertiary" />
      <p className="px-3 pb-3 pt-2 text-xs text-foreground-secondary">不支持的节点类型：<span className="text-foreground-tertiary">{data.originalType}</span></p>
      <Handle aria-label="从此节点创建连线" position={Position.Right} type="source" />
    </div>
  )
})
