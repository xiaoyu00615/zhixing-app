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
  readonly className: string
  readonly countClassName: string
}> = [
  {
    key: 'importantUrgent',
    title: '重要且紧急',
    description: '优先处理',
    className: 'border-danger/25 bg-danger-soft/40',
    countClassName: 'bg-danger-soft text-danger',
  },
  {
    key: 'importantNotUrgent',
    title: '重要不紧急',
    description: '安排推进',
    className: 'border-warning/25 bg-warning-soft/35',
    countClassName: 'bg-warning-soft text-warning',
  },
  {
    key: 'notImportantUrgent',
    title: '不重要但紧急',
    description: '尽快处理',
    className: 'border-info/25 bg-info-soft/35',
    countClassName: 'bg-info-soft text-info',
  },
  {
    key: 'notImportantNotUrgent',
    title: '不重要不紧急',
    description: '稍后处理',
    className: 'border-success/25 bg-success-soft/35',
    countClassName: 'bg-success-soft text-success',
  },
]

export function TaskQuadrantView({
  tasks,
  today,
  pendingTaskIds,
  onCreate,
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
    <section aria-label="任务四象限" className="space-y-4">
      {activeTaskCount === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-4 rounded-lg border border-border bg-surface px-5 py-4 shadow-card">
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
              className={`min-w-0 rounded-lg border p-4 shadow-card ${quadrant.className}`}
              key={quadrant.key}
            >
              <div className="mb-4 flex items-start justify-between gap-3">
                <div>
                  <h3
                    className="text-module font-semibold text-foreground"
                    id={titleId}
                  >
                    {quadrant.title}
                  </h3>
                  <p className="mt-1 text-caption text-foreground-secondary">
                    {quadrant.description}
                  </p>
                </div>
                <span
                  aria-label={`${quadrant.title}任务数量 ${quadrantTasks.length}`}
                  className={`inline-flex min-w-8 items-center justify-center rounded-md px-2 py-1 text-caption font-semibold ${quadrant.countClassName}`}
                >
                  {quadrantTasks.length}
                </span>
              </div>

              {quadrantTasks.length === 0 ? (
                <p className="rounded-md border border-dashed border-border bg-surface/65 px-4 py-8 text-center text-auxiliary text-foreground-tertiary">
                  暂无任务
                </p>
              ) : (
                <ul
                  aria-label={`${quadrant.title}任务`}
                  className="space-y-3"
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
                        className="rounded-md border border-border bg-surface p-4 shadow-sm"
                        key={task.id}
                      >
                        <div className="flex flex-wrap items-start justify-between gap-3">
                          <div className="min-w-0 flex-1">
                            <p className="break-words text-body font-medium text-foreground">
                              {task.title}
                            </p>
                            <div className="mt-2 flex flex-wrap gap-1.5">
                              <Badge variant="secondary">
                                {task.status === 'doing' ? '进行中' : '待开始'}
                              </Badge>
                              <Badge variant="outline">
                                {task.isImportant ? '重要' : '不重要'}
                              </Badge>
                              <Badge
                                className={
                                  effectivelyUrgent
                                    ? 'border-warning/20 bg-warning-soft text-warning'
                                    : undefined
                                }
                                variant="outline"
                              >
                                {effectivelyUrgent
                                  ? task.isUrgent
                                    ? '基础紧急'
                                    : '紧急（逾期）'
                                  : '非紧急'}
                              </Badge>
                              {overdue && (
                                <Badge variant="destructive">已逾期</Badge>
                              )}
                            </div>
                          </div>
                          <span className="inline-flex items-center gap-1.5 text-caption text-foreground-secondary">
                            <CalendarDays className="size-3.5" aria-hidden="true" />
                            {task.dueDate === null
                              ? '无截止日期'
                              : `截止 ${task.dueDate}`}
                          </span>
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <Button
                            aria-label={`${task.isImportant ? '取消重要' : '设为重要'}：${task.title}`}
                            disabled={pending}
                            onClick={() =>
                              onSetImportance(task, !task.isImportant)
                            }
                            size="sm"
                            type="button"
                            variant={
                              task.isImportant ? 'secondary' : 'outline'
                            }
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
                          <Input
                            aria-label={`任务截止日期：${task.title}`}
                            className="w-[142px]"
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

                        <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-border pt-3">
                          {task.status === 'todo' && (
                            <Button
                              aria-label={`开始任务：${task.title}`}
                              disabled={pending}
                              onClick={() =>
                                onStatusAction(task, 'startTask')
                              }
                              size="sm"
                              type="button"
                              variant="outline"
                            >
                              <CirclePlay data-icon="inline-start" />
                              开始
                            </Button>
                          )}
                          <Button
                            aria-label={`完成任务：${task.title}`}
                            disabled={pending}
                            onClick={() =>
                              onStatusAction(task, 'completeTask')
                            }
                            size="sm"
                            type="button"
                          >
                            <Check data-icon="inline-start" />
                            完成
                          </Button>
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
