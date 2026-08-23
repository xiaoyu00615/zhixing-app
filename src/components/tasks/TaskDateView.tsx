import {
  CalendarCheck2,
  CalendarClock,
  Plus,
  TriangleAlert,
} from 'lucide-react'
import { useState } from 'react'

import { TaskList, type TaskStatusAction } from '@/components/tasks/TaskList'
import { Button } from '@/components/ui/button'
import type { Project } from '@/project/model'
import type { Tag } from '@/tag/model'
import {
  TASK_DATE_GROUPS,
  groupTasksByDate,
  type LocalDate,
  type Task,
  type TaskDateGroup,
} from '@/task/model'

interface TaskDateViewProps {
  readonly tasks: readonly Task[]
  readonly projects: readonly Project[]
  readonly tags: readonly Tag[]
  readonly today: LocalDate
  readonly pendingTaskIds: ReadonlySet<string>
  readonly onCreate: () => void
  readonly onOpenDetail: (task: Task) => void
  readonly onRename: (task: Task) => void
  readonly onStatusAction: (task: Task, action: TaskStatusAction) => void
  readonly onSetImportance: (task: Task, isImportant: boolean) => void
  readonly onSetUrgency: (task: Task, isUrgent: boolean) => void
  readonly onSetDeadline: (task: Task, dueDate: LocalDate) => void
  readonly onClearDeadline: (task: Task) => void
}

const DATE_GROUP_PRESENTATION = {
  today: {
    title: '今日',
    description: '截止日期是今天的待办与进行中任务',
    emptyDescription: '今天没有需要到期处理的任务。',
    icon: CalendarCheck2,
    iconClassName: 'bg-primary-softest text-primary',
  },
  upcoming: {
    title: '即将到期',
    description: '截止日期在今天之后的待办与进行中任务',
    emptyDescription: '当前没有未来到期的活动任务。',
    icon: CalendarClock,
    iconClassName: 'bg-info-soft text-info',
  },
  overdue: {
    title: '已逾期',
    description: '已超过截止日期且仍未完成的任务',
    emptyDescription: '当前没有已逾期的活动任务。',
    icon: TriangleAlert,
    iconClassName: 'bg-danger-soft text-danger',
  },
} as const

function formatLocalDateLabel(localDate: LocalDate): string {
  const [, month = '', day = ''] = localDate.split('-')
  return `${Number(month)}月${Number(day)}日`
}

export function TaskDateView({
  tasks,
  projects,
  tags,
  today,
  pendingTaskIds,
  onCreate,
  onOpenDetail,
  onRename,
  onStatusAction,
  onSetImportance,
  onSetUrgency,
  onSetDeadline,
  onClearDeadline,
}: TaskDateViewProps) {
  const [selectedGroup, setSelectedGroup] = useState<TaskDateGroup>('today')
  const groups = groupTasksByDate(tasks, today)
  const selectedTasks = groups[selectedGroup]
  const presentation = DATE_GROUP_PRESENTATION[selectedGroup]
  const SelectedIcon = presentation.icon

  return (
    <section
      aria-label="任务日期视图"
      className="grid min-w-0 gap-4 xl:grid-cols-[232px_minmax(0,1fr)]"
    >
      <aside className="self-start rounded-lg border border-border bg-surface p-3">
        <div className="px-2 pb-3 pt-1">
          <h3 className="text-subtitle font-semibold text-foreground">日期</h3>
          <p className="mt-1 text-caption text-foreground-tertiary">
            今天是 {formatLocalDateLabel(today)}
          </p>
        </div>
        <nav aria-label="任务日期分类" className="space-y-1">
          {TASK_DATE_GROUPS.map((group) => {
            const item = DATE_GROUP_PRESENTATION[group]
            const active = selectedGroup === group
            return (
              <Button
                aria-label={`${item.title}，${groups[group].length} 项任务`}
                aria-pressed={active}
                className={`w-full justify-between px-3 ${
                  active
                    ? 'bg-primary-softest text-primary hover:bg-primary-softest'
                    : 'text-foreground-secondary'
                }`}
                key={group}
                onClick={() => setSelectedGroup(group)}
                type="button"
                variant="ghost"
              >
                <span>{item.title}</span>
                <span
                  aria-hidden="true"
                  className={`inline-flex min-w-6 items-center justify-center rounded-xs px-1.5 py-0.5 text-caption font-semibold ${
                    active
                      ? 'bg-surface text-primary'
                      : 'bg-surface-secondary text-foreground-tertiary'
                  }`}
                >
                  {groups[group].length}
                </span>
              </Button>
            )
          })}
        </nav>
      </aside>

      <div className="min-w-0">
        <header className="mb-4 flex min-h-14 items-center gap-3">
          <span
            aria-hidden="true"
            className={`flex size-10 shrink-0 items-center justify-center rounded-md ${presentation.iconClassName}`}
          >
            <SelectedIcon className="size-5" />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <h3 className="text-module font-semibold text-foreground">
                {presentation.title}
              </h3>
              <span className="text-auxiliary text-foreground-tertiary">
                {selectedTasks.length} 项
              </span>
            </div>
            <p className="mt-0.5 text-auxiliary text-foreground-secondary">
              {presentation.description}
            </p>
          </div>
        </header>

        {selectedTasks.length === 0 ? (
          <div className="flex min-h-[320px] flex-col items-center justify-center rounded-lg border border-border bg-surface px-6 py-10 text-center">
            <span
              aria-hidden="true"
              className={`flex size-12 items-center justify-center rounded-lg ${presentation.iconClassName}`}
            >
              <SelectedIcon className="size-6" />
            </span>
            <p className="mt-4 text-body font-medium text-foreground">
              暂无{presentation.title}任务
            </p>
            <p className="mt-1 text-auxiliary text-foreground-secondary">
              {presentation.emptyDescription}
            </p>
            <Button className="mt-5" onClick={onCreate} type="button">
              <Plus data-icon="inline-start" />
              新建任务
            </Button>
          </div>
        ) : (
          <TaskList
            projects={projects}
            tags={tags}
            onClearDeadline={onClearDeadline}
            onOpenDetail={onOpenDetail}
            onRename={onRename}
            onSetDeadline={onSetDeadline}
            onSetImportance={onSetImportance}
            onSetUrgency={onSetUrgency}
            onStatusAction={onStatusAction}
            pendingTaskIds={pendingTaskIds}
            tasks={selectedTasks}
            today={today}
          />
        )}
      </div>
    </section>
  )
}
