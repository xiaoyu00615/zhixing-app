import { describe, expect, test } from 'vitest'

import {
  TASK_STATUSES,
  TASK_STATUS_OPERATIONS,
  isCanonicalLowercaseUuid,
  getTaskQuadrant,
  groupTasksByQuadrant,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskEffectivelyUrgent,
  isTaskOverdue,
  isTaskStatus,
  isTaskStatusOperation,
  isValidLocalDate,
  localDateFromDate,
  resolveTaskStatusTransition,
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
        getTaskQuadrant(
          { ...TASK, isImportant, isUrgent },
          '2026-08-23',
        ),
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
        getTaskQuadrant(
          { ...TASK, isImportant: true, dueDate },
          '2026-08-23',
        ),
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
