import {
  CalendarDays,
  CalendarX,
  Check,
  CirclePlay,
  Clock3,
  Pencil,
  RotateCcw,
  Star,
  Zap,
  X,
} from 'lucide-react'
import { Dialog as DialogPrimitive } from 'radix-ui'
import type { ReactNode } from 'react'

import type { TaskStatusAction } from '@/components/tasks/TaskList'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  isTaskEffectivelyUrgent,
  isTaskOverdue,
  type LocalDate,
  type Task,
  type TaskStatus,
} from '@/task/model'

interface TaskDetailPanelProps {
  readonly task: Task | null
  readonly today: LocalDate
  readonly pending: boolean
  readonly onOpenChange: (open: boolean) => void
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

function formatTimestamp(timestampMs: number): string {
  const date = new Date(timestampMs)
  if (Number.isNaN(date.getTime())) {
    return '时间未知'
  }
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function DetailRow({
  label,
  children,
}: {
  readonly label: string
  readonly children: ReactNode
}) {
  return (
    <div className="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-3 border-b border-border/70 py-3 last:border-b-0">
      <dt className="text-auxiliary font-medium text-foreground-tertiary">
        {label}
      </dt>
      <dd className="min-w-0 text-body text-foreground">{children}</dd>
    </div>
  )
}

export function TaskDetailPanel({
  task,
  today,
  pending,
  onOpenChange,
  onRename,
  onStatusAction,
  onSetImportance,
  onSetUrgency,
  onSetDeadline,
  onClearDeadline,
}: TaskDetailPanelProps) {
  if (task === null) {
    return null
  }

  const status = STATUS_PRESENTATION[task.status]
  const overdue = isTaskOverdue(task, today)
  const effectivelyUrgent = isTaskEffectivelyUrgent(task, today)
  const active = task.status === 'todo' || task.status === 'doing'

  return (
    <DialogPrimitive.Root open onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 isolate z-modal bg-black/[0.03] duration-200 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0" />
        <DialogPrimitive.Content
          aria-label={`任务详情：${task.title}`}
          className="fixed top-0 right-0 left-auto z-modal grid h-dvh w-full max-w-[420px] translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden rounded-none border-l border-border bg-surface p-0 text-sm text-foreground shadow-modal duration-200 outline-none data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95 sm:max-w-[420px] sm:rounded-l-2xl"
        >
          <DialogHeader className="border-b border-border px-5 py-5 pr-12">
            <div className="flex flex-wrap items-center gap-2">
              <Badge className={status.className} variant="outline">
                {status.label}
              </Badge>
              {task.isImportant && (
                <Badge
                  className="border-danger/20 bg-danger-soft text-danger"
                  variant="outline"
                >
                  重要
                </Badge>
              )}
              {effectivelyUrgent && (
                <Badge
                  className="border-warning/20 bg-warning-soft text-warning"
                  variant="outline"
                >
                  {task.isUrgent ? '基础紧急' : '紧急（逾期）'}
                </Badge>
              )}
              {overdue && <Badge variant="destructive">已逾期</Badge>}
            </div>
            <DialogTitle className="mt-3 pr-2 text-xl leading-7 font-semibold tracking-tight text-foreground">
              <span className="sr-only">任务详情：</span>
              {task.title}
            </DialogTitle>
            <DialogDescription className="sr-only">
              查看并修改当前任务的已有属性
            </DialogDescription>
          </DialogHeader>

          <div className="min-h-0 overflow-y-auto">
            <section
              aria-labelledby="task-detail-actions"
              className="px-5 py-5"
            >
              <div className="flex items-center justify-between gap-3">
                <h3
                  className="text-auxiliary font-semibold tracking-wide text-foreground-tertiary uppercase"
                  id="task-detail-actions"
                >
                  任务操作
                </h3>
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
              </div>

              <div className="mt-3 flex flex-wrap gap-2">
                {task.status === 'todo' && (
                  <Button
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
                {active && (
                  <Button
                    disabled={pending}
                    onClick={() => onStatusAction(task, 'completeTask')}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Check data-icon="inline-start" />
                    完成
                  </Button>
                )}
                {active && (
                  <Button
                    className="text-danger hover:bg-danger-soft hover:text-danger"
                    disabled={pending}
                    onClick={() => onStatusAction(task, 'cancelTask')}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <X data-icon="inline-start" />
                    取消
                  </Button>
                )}
                {(task.status === 'completed' ||
                  task.status === 'cancelled') && (
                  <Button
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
            </section>

            <section
              aria-labelledby="task-detail-properties"
              className="border-y border-border bg-surface-secondary/25 px-5 py-2"
            >
              <h3 className="sr-only" id="task-detail-properties">
                任务属性
              </h3>
              <dl>
                <DetailRow label="重要程度">
                  <Button
                    aria-label={`${task.isImportant ? '取消重要' : '设为重要'}：${task.title}`}
                    className={
                      task.isImportant
                        ? 'bg-danger-soft text-danger hover:bg-danger-soft/75'
                        : undefined
                    }
                    disabled={pending}
                    onClick={() => onSetImportance(task, !task.isImportant)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Star
                      className={task.isImportant ? 'fill-current' : undefined}
                      data-icon="inline-start"
                    />
                    {task.isImportant ? '重要' : '不重要'}
                  </Button>
                </DetailRow>

                <DetailRow label="基础紧急">
                  <Button
                    aria-label={`${task.isUrgent ? '取消基础紧急' : '设为基础紧急'}：${task.title}`}
                    className={
                      task.isUrgent
                        ? 'bg-warning-soft text-warning hover:bg-warning-soft/75'
                        : undefined
                    }
                    disabled={pending}
                    onClick={() => onSetUrgency(task, !task.isUrgent)}
                    size="sm"
                    type="button"
                    variant="ghost"
                  >
                    <Zap
                      className={task.isUrgent ? 'fill-current' : undefined}
                      data-icon="inline-start"
                    />
                    {task.isUrgent ? '紧急' : '不紧急'}
                  </Button>
                </DetailRow>

                <DetailRow label="有效紧急">
                  <span className="inline-flex items-center gap-2">
                    <Zap
                      className={`size-4 ${effectivelyUrgent ? 'text-warning' : 'text-foreground-tertiary'}`}
                      aria-hidden="true"
                    />
                    {effectivelyUrgent ? '是' : '否'}
                    {overdue && !task.isUrgent && (
                      <span className="text-auxiliary text-warning">
                        由逾期产生
                      </span>
                    )}
                  </span>
                </DetailRow>

                <DetailRow label="截止日期">
                  <div className="flex min-w-0 items-center gap-2">
                    <CalendarDays
                      className="size-4 shrink-0 text-foreground-tertiary"
                      aria-hidden="true"
                    />
                    <Input
                      aria-label={`详情截止日期：${task.title}`}
                      className="h-8 min-w-0 flex-1"
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
                        aria-label={`清除详情截止日期：${task.title}`}
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
                </DetailRow>
              </dl>
            </section>

            <section aria-labelledby="task-detail-time" className="px-5 py-5">
              <div className="mb-2 flex items-center gap-2">
                <Clock3
                  className="size-4 text-foreground-tertiary"
                  aria-hidden="true"
                />
                <h3
                  className="text-auxiliary font-semibold tracking-wide text-foreground-tertiary uppercase"
                  id="task-detail-time"
                >
                  时间信息
                </h3>
              </div>
              <dl>
                <DetailRow label="创建时间">
                  {formatTimestamp(task.createdAtMs)}
                </DetailRow>
                <DetailRow label="更新时间">
                  {formatTimestamp(task.updatedAtMs)}
                </DetailRow>
              </dl>
            </section>
          </div>
          <DialogPrimitive.Close asChild>
            <Button
              className="absolute top-2 right-2"
              size="icon-sm"
              variant="ghost"
            >
              <X aria-hidden="true" />
              <span className="sr-only">关闭</span>
            </Button>
          </DialogPrimitive.Close>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
