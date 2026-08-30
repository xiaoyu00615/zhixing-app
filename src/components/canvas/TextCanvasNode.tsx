import { memo, useEffect, useState } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

import { CanvasNodeHeader } from '@/components/canvas/CanvasNodeHeader'

export interface TextCanvasNodeData extends Record<string, unknown> {
  readonly text: string
  readonly onCommit: (id: string, text: string) => void
  readonly nodeName: string
  readonly renameRequest: number
  readonly onRename: (id: string, nodeName: string) => Promise<boolean>
}

export type TextFlowNode = Node<TextCanvasNodeData, 'textCanvas'>

export const TextCanvasNode = memo(function TextCanvasNode({ id, data, selected }: NodeProps<TextFlowNode>) {
  const [text, setText] = useState(data.text)
  useEffect(() => setText(data.text), [data.text])
  return (
    <div className={`group relative w-64 rounded-xl border bg-surface p-1.5 shadow-md transition ${selected ? 'border-primary ring-2 ring-primary/10' : 'border-border hover:border-primary/30'}`}>
      <Handle
        aria-label="连接到此节点"
        className={`!h-3 !w-3 !border-2 !border-surface !bg-primary transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`}
        position={Position.Left}
        type="target"
      />
      <CanvasNodeHeader nodeId={id} nodeName={data.nodeName} typeLabel="TEXT" renameRequest={data.renameRequest} badgeClassName="bg-surface-secondary text-foreground-tertiary" onRename={data.onRename} />
      <textarea aria-label="文字节点内容" className="nodrag nopan min-h-28 w-full resize-none rounded-lg bg-transparent px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground-tertiary focus:bg-surface-secondary/40" placeholder="写下一个想法…" value={text} onChange={(event) => setText(event.target.value)} onBlur={() => { if (text !== data.text) data.onCommit(id, text) }} />
      <Handle
        aria-label="从此节点创建连线"
        className={`!h-3 !w-3 !border-2 !border-surface !bg-primary transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`}
        position={Position.Right}
        type="source"
      />
    </div>
  )
})
