import { CalendarDays, ChevronLeft, ChevronRight, Plus } from 'lucide-react'
import { useMemo, useState } from 'react'

import { TaskList, type TaskStatusAction } from '@/components/tasks/TaskList'
import { Button } from '@/components/ui/button'
import type { Project } from '@/project/model'
import {
  buildTaskCalendarMonth,
  isTaskOverdue,
  localMonthFromLocalDate,
  shiftLocalMonth,
  type LocalDate,
  type LocalMonth,
  type Task,
  type TaskCalendarDay,
} from '@/task/model'

interface TaskCalendarViewProps {
  readonly tasks: readonly Task[]
  readonly projects: readonly Project[]
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

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日']

function firstDateOfMonth(localMonth: LocalMonth): LocalDate {
  return `${localMonth.year.toString().padStart(4, '0')}-${localMonth.month
    .toString()
    .padStart(2, '0')}-01`
}

function formatMonth(localMonth: LocalMonth): string {
  return `${localMonth.year}年${localMonth.month}月`
}

function formatSelectedDate(localDate: LocalDate): string {
  const year = Number(localDate.slice(0, 4))
  const month = Number(localDate.slice(5, 7))
  const day = Number(localDate.slice(8, 10))
  return `${year}年${month}月${day}日`
}

function taskAccent(task: Task, today: LocalDate): string {
  if (isTaskOverdue(task, today)) {
    return 'border-l-danger bg-danger-soft/55 text-danger'
  }
  if (task.isImportant) {
    return 'border-l-primary bg-primary-softest text-primary'
  }
  if (task.status === 'doing') {
    return 'border-l-info bg-info-soft/70 text-info'
  }
  return 'border-l-border-strong bg-surface-secondary text-foreground-secondary'
}

function CalendarCell({
  day,
  selectedDate,
  today,
  onSelect,
  onOpenDetail,
  projects,
}: {
  readonly day: TaskCalendarDay
  readonly selectedDate: LocalDate
  readonly today: LocalDate
  readonly onSelect: (day: TaskCalendarDay) => void
  readonly onOpenDetail: (task: Task) => void
  readonly projects: readonly Project[]
}) {
  const selected = day.date === selectedDate
  const isToday = day.date === today
  const shownTasks = day.tasks.slice(0, 3)
  const projectsById = new Map(projects.map((project) => [project.id, project]))

  return (
    <div
      aria-selected={selected}
      className={`group/cell min-h-[102px] min-w-0 border-t border-l border-border p-2 transition-colors first:border-l-0 hover:bg-hover/45 ${
        day.isCurrentMonth ? 'bg-surface' : 'bg-surface-secondary/35'
      } ${selected ? 'relative z-10 bg-primary-softest/50 ring-1 ring-inset ring-primary/35' : ''}`}
      role="gridcell"
    >
      <button
        aria-label={`选择${formatSelectedDate(day.date)}，${day.tasks.length} 项任务`}
        className={`flex size-7 items-center justify-center rounded-full text-auxiliary font-medium transition-colors focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] ${
          isToday
            ? 'bg-primary text-on-primary'
            : day.isCurrentMonth
              ? 'text-foreground hover:bg-hover'
              : 'text-foreground-tertiary hover:bg-hover'
        }`}
        onClick={() => onSelect(day)}
        type="button"
      >
        {day.dayOfMonth}
      </button>

      <div className="mt-1 space-y-1">
        {shownTasks.map((task) => (
          <button
            aria-label={`查看任务详情：${task.title}，截止日期 ${day.date}`}
            className={`block h-6 w-full truncate rounded-[4px] border-l-2 px-1.5 text-left text-[11px] leading-6 font-medium transition-[filter] hover:brightness-[0.97] focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)] ${taskAccent(task, today)}`}
            key={task.id}
            onClick={() => {
              onSelect(day)
              onOpenDetail(task)
            }}
            title={task.title}
            type="button"
          >
            {task.projectId !== null && projectsById.has(task.projectId)
              ? `${projectsById.get(task.projectId)!.name} · `
              : ''}
            {task.title}
          </button>
        ))}
        {day.tasks.length > shownTasks.length && (
          <button
            aria-label={`查看${formatSelectedDate(day.date)}的全部 ${day.tasks.length} 项任务`}
            className="block w-full rounded-[4px] px-1.5 text-left text-[11px] leading-5 text-foreground-tertiary hover:bg-hover hover:text-foreground-secondary focus-visible:outline-none focus-visible:[box-shadow:var(--focus-ring)]"
            onClick={() => onSelect(day)}
            type="button"
          >
            另有 {day.tasks.length - shownTasks.length} 项
          </button>
        )}
      </div>
    </div>
  )
}

export function TaskCalendarView({
  tasks,
  projects,
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
}: TaskCalendarViewProps) {
  const todayMonth = localMonthFromLocalDate(today) ?? { year: 1970, month: 1 }
  const [displayedMonth, setDisplayedMonth] = useState<LocalMonth>(todayMonth)
  const [selectedDate, setSelectedDate] = useState<LocalDate>(today)

  const days = useMemo(
    () => buildTaskCalendarMonth(tasks, displayedMonth),
    [displayedMonth, tasks],
  )
  const selectedTasks =
    days.find((day) => day.date === selectedDate)?.tasks ?? []
  const previousMonth = shiftLocalMonth(displayedMonth, -1)
  const nextMonth = shiftLocalMonth(displayedMonth, 1)

  function showMonth(localMonth: LocalMonth) {
    setDisplayedMonth(localMonth)
    setSelectedDate(firstDateOfMonth(localMonth))
  }

  function selectDay(day: TaskCalendarDay) {
    const selectedMonth = localMonthFromLocalDate(day.date)
    if (selectedMonth !== null && !day.isCurrentMonth) {
      setDisplayedMonth(selectedMonth)
    }
    setSelectedDate(day.date)
  }

  function returnToToday() {
    setDisplayedMonth(todayMonth)
    setSelectedDate(today)
  }

  return (
    <section aria-label="任务日历视图" className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Button
            aria-label="上一月"
            disabled={previousMonth === null}
            onClick={() => previousMonth !== null && showMonth(previousMonth)}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <ChevronLeft aria-hidden="true" />
          </Button>
          <Button
            aria-label="下一月"
            disabled={nextMonth === null}
            onClick={() => nextMonth !== null && showMonth(nextMonth)}
            size="icon-sm"
            type="button"
            variant="outline"
          >
            <ChevronRight aria-hidden="true" />
          </Button>
          <Button
            onClick={returnToToday}
            size="sm"
            type="button"
            variant="outline"
          >
            今天
          </Button>
        </div>

        <h3 className="text-module font-semibold tracking-tight text-foreground">
          {formatMonth(displayedMonth)}
        </h3>

        <p className="min-w-[112px] text-right text-auxiliary text-foreground-secondary">
          {days.reduce((count, day) => count + day.tasks.length, 0)} 项到期任务
        </p>
      </div>

      <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-surface shadow-[0_1px_2px_rgba(15,23,42,0.03)]">
          <div className="grid grid-cols-7 bg-surface-secondary/55" role="row">
            {WEEKDAYS.map((weekday) => (
              <div
                className="px-2 py-2.5 text-center text-auxiliary font-medium text-foreground-secondary"
                key={weekday}
                role="columnheader"
              >
                {weekday}
              </div>
            ))}
          </div>
          <div
            aria-label={`${formatMonth(displayedMonth)}任务月历`}
            className="border-t border-border"
            role="grid"
          >
            {Array.from({ length: 6 }, (_, rowIndex) => (
              <div className="grid grid-cols-7" key={rowIndex} role="row">
                {days.slice(rowIndex * 7, rowIndex * 7 + 7).map((day) => (
                  <CalendarCell
                    day={day}
                    key={day.date}
                    onOpenDetail={onOpenDetail}
                    projects={projects}
                    onSelect={selectDay}
                    selectedDate={selectedDate}
                    today={today}
                  />
                ))}
              </div>
            ))}
          </div>
        </div>

        <aside
          aria-label="所选日期任务"
          className="min-w-0 rounded-lg border border-border bg-surface p-4"
        >
          <div className="flex items-start justify-between gap-3 border-b border-border pb-3">
            <div>
              <p className="text-auxiliary text-foreground-tertiary">
                已选日期
              </p>
              <h4 className="mt-1 text-subtitle font-semibold text-foreground">
                {formatSelectedDate(selectedDate)}
              </h4>
            </div>
            <span className="rounded-full bg-primary-softest px-2 py-1 text-auxiliary font-medium text-primary">
              {selectedTasks.length} 项
            </span>
          </div>

          {selectedTasks.length === 0 ? (
            <div className="flex min-h-[260px] flex-col items-center justify-center px-4 text-center">
              <span className="flex size-11 items-center justify-center rounded-xl bg-surface-secondary text-foreground-tertiary">
                <CalendarDays className="size-5" aria-hidden="true" />
              </span>
              <p className="mt-4 text-body font-medium text-foreground">
                当天暂无到期任务
              </p>
              <p className="mt-1 text-auxiliary text-foreground-secondary">
                新建任务并设置截止日期后会显示在月历中。
              </p>
              <Button
                className="mt-5"
                onClick={onCreate}
                size="sm"
                type="button"
              >
                <Plus data-icon="inline-start" />
                新建任务
              </Button>
            </div>
          ) : (
            <div className="mt-4 max-h-[600px] overflow-y-auto">
              <TaskList
                projects={projects}
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
            </div>
          )}
        </aside>
      </div>
    </section>
  )
}
