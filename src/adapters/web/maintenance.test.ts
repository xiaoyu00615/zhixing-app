/**
 * P6-S4C · Web Platform Maintenance Adapter tests
 *
 * The real `WebTaskRepository` reservation primitive is mocked so we exercise the
 * adapter's outcome mapping in isolation (spec §41). The key invariants:
 *   - BARRIER_UNAVAILABLE  -> reservation released, RECOVERABLE
 *   - NORMAL_CLOSE_FAILED   -> reservation released, RECOVERABLE
 *   - CLOSE_INDETERMINATE   -> reservation NOT released, BLOCKED
 *   - NOT_OWNER             -> reservation NOT released, BLOCKED
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { WebMaintenancePort } from './maintenance'
import { PersistenceMaintenanceError } from '@/maintenance/model'
import {
  reserveSharedWebPersistenceSlot,
  type SharedWebPersistenceRetirementOutcome,
} from './WebTaskRepository'

const h = vi.hoisted(() => ({
  reserveSeq: 0,
  releaseCalls: [] as string[],
  overlap: false,
  // Typed as the real retired-generation union so the failure reasons below
  // (`{ ok: false, reason }`) are assignable, not just the success statuses.
  retireResult: Promise.resolve<SharedWebPersistenceRetirementOutcome>({
    ok: true,
    status: 'NO_RUNTIME',
  }),
}))

vi.mock('./WebTaskRepository', () => ({
  reserveSharedWebPersistenceSlot: vi.fn(() => {
    if (h.overlap) {
      return { ok: false, reason: 'OVERLAP' }
    }
    const reservationId = `web-reservation-${h.reserveSeq++}`
    return {
      ok: true,
      reservation: {
        reservationId,
        release: () => {
          h.releaseCalls.push(reservationId)
          return Promise.resolve()
        },
        retireGeneration: () => h.retireResult,
      },
    }
  }),
}))

function expectErrorDisposition(
  error: unknown,
  disposition: 'RECOVERABLE' | 'BLOCKED',
  code?: string,
): void {
  expect(error).toBeInstanceOf(PersistenceMaintenanceError)
  const e = error as PersistenceMaintenanceError
  expect(e.disposition).toBe(disposition)
  if (code !== undefined) {
    expect(e.code).toBe(code)
  }
}

describe('WebMaintenancePort', () => {
  beforeEach(() => {
    h.reserveSeq = 0
    h.releaseCalls = []
    h.overlap = false
    h.retireResult = Promise.resolve({ ok: true, status: 'NO_RUNTIME' })
    vi.mocked(reserveSharedWebPersistenceSlot).mockClear()
  })

  test('success RETIRED: returns a lease bound to the reservation id', async () => {
    h.retireResult = Promise.resolve({ ok: true, status: 'RETIRED' })
    const port = new WebMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    expect(lease.leaseId).toBe('web-reservation-0')
    expect(h.releaseCalls).toHaveLength(0) // not released on success
    await lease.release()
    expect(h.releaseCalls).toEqual(['web-reservation-0'])
  })

  test('success NO_RUNTIME: returns a lease', async () => {
    h.retireResult = Promise.resolve({ ok: true, status: 'NO_RUNTIME' })
    const port = new WebMaintenancePort()
    const lease = await port.enterStrongMaintenance()
    expect(lease.leaseId).toBe('web-reservation-0')
    expect(h.releaseCalls).toHaveLength(0)
    await lease.release()
    expect(h.releaseCalls).toHaveLength(1)
  })

  test('reservation OVERLAP: RECOVERABLE, no owner released', async () => {
    h.overlap = true
    const port = new WebMaintenancePort()
    await expect(port.enterStrongMaintenance()).rejects.toMatchObject({
      disposition: 'RECOVERABLE',
    })
    expect(h.releaseCalls).toHaveLength(0)
  })

  test('BARRIER_UNAVAILABLE: reservation released, RECOVERABLE', async () => {
    h.retireResult = Promise.resolve({ ok: false, reason: 'BARRIER_UNAVAILABLE' })
    const port = new WebMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expectErrorDisposition(error, 'RECOVERABLE', 'BARRIER_UNAVAILABLE')
    expect(h.releaseCalls).toEqual(['web-reservation-0'])
  })

  test('NORMAL_CLOSE_FAILED: reservation released, RECOVERABLE', async () => {
    h.retireResult = Promise.resolve({ ok: false, reason: 'NORMAL_CLOSE_FAILED' })
    const port = new WebMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expectErrorDisposition(error, 'RECOVERABLE', 'NORMAL_CLOSE_FAILED')
    expect(h.releaseCalls).toEqual(['web-reservation-0'])
  })

  test('CLOSE_INDETERMINATE: reservation NOT released, BLOCKED', async () => {
    h.retireResult = Promise.resolve({ ok: false, reason: 'CLOSE_INDETERMINATE' })
    const port = new WebMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expectErrorDisposition(error, 'BLOCKED', 'CLOSE_INDETERMINATE')
    expect(h.releaseCalls).toHaveLength(0)
  })

  test('NOT_OWNER: reservation NOT released, BLOCKED', async () => {
    h.retireResult = Promise.resolve({ ok: false, reason: 'NOT_OWNER' })
    const port = new WebMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expectErrorDisposition(error, 'BLOCKED', 'NOT_OWNER')
    expect(h.releaseCalls).toHaveLength(0)
  })

  test('unexpected retirement rejection: BLOCKED (fail closed)', async () => {
    h.retireResult = Promise.reject(new Error('transport down'))
    const port = new WebMaintenancePort()
    let error: unknown
    try {
      await port.enterStrongMaintenance()
    } catch (e) {
      error = e
    }
    expectErrorDisposition(error, 'BLOCKED', 'RETIREMENT_TRANSPORT')
    expect(h.releaseCalls).toHaveLength(0)
  })
})
