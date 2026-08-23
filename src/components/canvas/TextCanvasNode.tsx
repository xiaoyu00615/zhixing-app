import { memo, useEffect, useState } from 'react'
import type { Node, NodeProps } from '@xyflow/react'

export interface TextCanvasNodeData extends Record<string, unknown> {
  readonly text: string
  readonly onCommit: (id: string, text: string) => void
}

export type TextFlowNode = Node<TextCanvasNodeData, 'textCanvas'>

export const TextCanvasNode = memo(function TextCanvasNode({ id, data, selected }: NodeProps<TextFlowNode>) {
  const [text, setText] = useState(data.text)
  useEffect(() => setText(data.text), [data.text])
  return (
    <div className={`w-64 rounded-xl border bg-surface p-1.5 shadow-md transition ${selected ? 'border-primary ring-2 ring-primary/10' : 'border-border hover:border-primary/30'}`}>
      <textarea aria-label="文字节点内容" className="nodrag nopan min-h-28 w-full resize-none rounded-lg bg-transparent px-3 py-2.5 text-sm leading-6 text-foreground outline-none placeholder:text-foreground-tertiary focus:bg-surface-secondary/40" placeholder="写下一个想法…" value={text} onChange={(event) => setText(event.target.value)} onBlur={() => { if (text !== data.text) data.onCommit(id, text) }} />
      <div className="px-3 pb-1 text-[10px] font-medium tracking-wide text-foreground-tertiary">文本节点</div>
    </div>
  )
})
