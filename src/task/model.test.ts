import { describe, expect, test } from 'vitest'

import {
  TASK_STATUSES,
  TASK_STATUS_OPERATIONS,
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatus,
  isTaskStatusOperation,
  resolveTaskStatusTransition,
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
