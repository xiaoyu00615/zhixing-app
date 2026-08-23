import {
  CalendarClock,
  Check,
  CirclePlay,
  Pencil,
  RotateCcw,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Task, TaskStatus } from '@/task/model'

export type TaskStatusAction =
  'startTask' | 'completeTask' | 'cancelTask' | 'reopenTask'

interface TaskListProps {
  readonly tasks: readonly Task[]
  readonly pendingTaskIds: ReadonlySet<string>
  readonly onRename: (task: Task) => void
  readonly onStatusAction: (task: Task, action: TaskStatusAction) => void
}

const STATUS_PRESENTATION: Record<
  TaskStatus,
  { readonly label: string; readonly className: string }
> = {
  todo: {
    label: '待开始',
    className: 'border-border bg-surface-secondary text-foreground-secondary',
  },
  doing: {
    label: '进行中',
    className: 'border-info/20 bg-info-soft text-info',
  },
  completed: {
    label: '已完成',
    className: 'border-success/20 bg-success-soft text-success',
  },
  cancelled: {
    label: '已取消',
    className: 'border-danger/20 bg-danger-soft text-danger',
  },
}

function formatUpdatedAt(updatedAtMs: number): string {
  const date = new Date(updatedAtMs)
  if (Number.isNaN(date.getTime())) {
    return '更新时间未知'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

export function TaskList({
  tasks,
  pendingTaskIds,
  onRename,
  onStatusAction,
}: TaskListProps) {
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface shadow-card">
      <div className="grid min-h-10 grid-cols-[minmax(0,1fr)_120px_160px_minmax(260px,auto)] items-center gap-4 border-b border-border bg-surface-secondary px-5 text-caption font-medium text-foreground-tertiary">
        <span>任务名称</span>
        <span>状态</span>
        <span>更新时间</span>
        <span className="text-right">操作</span>
      </div>
      <ul aria-label="任务列表" className="divide-y divide-border">
        {tasks.map((task) => {
          const pending = pendingTaskIds.has(task.id)
          const status = STATUS_PRESENTATION[task.status]
          return (
            <li
              className="grid min-h-[58px] grid-cols-[minmax(0,1fr)_120px_160px_minmax(260px,auto)] items-center gap-4 px-5 transition-colors hover:bg-hover"
              aria-busy={pending}
              key={task.id}
            >
              <p className="truncate text-body font-medium text-foreground">
                {task.title}
              </p>
              <Badge className={status.className} variant="outline">
                {status.label}
              </Badge>
              <span className="flex items-center gap-2 text-auxiliary text-foreground-tertiary">
                <CalendarClock className="size-3.5" aria-hidden="true" />
                {formatUpdatedAt(task.updatedAtMs)}
              </span>
              <div className="flex items-center justify-end gap-2">
                <Button
                  aria-label={`重命名任务：${task.title}`}
                  disabled={pending}
                  onClick={() => onRename(task)}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  <Pencil data-icon="inline-start" />
                  重命名
                </Button>
                {task.status === 'todo' && (
                  <Button
                    aria-label={`开始任务：${task.title}`}
                    disabled={pending}
                    onClick={() => onStatusAction(task, 'startTask')}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <CirclePlay data-icon="inline-start" />
                    开始
                  </Button>
                )}
                {(task.status === 'todo' || task.status === 'doing') && (
                  <Button
                    aria-label={`完成任务：${task.title}`}
                    disabled={pending}
                    onClick={() => onStatusAction(task, 'completeTask')}
                    size="sm"
                    type="button"
                  >
                    <Check data-icon="inline-start" />
                    完成
                  </Button>
                )}
                {(task.status === 'todo' || task.status === 'doing') && (
                  <Button
                    aria-label={`取消任务：${task.title}`}
                    disabled={pending}
                    onClick={() => onStatusAction(task, 'cancelTask')}
                    size="sm"
                    type="button"
                    variant="destructive"
                  >
                    <X data-icon="inline-start" />
                    取消
                  </Button>
                )}
                {(task.status === 'completed' ||
                  task.status === 'cancelled') && (
                  <Button
                    aria-label={`恢复任务：${task.title}`}
                    disabled={pending}
                    onClick={() => onStatusAction(task, 'reopenTask')}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw data-icon="inline-start" />
                    恢复
                  </Button>
                )}
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
