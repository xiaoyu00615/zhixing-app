/**
 * P6-S8 · Backup Restore · domain model tests
 *
 * The disposition table is a SAFETY table: it decides whether the caller may
 * release the strong barrier. These tests pin it down explicitly, because a
 * silently "helpful" default (treating an unknown as recoverable) is exactly how
 * a database gets replaced without anyone noticing.
 */

import { describe, expect, test } from 'vitest'

import {
  BACKUP_RESTORE_ERROR_CODES,
  BACKUP_RESTORE_RECONCILE_OUTCOMES,
  BACKUP_RESTORE_RECONCILE_REASONS,
  BackupRestoreError,
  dispositionForRestoreCode,
  isBackupRestoreErrorCode,
  isBackupRestoreReconcileOutcome,
  isBackupRestoreReconcileReason,
  isRestoreSha256Hex,
  isRestoreUuid,
  safeMessageForRestoreCode,
} from './model'

describe('BackupRestoreError', () => {
  test('an unprovable code is BLOCKED, never RECOVERABLE', () => {
    for (const code of [
      'SWITCH_INDETERMINATE',
      'ROLLBACK_FAILED',
      'TRANSPORT_AMBIGUOUS',
      'PROTOCOL_INVALID',
      'INTERNAL',
    ] as const) {
      expect(dispositionForRestoreCode(code)).toBe('BLOCKED')
    }
  })

  test('a proven-safe code is RECOVERABLE', () => {
    for (const code of [
      'BACKUP_NOT_FOUND',
      'BACKUP_VERIFY_FAILED',
      'OWNER_MISMATCH',
      'SAFETY_BACKUP_FAILED',
      'CHECKPOINT_FAILED',
      'SWITCH_FAILED',
      'ROLLED_BACK',
      'REQUEST_INVALID',
    ] as const) {
      expect(dispositionForRestoreCode(code)).toBe('RECOVERABLE')
    }
  })

  test('every declared code has an explicit disposition and safe message', () => {
    for (const code of BACKUP_RESTORE_ERROR_CODES) {
      const disposition = dispositionForRestoreCode(code)
      expect(['RECOVERABLE', 'BLOCKED']).toContain(disposition)
      expect(safeMessageForRestoreCode(code).length).toBeGreaterThan(0)
    }
  })

  test('the error defaults its disposition from the code', () => {
    expect(new BackupRestoreError('SWITCH_FAILED', 'x').disposition).toBe(
      'RECOVERABLE',
    )
    expect(new BackupRestoreError('INTERNAL', 'x').disposition).toBe('BLOCKED')
  })

  test('the error carries a name, code and safe message', () => {
    const error = new BackupRestoreError('BACKUP_INVALID', 'Damaged.')
    expect(error.name).toBe('BackupRestoreError')
    expect(error.code).toBe('BACKUP_INVALID')
    expect(error.safeMessage).toBe('Damaged.')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('guards', () => {
  test('isBackupRestoreErrorCode accepts only declared codes', () => {
    expect(isBackupRestoreErrorCode('SWITCH_FAILED')).toBe(true)
    expect(isBackupRestoreErrorCode('NOT_A_CODE')).toBe(false)
    expect(isBackupRestoreErrorCode(7)).toBe(false)
    expect(isBackupRestoreErrorCode(undefined)).toBe(false)
  })

  test('isBackupRestoreReconcileOutcome accepts only declared outcomes', () => {
    for (const outcome of BACKUP_RESTORE_RECONCILE_OUTCOMES) {
      expect(isBackupRestoreReconcileOutcome(outcome)).toBe(true)
    }
    expect(isBackupRestoreReconcileOutcome('MAYBE')).toBe(false)
  })

  test('isBackupRestoreReconcileReason accepts only declared reasons', () => {
    for (const reason of BACKUP_RESTORE_RECONCILE_REASONS) {
      expect(isBackupRestoreReconcileReason(reason)).toBe(true)
    }
    expect(isBackupRestoreReconcileReason('WHATEVER')).toBe(false)
  })

  test('isRestoreUuid requires the canonical lowercase form', () => {
    expect(isRestoreUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isRestoreUuid('11111111-1111-4111-8111-11111111111')).toBe(false)
    expect(isRestoreUuid('11111111111141118111111111111111')).toBe(false)
    expect(isRestoreUuid('')).toBe(false)
    expect(isRestoreUuid(null)).toBe(false)
  })

  test('isRestoreSha256Hex requires 64 lowercase hex characters', () => {
    expect(isRestoreSha256Hex('a'.repeat(64))).toBe(true)
    expect(isRestoreSha256Hex('A'.repeat(64))).toBe(false)
    expect(isRestoreSha256Hex('a'.repeat(63))).toBe(false)
    expect(isRestoreSha256Hex(42)).toBe(false)
  })
})
