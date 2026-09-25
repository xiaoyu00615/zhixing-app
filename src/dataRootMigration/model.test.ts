/**
 * P6-S9 · Data Root Migration · domain model tests
 *
 * The disposition table is a SAFETY table: it decides whether the caller may
 * release the strong barrier. These tests pin it down explicitly, because a
 * silently "helpful" default (treating an unknown as recoverable) is exactly how
 * a user ends up with two data folders and no idea which one is live.
 */

import { describe, expect, test } from 'vitest'

import {
  DATA_ROOT_MIGRATION_ERROR_CODES,
  DATA_ROOT_MIGRATION_RECONCILE_OUTCOMES,
  DATA_ROOT_MIGRATION_RECONCILE_REASONS,
  DataRootMigrationError,
  dispositionForMigrationCode,
  isDataRootMigrationErrorCode,
  isDataRootMigrationReconcileOutcome,
  isDataRootMigrationReconcileReason,
  isMigrationUuid,
  isUsableTargetDataRoot,
  safeMessageForMigrationCode,
} from './model'

describe('DataRootMigrationError', () => {
  test('an unprovable code is BLOCKED, never RECOVERABLE', () => {
    for (const code of [
      'BOOTSTRAP_CHANGED',
      'SWITCH_INDETERMINATE',
      'TRANSPORT_AMBIGUOUS',
      'PROTOCOL_INVALID',
      'INTERNAL',
    ] as const) {
      expect(dispositionForMigrationCode(code)).toBe('BLOCKED')
    }
  })

  test('a proven-safe code is RECOVERABLE', () => {
    for (const code of [
      'TARGET_INVALID',
      'UNSUPPORTED_SOURCE_LAYOUT',
      'INSUFFICIENT_SPACE',
      'SAFETY_BACKUP_FAILED',
      'COPY_FAILED',
      'VERIFY_FAILED',
      'TARGET_PUBLISH_FAILED',
      'BOOTSTRAP_SWITCH_FAILED',
      'ROLLED_BACK',
      'REQUEST_INVALID',
      'OWNER_UNAVAILABLE',
      'UNSUPPORTED_PLATFORM',
    ] as const) {
      expect(dispositionForMigrationCode(code)).toBe('RECOVERABLE')
    }
  })

  test('every declared code has an explicit disposition and safe message', () => {
    for (const code of DATA_ROOT_MIGRATION_ERROR_CODES) {
      const disposition = dispositionForMigrationCode(code)
      expect(['RECOVERABLE', 'BLOCKED']).toContain(disposition)
      expect(safeMessageForMigrationCode(code).length).toBeGreaterThan(0)
    }
  })

  test('a "nothing was moved" claim is never made for an unprovable outcome', () => {
    // The message table is the only text a user reads about their data. A
    // BLOCKED code must not promise that nothing happened.
    for (const code of [
      'BOOTSTRAP_CHANGED',
      'SWITCH_INDETERMINATE',
      'TRANSPORT_AMBIGUOUS',
      'PROTOCOL_INVALID',
      'INTERNAL',
    ] as const) {
      expect(safeMessageForMigrationCode(code)).not.toContain('nothing was moved')
    }
  })

  test('the error defaults its disposition from the code', () => {
    expect(new DataRootMigrationError('COPY_FAILED', 'x').disposition).toBe(
      'RECOVERABLE',
    )
    expect(new DataRootMigrationError('INTERNAL', 'x').disposition).toBe(
      'BLOCKED',
    )
  })

  test('the error carries a name, code and safe message', () => {
    const error = new DataRootMigrationError('TARGET_INVALID', 'Bad target.')
    expect(error.name).toBe('DataRootMigrationError')
    expect(error.code).toBe('TARGET_INVALID')
    expect(error.safeMessage).toBe('Bad target.')
    expect(error).toBeInstanceOf(Error)
  })
})

describe('guards', () => {
  test('isDataRootMigrationErrorCode accepts only declared codes', () => {
    expect(isDataRootMigrationErrorCode('COPY_FAILED')).toBe(true)
    expect(isDataRootMigrationErrorCode('NOT_A_CODE')).toBe(false)
    expect(isDataRootMigrationErrorCode(7)).toBe(false)
    expect(isDataRootMigrationErrorCode(undefined)).toBe(false)
  })

  test('isDataRootMigrationReconcileOutcome accepts only declared outcomes', () => {
    for (const outcome of DATA_ROOT_MIGRATION_RECONCILE_OUTCOMES) {
      expect(isDataRootMigrationReconcileOutcome(outcome)).toBe(true)
    }
    expect(isDataRootMigrationReconcileOutcome('MAYBE')).toBe(false)
  })

  test('isDataRootMigrationReconcileReason accepts only declared reasons', () => {
    for (const reason of DATA_ROOT_MIGRATION_RECONCILE_REASONS) {
      expect(isDataRootMigrationReconcileReason(reason)).toBe(true)
    }
    expect(isDataRootMigrationReconcileReason('WHATEVER')).toBe(false)
  })

  test('isMigrationUuid requires the canonical lowercase form', () => {
    expect(isMigrationUuid('11111111-1111-4111-8111-111111111111')).toBe(true)
    expect(isMigrationUuid('11111111-1111-4111-8111-11111111111')).toBe(false)
    expect(isMigrationUuid('11111111111141118111111111111111')).toBe(false)
    expect(isMigrationUuid('')).toBe(false)
    expect(isMigrationUuid(null)).toBe(false)
  })

  test('isUsableTargetDataRoot accepts the absolute forms a picker produces', () => {
    expect(isUsableTargetDataRoot('D:\\Data\\zhixing')).toBe(true)
    expect(isUsableTargetDataRoot('C:/Users/me/zhixing')).toBe(true)
    expect(isUsableTargetDataRoot('/home/me/zhixing')).toBe(true)
    expect(isUsableTargetDataRoot('\\\\server\\share\\zhixing')).toBe(true)
    expect(isUsableTargetDataRoot('zhixing')).toBe(false)
    expect(isUsableTargetDataRoot('  ')).toBe(false)
    expect(isUsableTargetDataRoot('')).toBe(false)
    expect(isUsableTargetDataRoot(42)).toBe(false)
  })
})
