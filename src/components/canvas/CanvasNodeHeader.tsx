import { useCallback, useEffect, useRef, useState } from 'react'

import { CANVAS_NODE_NAME_MAX_LENGTH } from '@/canvas/model'

export interface CanvasNodeHeaderProps {
  readonly nodeId: string
  readonly nodeName: string
  readonly typeLabel: string
  readonly renameRequest?: number
  readonly badgeClassName: string
  readonly placeholderClassName?: string
  readonly onRename?: (id: string, nodeName: string) => Promise<boolean>
}

export function CanvasNodeHeader({
  nodeId,
  nodeName,
  typeLabel,
  renameRequest = 0,
  badgeClassName,
  placeholderClassName = 'text-foreground-tertiary',
  onRename,
}: CanvasNodeHeaderProps) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(nodeName)
  const inputRef = useRef<HTMLInputElement>(null)
  const previousRequest = useRef(renameRequest)
  const cancelBlur = useRef(false)

  const beginEditing = useCallback(() => {
    if (onRename === undefined) return
    cancelBlur.current = false
    setDraft(nodeName)
    setEditing(true)
  }, [nodeName, onRename])

  useEffect(() => {
    if (renameRequest > previousRequest.current) beginEditing()
    previousRequest.current = renameRequest
  }, [beginEditing, renameRequest])
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])

  const commit = async () => {
    if (cancelBlur.current) {
      cancelBlur.current = false
      return
    }
    setEditing(false)
    if (onRename === undefined || draft === nodeName) return
    const saved = await onRename(nodeId, draft)
    if (!saved) setDraft(nodeName)
  }

  return (
    <div className="flex h-8 min-w-0 items-center gap-2 px-3">
      {editing ? (
        <input
          ref={inputRef}
          aria-label="节点名称"
          className="nodrag nopan min-w-0 flex-1 rounded border border-primary/35 bg-white/75 px-1.5 py-0.5 text-xs font-medium text-foreground outline-none focus:ring-2 focus:ring-primary/15"
          value={draft}
          onChange={(event) => {
            if (Array.from(event.target.value).length <= CANVAS_NODE_NAME_MAX_LENGTH) {
              setDraft(event.target.value)
            }
          }}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              event.currentTarget.blur()
            }
            if (event.key === 'Escape') {
              event.preventDefault()
              cancelBlur.current = true
              setDraft(nodeName)
              setEditing(false)
            }
          }}
          onPointerDown={(event) => event.stopPropagation()}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate text-xs font-medium ${nodeName === '' ? placeholderClassName : 'text-foreground'}`}
          title={nodeName === '' ? '未命名节点' : nodeName}
          onDoubleClick={(event) => {
            event.stopPropagation()
            beginEditing()
          }}
        >
          {nodeName === '' ? '未命名节点' : nodeName}
        </span>
      )}
      <span className={`shrink-0 rounded-full px-2 py-0.5 text-[9px] font-semibold tracking-wider ${badgeClassName}`}>
        {typeLabel}
      </span>
    </div>
  )
}
