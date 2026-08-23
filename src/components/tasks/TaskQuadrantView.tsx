import {
  CalendarDays,
  CalendarX,
  Check,
  CirclePlay,
  Plus,
  Star,
  Zap,
  X,
} from 'lucide-react'

import type { TaskStatusAction } from '@/components/tasks/TaskList'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  groupTasksByQuadrant,
  isTaskEffectivelyUrgent,
  isTaskOverdue,
  type LocalDate,
  type Task,
  type TaskQuadrant,
} from '@/task/model'

interface TaskQuadrantViewProps {
  readonly tasks: readonly Task[]
  readonly today: LocalDate
  readonly pendingTaskIds: ReadonlySet<string>
  readonly onCreate: () => void
  readonly onOpenDetail: (task: Task) => void
  readonly onStatusAction: (task: Task, action: TaskStatusAction) => void
  readonly onSetImportance: (task: Task, isImportant: boolean) => void
  readonly onSetUrgency: (task: Task, isUrgent: boolean) => void
  readonly onSetDeadline: (task: Task, dueDate: LocalDate) => void
  readonly onClearDeadline: (task: Task) => void
}

const QUADRANT_PRESENTATION: ReadonlyArray<{
  readonly key: TaskQuadrant
  readonly title: string
  readonly description: string
  readonly accentClassName: string
  readonly countClassName: string
  readonly titleClassName: string
}> = [
  {
    key: 'importantUrgent',
    title: '重要且紧急',
    description: '优先处理',
    accentClassName: 'border-t-danger/70',
    countClassName: 'bg-danger-soft text-danger',
    titleClassName: 'text-danger',
  },
  {
    key: 'importantNotUrgent',
    title: '重要不紧急',
    description: '安排推进',
    accentClassName: 'border-t-warning/70',
    countClassName: 'bg-warning-soft text-warning',
    titleClassName: 'text-warning',
  },
  {
    key: 'notImportantUrgent',
    title: '不重要但紧急',
    description: '尽快处理',
    accentClassName: 'border-t-info/70',
    countClassName: 'bg-info-soft text-info',
    titleClassName: 'text-info',
  },
  {
    key: 'notImportantNotUrgent',
    title: '不重要不紧急',
    description: '稍后处理',
    accentClassName: 'border-t-success/70',
    countClassName: 'bg-success-soft text-success',
    titleClassName: 'text-success',
  },
]

export function TaskQuadrantView({
  tasks,
  today,
  pendingTaskIds,
  onCreate,
  onOpenDetail,
  onStatusAction,
  onSetImportance,
  onSetUrgency,
  onSetDeadline,
  onClearDeadline,
}: TaskQuadrantViewProps) {
  const groups = groupTasksByQuadrant(tasks, today)
  const activeTaskCount = QUADRANT_PRESENTATION.reduce(
    (total, quadrant) => total + groups[quadrant.key].length,
    0,
  )

  return (
    <section aria-label="任务四象限" className="space-y-5">
      {activeTaskCount === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 border-b border-border px-1 pb-4">
          <div>
            <p className="text-body font-medium text-foreground">
              当前没有待开始或进行中的任务
            </p>
            <p className="mt-1 text-auxiliary text-foreground-secondary">
              已完成和已取消任务仍可在列表视图中查看。
            </p>
          </div>
          <Button onClick={onCreate} type="button">
            <Plus data-icon="inline-start" />
            新建任务
          </Button>
        </div>
      )}

      <div className="grid gap-4 xl:grid-cols-2">
        {QUADRANT_PRESENTATION.map((quadrant) => {
          const quadrantTasks = groups[quadrant.key]
          const titleId = `task-quadrant-${quadrant.key}`

          return (
            <section
              aria-labelledby={titleId}
              className={`min-h-[264px] min-w-0 rounded-lg border border-t-2 border-border bg-surface px-4 pb-4 pt-4 xl:min-h-[304px] ${quadrant.accentClassName}`}
              key={quadrant.key}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <div className="flex min-w-0 items-baseline gap-2.5">
                  <h3
                    className={`text-subtitle font-semibold ${quadrant.titleClassName}`}
                    id={titleId}
                  >
                    {quadrant.title}
                  </h3>
                  <p className="text-caption text-foreground-tertiary">
                    {quadrant.description}
                  </p>
                </div>
                <span
                  aria-label={`${quadrant.title}任务数量 ${quadrantTasks.length}`}
                  className={`inline-flex min-w-7 items-center justify-center rounded-sm px-1.5 py-0.5 text-caption font-semibold ${quadrant.countClassName}`}
                >
                  {quadrantTasks.length}
                </span>
              </div>

              {quadrantTasks.length === 0 ? (
                <p className="flex min-h-[96px] items-center justify-center px-4 text-center text-auxiliary text-foreground-tertiary/70 xl:min-h-[120px]">
                  暂无任务
                </p>
              ) : (
                <ul
                  aria-label={`${quadrant.title}任务`}
                  className="space-y-2.5"
                >
                  {quadrantTasks.map((task) => {
                    const pending = pendingTaskIds.has(task.id)
                    const overdue = isTaskOverdue(task, today)
                    const effectivelyUrgent = isTaskEffectivelyUrgent(
                      task,
                      today,
                    )
                    return (
                      <li
                        aria-busy={pending}
                        className="group min-h-[128px] rounded-md border border-border bg-surface px-4 py-3.5 shadow-sm transition-[border-color,box-shadow] duration-150 hover:border-primary/25 hover:shadow-card"
                        key={task.id}
                      >
                        <div className="flex items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <button
                              aria-label={`查看任务详情：${task.title}`}
                              className="break-words rounded-xs text-left text-[15px] leading-6 font-semibold text-foreground hover:text-primary focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
                              onClick={() => onOpenDetail(task)}
                              type="button"
                            >
                              {task.title}
                            </button>
                            <div className="mt-2 flex flex-wrap items-center gap-1.5">
                              <Badge variant="secondary">
                                {task.status === 'doing' ? '进行中' : '待开始'}
                              </Badge>
                              {overdue && (
                                <Badge variant="destructive">已逾期</Badge>
                              )}
                              {effectivelyUrgent && !task.isUrgent && (
                                <Badge
                                  className="border-warning/20 bg-warning-soft text-warning"
                                  variant="outline"
                                >
                                  紧急（逾期）
                                </Badge>
                              )}
                            </div>
                          </div>

                          <div className="flex shrink-0 items-center gap-0.5 opacity-70 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100 lg:opacity-0">
                            {task.status === 'todo' && (
                              <Button
                                aria-label={`开始任务：${task.title}`}
                                disabled={pending}
                                onClick={() =>
                                  onStatusAction(task, 'startTask')
                                }
                                size="icon-sm"
                                title="开始任务"
                                type="button"
                                variant="ghost"
                              >
                                <CirclePlay aria-hidden="true" />
                              </Button>
                            )}
                            <Button
                              aria-label={`完成任务：${task.title}`}
                              className="text-success hover:bg-success-soft hover:text-success"
                              disabled={pending}
                              onClick={() =>
                                onStatusAction(task, 'completeTask')
                              }
                              size="icon-sm"
                              title="完成任务"
                              type="button"
                              variant="ghost"
                            >
                              <Check aria-hidden="true" />
                            </Button>
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
                          </div>
                        </div>

                        <div className="mt-3 flex flex-wrap items-center gap-1 text-auxiliary">
                          <Button
                            aria-label={`${task.isImportant ? '取消重要' : '设为重要'}：${task.title}`}
                            className={`h-7 rounded-sm border-0 px-2 text-auxiliary ${
                              task.isImportant
                                ? 'bg-danger-soft text-danger hover:bg-danger-soft/75'
                                : 'bg-surface-secondary/55 text-foreground-tertiary hover:bg-surface-secondary hover:text-foreground-secondary'
                            }`}
                            disabled={pending}
                            onClick={() =>
                              onSetImportance(task, !task.isImportant)
                            }
                            type="button"
                            variant="ghost"
                          >
                            <Star
                              className={
                                task.isImportant ? 'fill-current' : undefined
                              }
                              data-icon="inline-start"
                            />
                            {task.isImportant ? '重要' : '不重要'}
                          </Button>
                          <Button
                            aria-label={`${task.isUrgent ? '取消基础紧急' : '设为基础紧急'}：${task.title}`}
                            className={`h-7 rounded-sm border-0 px-2 text-auxiliary ${
                              effectivelyUrgent
                                ? 'bg-warning-soft text-warning hover:bg-warning-soft/75'
                                : 'bg-surface-secondary/55 text-foreground-tertiary hover:bg-surface-secondary hover:text-foreground-secondary'
                            }`}
                            disabled={pending}
                            onClick={() => onSetUrgency(task, !task.isUrgent)}
                            type="button"
                            variant="ghost"
                          >
                            <Zap
                              className={
                                task.isUrgent ? 'fill-current' : undefined
                              }
                              data-icon="inline-start"
                            />
                            {task.isUrgent ? '基础紧急' : '基础不紧急'}
                          </Button>
                          <div
                            className={`group/deadline relative flex h-7 items-center rounded-sm focus-within:[box-shadow:var(--focus-ring)] ${
                              overdue
                                ? 'bg-danger-soft text-danger'
                                : 'bg-surface-secondary/55 text-foreground-tertiary hover:bg-surface-secondary hover:text-foreground-secondary'
                            }`}
                          >
                            <span
                              aria-hidden="true"
                              className="inline-flex h-7 items-center gap-1.5 px-2 text-auxiliary"
                            >
                              <CalendarDays className="size-4" />
                              {task.dueDate === null
                                ? '无截止日期'
                                : task.dueDate}
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
                        </div>
                      </li>
                    )
                  })}
                </ul>
              )}
            </section>
          )
        })}
      </div>
    </section>
  )
}
