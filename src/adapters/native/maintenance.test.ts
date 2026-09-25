/**
 * P6-S4C · Native Platform Maintenance Adapter tests
 *
 * `invoke` from `@tauri-apps/api/core` is mocked so we verify the adapter's exact
 * command/argument contract and fail-closed semantics (spec §42):
 *   - enter command is `native_maintenance_enter` with no args
 *   - success parses `{ leaseId }` (camelCase)
 *   - malformed success / rejection => BLOCKED
 *   - exit command is `native_maintenance_exit` with `{ leaseId }`
 *   - release failure is retry-capable; concurrent release is single-flight;
 *     post-success release is a NO-OP
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

describe('NativeMaintenancePort', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('enter invokes native_maintenance_enter with no arguments and parses leaseId', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      expect(cmd).toBe('native_maintenance_enter')
      return { leaseId: 'native-maint-0' }
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    expect(lease.leaseId).toBe('native-maint-0')
    expect(h.invoke).toHaveBeenCalledWith('native_maintenance_enter')
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

  test('release invokes native_maintenance_exit with { leaseId }', async () => {
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: 'native-maint-0' }
      expect(cmd).toBe('native_maintenance_exit')
      return undefined
    })
    const port = new NativeMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    await lease.release()
    const exitCall = h.invoke.mock.calls.find((c) => c[0] === 'native_maintenance_exit')
    expect(exitCall).toBeDefined()
    expect(exitCall?.[1]).toEqual({ leaseId: 'native-maint-0' })
  })

  test('release failure is retry-capable; eventual success clears the barrier', async () => {
    let exitCount = 0
    h.invoke.mockImplementation((cmd: string) => {
      if (cmd === 'native_maintenance_enter') return { leaseId: 'native-maint-0' }
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
      if (cmd === 'native_maintenance_enter') return { leaseId: 'native-maint-0' }
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
      if (cmd === 'native_maintenance_enter') return { leaseId: 'native-maint-0' }
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
