import { memo, useEffect, useState } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'

export interface StickyCanvasNodeData extends Record<string, unknown> {
  readonly text: string
  readonly onCommit: (id: string, text: string) => void
}

export type StickyFlowNode = Node<StickyCanvasNodeData, 'stickyCanvas'>

export const StickyCanvasNode = memo(function StickyCanvasNode({ id, data, selected }: NodeProps<StickyFlowNode>) {
  const [text, setText] = useState(data.text)
  useEffect(() => setText(data.text), [data.text])
  return (
    <div className={`group relative w-64 rounded-xl border bg-[#fff8d9] p-1.5 shadow-md transition ${selected ? 'border-amber-500 ring-2 ring-amber-400/20' : 'border-amber-200 hover:border-amber-400'}`}>
      <Handle aria-label="连接到此节点" className={`!h-3 !w-3 !border-2 !border-[#fff8d9] !bg-amber-500 transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`} position={Position.Left} type="target" />
      <div className="flex h-7 items-center px-3"><span className="rounded-full bg-amber-100 px-2 py-0.5 text-[9px] font-semibold tracking-wider text-amber-800">STICKY</span><span className="min-w-0 flex-1" aria-hidden="true" /></div>
      <textarea aria-label="便签节点内容" className="nodrag nopan min-h-28 w-full resize-none rounded-lg bg-transparent px-3 py-2.5 text-sm leading-6 text-amber-950 outline-none placeholder:text-amber-700/45 focus:bg-white/35" placeholder="记下一条便签…" value={text} onChange={(event) => setText(event.target.value)} onBlur={() => { if (text !== data.text) data.onCommit(id, text) }} />
      <Handle aria-label="从此节点创建连线" className={`!h-3 !w-3 !border-2 !border-[#fff8d9] !bg-amber-500 transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`} position={Position.Right} type="source" />
    </div>
  )
})
