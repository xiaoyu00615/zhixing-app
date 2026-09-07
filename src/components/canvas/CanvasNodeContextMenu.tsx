import { LockKeyhole, Save, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import { CANVAS_NODE_NAME_MAX_LENGTH } from '@/canvas/model'
import type { CanvasNodeCommand } from '@/canvas/commandRegistry'
import type { CanvasNodeContextMenuModel } from '@/canvas/contextMenuRegistry'

interface CanvasNodeContextMenuProps {
  readonly model: CanvasNodeContextMenuModel
  readonly x: number
  readonly y: number
  readonly busy: boolean
  readonly onCommand: (command: CanvasNodeCommand) => Promise<boolean>
  readonly onClose: () => void
}

const VIEWPORT_MARGIN = 8

export function CanvasNodeContextMenu({
  model,
  x,
  y,
  busy,
  onCommand,
  onClose,
}: CanvasNodeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })
  const [nodeName, setNodeName] = useState(model.nodeName)
  const canRename = model.commands.includes('rename_node')
  const canDelete = model.commands.includes('delete_node')

  useLayoutEffect(() => {
    const menu = menuRef.current
    if (menu === null) return
    const bounds = menu.getBoundingClientRect()
    setPosition({
      x: Math.max(
        VIEWPORT_MARGIN,
        Math.min(x, window.innerWidth - bounds.width - VIEWPORT_MARGIN),
      ),
      y: Math.max(
        VIEWPORT_MARGIN,
        Math.min(y, window.innerHeight - bounds.height - VIEWPORT_MARGIN),
      ),
    })
    menu.focus()
  }, [x, y])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose()
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [onClose])

  const rename = async () => {
    const succeeded = await onCommand({
      id: 'rename_node',
      nodeId: model.nodeId,
      nodeName,
    })
    if (succeeded) onClose()
  }

  return (
    <div
      aria-label={`节点菜单：${model.title}`}
      className="fixed z-50 w-60 rounded-xl border border-border/80 bg-surface/98 p-1.5 shadow-xl"
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === 'Escape') {
          event.preventDefault()
          onClose()
        }
      }}
      onPointerDown={(event) => event.stopPropagation()}
      ref={menuRef}
      role="menu"
      style={{ left: position.x, top: position.y }}
      tabIndex={-1}
    >
      <div className="px-2.5 py-2">
        <p className="text-xs font-semibold text-foreground">{model.title}</p>
        {model.readOnly && (
          <p className="mt-1 flex items-center gap-1.5 text-[11px] text-foreground-tertiary">
            <LockKeyhole className="size-3" />
            只读
          </p>
        )}
      </div>
      {canRename && (
        <form
          className="border-t border-border/70 px-2 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void rename()
          }}
        >
          <label
            className="mb-1 block text-[10px] font-medium text-foreground-tertiary"
            htmlFor={`node-context-name-${model.nodeId}`}
          >
            节点名称
          </label>
          <div className="flex gap-1.5">
            <input
              aria-label="节点名称"
              className="h-8 min-w-0 flex-1 rounded-lg border border-border bg-surface px-2 text-xs outline-none focus:border-primary/40 focus:ring-2 focus:ring-primary/10"
              disabled={busy}
              id={`node-context-name-${model.nodeId}`}
              maxLength={CANVAS_NODE_NAME_MAX_LENGTH}
              onChange={(event) => setNodeName(event.target.value)}
              value={nodeName}
            />
            <button
              aria-label="保存节点名称"
              className="flex size-8 shrink-0 items-center justify-center rounded-lg text-foreground-secondary transition hover:bg-surface-secondary hover:text-foreground disabled:opacity-50"
              disabled={busy}
              type="submit"
            >
              <Save className="size-3.5" />
            </button>
          </div>
        </form>
      )}
      {canDelete && (
        <div className="border-t border-border/70 pt-1">
          <button
            aria-label="删除节点"
            className="flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs text-danger transition hover:bg-danger/8 disabled:cursor-not-allowed disabled:opacity-50"
            disabled={busy}
            onClick={() => {
              void onCommand({
                id: 'delete_node',
                nodeId: model.nodeId,
              }).then((succeeded) => {
                if (succeeded) onClose()
              })
            }}
            role="menuitem"
            type="button"
          >
            <Trash2 className="size-3.5" />
            删除节点
          </button>
        </div>
      )}
    </div>
  )
}
