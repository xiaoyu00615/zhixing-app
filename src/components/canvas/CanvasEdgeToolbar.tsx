import { ArrowLeftRight, ArrowRight, Minus, Trash2 } from 'lucide-react'

import type {
  CanvasEdge,
} from '@/canvas/model'
import type { CanvasEdgeCommand } from '@/canvas/commandRegistry'
import { getCanvasEdgeTypeDefinition, canvasEdgeRegistry } from '@/canvas/edgeRegistry'

interface CanvasEdgeToolbarProps {
  readonly edge: CanvasEdge
  readonly busy: boolean
  readonly onCommand: (command: CanvasEdgeCommand) => void
}

const DIRECTIONS: readonly {
  value: CanvasEdge['direction']
  label: string
  icon: typeof ArrowRight
}[] = [
  { value: 'forward', label: '单向', icon: ArrowRight },
  { value: 'bidirectional', label: '双向', icon: ArrowLeftRight },
  { value: 'none', label: '无方向', icon: Minus },
]

const LINE_STYLES: readonly {
  value: CanvasEdge['lineStyle']
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
  onCommand,
}: CanvasEdgeToolbarProps) {
  const definition = getCanvasEdgeTypeDefinition(edge.relationType)
  const locked = definition?.presentationLocked === true
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
          <h3 className="mt-1 text-sm font-semibold">
            {definition?.displayName ?? '未知关系'}
          </h3>
          {definition === null && (
            <p className="mt-1 max-w-44 truncate text-[11px] text-foreground-tertiary" title={edge.relationType}>
              原始类型：{edge.relationType}
            </p>
          )}
        </div>
        <span className="rounded-full bg-primary/8 px-2.5 py-1 text-[11px] font-medium text-primary">
          已自动保存
        </span>
      </div>

      <fieldset className="mt-4" disabled={busy || definition === null || locked}>
        <legend className="mb-2 text-xs font-medium text-foreground-secondary">
          关系类型
        </legend>
        {definition === null ? (
          <div className="rounded-xl bg-surface-secondary px-3 py-2.5 text-xs text-foreground-secondary">
            未知关系保持只读，不会自动转换。
          </div>
        ) : (
          <div className="grid grid-cols-3 gap-1 rounded-xl bg-surface-secondary p-1">
            {canvasEdgeRegistry.definitions.filter((item) => item.ordinarySelectable).map((item) => (
              <button
                aria-pressed={edge.relationType === item.relationType}
                className={`h-9 rounded-lg text-xs font-medium transition ${
                  edge.relationType === item.relationType
                    ? 'bg-surface text-primary shadow-sm'
                    : 'text-foreground-secondary hover:text-foreground'
                }`}
                key={item.relationType}
                onClick={() => onCommand({
                  id: 'update_edge_relation_type',
                  edgeId: edge.id,
                  relationType: item.relationType,
                })}
                type="button"
              >
                {item.displayName}
              </button>
            ))}
          </div>
        )}
      </fieldset>

      {locked && (
        <p className="mt-3 rounded-xl bg-surface-secondary px-3 py-2 text-xs text-foreground-secondary">
          成员关系的方向与线型固定，由节点盒维护。
        </p>
      )}

      {definition !== null && !locked && <fieldset className="mt-4" disabled={busy}>
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
              onClick={() => onCommand({
                id: 'update_edge_direction',
                edgeId: edge.id,
                direction: value,
              })}
              type="button"
            >
              <Icon className="size-3.5" />
              {label}
            </button>
          ))}
        </div>
      </fieldset>}

      {definition !== null && !locked && <fieldset className="mt-4" disabled={busy}>
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
              onClick={() => onCommand({
                id: 'update_edge_line_style',
                edgeId: edge.id,
                lineStyle: value,
              })}
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
      </fieldset>}

      <div className="mt-4 border-t border-border/70 pt-3">
        <button
          className="flex h-9 w-full items-center justify-center gap-2 rounded-lg text-xs font-medium text-danger transition hover:bg-danger/8 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={busy}
          onClick={() => onCommand({
            id: locked ? 'remove_membership' : 'delete_edge',
            edgeId: edge.id,
          })}
          type="button"
        >
          <Trash2 className="size-4" />
          删除连线
        </button>
      </div>
    </aside>
  )
}
