import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

export interface UnsupportedCanvasNodeData extends Record<string, unknown> {
  readonly originalType: string
}

export type UnsupportedFlowNode = Node<UnsupportedCanvasNodeData, 'unsupportedCanvas'>

export const UnsupportedCanvasNode = memo(function UnsupportedCanvasNode({ data, selected }: NodeProps<UnsupportedFlowNode>) {
  return (
    <div className={`group relative w-64 rounded-xl border bg-surface p-4 shadow-sm ${selected ? 'border-primary ring-2 ring-primary/10' : 'border-dashed border-border'}`}>
      <Handle aria-label="连接到此节点" position={Position.Left} type="target" />
      <p className="text-xs font-semibold text-foreground-secondary">不支持的节点类型</p>
      <p className="mt-1 truncate text-[11px] text-foreground-tertiary">{data.originalType}</p>
      <Handle aria-label="从此节点创建连线" position={Position.Right} type="source" />
    </div>
  )
})
