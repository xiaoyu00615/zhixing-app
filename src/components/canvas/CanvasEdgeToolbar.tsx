import { ArrowLeftRight, ArrowRight, Minus, Trash2 } from 'lucide-react'

import type {
  CanvasEdge,
  CanvasEdgeDirection,
  CanvasEdgeLineStyle,
} from '@/canvas/model'

interface CanvasEdgeToolbarProps {
  readonly edge: CanvasEdge
  readonly busy: boolean
  readonly onDirectionChange: (direction: CanvasEdgeDirection) => void
  readonly onLineStyleChange: (lineStyle: CanvasEdgeLineStyle) => void
  readonly onDelete: () => void
}

const DIRECTIONS: readonly {
  value: CanvasEdgeDirection
  label: string
  icon: typeof ArrowRight
}[] = [
  { value: 'forward', label: '单向', icon: ArrowRight },
  { value: 'bidirectional', label: '双向', icon: ArrowLeftRight },
  { value: 'none', label: '无方向', icon: Minus },
]

const LINE_STYLES: readonly {
  value: CanvasEdgeLineStyle
  label: string
  dash: string
}[] = [
  { value: 'solid', label: '实线', dash: '' },
  { value: 'dashed', label: '虚线', dash: '7 5' },
  { value: 'dotted', label: '点线', dash: '2 4' },
]

export function CanvasEdgeToolbar({
  edge,
  busy,
  onDirectionChange,
  onLineStyleChange,
  onDelete,
}: CanvasEdgeToolbarProps) {
  return (
    <aside
      aria-label="连线设置"
      className="absolute right-5 top-20 z-20 w-72 rounded-2xl border border-border/80 bg-surface/95 p-4 shadow-xl backdrop-blur-sm"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.14em] text-foreground-tertiary">
            连线设置
          </p>
          <h3 className="mt-1 text-sm font-semibold">普通关系</h3>
        </div>
        <span className="rounded-full bg-primary/8 px-2.5 py-1 text-[11px] font-medium text-primary">
          已自动保存
        </span>
      </div>

      <fieldset className="mt-4" disabled={busy}>
        <legend className="mb-2 text-xs font-medium text-foreground-secondary">
          方向
        </legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-secondary p-1">
          {DIRECTIONS.map(({ value, label, icon: Icon }) => (
            <button
              aria-pressed={edge.direction === value}
              className={`flex h-9 items-center justify-center gap-1.5 rounded-lg text-xs font-medium transition ${
                edge.direction === value
                  ? 'bg-surface text-primary shadow-sm'
                  : 'text-foreground-secondary hover:text-foreground'
              }`}
              key={value}
              onClick={() => onDirectionChange(value)}
              type="button"
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className="mt-4" disabled={busy}>
        <legend className="mb-2 text-xs font-medium text-foreground-secondary">
          线型
        </legend>
        <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-secondary p-1">
          {LINE_STYLES.map(({ value, label, dash }) => (
            <button
              aria-pressed={edge.lineStyle === value}
              className={`flex h-10 flex-col items-center justify-center gap-1 rounded-lg text-[11px] font-medium transition ${
                edge.lineStyle === value
                  ? 'bg-surface text-primary shadow-sm'
                  : 'text-foreground-secondary hover:text-foreground'
              }`}
              key={value}
              onClick={() => onLineStyleChange(value)}
              type="button"
            >
              <svg aria-hidden="true" className="h-1.5 w-10" viewBox="0 0 40 6">
                <line
                  stroke="currentColor"
                  strokeDasharray={dash || undefined}
                  strokeLinecap="round"
                  strokeWidth="2"
                  x1="1"
                  x2="39"
                  y1="3"
                  y2="3"
                />
              </svg>
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="mt-4 border-t border-border/70 pt-3">
        <button
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-danger transition hover:bg-danger/8 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={onDelete}
          type="button"
        >
          <Trash2 className="size-4" />
          删除连线
        </button>
      </div>
    </aside>
  )
}
