/**
 * P6-S4C · Native Platform Maintenance Adapter tests
 *
 * `invoke` from `@tauri-apps/api/core` is mocked so we verify the adapter's exact
 * command/argument contract and fail-closed semantics (spec §42):
 *   - enter command is `native_maintenance_enter` with no args
 *   - success parses `{ leaseId }` (camelCase)
 *   - malformed success / rejection => BLOCKED
 *   - exit command is `native_maintenance_exit` with the REAL owner id
 *   - release failure is retry-capable; concurrent release is single-flight;
 *     post-success release is a NO-OP
 *
 * P6-S8 adds two properties this file now also guards:
 *   - the RAW native owner token never appears on the published lease;
 *   - the only privileged surface is a purpose-bound owner capability, which is
 *     bound to exactly two restore commands and exposes nothing else.
 *
 * P6-S9R adds the migration purpose and — critically — keeps it SEPARATE:
 * the one hidden owner token yields TWO capabilities of exactly two methods
 * each, never one generic privileged object. §13–§17 of the repair spec are
 * enforced by the `purpose-bound capability separation` block at the bottom:
 * each capability's reachable surface (own + prototype chain) is enumerated and
 * each adapter is driven through a mock source providing ONLY its own purpose.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeMaintenancePort } from './maintenance'
import { NativeBackupRestoreAdapter } from './backupRestore'
import { NativeDataRootMigrationAdapter } from './dataRootMigration'
import { PersistenceMaintenanceError } from '@/maintenance/model'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: h.invoke,
}))

const RAW_OWNER = 'native-maint-0'
const OP_ID = '11111111-1111-4111-8111-111111111111'
const BACKUP_ID = '22222222-2222-4222-8222-222222222222'
const TARGET_ROOT = 'D:\\Data\\zhixing'

describe('NativeMaintenancePort', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('enter invokes native_maintenance_enter with no arguments and parses leaseId', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      expect(cmd).toBe('native_maintenance_enter')
      return { leaseId: RAW_OWNER }
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    // The published lease identity is OPAQUE: the raw owner id must not leak.
    expect(lease.leaseId).not.toBe(RAW_OWNER)
    expect(lease.leaseId).not.toContain('native-maint-')
    expect(lease.leaseId.length).toBeGreaterThan(0)
    expect(h.invoke).toHaveBeenCalledWith('native_maintenance_enter')
  })

  test('two leases never share a published identity', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      return undefined
    })
    const port = new NativeMaintenancePort()
    const a = await port.enterStrongMaintenance()
    await a.release()
    const b = await port.enterStrongMaintenance()
    expect(a.leaseId).not.toBe(b.leaseId)
  })

  test('malformed success lease => BLOCKED', async () => {
    h.invoke.mockResolvedValue({}) // missing leaseId
    const port = new NativeMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(PersistenceMaintenanceError)
    expect((error as PersistenceMaintenanceError).disposition).toBe('BLOCKED')
    expect((error as PersistenceMaintenanceError).code).toBe('MALFORMED_LEASE')
  })

  test('enter rejection => BLOCKED', async () => {
    h.invoke.mockRejectedValue(new Error('native busy'))
    const port = new NativeMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expect(error).toBeInstanceOf(PersistenceMaintenanceError)
    expect((error as PersistenceMaintenanceError).disposition).toBe('BLOCKED')
    expect((error as PersistenceMaintenanceError).code).toBe('NATIVE_ENTER_FAILED')
  })

  test('release invokes native_maintenance_exit with the REAL owner id', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      expect(cmd).toBe('native_maintenance_exit')
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await lease.release()
    const exitCall = h.invoke.mock.calls.find((c) => c[0] === 'native_maintenance_exit')
    expect(exitCall).toBeDefined()
    // The opaque published lease id is NEVER sent to Rust — the command contract
    // needs the real owner id, which is what makes the raw token secret.
    expect(exitCall?.[1]).toEqual({ leaseId: RAW_OWNER })
  })

  test('release failure is retry-capable; eventual success clears the barrier', async () => {
    let exitCount = 0
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      exitCount += 1
      if (exitCount === 1) return Promise.reject(new Error('exit lost'))
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await expect(lease.release()).rejects.toMatchObject({ code: 'NATIVE_EXIT_FAILED' })
    // Retry the SAME handle: now the exit succeeds.
    await lease.release()
    expect(exitCount).toBe(2)
  })

  test('concurrent release => single exit invoke', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await Promise.all([lease.release(), lease.release()])
    const exitCalls = h.invoke.mock.calls.filter(
      (c) => c[0] === 'native_maintenance_exit',
    )
    expect(exitCalls).toHaveLength(1)
  })

  test('post-success release => NO-OP (no second exit invoke)', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await lease.release()
    await lease.release() // stale post-success call
    const exitCalls = h.invoke.mock.calls.filter(
      (c) => c[0] === 'native_maintenance_exit',
    )
    expect(exitCalls).toHaveLength(1)
  })
})

describe('NativeMaintenancePort · purpose-bound owner capability (P6-S8, extended P6-S9)', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  function enterWithOwner(): Promise<NativeMaintenancePort> {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      return undefined
    })
    return Promise.resolve(new NativeMaintenancePort())
  }

  test('no capability exists before a lease is held', () => {
    const port = new NativeMaintenancePort()
    expect(port.ownerCapability()).toBeNull()
    expect(port.dataRootMigrationCapability()).toBeNull()
  })

  test('holding the port never yields a capability without asking for it', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()

    // While held, the port's own enumerable surface must stay empty: a
    // TypeScript `private` field would be an own property here and could be
    // read (or spread) off the instance. A `#` field cannot.
    expect(Object.keys(port)).toEqual([])
    expect({ ...port }).not.toHaveProperty('capability')
    expect(Object.getOwnPropertyNames(port)).not.toContain('capability')
    expect(Object.getOwnPropertyNames(port)).not.toContain('restoreCapability')
    expect(Object.getOwnPropertyNames(port)).not.toContain('migrationCapability')
    expect(JSON.stringify(port)).toEqual('{}')
    // And the two purpose-specific accessors are the only way to reach them.
    expect(port.ownerCapability()).not.toBeNull()
    expect(port.dataRootMigrationCapability()).not.toBeNull()
  })

  /**
   * Every key reachable on `value`: own (enumerable AND non-enumerable) plus,
   * for objects, everything inherited up the prototype chain.
   *
   * A capability is an ordinary object literal, so `Object.keys` alone would
   * under-report; this walks the whole reachable surface so "the migration
   * method is not here" is a real claim rather than a claim about `Object.keys`.
   */
  function reachableSurface(value: unknown): string[] {
    const found = new Set<string>()
    let current: object | null = value as object | null
    while (current !== null && current !== Object.prototype) {
      for (const key of Object.getOwnPropertyNames(current)) {
        found.add(key)
      }
      current = Object.getPrototypeOf(current) as object | null
    }
    return [...found].sort()
  }

  test('the RESTORE capability exposes ONLY the two restore methods', async () => {
    const port = await enterWithOwner()
    const lease = await port.enterStrongMaintenance()
    const capability = port.ownerCapability()
    expect(capability).not.toBeNull()

    // §13: exactly two restore methods and nothing else — in particular NO
    // migration method. This is the property a shared four-method capability
    // violated.
    expect(reachableSurface(capability)).toEqual([
      'applyRestore',
      'reconcileRestore',
    ])
    expect(capability).not.toHaveProperty('applyDataRootMigration')
    expect(capability).not.toHaveProperty('reconcileDataRootMigration')

    // No accessor of any kind can surface the raw owner token.
    expect(capability).not.toHaveProperty('getToken')
    expect(capability).not.toHaveProperty('rawOwnerId')
    expect(capability).not.toHaveProperty('leases')
    expect(JSON.stringify(capability)).not.toContain(RAW_OWNER)
    // `lease` is still needed for cleanup below.
    expect(lease.leaseId).not.toBe(RAW_OWNER)
  })

  test('the MIGRATION capability exposes ONLY the two migration methods', async () => {
    const port = await enterWithOwner()
    const lease = await port.enterStrongMaintenance()
    const capability = port.dataRootMigrationCapability()
    expect(capability).not.toBeNull()

    // §14: exactly two migration methods and nothing else — in particular NO
    // restore method. Restore privilege != Data Root Migration privilege.
    expect(reachableSurface(capability)).toEqual([
      'applyDataRootMigration',
      'reconcileDataRootMigration',
    ])
    expect(capability).not.toHaveProperty('applyRestore')
    expect(capability).not.toHaveProperty('reconcileRestore')

    expect(capability).not.toHaveProperty('getToken')
    expect(capability).not.toHaveProperty('rawOwnerId')
    expect(JSON.stringify(capability)).not.toContain(RAW_OWNER)
    expect(lease.leaseId).not.toBe(RAW_OWNER)
  })

  test('the two capabilities are DIFFERENT objects, neither one a superset', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()
    const restore = port.ownerCapability()
    const migration = port.dataRootMigrationCapability()

    expect(restore).not.toBe(migration)
    // §3: no object ever answers both purposes, so nothing needs — or could —
    // be narrowed with `Pick<...>` at a call site.
    expect(reachableSurface(restore)).not.toContain('applyDataRootMigration')
    expect(reachableSurface(migration)).not.toContain('applyRestore')
  })

  test('applyRestore invokes the restore command with the hidden owner id', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()
    const capability = port.ownerCapability()
    expect(capability).not.toBeNull()

    await capability?.applyRestore({ operationId: OP_ID, backupId: BACKUP_ID })

    const call = h.invoke.mock.calls.find(
      (c) => c[0] === 'native_backup_restore_apply',
    )
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP_ID,
      backupId: BACKUP_ID,
    })
  })

  test('reconcileRestore invokes the reconcile command with the hidden owner id', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()
    const capability = port.ownerCapability()

    await capability?.reconcileRestore({ operationId: OP_ID, backupId: BACKUP_ID })

    const call = h.invoke.mock.calls.find(
      (c) => c[0] === 'native_backup_restore_reconcile',
    )
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP_ID,
      backupId: BACKUP_ID,
    })
  })

  test('applyDataRootMigration invokes the migration command with the hidden owner id', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()
    const capability = port.dataRootMigrationCapability()
    expect(capability).not.toBeNull()

    await capability?.applyDataRootMigration({
      operationId: OP_ID,
      targetDataRoot: TARGET_ROOT,
    })

    const call = h.invoke.mock.calls.find(
      (c) => c[0] === 'native_data_root_migration_apply',
    )
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP_ID,
      targetDataRoot: TARGET_ROOT,
    })
  })

  test('reconcileDataRootMigration invokes the migration reconcile command with the hidden owner id', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()
    const capability = port.dataRootMigrationCapability()

    await capability?.reconcileDataRootMigration({
      operationId: OP_ID,
      targetDataRoot: TARGET_ROOT,
    })

    const call = h.invoke.mock.calls.find(
      (c) => c[0] === 'native_data_root_migration_reconcile',
    )
    expect(call).toBeDefined()
    expect(call?.[1]).toEqual({
      ownerLeaseId: RAW_OWNER,
      operationId: OP_ID,
      targetDataRoot: TARGET_ROOT,
    })
  })

  test('a PROVEN release retracts BOTH capabilities (§17)', async () => {
    const port = await enterWithOwner()
    const lease = await port.enterStrongMaintenance()
    // Enter => both are live.
    expect(port.ownerCapability()).not.toBeNull()
    expect(port.dataRootMigrationCapability()).not.toBeNull()

    await lease.release()

    // Exit proven => BOTH are gone. One barrier, one lifetime: a release may
    // never leave one capability alive while the other is retracted.
    expect(port.ownerCapability()).toBeNull()
    expect(port.dataRootMigrationCapability()).toBeNull()
  })

  test('a FAILED release keeps BOTH capabilities (§17, the barrier is still held)', async () => {
    let exitCount = 0
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      exitCount += 1
      if (exitCount === 1) return Promise.reject(new Error('exit lost'))
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await expect(lease.release()).rejects.toMatchObject({ code: 'NATIVE_EXIT_FAILED' })
    // The barrier is unproven-released (e.g. MAINTENANCE_BUSY), so BOTH
    // capabilities must survive for the retry / reconcile path.
    expect(port.ownerCapability()).not.toBeNull()
    expect(port.dataRootMigrationCapability()).not.toBeNull()

    await lease.release()

    expect(port.ownerCapability()).toBeNull()
    expect(port.dataRootMigrationCapability()).toBeNull()
  })

  test('a malformed enter never publishes either capability', async () => {
    h.invoke.mockResolvedValue({})
    const port = new NativeMaintenancePort()
    await expect(port.enterStrongMaintenance()).rejects.toBeInstanceOf(
      PersistenceMaintenanceError,
    )
    expect(port.ownerCapability()).toBeNull()
    expect(port.dataRootMigrationCapability()).toBeNull()
  })
})

/**
 * §15 · ADAPTER SEPARATION. Each adapter must be drivable through a source that
 * provides ONLY its own purpose. No test fixture has to build — or even is able
 * to build — a four-method capability, because no such object exists.
 */
describe('Purpose-bound capability separation (P6-S9R) · §15 adapter separation', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  const RESTORE_OP = '44444444-4444-4444-8444-444444444444'
  const BACKUP = '55555555-5555-4555-8555-555555555555'
  const SAFETY = '66666666-6666-4666-8666-666666666666'
  const SHA = 'a'.repeat(64)

  test('the RESTORE adapter works with a source that has ONLY the restore capability', async () => {
    const apply = vi.fn(() =>
      Promise.resolve({
        operationId: RESTORE_OP,
        backupId: BACKUP,
        outcome: 'RESTORED',
        safetyBackupId: SAFETY,
        restoredChecksumSha256: SHA,
      }),
    )
    const source = {
      ownerCapability: () => ({ applyRestore: apply, reconcileRestore: vi.fn() }),
    }

    // The fixture itself structurally cannot answer the migration purpose.
    expect(Object.getOwnPropertyNames(source)).toEqual(['ownerCapability'])
    expect(source).not.toHaveProperty('dataRootMigrationCapability')

    const adapter = new NativeBackupRestoreAdapter(source)
    const result = await adapter.applyBackupRestore({
      operationId: RESTORE_OP,
      backupId: BACKUP,
    })

    expect(result.outcome).toBe('RESTORED')
    expect(apply).toHaveBeenCalledTimes(1)
    // Nothing leaked into Tauri: the whole path was satisfied by the mock.
    expect(h.invoke).not.toHaveBeenCalled()
  })

  test('the MIGRATION adapter works with a source that has ONLY the migration capability', async () => {
    const apply = vi.fn(() =>
      Promise.resolve({
        operationId: OP_ID,
        targetDataRoot: TARGET_ROOT,
        outcome: 'MIGRATED',
        safetyBackupId: SAFETY,
      }),
    )
    const source = {
      dataRootMigrationCapability: () => ({
        applyDataRootMigration: apply,
        reconcileDataRootMigration: vi.fn(),
      }),
    }

    // Same shape of claim, other direction: this fixture cannot answer restore.
    expect(Object.getOwnPropertyNames(source)).toEqual([
      'dataRootMigrationCapability',
    ])
    expect(source).not.toHaveProperty('ownerCapability')

    const adapter = new NativeDataRootMigrationAdapter(source)
    const result = await adapter.applyDataRootMigration({
      operationId: OP_ID,
      targetDataRoot: TARGET_ROOT,
    })

    expect(result.outcome).toBe('MIGRATED')
    expect(apply).toHaveBeenCalledTimes(1)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  test('the RESTORE adapter never falls back to a migration method for a restore-only source', async () => {
    // A migration-only source is the WRONG shape; the adapter must refuse rather
    // than widen its dependency at runtime. No cross-cast, no fallback: this is
    // what makes the two contracts genuinely independent.
    const source = {
      dataRootMigrationCapability: () => ({
        applyDataRootMigration: vi.fn(),
        reconcileDataRootMigration: vi.fn(),
      }),
    } as unknown as ConstructorParameters<typeof NativeBackupRestoreAdapter>[0]

    const adapter = new NativeBackupRestoreAdapter(source)
    await expect(
      adapter.applyBackupRestore({ operationId: RESTORE_OP, backupId: BACKUP }),
    ).rejects.toBeInstanceOf(TypeError)
    expect(h.invoke).not.toHaveBeenCalled()
  })

  test('the MIGRATION adapter never falls back to a restore method for a restore-only source', async () => {
    const applyRestore = vi.fn()
    const source = {
      ownerCapability: () => ({
        applyRestore,
        reconcileRestore: vi.fn(),
      }),
    } as unknown as ConstructorParameters<typeof NativeDataRootMigrationAdapter>[0]

    const adapter = new NativeDataRootMigrationAdapter(source)
    await expect(
      adapter.applyDataRootMigration({
        operationId: OP_ID,
        targetDataRoot: TARGET_ROOT,
      }),
    ).rejects.toBeInstanceOf(TypeError)
    // The decisive property: it did NOT quietly use the restore authority.
    expect(applyRestore).not.toHaveBeenCalled()
    expect(h.invoke).not.toHaveBeenCalled()
  })
})

/**
 * §16 · RAW TOKEN. The hidden owner id is readable nowhere — not on the port,
 * not on the lease, not on either capability, whether the barrier is held or
 * its release is unproven.
 *
 * The BLOCKED SESSION surfaces are additionally covered in place by
 * `backupRestore/workflow.test.ts` and `dataRootMigration/workflow.test.ts`
 * ("the session exposes no platform identity" + the real-coordinator cases).
 */
describe('Purpose-bound capability separation (P6-S9R) · §16 raw token surface', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  /** A port holding a live lease. The lease itself is deliberately NOT returned:
   *  only its silence about the owner token is asserted here. */
  async function holdPort(): Promise<NativeMaintenancePort> {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      return undefined
    })
    const port = new NativeMaintenancePort()
    await port.enterStrongMaintenance()
    return port
  }

  test('the token is unreadable while the barrier is held', async () => {
    const port = await holdPort()

    expect(JSON.stringify(port)).not.toContain('native-maint-')
    expect(Object.getOwnPropertyNames(port)).toEqual([])
    for (const capability of [
      port.ownerCapability(),
      port.dataRootMigrationCapability(),
    ]) {
      expect(capability).not.toBeNull()
      expect(JSON.stringify(capability)).not.toContain('native-maint-')
      // Functions are opaque to JSON; their own reachable surface is checked too.
      for (const fn of Object.values(capability ?? {})) {
        expect(JSON.stringify(Object.getOwnPropertyNames(fn))).not.toContain(
          RAW_OWNER,
        )
      }
    }
  })

  test('the token stays unreadable after an UNPROVEN release attempt', async () => {
    let exitCount = 0
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: RAW_OWNER }
      exitCount += 1
      if (exitCount === 1) return Promise.reject(new Error('exit lost'))
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await expect(lease.release()).rejects.toMatchObject({ code: 'NATIVE_EXIT_FAILED' })

    // Still held, still retryable — and still unreadable.
    expect(JSON.stringify(port)).not.toContain('native-maint-')
    expect(port.ownerCapability()).not.toBeNull()
    expect(port.dataRootMigrationCapability()).not.toBeNull()
  })

  test('the published lease carries no part of the token', async () => {
    const port = await holdPort()
    const lease = await port.enterStrongMaintenance()

    expect(lease.leaseId).not.toContain('native-maint-')
    expect(JSON.stringify(Object.keys(lease))).not.toContain('native-maint-')
  })
})
