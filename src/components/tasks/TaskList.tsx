import {
  CalendarClock,
  CalendarX,
  Check,
  CirclePlay,
  Pencil,
  RotateCcw,
  Star,
  Zap,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  isTaskEffectivelyUrgent,
  isTaskOverdue,
  type LocalDate,
  type Task,
  type TaskStatus,
} from '@/task/model'

export type TaskStatusAction =
  'startTask' | 'completeTask' | 'cancelTask' | 'reopenTask'

interface TaskListProps {
  readonly tasks: readonly Task[]
  readonly today: LocalDate
  readonly pendingTaskIds: ReadonlySet<string>
  readonly onRename: (task: Task) => void
  readonly onStatusAction: (task: Task, action: TaskStatusAction) => void
  readonly onSetImportance: (task: Task, isImportant: boolean) => void
  readonly onSetUrgency: (task: Task, isUrgent: boolean) => void
  readonly onSetDeadline: (task: Task, dueDate: LocalDate) => void
  readonly onClearDeadline: (task: Task) => void
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
  today,
  pendingTaskIds,
  onRename,
  onStatusAction,
  onSetImportance,
  onSetUrgency,
  onSetDeadline,
  onClearDeadline,
}: TaskListProps) {
  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface shadow-card">
      <div className="min-w-[1180px]">
        <div className="grid min-h-10 grid-cols-[minmax(220px,1fr)_100px_180px_150px_230px_minmax(280px,auto)] items-center gap-4 border-b border-border bg-surface-secondary px-5 text-caption font-medium text-foreground-tertiary">
          <span>任务名称</span>
          <span>状态</span>
          <span>截止日期</span>
          <span>更新时间</span>
          <span>规划属性</span>
          <span className="text-right">操作</span>
        </div>
        <ul aria-label="任务列表" className="divide-y divide-border">
          {tasks.map((task) => {
            const pending = pendingTaskIds.has(task.id)
            const status = STATUS_PRESENTATION[task.status]
            const overdue = isTaskOverdue(task, today)
            const effectivelyUrgent = isTaskEffectivelyUrgent(task, today)
            return (
              <li
                className="grid min-h-[74px] grid-cols-[minmax(220px,1fr)_100px_180px_150px_230px_minmax(280px,auto)] items-center gap-4 px-5 transition-colors hover:bg-hover"
                aria-busy={pending}
                key={task.id}
              >
                <div className="min-w-0 space-y-1.5">
                  <p className="truncate text-body font-medium text-foreground">
                    {task.title}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {task.isImportant && (
                      <Badge variant="secondary">重要</Badge>
                    )}
                    {overdue && <Badge variant="destructive">已逾期</Badge>}
                    {effectivelyUrgent && (
                      <Badge
                        className="border-warning/20 bg-warning-soft text-warning"
                        variant="outline"
                      >
                        {task.isUrgent ? '紧急' : '紧急（逾期）'}
                      </Badge>
                    )}
                  </div>
                </div>
                <Badge className={status.className} variant="outline">
                  {status.label}
                </Badge>
                <div className="flex items-center gap-2">
                  <Input
                    aria-label={`任务截止日期：${task.title}`}
                    className="w-[132px]"
                    disabled={pending}
                    onChange={(event) => {
                      if (event.target.value === '') {
                        onClearDeadline(task)
                      } else {
                        onSetDeadline(task, event.target.value)
                      }
                    }}
                    type="date"
                    value={task.dueDate ?? ''}
                  />
                  {task.dueDate !== null && (
                    <Button
                      aria-label={`清除截止日期：${task.title}`}
                      disabled={pending}
                      onClick={() => onClearDeadline(task)}
                      size="icon-sm"
                      title="清除截止日期"
                      type="button"
                      variant="ghost"
                    >
                      <CalendarX aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <span className="flex items-center gap-2 text-auxiliary text-foreground-tertiary">
                  <CalendarClock className="size-3.5" aria-hidden="true" />
                  {formatUpdatedAt(task.updatedAtMs)}
                </span>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    aria-label={`${task.isImportant ? '取消重要' : '设为重要'}：${task.title}`}
                    disabled={pending}
                    onClick={() => onSetImportance(task, !task.isImportant)}
                    size="sm"
                    type="button"
                    variant={task.isImportant ? 'secondary' : 'outline'}
                  >
                    <Star data-icon="inline-start" />
                    {task.isImportant ? '重要' : '不重要'}
                  </Button>
                  <Button
                    aria-label={`${task.isUrgent ? '取消基础紧急' : '设为基础紧急'}：${task.title}`}
                    disabled={pending}
                    onClick={() => onSetUrgency(task, !task.isUrgent)}
                    size="sm"
                    type="button"
                    variant={task.isUrgent ? 'secondary' : 'outline'}
                  >
                    <Zap data-icon="inline-start" />
                    {task.isUrgent ? '基础紧急' : '基础不紧急'}
                  </Button>
                </div>
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
    </div>
  )
}
