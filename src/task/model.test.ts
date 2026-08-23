import { describe, expect, test } from 'vitest'

import {
  DEFAULT_TASK_FILTER,
  TASK_STATUSES,
  TASK_STATUS_OPERATIONS,
  buildTaskCalendarMonth,
  deriveVisibleTasks,
  filterTasks,
  isCanonicalLowercaseUuid,
  getDaysInLocalMonth,
  getTaskDateGroup,
  getTaskQuadrant,
  groupTasksByDate,
  groupTasksByQuadrant,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskEffectivelyUrgent,
  isTaskOverdue,
  isTaskStatus,
  isTaskStatusOperation,
  isValidLocalDate,
  localDateFromDate,
  localMonthFromLocalDate,
  matchesTaskSearch,
  resolveTaskStatusTransition,
  shiftLocalMonth,
  type Task,
  type TaskStatus,
  type TaskStatusOperation,
} from '@/task/model'

const LEGAL_TRANSITIONS: ReadonlyArray<
  readonly [TaskStatus, TaskStatusOperation, TaskStatus]
> = [
  ['todo', 'start', 'doing'],
  ['todo', 'complete', 'completed'],
  ['doing', 'complete', 'completed'],
  ['todo', 'cancel', 'cancelled'],
  ['doing', 'cancel', 'cancelled'],
  ['completed', 'reopen', 'todo'],
  ['cancelled', 'reopen', 'todo'],
]

const TASK: Task = {
  id: '00000000-0000-4000-8000-000000000001',
  title: 'Task',
  status: 'todo',
  createdAtMs: 100,
  updatedAtMs: 100,
  isImportant: false,
  isUrgent: false,
  dueDate: null,
  projectId: null,
  tagIds: [],
}

describe('Task model persistence contract', () => {
  test.each(LEGAL_TRANSITIONS)(
    '%s + %s transitions to %s',
    (current, operation, expected) => {
      expect(resolveTaskStatusTransition(current, operation)).toBe(expected)
    },
  )

  test('rejects every non-approved status-operation combination', () => {
    const legal = new Set(
      LEGAL_TRANSITIONS.map(
        ([current, operation]) => `${current}:${operation}`,
      ),
    )

    for (const current of TASK_STATUSES) {
      for (const operation of TASK_STATUS_OPERATIONS) {
        if (!legal.has(`${current}:${operation}`)) {
          expect(resolveTaskStatusTransition(current, operation)).toBeNull()
        }
      }
    }
  })

  test('validates canonical Gregorian local dates', () => {
    for (const valid of [
      '0001-01-01',
      '2024-02-29',
      '2026-08-23',
      '9999-12-31',
    ]) {
      expect(isValidLocalDate(valid), valid).toBe(true)
    }
    for (const invalid of [
      '0000-01-01',
      '2026-00-01',
      '2026-13-01',
      '2026-02-30',
      '2025-02-29',
      '2026-8-23',
      '2026/08/23',
      null,
    ]) {
      expect(isValidLocalDate(invalid), String(invalid)).toBe(false)
    }
  })

  test('derives today with local calendar getters rather than UTC serialization', () => {
    const date = {
      getFullYear: () => 2026,
      getMonth: () => 7,
      getDate: () => 23,
      toISOString: () => {
        throw new Error('UTC serialization must not be used')
      },
    } as unknown as Date

    expect(localDateFromDate(date)).toBe('2026-08-23')
  })

  test.each([
    { dueDate: null, status: 'todo', expected: false },
    { dueDate: '2026-08-22', status: 'todo', expected: true },
    { dueDate: '2026-08-22', status: 'doing', expected: true },
    { dueDate: '2026-08-23', status: 'todo', expected: false },
    { dueDate: '2026-08-24', status: 'todo', expected: false },
    { dueDate: '2026-08-22', status: 'completed', expected: false },
    { dueDate: '2026-08-22', status: 'cancelled', expected: false },
  ] as const)(
    'derives overdue for $status with deadline $dueDate as $expected',
    ({ dueDate, status, expected }) => {
      expect(isTaskOverdue({ ...TASK, dueDate, status }, '2026-08-23')).toBe(
        expected,
      )
    },
  )

  test.each([
    { isUrgent: true, dueDate: '2026-08-24', status: 'todo', expected: true },
    { isUrgent: false, dueDate: '2026-08-24', status: 'todo', expected: false },
    { isUrgent: false, dueDate: '2026-08-22', status: 'todo', expected: true },
    { isUrgent: true, dueDate: '2026-08-22', status: 'todo', expected: true },
    {
      isUrgent: false,
      dueDate: '2026-08-22',
      status: 'completed',
      expected: false,
    },
    {
      isUrgent: true,
      dueDate: '2026-08-22',
      status: 'completed',
      expected: true,
    },
  ] as const)(
    'derives effective urgency from base urgency and overdue',
    ({ isUrgent, dueDate, status, expected }) => {
      expect(
        isTaskEffectivelyUrgent(
          { ...TASK, isUrgent, dueDate, status },
          '2026-08-23',
        ),
      ).toBe(expected)
    },
  )

  test('validates the frozen status and operation values', () => {
    for (const status of TASK_STATUSES) {
      expect(isTaskStatus(status)).toBe(true)
    }
    for (const operation of TASK_STATUS_OPERATIONS) {
      expect(isTaskStatusOperation(operation)).toBe(true)
    }

    expect(isTaskStatus('archived')).toBe(false)
    expect(isTaskStatusOperation('pause')).toBe(false)
  })

  test('validates persistence input primitives without normalizing them', () => {
    expect(
      isCanonicalLowercaseUuid('12345678-1234-4321-8000-0123456789ab'),
    ).toBe(true)
    expect(
      isCanonicalLowercaseUuid('12345678-1234-4321-8000-0123456789AB'),
    ).toBe(false)
    expect(isCanonicalLowercaseUuid('not-a-uuid')).toBe(false)

    expect(isNonEmptyTaskTitle('  title  ')).toBe(true)
    expect(isNonEmptyTaskTitle('   ')).toBe(false)

    expect(isNonNegativeSafeIntegerMilliseconds(0)).toBe(true)
    expect(isNonNegativeSafeIntegerMilliseconds(1_000)).toBe(true)
    expect(isNonNegativeSafeIntegerMilliseconds(-1)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(1.5)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(Number.MAX_VALUE)).toBe(false)
  })
})

describe('Task quadrant derivation', () => {
  test.each([
    {
      isImportant: true,
      isUrgent: true,
      expected: 'importantUrgent',
    },
    {
      isImportant: true,
      isUrgent: false,
      expected: 'importantNotUrgent',
    },
    {
      isImportant: false,
      isUrgent: true,
      expected: 'notImportantUrgent',
    },
    {
      isImportant: false,
      isUrgent: false,
      expected: 'notImportantNotUrgent',
    },
  ] as const)(
    'maps todo importance=$isImportant urgency=$isUrgent to $expected',
    ({ isImportant, isUrgent, expected }) => {
      expect(
        getTaskQuadrant({ ...TASK, isImportant, isUrgent }, '2026-08-23'),
      ).toBe(expected)
    },
  )

  test('includes doing tasks in the same quadrant rules', () => {
    expect(
      getTaskQuadrant(
        { ...TASK, status: 'doing', isImportant: true, isUrgent: false },
        '2026-08-23',
      ),
    ).toBe('importantNotUrgent')
  })

  test.each(['completed', 'cancelled'] as const)(
    'excludes %s tasks',
    (status) => {
      expect(getTaskQuadrant({ ...TASK, status }, '2026-08-23')).toBeNull()
    },
  )

  test('uses overdue-derived urgency without changing base urgency', () => {
    const overdue = {
      ...TASK,
      isImportant: true,
      isUrgent: false,
      dueDate: '2026-08-22',
    }

    expect(getTaskQuadrant(overdue, '2026-08-23')).toBe('importantUrgent')
    expect(overdue.isUrgent).toBe(false)
  })

  test.each([
    { dueDate: '2026-08-23', expected: 'importantNotUrgent' },
    { dueDate: '2026-08-24', expected: 'importantNotUrgent' },
  ] as const)(
    'keeps a non-base-urgent deadline $dueDate non-urgent',
    ({ dueDate, expected }) => {
      expect(
        getTaskQuadrant({ ...TASK, isImportant: true, dueDate }, '2026-08-23'),
      ).toBe(expected)
    },
  )

  test('future deadlines still respect base urgency', () => {
    expect(
      getTaskQuadrant(
        {
          ...TASK,
          isImportant: false,
          isUrgent: true,
          dueDate: '2026-08-24',
        },
        '2026-08-23',
      ),
    ).toBe('notImportantUrgent')
  })
})

describe('Task quadrant grouping', () => {
  test('groups active tasks, excludes inactive tasks, and preserves list order', () => {
    const q1First = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000011',
      title: 'Q1 first',
      isImportant: true,
      isUrgent: true,
    }
    const q2 = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000012',
      title: 'Q2',
      isImportant: true,
    }
    const completed = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000013',
      title: 'Completed',
      status: 'completed' as const,
    }
    const q1Second = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000014',
      title: 'Q1 second',
      status: 'doing' as const,
      isImportant: true,
      dueDate: '2026-08-22',
    }
    const q3 = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000015',
      title: 'Q3',
      isUrgent: true,
    }
    const q4 = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000016',
      title: 'Q4',
    }
    const cancelled = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000017',
      title: 'Cancelled',
      status: 'cancelled' as const,
    }
    const tasks = [q1First, q2, completed, q1Second, q3, q4, cancelled]
    const snapshot = tasks.map((task) => ({ ...task }))

    const groups = groupTasksByQuadrant(tasks, '2026-08-23')

    expect(groups.importantUrgent).toEqual([q1First, q1Second])
    expect(groups.importantNotUrgent).toEqual([q2])
    expect(groups.notImportantUrgent).toEqual([q3])
    expect(groups.notImportantNotUrgent).toEqual([q4])
    expect(tasks).toEqual(snapshot)
  })

  test('returns four empty groups for an empty task list', () => {
    expect(groupTasksByQuadrant([], '2026-08-23')).toEqual({
      importantUrgent: [],
      importantNotUrgent: [],
      notImportantUrgent: [],
      notImportantNotUrgent: [],
    })
  })
})

describe('Task date grouping', () => {
  test.each([
    { dueDate: '2026-08-23', status: 'todo', expected: 'today' },
    { dueDate: '2026-08-23', status: 'doing', expected: 'today' },
    { dueDate: '2026-08-24', status: 'todo', expected: 'upcoming' },
    { dueDate: '2026-09-01', status: 'doing', expected: 'upcoming' },
    { dueDate: '2026-08-22', status: 'todo', expected: 'overdue' },
    { dueDate: '2026-08-22', status: 'doing', expected: 'overdue' },
    { dueDate: null, status: 'todo', expected: null },
    { dueDate: '2026-08-23', status: 'completed', expected: null },
    { dueDate: '2026-08-24', status: 'cancelled', expected: null },
    { dueDate: 'invalid', status: 'todo', expected: null },
  ] as const)(
    'derives $expected for $status with deadline $dueDate',
    ({ dueDate, status, expected }) => {
      expect(getTaskDateGroup({ ...TASK, dueDate, status }, '2026-08-23')).toBe(
        expected,
      )
    },
  )

  test('rejects classification when today is not a valid local date', () => {
    expect(
      getTaskDateGroup({ ...TASK, dueDate: '2026-08-23' }, '2026-8-23'),
    ).toBeNull()
  })

  test('groups active dated tasks and preserves repository list order', () => {
    const overdueFirst = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000021',
      title: 'Overdue first',
      dueDate: '2026-08-21',
    }
    const todayFirst = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000022',
      title: 'Today first',
      dueDate: '2026-08-23',
    }
    const upcoming = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000023',
      title: 'Upcoming',
      status: 'doing' as const,
      dueDate: '2026-08-24',
    }
    const todaySecond = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000024',
      title: 'Today second',
      status: 'doing' as const,
      dueDate: '2026-08-23',
    }
    const completed = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000025',
      title: 'Completed',
      status: 'completed' as const,
      dueDate: '2026-08-23',
    }
    const overdueSecond = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000026',
      title: 'Overdue second',
      dueDate: '2026-08-22',
    }
    const tasks = [
      overdueFirst,
      todayFirst,
      upcoming,
      todaySecond,
      completed,
      overdueSecond,
    ]
    const snapshot = tasks.map((task) => ({ ...task }))

    expect(groupTasksByDate(tasks, '2026-08-23')).toEqual({
      today: [todayFirst, todaySecond],
      upcoming: [upcoming],
      overdue: [overdueFirst, overdueSecond],
    })
    expect(tasks).toEqual(snapshot)
  })

  test('returns three empty groups for an empty task list', () => {
    expect(groupTasksByDate([], '2026-08-23')).toEqual({
      today: [],
      upcoming: [],
      overdue: [],
    })
  })
})

describe('Task calendar derivation', () => {
  test('reports the correct month length including Gregorian leap years', () => {
    expect(getDaysInLocalMonth(2026, 8)).toBe(31)
    expect(getDaysInLocalMonth(2024, 2)).toBe(29)
    expect(getDaysInLocalMonth(2025, 2)).toBe(28)
    expect(getDaysInLocalMonth(2100, 2)).toBe(28)
    expect(getDaysInLocalMonth(2000, 2)).toBe(29)
  })

  test('builds a Monday-first six-week grid at the real month position', () => {
    const days = buildTaskCalendarMonth([], { year: 2026, month: 8 })

    expect(days).toHaveLength(42)
    expect(days[0]).toMatchObject({
      date: '2026-07-27',
      isCurrentMonth: false,
    })
    expect(days[5]).toMatchObject({
      date: '2026-08-01',
      dayOfMonth: 1,
      isCurrentMonth: true,
    })
    expect(days[35]).toMatchObject({
      date: '2026-08-31',
      dayOfMonth: 31,
      isCurrentMonth: true,
    })
    expect(days[41]).toMatchObject({
      date: '2026-09-06',
      isCurrentMonth: false,
    })
    expect(days.filter((day) => day.isCurrentMonth)).toHaveLength(31)
  })

  test('includes February 29 in a leap-year calendar', () => {
    const leapFebruary = buildTaskCalendarMonth([], { year: 2024, month: 2 })
    const commonFebruary = buildTaskCalendarMonth([], {
      year: 2025,
      month: 2,
    })

    expect(leapFebruary.filter((day) => day.isCurrentMonth).at(-1)?.date).toBe(
      '2024-02-29',
    )
    expect(
      commonFebruary.filter((day) => day.isCurrentMonth).at(-1)?.date,
    ).toBe('2025-02-28')
  })

  test('shifts local months across year boundaries without Date or UTC', () => {
    expect(localMonthFromLocalDate('2026-12-31')).toEqual({
      year: 2026,
      month: 12,
    })
    expect(shiftLocalMonth({ year: 2026, month: 12 }, 1)).toEqual({
      year: 2027,
      month: 1,
    })
    expect(shiftLocalMonth({ year: 2026, month: 1 }, -1)).toEqual({
      year: 2025,
      month: 12,
    })
  })

  test('places multiple active tasks on their due date and excludes inactive or undated tasks', () => {
    const first = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000031',
      title: 'First',
      dueDate: '2026-08-23',
    }
    const second = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000032',
      title: 'Second',
      status: 'doing' as const,
      dueDate: '2026-08-23',
    }
    const completed = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000033',
      title: 'Completed',
      status: 'completed' as const,
      dueDate: '2026-08-23',
    }
    const cancelled = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000034',
      title: 'Cancelled',
      status: 'cancelled' as const,
      dueDate: '2026-08-24',
    }
    const withoutDeadline = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000035',
      title: 'Undated',
    }
    const nextMonth = {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000036',
      title: 'Next month',
      dueDate: '2026-09-01',
    }

    const days = buildTaskCalendarMonth(
      [first, completed, second, cancelled, withoutDeadline, nextMonth],
      { year: 2026, month: 8 },
    )

    expect(days.find((day) => day.date === '2026-08-23')?.tasks).toEqual([
      first,
      second,
    ])
    expect(days.find((day) => day.date === '2026-08-24')?.tasks).toEqual([])
    expect(days.find((day) => day.date === '2026-09-01')?.tasks).toEqual([])
    expect(days.flatMap((day) => day.tasks)).not.toContain(withoutDeadline)
  })
})

describe('Task filter derivation', () => {
  const projectId = '00000000-0000-4000-8000-000000000101'
  const tagId = '00000000-0000-4000-8000-000000000201'
  const tasks: readonly Task[] = [
    {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000041',
      title: 'Matching overdue task',
      status: 'doing',
      isImportant: true,
      dueDate: '2026-08-22',
      projectId,
      tagIds: [tagId],
    },
    {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000042',
      title: 'Today task',
      dueDate: '2026-08-23',
    },
    {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000043',
      title: 'Upcoming urgent task',
      isUrgent: true,
      dueDate: '2026-08-24',
    },
    {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000044',
      title: 'Completed past task',
      status: 'completed',
      dueDate: '2026-08-22',
    },
    {
      ...TASK,
      id: '00000000-0000-4000-8000-000000000045',
      title: 'Cancelled undated urgent task',
      status: 'cancelled',
      isUrgent: true,
    },
  ]

  test.each([
    ['status', { status: 'doing' }, ['Matching overdue task']],
    ['importance', { importance: 'yes' }, ['Matching overdue task']],
    [
      'effective urgency',
      { urgency: 'yes' },
      [
        'Matching overdue task',
        'Upcoming urgent task',
        'Cancelled undated urgent task',
      ],
    ],
    ['today', { date: 'today' }, ['Today task']],
    ['upcoming', { date: 'upcoming' }, ['Upcoming urgent task']],
    ['overdue', { date: 'overdue' }, ['Matching overdue task']],
    ['no deadline', { date: 'none' }, ['Cancelled undated urgent task']],
    ['project', { project: projectId }, ['Matching overdue task']],
    [
      'no project',
      { project: 'none' },
      [
        'Today task',
        'Upcoming urgent task',
        'Completed past task',
        'Cancelled undated urgent task',
      ],
    ],
    ['tag', { tag: tagId }, ['Matching overdue task']],
    [
      'no tag',
      { tag: 'none' },
      [
        'Today task',
        'Upcoming urgent task',
        'Completed past task',
        'Cancelled undated urgent task',
      ],
    ],
  ] as const)('filters by %s', (_name, partial, expectedTitles) => {
    expect(
      filterTasks(
        tasks,
        { ...DEFAULT_TASK_FILTER, ...partial },
        '2026-08-23',
      ).map((task) => task.title),
    ).toEqual(expectedTitles)
  })

  test('combines every dimension with AND without mutating source tasks', () => {
    const result = filterTasks(
      tasks,
      {
        status: 'doing',
        importance: 'yes',
        urgency: 'yes',
        date: 'overdue',
        project: projectId,
        tag: tagId,
      },
      '2026-08-23',
    )

    expect(result).toEqual([tasks[0]])
    expect(tasks).toHaveLength(5)
  })

  test('does not classify completed/cancelled deadlines as active date groups', () => {
    expect(
      filterTasks(
        tasks,
        { ...DEFAULT_TASK_FILTER, date: 'overdue' },
        '2026-08-23',
      ),
    ).not.toContain(tasks[3])
    expect(
      filterTasks(
        tasks,
        { ...DEFAULT_TASK_FILTER, status: 'cancelled', urgency: 'yes' },
        '2026-08-23',
      ),
    ).toEqual([tasks[4]])
  })
})

describe('Task title search derivation', () => {
  const englishTask: Task = { ...TASK, title: 'Write Release Notes' }
  const chineseTask: Task = {
    ...TASK,
    id: '00000000-0000-4000-8000-000000000051',
    title: '整理任务需求',
    isImportant: true,
  }
  const metadataTask: Task = {
    ...TASK,
    id: '00000000-0000-4000-8000-000000000052',
    title: 'Project metadata only',
    projectId: '00000000-0000-4000-8000-000000000101',
    tagIds: ['00000000-0000-4000-8000-000000000201'],
  }
  const tasks: readonly Task[] = [englishTask, chineseTask, metadataTask]

  test.each([
    ['exact title', 'Write Release Notes', true],
    ['substring', 'Release', true],
    ['case-insensitive English', 'write release', true],
    ['trimmed query', '  release notes  ', true],
    ['blank query', '   ', true],
    ['non-match', 'calendar', false],
  ] as const)('%s', (_name, query, expected) => {
    expect(matchesTaskSearch(englishTask, query)).toBe(expected)
  })

  test('matches Chinese by literal substring and only reads Task.title', () => {
    expect(matchesTaskSearch(chineseTask, '任务')).toBe(true)
    expect(matchesTaskSearch(chineseTask, '任 务')).toBe(false)
    expect(matchesTaskSearch(metadataTask, '知行')).toBe(false)
    expect(matchesTaskSearch(metadataTask, 'AI')).toBe(false)
  })

  test('combines search and filters with AND without mutating tasks', () => {
    const result = deriveVisibleTasks(
      tasks,
      { ...DEFAULT_TASK_FILTER, importance: 'yes' },
      '整理',
      '2026-08-23',
    )

    expect(result).toEqual([chineseTask])
    expect(tasks).toHaveLength(3)
  })
})
