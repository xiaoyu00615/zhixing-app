/**
 * P6-S8 · Native backup restore adapter tests
 *
 * Two things are under test here, and the second is a hard gate.
 *
 * 1. Protocol strictness: the adapter re-validates every raw DTO field and never
 *    lets a malformed payload become a domain fact.
 *
 * 2. IPC ACKNOWLEDGEMENT AMBIGUITY. An apply can be rejected (or return garbage)
 *    AFTER the destructive switch already happened. The adapter must therefore
 *    NEVER report "the restore failed" from an unknown. It reconciles the SAME
 *    operation and reports what the disk says:
 *      - COMMITTED      -> success (the restore IS applied)
 *      - NOT_COMMITTED  -> RECOVERABLE failure
 *      - ROLLED_BACK    -> RECOVERABLE failure
 *      - INDETERMINATE  -> BLOCKED
 *
 * The real `NativeMaintenancePort` is used, so the whole chain is exercised and
 * the hidden owner id can be observed at the invoke boundary.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { PersistenceMaintenanceLease } from '@/maintenance/model'

import { BackupRestoreError } from '@/backupRestore/model'
import { NativeBackupRestoreAdapter } from './backupRestore'
import { NativeMaintenancePort } from './maintenance'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: h.invoke,
}))

// The real owner id shape: `native-maint-<uuid-v4>` (high entropy, not a
// predictable sequence). The adapter must treat it as fully opaque.
const RAW_OWNER = 'native-maint-7c9e6679-7425-40de-944b-e07fc1f90ae7'
const OP = '11111111-1111-4111-8111-111111111111'
const BACKUP = '22222222-2222-4222-8222-222222222222'
const SAFETY = '33333333-3333-4333-8333-333333333333'
const SHA = 'b'.repeat(64)
const REQUEST = { operationId: OP, backupId: BACKUP }

const APPLY_OK = {
  operationId: OP,
  backupId: BACKUP,
  outcome: 'RESTORED',
  safetyBackupId: SAFETY,
  restoredChecksumSha256: SHA,
}

function committed() {
  return {
    operationId: OP,
    backupId: BACKUP,
    outcome: 'COMMITTED',
    safetyBackupId: SAFETY,
    restoredChecksumSha256: SHA,
  }
}

function settle(value: unknown): Promise<unknown> {
  if (value instanceof Error) return Promise.reject(value)
  return Promise.resolve(value)
}

/**
 * A thunk that REJECTS the command with a NON-`Error` value.
 *
 * Tauri's `invoke` rejects with the SERIALIZED Rust error — a plain object, or
 * for an opaque failure anything at all — and never an `Error` instance.
 * Reproducing that faithfully is the entire point of the ambiguity tests, so
 * the value is typed `unknown` and thrown as-is: narrowing it to a concrete
 * literal type here would both be a lie and hide the case the adapter must
 * actually survive.
 */
function rejectWith(value: unknown): () => never {
  return () => {
    throw value
  }
}

interface Script {
  // Either a raw transport value or a thunk that produces one. The distinction
  // is made at RUNTIME with `typeof`, so a union here would only be misleading
  // (`unknown` absorbs every constituent, including the function form).
  apply: unknown
  reconcile: unknown
}

async function setup(script: Partial<Script>): Promise<{
  adapter: NativeBackupRestoreAdapter
  port: NativeMaintenancePort
  lease: PersistenceMaintenanceLease
}> {
  const pick = (value: unknown): unknown => {
    if (typeof value === 'function') return (value as () => unknown)()
    return value
  }
  h.invoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'native_maintenance_enter':
        return Promise.resolve({ leaseId: RAW_OWNER })
      case 'native_backup_restore_apply':
        return settle(pick(script.apply))
      case 'native_backup_restore_reconcile':
        return settle(pick(script.reconcile))
      default:
        return Promise.resolve(undefined)
    }
  })
  const port = new NativeMaintenancePort()
  const lease = await port.enterStrongMaintenance()
  return { adapter: new NativeBackupRestoreAdapter(port), port, lease }
}

function callArgs(command: string): unknown {
  const call = h.invoke.mock.calls.find((c) => c[0] === command)
  expect(call).toBeDefined()
  return call?.[1]
}

function callCount(command: string): number {
  return h.invoke.mock.calls.filter((c) => c[0] === command).length
}

describe('NativeBackupRestoreAdapter · protocol', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('a successful apply is parsed and returned', async () => {
    const { adapter } = await setup({ apply: APPLY_OK })

    const result = await adapter.applyBackupRestore(REQUEST)

    expect(result).toEqual({
      operationId: OP,
      backupId: BACKUP,
      outcome: 'RESTORED',
      safetyBackupId: SAFETY,
      restoredChecksumSha256: SHA,
    })
    // The hidden owner id travels with the privileged call and nowhere else.
    expect(callArgs('native_backup_restore_apply')).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP,
      backupId: BACKUP,
    })
    expect(callCount('native_backup_restore_reconcile')).toBe(0)
  })

  test('no owner capability => OWNER_UNAVAILABLE and no invoke', async () => {
    h.invoke.mockReset()
    const port = new NativeMaintenancePort()
    const adapter = new NativeBackupRestoreAdapter(port)

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'OWNER_UNAVAILABLE',
      disposition: 'RECOVERABLE',
    })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  test('a malformed apply success is treated as ambiguous, not as success', async () => {
    const { adapter } = await setup({
      apply: { ...APPLY_OK, restoredChecksumSha256: 'not-a-hash' },
      reconcile: committed(),
    })

    // The reconcile proves it committed, so the adapter reports success — but it
    // got there by reconciling, which is the point.
    const result = await adapter.applyBackupRestore(REQUEST)
    expect(result.outcome).toBe('RESTORED')
    expect(callCount('native_backup_restore_reconcile')).toBe(1)
  })

  test('an apply payload that echoes a different operation is ambiguous', async () => {
    const { adapter } = await setup({
      apply: { ...APPLY_OK, backupId: SAFETY },
      reconcile: committed(),
    })

    await adapter.applyBackupRestore(REQUEST)
    expect(callCount('native_backup_restore_reconcile')).toBe(1)
  })
})

describe('NativeBackupRestoreAdapter · structured failures', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('a structured RECOVERABLE error is reported as-is, with no reconcile', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'BACKUP_VERIFY_FAILED',
        message: 'ignored',
        disposition: 'RECOVERABLE',
      }),
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'BACKUP_VERIFY_FAILED',
      disposition: 'RECOVERABLE',
    })
    expect(callCount('native_backup_restore_reconcile')).toBe(0)
  })

  test('a structured BLOCKED error is reported as-is', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'SWITCH_INDETERMINATE',
        message: 'ignored',
        disposition: 'BLOCKED',
      }),
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'SWITCH_INDETERMINATE',
      disposition: 'BLOCKED',
    })
  })

  test('a backend RECOVERABLE claim never weakens a locally-BLOCKED code', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'ROLLBACK_FAILED',
        message: 'ignored',
        disposition: 'RECOVERABLE',
      }),
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'ROLLBACK_FAILED',
      disposition: 'BLOCKED',
    })
  })

  test('the safe message comes from the local table, never from the payload', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'BACKUP_NOT_FOUND',
        message: 'C:\\Users\\secret\\zhixing.db exploded',
        disposition: 'RECOVERABLE',
      }),
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      safeMessage: 'The selected backup was not found.',
    })
  })
})

describe('NativeBackupRestoreAdapter · IPC acknowledgement ambiguity', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('unknown apply rejection + reconcile COMMITTED => reported as SUCCESS', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: committed(),
    })

    const result = await adapter.applyBackupRestore(REQUEST)

    expect(result.outcome).toBe('RESTORED')
    expect(result.safetyBackupId).toBe(SAFETY)
    // The reconcile used the SAME operation identity and the SAME hidden owner.
    expect(callArgs('native_backup_restore_reconcile')).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP,
      backupId: BACKUP,
    })
  })

  test('unknown apply rejection + reconcile NOT_COMMITTED => RECOVERABLE failure', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: {
        operationId: OP,
        backupId: BACKUP,
        outcome: 'NOT_COMMITTED',
      },
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'SWITCH_FAILED',
      disposition: 'RECOVERABLE',
    })
  })

  test('unknown apply rejection + reconcile ROLLED_BACK => RECOVERABLE failure', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: {
        operationId: OP,
        backupId: BACKUP,
        outcome: 'ROLLED_BACK',
      },
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'ROLLED_BACK',
      disposition: 'RECOVERABLE',
    })
  })

  test('unknown apply rejection + reconcile INDETERMINATE => BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: {
        operationId: OP,
        backupId: BACKUP,
        outcome: 'INDETERMINATE',
        reasonCode: 'LIVE_UNKNOWN_DATABASE',
      },
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'SWITCH_INDETERMINATE',
      disposition: 'BLOCKED',
    })
  })

  test('unknown apply rejection + unknown reconcile rejection => BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: rejectWith(new Error('IPC channel closed again')),
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'TRANSPORT_AMBIGUOUS',
      disposition: 'BLOCKED',
    })
  })

  test('unknown apply rejection + malformed reconcile payload => BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: { outcome: 'COMMITTED' }, // missing operation identity
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
      disposition: 'BLOCKED',
    })
  })

  test('a COMMITTED reconcile without a full result stays BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: { operationId: OP, backupId: BACKUP, outcome: 'COMMITTED' },
    })

    await expect(adapter.applyBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
      disposition: 'BLOCKED',
    })
  })

  test('the ambiguous path NEVER reports a plain failure for an unknown', async () => {
    const { adapter } = await setup({
      apply: rejectWith('not even an error object'),
      reconcile: committed(),
    })

    const result = await adapter.applyBackupRestore(REQUEST)
    expect(result.outcome).toBe('RESTORED')
  })
})

describe('NativeBackupRestoreAdapter · reconcile command', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('reconcile returns the proven outcome', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        backupId: BACKUP,
        outcome: 'INDETERMINATE',
        reasonCode: 'LIVE_MISSING',
      },
    })

    const result = await adapter.reconcileBackupRestore(REQUEST)
    expect(result.outcome).toBe('INDETERMINATE')
    expect(result.reasonCode).toBe('LIVE_MISSING')
    expect(callArgs('native_backup_restore_reconcile')).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP,
      backupId: BACKUP,
    })
  })

  test('a reason code on a non-INDETERMINATE outcome is contradictory', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        backupId: BACKUP,
        outcome: 'COMMITTED',
        reasonCode: 'LIVE_MISSING',
      },
    })

    await expect(adapter.reconcileBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
    })
  })

  test('INDETERMINATE without a reason code is contradictory', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        backupId: BACKUP,
        outcome: 'INDETERMINATE',
      },
    })

    await expect(adapter.reconcileBackupRestore(REQUEST)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
    })
  })

  test('an unknown reconcile outcome is a protocol violation', async () => {
    const { adapter } = await setup({
      reconcile: { operationId: OP, backupId: BACKUP, outcome: 'MAYBE' },
    })

    await expect(adapter.reconcileBackupRestore(REQUEST)).rejects.toBeInstanceOf(
      BackupRestoreError,
    )
  })
})
