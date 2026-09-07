import { Check, LockKeyhole, Trash2 } from 'lucide-react'
import { useEffect, useLayoutEffect, useRef, useState } from 'react'

import type { CanvasEdgeCommand } from '@/canvas/commandRegistry'
import type { CanvasContextMenuModel } from '@/canvas/contextMenuRegistry'

interface CanvasEdgeContextMenuProps {
  readonly model: CanvasContextMenuModel
  readonly x: number
  readonly y: number
  readonly busy: boolean
  readonly onCommand: (command: CanvasEdgeCommand) => Promise<boolean>
  readonly onClose: () => void
}

const VIEWPORT_MARGIN = 8

export function CanvasEdgeContextMenu({
  model,
  x,
  y,
  busy,
  onCommand,
  onClose,
}: CanvasEdgeContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ x, y })

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

  return (
    <div
      aria-label={`关系菜单：${model.title}`}
      className="fixed z-50 w-52 rounded-xl border border-border/80 bg-surface/98 p-1.5 shadow-xl"
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
      {model.groups.map((group, groupIndex) => (
        <div
          className={groupIndex === 0 ? '' : 'mt-1 border-t border-border/70 pt-1'}
          key={`${group.label ?? 'actions'}-${groupIndex}`}
        >
          {group.label !== null && (
            <p className="px-2.5 pb-1 pt-1.5 text-[10px] font-medium text-foreground-tertiary">
              {group.label}
            </p>
          )}
          {group.items.map((item) => {
            const checkable = item.command.id === 'update_edge_relation_type' ||
              item.command.id === 'update_edge_direction' ||
              item.command.id === 'update_edge_line_style'
            return (
              <button
                aria-checked={checkable ? item.checked : undefined}
                aria-label={item.label}
                className={`flex h-8 w-full items-center gap-2 rounded-lg px-2.5 text-left text-xs transition disabled:cursor-not-allowed disabled:opacity-50 ${item.destructive === true ? 'text-danger hover:bg-danger/8' : 'text-foreground-secondary hover:bg-surface-secondary hover:text-foreground'}`}
                disabled={busy || !item.enabled}
                key={item.id}
                onClick={() => {
                  void onCommand(item.command).then((succeeded) => {
                    if (succeeded) onClose()
                  })
                }}
                role={checkable ? 'menuitemradio' : 'menuitem'}
                type="button"
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {item.checked && <Check className="size-3.5 text-primary" />}
                  {item.destructive === true && <Trash2 className="size-3.5" />}
                </span>
                {item.label}
              </button>
            )
          })}
        </div>
      ))}
    </div>
  )
}
