import { describe, expect, test } from 'vitest'

import {
  TASK_STATUSES,
  TASK_STATUS_OPERATIONS,
  isCanonicalLowercaseUuid,
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
