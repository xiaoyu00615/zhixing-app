/**
 * P6-S9 · Native data root migration adapter tests
 *
 * Two things are under test here, and the second is a hard gate.
 *
 * 1. Protocol strictness: the adapter re-validates every raw DTO field and never
 *    lets a malformed payload become a domain fact.
 *
 * 2. IPC ACKNOWLEDGEMENT AMBIGUITY. An apply can be rejected (or return garbage)
 *    AFTER the bootstrap switch already happened. The adapter must therefore
 *    NEVER report "the move failed" from an unknown. It reconciles the SAME
 *    operation and reports what the disk says:
 *      - COMMITTED      -> success (the migration IS applied)
 *      - NOT_COMMITTED  -> RECOVERABLE failure
 *      - ROLLED_BACK    -> RECOVERABLE failure
 *      - INDETERMINATE  -> BLOCKED
 *
 * The real `NativeMaintenancePort` is used, so the whole chain is exercised and
 * the hidden owner id can be observed at the invoke boundary.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import type { PersistenceMaintenanceLease } from '@/maintenance/model'

import { DataRootMigrationError } from '@/dataRootMigration/model'
import { NativeDataRootMigrationAdapter } from './dataRootMigration'
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
const SAFETY = '33333333-3333-4333-8333-333333333333'
const TARGET = 'D:\\Data\\zhixing'
const REQUEST = { operationId: OP, targetDataRoot: TARGET }

const APPLY_OK = {
  operationId: OP,
  targetDataRoot: TARGET,
  outcome: 'MIGRATED',
  safetyBackupId: SAFETY,
}

function committed() {
  return {
    operationId: OP,
    targetDataRoot: TARGET,
    outcome: 'COMMITTED',
    safetyBackupId: SAFETY,
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
  adapter: NativeDataRootMigrationAdapter
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
      case 'native_data_root_migration_apply':
        return settle(pick(script.apply))
      case 'native_data_root_migration_reconcile':
        return settle(pick(script.reconcile))
      default:
        return Promise.resolve(undefined)
    }
  })
  const port = new NativeMaintenancePort()
  const lease = await port.enterStrongMaintenance()
  return { adapter: new NativeDataRootMigrationAdapter(port), port, lease }
}

function callArgs(command: string): unknown {
  const call = h.invoke.mock.calls.find((c) => c[0] === command)
  expect(call).toBeDefined()
  return call?.[1]
}

function callCount(command: string): number {
  return h.invoke.mock.calls.filter((c) => c[0] === command).length
}

describe('NativeDataRootMigrationAdapter · protocol', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('a successful apply is parsed and returned', async () => {
    const { adapter } = await setup({ apply: APPLY_OK })

    const result = await adapter.applyDataRootMigration(REQUEST)

    expect(result).toEqual({
      operationId: OP,
      targetDataRoot: TARGET,
      outcome: 'MIGRATED',
      safetyBackupId: SAFETY,
    })
    // The hidden owner id travels with the privileged call and nowhere else.
    expect(callArgs('native_data_root_migration_apply')).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP,
      targetDataRoot: TARGET,
    })
    expect(callCount('native_data_root_migration_reconcile')).toBe(0)
  })

  test('no owner capability => OWNER_UNAVAILABLE and no invoke', async () => {
    h.invoke.mockReset()
    const port = new NativeMaintenancePort()
    const adapter = new NativeDataRootMigrationAdapter(port)

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'OWNER_UNAVAILABLE',
      disposition: 'RECOVERABLE',
    })
    expect(h.invoke).not.toHaveBeenCalled()
  })

  test('the backend may return a normalised target root without becoming ambiguous', async () => {
    // The authoritative root comes from the backend's own journal: a caller
    // spelling of `d:/data/zhixing` legitimately comes back as
    // `D:\Data\zhixing`. Demanding a byte-exact echo would reject a correct
    // answer, so only the OPERATION identity must match.
    const { adapter } = await setup({
      apply: { ...APPLY_OK, targetDataRoot: 'D:\\Data\\zhixing' },
    })

    const result = await adapter.applyDataRootMigration({
      operationId: OP,
      targetDataRoot: 'd:/data/zhixing',
    })

    expect(result.outcome).toBe('MIGRATED')
    expect(result.targetDataRoot).toBe('D:\\Data\\zhixing')
    expect(callCount('native_data_root_migration_reconcile')).toBe(0)
  })

  test('a malformed apply success is treated as ambiguous, not as success', async () => {
    const { adapter } = await setup({
      apply: { ...APPLY_OK, safetyBackupId: 'not-a-uuid' },
      reconcile: committed(),
    })

    // The reconcile proves it committed, so the adapter reports success — but it
    // got there by reconciling, which is the point.
    const result = await adapter.applyDataRootMigration(REQUEST)
    expect(result.outcome).toBe('MIGRATED')
    expect(callCount('native_data_root_migration_reconcile')).toBe(1)
  })

  test('an apply payload that names a different operation is ambiguous', async () => {
    const { adapter } = await setup({
      apply: { ...APPLY_OK, operationId: SAFETY },
      reconcile: committed(),
    })

    await adapter.applyDataRootMigration(REQUEST)
    expect(callCount('native_data_root_migration_reconcile')).toBe(1)
  })

  test('an empty target root in the payload is ambiguous', async () => {
    const { adapter } = await setup({
      apply: { ...APPLY_OK, targetDataRoot: '   ' },
      reconcile: committed(),
    })

    await adapter.applyDataRootMigration(REQUEST)
    expect(callCount('native_data_root_migration_reconcile')).toBe(1)
  })
})

describe('NativeDataRootMigrationAdapter · structured failures', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('a structured RECOVERABLE error is reported as-is, with no reconcile', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'VERIFY_FAILED',
        message: 'ignored',
        disposition: 'RECOVERABLE',
      }),
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
      disposition: 'RECOVERABLE',
    })
    expect(callCount('native_data_root_migration_reconcile')).toBe(0)
  })

  test('a structured BLOCKED error is reported as-is', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'SWITCH_INDETERMINATE',
        message: 'ignored',
        disposition: 'BLOCKED',
      }),
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'SWITCH_INDETERMINATE',
      disposition: 'BLOCKED',
    })
  })

  test('a backend RECOVERABLE claim never weakens a locally-BLOCKED code', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'BOOTSTRAP_CHANGED',
        message: 'ignored',
        disposition: 'RECOVERABLE',
      }),
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'BOOTSTRAP_CHANGED',
      disposition: 'BLOCKED',
    })
  })

  test('the safe message comes from the local table, never from the payload', async () => {
    const { adapter } = await setup({
      apply: rejectWith({
        code: 'TARGET_INVALID',
        message: 'C:\\Users\\secret\\zhixing.db exploded',
        disposition: 'RECOVERABLE',
      }),
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      safeMessage: 'The destination folder is not usable.',
    })
  })
})

describe('NativeDataRootMigrationAdapter · IPC acknowledgement ambiguity', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('unknown apply rejection + reconcile COMMITTED => reported as SUCCESS', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: committed(),
    })

    const result = await adapter.applyDataRootMigration(REQUEST)

    expect(result.outcome).toBe('MIGRATED')
    expect(result.safetyBackupId).toBe(SAFETY)
    // The reconcile used the SAME operation identity and the SAME hidden owner.
    expect(callArgs('native_data_root_migration_reconcile')).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP,
      targetDataRoot: TARGET,
    })
  })

  test('unknown apply rejection + reconcile NOT_COMMITTED => RECOVERABLE failure', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'NOT_COMMITTED',
      },
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'BOOTSTRAP_SWITCH_FAILED',
      disposition: 'RECOVERABLE',
    })
  })

  test('unknown apply rejection + reconcile ROLLED_BACK => RECOVERABLE failure', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'ROLLED_BACK',
      },
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'ROLLED_BACK',
      disposition: 'RECOVERABLE',
    })
  })

  test('unknown apply rejection + reconcile INDETERMINATE => BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'INDETERMINATE',
        reasonCode: 'BOOTSTRAP_POINTS_NEITHER',
      },
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'SWITCH_INDETERMINATE',
      disposition: 'BLOCKED',
    })
  })

  test('unknown apply rejection + unknown reconcile rejection => BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: rejectWith(new Error('IPC channel closed again')),
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'TRANSPORT_AMBIGUOUS',
      disposition: 'BLOCKED',
    })
  })

  test('unknown apply rejection + malformed reconcile payload => BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: { outcome: 'COMMITTED' }, // missing operation identity
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
      disposition: 'BLOCKED',
    })
  })

  test('a COMMITTED reconcile without a safety backup stays BLOCKED', async () => {
    const { adapter } = await setup({
      apply: rejectWith(new Error('IPC channel closed')),
      reconcile: { operationId: OP, targetDataRoot: TARGET, outcome: 'COMMITTED' },
    })

    await expect(adapter.applyDataRootMigration(REQUEST)).rejects.toMatchObject({
      code: 'PROTOCOL_INVALID',
      disposition: 'BLOCKED',
    })
  })

  test('the ambiguous path NEVER reports a plain failure for an unknown', async () => {
    const { adapter } = await setup({
      apply: rejectWith('not even an error object'),
      reconcile: committed(),
    })

    const result = await adapter.applyDataRootMigration(REQUEST)
    expect(result.outcome).toBe('MIGRATED')
  })
})

describe('NativeDataRootMigrationAdapter · reconcile command', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('reconcile returns the proven outcome', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'INDETERMINATE',
        reasonCode: 'SOURCE_INVALID',
      },
    })

    const result = await adapter.reconcileDataRootMigration(REQUEST)
    expect(result.outcome).toBe('INDETERMINATE')
    expect(result.reasonCode).toBe('SOURCE_INVALID')
    expect(callArgs('native_data_root_migration_reconcile')).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP,
      targetDataRoot: TARGET,
    })
  })

  test('a reason code on a non-INDETERMINATE outcome is contradictory', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'COMMITTED',
        reasonCode: 'SOURCE_INVALID',
      },
    })

    await expect(
      adapter.reconcileDataRootMigration(REQUEST),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
  })

  test('INDETERMINATE without a reason code is contradictory', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'INDETERMINATE',
      },
    })

    await expect(
      adapter.reconcileDataRootMigration(REQUEST),
    ).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' })
  })

  test('an unknown reconcile outcome is a protocol violation', async () => {
    const { adapter } = await setup({
      reconcile: {
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'MAYBE',
      },
    })

    await expect(
      adapter.reconcileDataRootMigration(REQUEST),
    ).rejects.toBeInstanceOf(DataRootMigrationError)
  })
})
