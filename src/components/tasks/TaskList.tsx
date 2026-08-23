import {
  CalendarDays,
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
import { ProjectChip } from '@/components/tasks/ProjectChip'
import type { Project } from '@/project/model'
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
  readonly projects: readonly Project[]
  readonly today: LocalDate
  readonly pendingTaskIds: ReadonlySet<string>
  readonly onOpenDetail: (task: Task) => void
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
    return '时间未知'
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
  projects,
  today,
  pendingTaskIds,
  onOpenDetail,
  onRename,
  onStatusAction,
  onSetImportance,
  onSetUrgency,
  onSetDeadline,
  onClearDeadline,
}: TaskListProps) {
  const projectsById = new Map(projects.map((project) => [project.id, project]))
  return (
    <div className="overflow-hidden rounded-lg border border-border bg-surface">
      <ul aria-label="任务列表" className="divide-y divide-border">
        {tasks.map((task) => {
          const pending = pendingTaskIds.has(task.id)
          const status = STATUS_PRESENTATION[task.status]
          const overdue = isTaskOverdue(task, today)
          const effectivelyUrgent = isTaskEffectivelyUrgent(task, today)
          const isActive = task.status === 'todo' || task.status === 'doing'

          return (
            <li
              aria-busy={pending}
              className="group flex min-h-[100px] items-start gap-3 px-4 py-[18px] transition-colors duration-150 hover:bg-hover/70 sm:gap-4 sm:px-5"
              key={task.id}
            >
              {isActive ? (
                <Button
                  aria-label={`完成任务：${task.title}`}
                  className="mt-0.5 size-6 shrink-0 rounded-full border-border text-transparent hover:border-primary hover:bg-primary-softest hover:text-primary focus-visible:text-primary"
                  disabled={pending}
                  onClick={() => onStatusAction(task, 'completeTask')}
                  size="icon-sm"
                  title="完成任务"
                  type="button"
                  variant="outline"
                >
                  <Check className="size-3.5" aria-hidden="true" />
                </Button>
              ) : (
                <span
                  aria-hidden="true"
                  className={`mt-0.5 flex size-6 shrink-0 items-center justify-center rounded-full border ${
                    task.status === 'completed'
                      ? 'border-success/25 bg-success-soft text-success'
                      : 'border-danger/20 bg-danger-soft text-danger'
                  }`}
                >
                  {task.status === 'completed' ? (
                    <Check className="size-3.5" />
                  ) : (
                    <X className="size-3.5" />
                  )}
                </span>
              )}

              <div className="min-w-0 flex-1">
                <div className="flex min-w-0 flex-wrap items-center gap-2">
                  <button
                    aria-label={`查看任务详情：${task.title}`}
                    className={`min-w-0 break-words rounded-xs text-left text-[15px] leading-6 font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] ${
                      task.status === 'completed' || task.status === 'cancelled'
                        ? 'text-foreground-secondary line-through decoration-border'
                        : ''
                    }`}
                    onClick={() => onOpenDetail(task)}
                    type="button"
                  >
                    {task.title}
                  </button>
                  <Badge className={status.className} variant="outline">
                    {status.label}
                  </Badge>
                  {overdue && <Badge variant="destructive">已逾期</Badge>}
                  {effectivelyUrgent && !task.isUrgent && (
                    <Badge
                      className="border-warning/20 bg-warning-soft text-warning"
                      variant="outline"
                    >
                      紧急（逾期）
                    </Badge>
                  )}
                </div>

                <div className="mt-2 flex flex-wrap items-center gap-x-1 gap-y-1 text-auxiliary text-foreground-tertiary">
                  {task.projectId !== null &&
                    projectsById.has(task.projectId) && (
                      <ProjectChip
                        project={projectsById.get(task.projectId)!}
                      />
                    )}
                  <span className="mr-1">
                    更新于 {formatUpdatedAt(task.updatedAtMs)}
                  </span>
                  <span aria-hidden="true" className="text-border-strong">
                    ·
                  </span>
                  <Button
                    aria-label={`${task.isImportant ? '取消重要' : '设为重要'}：${task.title}`}
                    className={`h-7 rounded-sm border-0 px-2 text-auxiliary ${
                      task.isImportant
                        ? 'bg-danger-soft text-danger hover:bg-danger-soft/75'
                        : 'bg-transparent text-foreground-tertiary hover:bg-surface-secondary hover:text-foreground-secondary'
                    }`}
                    disabled={pending}
                    onClick={() => onSetImportance(task, !task.isImportant)}
                    type="button"
                    variant="ghost"
                  >
                    <Star
                      className={task.isImportant ? 'fill-current' : undefined}
                      data-icon="inline-start"
                    />
                    {task.isImportant ? '重要' : '不重要'}
                  </Button>
                  <Button
                    aria-label={`${task.isUrgent ? '取消基础紧急' : '设为基础紧急'}：${task.title}`}
                    className={`h-7 rounded-sm border-0 px-2 text-auxiliary ${
                      effectivelyUrgent
                        ? 'bg-warning-soft text-warning hover:bg-warning-soft/75'
                        : 'bg-transparent text-foreground-tertiary hover:bg-surface-secondary hover:text-foreground-secondary'
                    }`}
                    disabled={pending}
                    onClick={() => onSetUrgency(task, !task.isUrgent)}
                    type="button"
                    variant="ghost"
                  >
                    <Zap
                      className={task.isUrgent ? 'fill-current' : undefined}
                      data-icon="inline-start"
                    />
                    {task.isUrgent ? '基础紧急' : '基础不紧急'}
                  </Button>
                  <div
                    className={`group/deadline relative flex h-7 items-center rounded-sm focus-within:[box-shadow:var(--focus-ring)] ${
                      overdue
                        ? 'bg-danger-soft text-danger'
                        : 'text-foreground-tertiary hover:bg-surface-secondary hover:text-foreground-secondary'
                    }`}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-flex h-7 items-center gap-1.5 px-2 text-auxiliary"
                    >
                      <CalendarDays className="size-4" />
                      {task.dueDate === null ? '无截止日期' : task.dueDate}
                    </span>
                    <Input
                      aria-label={`任务截止日期：${task.title}`}
                      className="absolute inset-0 h-full w-full cursor-pointer border-0 opacity-0"
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
                        className="relative z-10 mr-0.5 size-6 text-foreground-tertiary opacity-60 hover:bg-surface hover:text-foreground group-hover/deadline:opacity-100 group-focus-within/deadline:opacity-100"
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
                  <div className="ml-2 flex shrink-0 items-center gap-0.5">
                    {task.status === 'todo' && (
                      <Button
                        aria-label={`开始任务：${task.title}`}
                        className="h-7"
                        disabled={pending}
                        onClick={() => onStatusAction(task, 'startTask')}
                        size="sm"
                        title="开始任务"
                        type="button"
                        variant="outline"
                      >
                        <CirclePlay data-icon="inline-start" />
                        开始
                      </Button>
                    )}
                    {(task.status === 'completed' ||
                      task.status === 'cancelled') && (
                      <Button
                        aria-label={`恢复任务：${task.title}`}
                        className="h-7"
                        disabled={pending}
                        onClick={() => onStatusAction(task, 'reopenTask')}
                        size="sm"
                        title="恢复任务"
                        type="button"
                        variant="outline"
                      >
                        <RotateCcw data-icon="inline-start" />
                        恢复
                      </Button>
                    )}
                    <div className="flex items-center gap-0.5 opacity-60 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 lg:opacity-0">
                      <Button
                        aria-label={`重命名任务：${task.title}`}
                        disabled={pending}
                        onClick={() => onRename(task)}
                        size="icon-sm"
                        title="重命名"
                        type="button"
                        variant="ghost"
                      >
                        <Pencil aria-hidden="true" />
                      </Button>
                      {isActive && (
                        <Button
                          aria-label={`取消任务：${task.title}`}
                          className="text-foreground-tertiary hover:bg-danger-soft hover:text-danger"
                          disabled={pending}
                          onClick={() => onStatusAction(task, 'cancelTask')}
                          size="icon-sm"
                          title="取消任务"
                          type="button"
                          variant="ghost"
                        >
                          <X aria-hidden="true" />
                        </Button>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
