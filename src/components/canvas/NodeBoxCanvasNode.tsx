import { memo, useState, type DragEvent } from 'react'
import { Handle, Position, type Node, type NodeProps } from '@xyflow/react'
import { GripVertical, X } from 'lucide-react'

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
  readonly membershipReorderBusy: boolean
  readonly onRemoveMembership: (edgeId: string) => void
  readonly onReorderMemberships: (
    nodeBoxId: string,
    orderedMembershipEdgeIds: readonly string[],
    unorderedMembershipEdgeIds: readonly string[],
  ) => void
}

export type NodeBoxFlowNode = Node<NodeBoxCanvasNodeData, 'nodeBoxCanvas'>

type NodeBoxSection = 'ordered' | 'unordered'

interface MembershipDragState {
  readonly edgeId: string
  readonly section: NodeBoxSection
}

interface MembershipDropTarget {
  readonly section: NodeBoxSection
  readonly index: number
}

function sameOrder(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}

function MemberList({
  members,
  ordered,
  busy,
  dragState,
  dropTarget,
  onDragStart,
  onDragEnd,
  onDrop,
  onDropTargetChange,
  onRemove,
}: {
  readonly members: readonly NodeBoxMemberView[]
  readonly ordered: boolean
  readonly busy: boolean
  readonly dragState: MembershipDragState | null
  readonly dropTarget: MembershipDropTarget | null
  readonly onDragStart: (edgeId: string, section: NodeBoxSection, event: DragEvent) => void
  readonly onDragEnd: () => void
  readonly onDrop: (section: NodeBoxSection, index: number) => void
  readonly onDropTargetChange: (target: MembershipDropTarget) => void
  readonly onRemove: (edgeId: string) => void
}) {
  const section: NodeBoxSection = ordered ? 'ordered' : 'unordered'
  if (members.length === 0) {
    const active = dropTarget?.section === section && dropTarget.index === 0
    return (
      <div
        aria-label={`${ordered ? '有序' : '无序'}成员空白放置区`}
        className={`rounded-md border px-2 py-2 text-[11px] transition ${active ? 'border-primary bg-primary/5 text-primary' : 'border-transparent text-foreground-tertiary'}`}
        onDragOver={(event) => {
          if (dragState === null || busy) return
          event.preventDefault()
          event.stopPropagation()
          onDropTargetChange({ section, index: 0 })
        }}
        onDrop={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onDrop(section, 0)
        }}
      >
        {active ? '放到这里' : '暂无成员'}
      </div>
    )
  }
  return (
    <ul className="space-y-1">
      {members.map((member, index) => {
        const before = dropTarget?.section === section && dropTarget.index === index
        const after = dropTarget?.section === section && dropTarget.index === index + 1
        return (
        <li
          aria-label={`拖动成员 ${member.nodeName || '未命名节点'}`}
          className={`group/member nodrag nopan flex min-w-0 items-center gap-1 rounded-md border-y-2 bg-surface/75 px-1.5 py-1 text-xs transition ${before ? 'border-t-primary' : 'border-t-transparent'} ${after ? 'border-b-primary' : 'border-b-transparent'} ${dragState?.edgeId === member.edgeId ? 'opacity-45' : ''}`}
          draggable={!busy}
          key={member.edgeId}
          onDragEnd={onDragEnd}
          onDragOver={(event) => {
            if (dragState === null || busy) return
            event.preventDefault()
            event.stopPropagation()
            const bounds = event.currentTarget.getBoundingClientRect()
            onDropTargetChange({
              section,
              index: event.clientY < bounds.top + bounds.height / 2 ? index : index + 1,
            })
          }}
          onDragStart={(event) => onDragStart(member.edgeId, section, event)}
          onDrop={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const bounds = event.currentTarget.getBoundingClientRect()
            onDrop(
              section,
              event.clientY < bounds.top + bounds.height / 2 ? index : index + 1,
            )
          }}
        >
          <GripVertical className="size-3.5 shrink-0 cursor-grab text-foreground-tertiary active:cursor-grabbing" aria-hidden="true" />
          <span className="w-4 shrink-0 text-center text-[10px] text-foreground-tertiary">
            {ordered ? index + 1 : '•'}
          </span>
          <span className="min-w-0 flex-1 truncate" title={member.nodeName || '未命名节点'}>
            {member.nodeName || '未命名节点'}
          </span>
          <button
            aria-label={`移除成员 ${member.nodeName || '未命名节点'}`}
            className="nodrag nopan rounded p-0.5 text-foreground-tertiary opacity-0 transition hover:bg-danger/10 hover:text-danger focus-visible:opacity-100 group-hover/member:opacity-100"
            disabled={busy}
            onClick={(event) => {
              event.stopPropagation()
              onRemove(member.edgeId)
            }}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        </li>
      )})}
    </ul>
  )
}

export const NodeBoxCanvasNode = memo(function NodeBoxCanvasNode({
  id,
  data,
  selected,
}: NodeProps<NodeBoxFlowNode>) {
  const [dragState, setDragState] = useState<MembershipDragState | null>(null)
  const [dropTarget, setDropTarget] = useState<MembershipDropTarget | null>(null)

  function finishDrop(targetSection: NodeBoxSection, targetIndex: number): void {
    if (dragState === null || data.membershipReorderBusy) return
    const previousOrdered = data.orderedMembers.map((member) => member.edgeId)
    const previousUnordered = data.unorderedMembers.map((member) => member.edgeId)
    const source = dragState.section === 'ordered' ? previousOrdered : previousUnordered
    const sourceIndex = source.indexOf(dragState.edgeId)
    if (sourceIndex < 0) {
      setDragState(null)
      setDropTarget(null)
      return
    }
    const ordered = previousOrdered.filter((edgeId) => edgeId !== dragState.edgeId)
    const unordered = previousUnordered.filter((edgeId) => edgeId !== dragState.edgeId)
    const target = targetSection === 'ordered' ? ordered : unordered
    const adjustedIndex = dragState.section === targetSection && sourceIndex < targetIndex
      ? targetIndex - 1
      : targetIndex
    target.splice(Math.max(0, Math.min(adjustedIndex, target.length)), 0, dragState.edgeId)
    setDragState(null)
    setDropTarget(null)
    if (
      sameOrder(previousOrdered, ordered) &&
      sameOrder(previousUnordered, unordered)
    ) {
      return
    }
    data.onReorderMemberships(id, ordered, unordered)
  }

  const memberListProps = {
    busy: data.membershipReorderBusy,
    dragState,
    dropTarget,
    onDragEnd: () => {
      setDragState(null)
      setDropTarget(null)
    },
    onDragStart: (
      edgeId: string,
      section: NodeBoxSection,
      event: DragEvent,
    ) => {
      if (data.membershipReorderBusy) {
        event.preventDefault()
        return
      }
      event.stopPropagation()
      event.dataTransfer.effectAllowed = 'move'
      event.dataTransfer.setData('text/plain', edgeId)
      setDragState({ edgeId, section })
      setDropTarget({ section, index: section === 'ordered'
        ? data.orderedMembers.findIndex((member) => member.edgeId === edgeId)
        : data.unorderedMembers.findIndex((member) => member.edgeId === edgeId) })
    },
    onDrop: finishDrop,
    onDropTargetChange: setDropTarget,
    onRemove: data.onRemoveMembership,
  }
  return (
    <div className={`group relative w-72 rounded-xl border bg-[#f5f1e8] p-1.5 shadow-md transition ${selected ? 'border-primary ring-2 ring-primary/10' : 'border-[#d8cfbc] hover:border-primary/30'}`}>
      <Handle aria-label="连接到此节点盒" className={`!h-3 !w-3 !border-2 !border-[#f5f1e8] !bg-[#8c7a59] transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`} position={Position.Left} type="target" />
      <CanvasNodeHeader nodeId={id} nodeName={data.nodeName} typeLabel="BOX" renameRequest={data.renameRequest} badgeClassName="bg-[#e7dfcf] text-[#695a40]" onRename={data.onRename} />
      <div className="nodrag nopan grid gap-2 px-2 pb-2">
        <section>
          <h4 className="mb-1 text-[10px] font-semibold tracking-wide text-foreground-secondary">有序成员</h4>
          <MemberList members={data.orderedMembers} ordered {...memberListProps} />
        </section>
        <section className="border-t border-[#ded6c6] pt-2">
          <h4 className="mb-1 text-[10px] font-semibold tracking-wide text-foreground-secondary">无序成员</h4>
          <MemberList members={data.unorderedMembers} ordered={false} {...memberListProps} />
        </section>
      </div>
      <Handle aria-label="从此节点盒创建连线" className={`!h-3 !w-3 !border-2 !border-[#f5f1e8] !bg-[#8c7a59] transition-opacity ${selected ? '!opacity-100' : '!opacity-35 group-hover:!opacity-100'}`} position={Position.Right} type="source" />
    </div>
  )
})
