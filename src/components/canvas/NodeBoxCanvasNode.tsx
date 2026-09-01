import { memo } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { X } from 'lucide-react'

import { CanvasNodeHeader } from '@/components/canvas/CanvasNodeHeader'

export interface NodeBoxMemberView {
  readonly edgeId: string
  readonly nodeName: string
}

export interface NodeBoxCanvasNodeData extends Record<string, unknown> {
  readonly nodeName: string
  readonly renameRequest: number
  readonly onRename: (id: string, nodeName: string) => Promise<boolean>
  readonly orderedMembers: readonly NodeBoxMemberView[]
  readonly unorderedMembers: readonly NodeBoxMemberView[]
  readonly onRemoveMembership: (edgeId: string) => void
}

export type NodeBoxFlowNode = Node<NodeBoxCanvasNodeData, 'nodeBoxCanvas'>

function MemberList({
  members,
  ordered,
  onRemove,
}: {
  readonly members: readonly NodeBoxMemberView[]
  readonly ordered: boolean
  readonly onRemove: (edgeId: string) => void
}) {
  if (members.length === 0) {
    return <p className="py-2 text-[11px] text-foreground-tertiary">暂无成员</p>
  }
  return (
    <ul className="space-y-1">
      {members.map((member, index) => (
        <li className="group/member flex min-w-0 items-center gap-2 rounded-md bg-surface/75 px-2 py-1.5 text-xs" key={member.edgeId}>
          <span className="w-4 shrink-0 text-center text-[10px] text-foreground-tertiary">
            {ordered ? index + 1 : '•'}
          </span>
          <span className="min-w-0 flex-1 truncate" title={member.nodeName || '未命名节点'}>
            {member.nodeName || '未命名节点'}
          </span>
          <button
            aria-label={`移除成员 ${member.nodeName || '未命名节点'}`}
            className="nodrag nopan rounded p-0.5 text-foreground-tertiary opacity-0 transition hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover/member:opacity-100"
            onClick={(event) => {
              event.stopPropagation()
              onRemove(member.edgeId)
            }}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </li>
      ))}
    </ul>
  )
}

export const NodeBoxCanvasNode = memo(function NodeBoxCanvasNode({
  id,
  data,
  selected,
}: NodeProps<NodeBoxFlowNode>) {
  return (
    <div className={`group relative w-72 rounded-xl border bg-[#f5f1e8] p-1.5 shadow-md transition ${selected ? 'border-primary ring-2 ring-primary/10' : 'border-[#d8cfbc] hover:border-primary/30'}`}>
      <Handle aria-label="连接到此节点盒" className={`!h-3 !w-3 !border-2 !border-[#f5f1e8] !bg-[#8c7a59] transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`} position={Position.Left} type="target" />
      <CanvasNodeHeader nodeId={id} nodeName={data.nodeName} typeLabel="BOX" renameRequest={data.renameRequest} badgeClassName="bg-[#e7dfcf] text-[#695a40]" onRename={data.onRename} />
      <div className="nodrag nopan grid gap-2 px-2 pb-2">
        <section>
          <h4 className="mb-1 text-[10px] font-semibold tracking-wide text-foreground-secondary">有序成员</h4>
          <MemberList members={data.orderedMembers} ordered onRemove={data.onRemoveMembership} />
        </section>
        <section className="border-t border-[#ded6c6] pt-2">
          <h4 className="mb-1 text-[10px] font-semibold tracking-wide text-foreground-secondary">无序成员</h4>
          <MemberList members={data.unorderedMembers} ordered={false} onRemove={data.onRemoveMembership} />
        </section>
      </div>
      <Handle aria-label="从此节点盒创建连线" className={`!h-3 !w-3 !border-2 !border-[#f5f1e8] !bg-[#8c7a59] transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`} position={Position.Right} type="source" />
    </div>
  )
})
