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
 *   - the only privileged surface is the purpose-bound owner capability, which
 *     is bound to exactly two restore commands and exposes nothing else.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeMaintenancePort } from './maintenance'
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

describe('NativeMaintenancePort · purpose-bound owner capability (P6-S8)', () => {
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
  })

  test('holding the port never yields the capability without asking for it', async () => {
    const port = await enterWithOwner()
    await port.enterStrongMaintenance()

    // While held, the port's own enumerable surface must stay empty: a
    // TypeScript `private` field would be an own property here and could be
    // read (or spread) off the instance. A `#` field cannot.
    expect(Object.keys(port)).toEqual([])
    expect({ ...port }).not.toHaveProperty('capability')
    expect(Object.getOwnPropertyNames(port)).not.toContain('capability')
    // And the accessor is the only way to reach it.
    expect(port.ownerCapability()).not.toBeNull()
  })

  test('the capability exposes ONLY the two purpose-bound methods', async () => {
    const port = await enterWithOwner()
    const lease = await port.enterStrongMaintenance()
    const capability = port.ownerCapability()
    expect(capability).not.toBeNull()
    expect(Object.keys(capability ?? {}).sort()).toEqual([
      'applyRestore',
      'reconcileRestore',
    ])
    // No accessor of any kind can surface the raw owner token.
    const asRecord = capability as unknown as Record<string, unknown>
    expect(asRecord['getToken']).toBeUndefined()
    expect(asRecord['rawOwnerId']).toBeUndefined()
    expect(asRecord['leases']).toBeUndefined()
    // `lease` is still needed for cleanup below.
    expect(lease.leaseId).not.toBe(RAW_OWNER)
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

  test('a successful release retracts the capability', async () => {
    const port = await enterWithOwner()
    const lease = await port.enterStrongMaintenance()
    expect(port.ownerCapability()).not.toBeNull()
    await lease.release()
    expect(port.ownerCapability()).toBeNull()
  })

  test('a FAILED release keeps the capability (the barrier is still held)', async () => {
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
    // The barrier is unproven-released, so the owner capability must survive for
    // the retry / reconcile path.
    expect(port.ownerCapability()).not.toBeNull()
    await lease.release()
    expect(port.ownerCapability()).toBeNull()
  })

  test('a malformed enter never publishes a capability', async () => {
    h.invoke.mockResolvedValue({})
    const port = new NativeMaintenancePort()
    await expect(port.enterStrongMaintenance()).rejects.toBeInstanceOf(
      PersistenceMaintenanceError,
    )
    expect(port.ownerCapability()).toBeNull()
  })
})
