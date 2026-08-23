export const TASK_STATUSES = [
  'todo',
  'doing',
  'completed',
  'cancelled',
] as const

export type TaskStatus = (typeof TASK_STATUSES)[number]

export const TASK_STATUS_OPERATIONS = [
  'start',
  'complete',
  'cancel',
  'reopen',
] as const

export type TaskStatusOperation = (typeof TASK_STATUS_OPERATIONS)[number]

export type LocalDate = string

export interface Task {
  readonly id: string
  readonly title: string
  readonly status: TaskStatus
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly isImportant: boolean
  readonly isUrgent: boolean
  readonly dueDate: LocalDate | null
}

export const TASK_QUADRANTS = [
  'importantUrgent',
  'importantNotUrgent',
  'notImportantUrgent',
  'notImportantNotUrgent',
] as const

export type TaskQuadrant = (typeof TASK_QUADRANTS)[number]

export type TasksByQuadrant = Readonly<Record<TaskQuadrant, readonly Task[]>>

export const TASK_DATE_GROUPS = ['today', 'upcoming', 'overdue'] as const

export type TaskDateGroup = (typeof TASK_DATE_GROUPS)[number]

export type TasksByDateGroup = Readonly<Record<TaskDateGroup, readonly Task[]>>

export interface LocalMonth {
  readonly year: number
  readonly month: number
}

export interface TaskCalendarDay {
  readonly date: LocalDate
  readonly dayOfMonth: number
  readonly isCurrentMonth: boolean
  readonly tasks: readonly Task[]
}

const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isTaskStatus(value: unknown): value is TaskStatus {
  return (
    typeof value === 'string' &&
    TASK_STATUSES.some((status) => status === value)
  )
}

export function isTaskStatusOperation(
  value: unknown,
): value is TaskStatusOperation {
  return (
    typeof value === 'string' &&
    TASK_STATUS_OPERATIONS.some((operation) => operation === value)
  )
}

export function isCanonicalLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_LOWERCASE_UUID.test(value)
}

export function isNonEmptyTaskTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isNonNegativeSafeIntegerMilliseconds(
  value: unknown,
): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function getDaysInLocalMonth(
  year: number,
  month: number,
): number | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) {
    return null
  }
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    return null
  }
  return [
    31,
    isLeapYear(year) ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ][month - 1]!
}

export function isValidLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string') {
    return false
  }
  const match = LOCAL_DATE_PATTERN.exec(value)
  if (match === null) {
    return false
  }
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || month < 1 || month > 12 || day < 1) {
    return false
  }
  const daysInMonth = getDaysInLocalMonth(year, month)
  return daysInMonth !== null && day <= daysInMonth
}

export function localDateFromDate(date: Date): LocalDate {
  const year = date.getFullYear().toString().padStart(4, '0')
  const month = (date.getMonth() + 1).toString().padStart(2, '0')
  const day = date.getDate().toString().padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function isTaskOverdue(task: Task, today: LocalDate): boolean {
  return (
    isValidLocalDate(today) &&
    task.dueDate !== null &&
    isValidLocalDate(task.dueDate) &&
    task.dueDate < today &&
    (task.status === 'todo' || task.status === 'doing')
  )
}

export function isTaskEffectivelyUrgent(task: Task, today: LocalDate): boolean {
  return task.isUrgent || isTaskOverdue(task, today)
}

export function getTaskQuadrant(
  task: Task,
  today: LocalDate,
): TaskQuadrant | null {
  if (task.status !== 'todo' && task.status !== 'doing') {
    return null
  }

  const effectivelyUrgent = isTaskEffectivelyUrgent(task, today)
  if (task.isImportant) {
    return effectivelyUrgent ? 'importantUrgent' : 'importantNotUrgent'
  }
  return effectivelyUrgent ? 'notImportantUrgent' : 'notImportantNotUrgent'
}

export function groupTasksByQuadrant(
  tasks: readonly Task[],
  today: LocalDate,
): TasksByQuadrant {
  const groups: Record<TaskQuadrant, Task[]> = {
    importantUrgent: [],
    importantNotUrgent: [],
    notImportantUrgent: [],
    notImportantNotUrgent: [],
  }

  for (const task of tasks) {
    const quadrant = getTaskQuadrant(task, today)
    if (quadrant !== null) {
      groups[quadrant].push(task)
    }
  }

  return groups
}

export function getTaskDateGroup(
  task: Task,
  today: LocalDate,
): TaskDateGroup | null {
  if (
    !isValidLocalDate(today) ||
    task.dueDate === null ||
    !isValidLocalDate(task.dueDate) ||
    (task.status !== 'todo' && task.status !== 'doing')
  ) {
    return null
  }
  if (task.dueDate === today) {
    return 'today'
  }
  if (isTaskOverdue(task, today)) {
    return 'overdue'
  }
  return task.dueDate > today ? 'upcoming' : null
}

export function groupTasksByDate(
  tasks: readonly Task[],
  today: LocalDate,
): TasksByDateGroup {
  const groups: Record<TaskDateGroup, Task[]> = {
    today: [],
    upcoming: [],
    overdue: [],
  }

  for (const task of tasks) {
    const group = getTaskDateGroup(task, today)
    if (group !== null) {
      groups[group].push(task)
    }
  }

  return groups
}

export function localMonthFromLocalDate(
  localDate: LocalDate,
): LocalMonth | null {
  if (!isValidLocalDate(localDate)) {
    return null
  }
  return {
    year: Number(localDate.slice(0, 4)),
    month: Number(localDate.slice(5, 7)),
  }
}

export function shiftLocalMonth(
  localMonth: LocalMonth,
  offset: number,
): LocalMonth | null {
  if (
    getDaysInLocalMonth(localMonth.year, localMonth.month) === null ||
    !Number.isInteger(offset)
  ) {
    return null
  }

  const ordinal = (localMonth.year - 1) * 12 + localMonth.month - 1 + offset
  if (ordinal < 0 || ordinal >= 9999 * 12) {
    return null
  }
  return {
    year: Math.floor(ordinal / 12) + 1,
    month: (ordinal % 12) + 1,
  }
}

function formatLocalDate(year: number, month: number, day: number): LocalDate {
  return `${year.toString().padStart(4, '0')}-${month
    .toString()
    .padStart(2, '0')}-${day.toString().padStart(2, '0')}`
}

function getMondayFirstWeekdayIndex(
  year: number,
  month: number,
  day: number,
): number {
  const monthOffsets = [0, 3, 2, 5, 0, 3, 5, 1, 4, 6, 2, 4]
  const adjustedYear = month < 3 ? year - 1 : year
  const sundayFirst =
    (adjustedYear +
      Math.floor(adjustedYear / 4) -
      Math.floor(adjustedYear / 100) +
      Math.floor(adjustedYear / 400) +
      monthOffsets[month - 1]! +
      day) %
    7
  return (sundayFirst + 6) % 7
}

export function buildTaskCalendarMonth(
  tasks: readonly Task[],
  localMonth: LocalMonth,
): readonly TaskCalendarDay[] {
  const daysInMonth = getDaysInLocalMonth(localMonth.year, localMonth.month)
  const previousMonth = shiftLocalMonth(localMonth, -1)
  const nextMonth = shiftLocalMonth(localMonth, 1)
  if (daysInMonth === null || previousMonth === null || nextMonth === null) {
    return []
  }

  const tasksByDate = new Map<LocalDate, Task[]>()
  for (const task of tasks) {
    if (
      task.dueDate === null ||
      !isValidLocalDate(task.dueDate) ||
      (task.status !== 'todo' && task.status !== 'doing')
    ) {
      continue
    }
    const taskMonth = localMonthFromLocalDate(task.dueDate)
    if (
      taskMonth?.year !== localMonth.year ||
      taskMonth.month !== localMonth.month
    ) {
      continue
    }
    const dateTasks = tasksByDate.get(task.dueDate) ?? []
    dateTasks.push(task)
    tasksByDate.set(task.dueDate, dateTasks)
  }

  const firstDayOffset = getMondayFirstWeekdayIndex(
    localMonth.year,
    localMonth.month,
    1,
  )
  const previousMonthDays = getDaysInLocalMonth(
    previousMonth.year,
    previousMonth.month,
  )!

  return Array.from({ length: 42 }, (_, cellIndex): TaskCalendarDay => {
    const relativeDay = cellIndex - firstDayOffset + 1
    let cellMonth = localMonth
    let dayOfMonth = relativeDay
    let isCurrentMonth = true

    if (relativeDay < 1) {
      cellMonth = previousMonth
      dayOfMonth = previousMonthDays + relativeDay
      isCurrentMonth = false
    } else if (relativeDay > daysInMonth) {
      cellMonth = nextMonth
      dayOfMonth = relativeDay - daysInMonth
      isCurrentMonth = false
    }

    const date = formatLocalDate(cellMonth.year, cellMonth.month, dayOfMonth)
    return {
      date,
      dayOfMonth,
      isCurrentMonth,
      tasks: isCurrentMonth ? (tasksByDate.get(date) ?? []) : [],
    }
  })
}

/**
 * Shared frontend/Web transition rule. A null result is STATUS_CONFLICT.
 */
export function resolveTaskStatusTransition(
  current: TaskStatus,
  operation: TaskStatusOperation,
): TaskStatus | null {
  switch (operation) {
    case 'start':
      return current === 'todo' ? 'doing' : null
    case 'complete':
      return current === 'todo' || current === 'doing' ? 'completed' : null
    case 'cancel':
      return current === 'todo' || current === 'doing' ? 'cancelled' : null
    case 'reopen':
      return current === 'completed' || current === 'cancelled' ? 'todo' : null
  }
}
