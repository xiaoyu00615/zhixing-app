/**
 * P6-S4C · Platform Maintenance Handoff · Coordinator exclusive-session tests
 *
 * Covers the required matrix (spec §34-§40):
 *   - flush settles BEFORE the platform port enter is called (and flush failure
 *     means zero port enter calls, state IDLE)
 *   - success: enter -> EXCLUSIVE_MAINTENANCE, overlap refused, release -> IDLE
 *   - RECOVERABLE enter failure -> IDLE, retry allowed
 *   - BLOCKED enter failure -> state BLOCKED, further maintenance refused
 *   - UNKNOWN (generic throw) -> BLOCKED
 *   - release failure + retry: first rejects, state held, retry succeeds
 *   - concurrent release: single-flight -> one platform release call
 *   - stale release: old lease cannot release a future lease
 */

import { describe, expect, test } from 'vitest'

import { MaintenanceCoordinator } from './coordinator'
import { MaintenanceCoordinatorError } from './model'
import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from './model'

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

/** Drain pending microtasks (no timers: nothing here depends on wall-clock time). */
async function tick(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

class FakeMaintenancePort implements PersistenceMaintenancePort {
  enterMode: 'ok' | 'recoverable' | 'blocked' | 'unknown' = 'ok'
  releaseRejectsFirst = false
  enterCallCount = 0
  releaseCallCount = 0

  enterStrongMaintenance(): Promise<PersistenceMaintenanceLease> {
    this.enterCallCount += 1
    switch (this.enterMode) {
      case 'recoverable':
        return Promise.reject(
          new PersistenceMaintenanceError('FAKE', 'RECOVERABLE', 'recoverable'),
        )
      case 'blocked':
        return Promise.reject(
          new PersistenceMaintenanceError('FAKE', 'BLOCKED', 'blocked'),
        )
      case 'unknown':
        return Promise.reject(new Error('boom'))
    }
    let rejected = false
    const lease: PersistenceMaintenanceLease = {
      leaseId: 'fake-platform-lease',
      release: (): Promise<void> => {
        this.releaseCallCount += 1
        if (this.releaseRejectsFirst && !rejected) {
          rejected = true
          return Promise.reject(new Error('release failed'))
        }
        return Promise.resolve()
      },
    }
    return Promise.resolve(lease)
  }
}

describe('MaintenanceCoordinator.enterExclusiveMaintenance', () => {
  test('ORDER: editor flush settles before the platform port enter is called', async () => {
    const port = new FakeMaintenancePort()
    const coordinator = new MaintenanceCoordinator(port)
    const flush = deferred<void>()
    coordinator.register({ id: 'note-editor', flush: () => flush.promise })

    const enter = coordinator.enterExclusiveMaintenance()
    // Flush is still pending: the coordinator must be flushing, and the platform
    // port must NOT have been entered yet.
    await tick()
    expect(coordinator.getState()).toBe('FLUSHING_EDITORS')
    expect(port.enterCallCount).toBe(0)

    flush.resolve()
    await enter
    expect(port.enterCallCount).toBe(1)
    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')
  })

  test('ORDER: flush failure => no platform enter, state returns to IDLE', async () => {
    const port = new FakeMaintenancePort()
    const coordinator = new MaintenanceCoordinator(port)
    coordinator.register({
      id: 'note-editor',
      flush: () => Promise.reject(new Error('save failed')),
    })

    await expect(coordinator.enterExclusiveMaintenance()).rejects.toThrow(
      'save failed',
    )
    expect(port.enterCallCount).toBe(0)
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('SUCCESS: enter -> EXCLUSIVE, overlap refused, release -> IDLE', async () => {
    const port = new FakeMaintenancePort()
    const coordinator = new MaintenanceCoordinator(port)
    const lease = await coordinator.enterExclusiveMaintenance()

    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')
    expect(lease.leaseId).toMatch(/^excl-/)

    // A second prepare or enter while EXCLUSIVE must be refused (OVERLAP).
    await expect(coordinator.prepareForMaintenance()).rejects.toMatchObject({
      code: 'OVERLAP',
    })
    await expect(coordinator.enterExclusiveMaintenance()).rejects.toMatchObject({
      code: 'OVERLAP',
    })

    await lease.release()
    expect(coordinator.getState()).toBe('IDLE')
    expect(port.releaseCallCount).toBe(1)
  })

  test('RECOVERABLE: port RECOVERABLE => IDLE, retry allowed', async () => {
    const port = new FakeMaintenancePort()
    port.enterMode = 'recoverable'
    const coordinator = new MaintenanceCoordinator(port)

    await expect(coordinator.enterExclusiveMaintenance()).rejects.toThrow(
      /safe to retry/i,
    )
    expect(coordinator.getState()).toBe('IDLE')

    // Safe to attempt again once the transient condition clears.
    port.enterMode = 'ok'
    const lease = await coordinator.enterExclusiveMaintenance()
    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')
    await lease.release()
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('BLOCKED: port BLOCKED => state BLOCKED, further maintenance refused', async () => {
    const port = new FakeMaintenancePort()
    port.enterMode = 'blocked'
    const coordinator = new MaintenanceCoordinator(port)

    await expect(coordinator.enterExclusiveMaintenance()).rejects.toThrow(
      /BLOCKED/i,
    )
    expect(coordinator.getState()).toBe('BLOCKED')

    // While BLOCKED, new high-risk maintenance cannot begin.
    await expect(coordinator.prepareForMaintenance()).rejects.toMatchObject({
      code: 'OVERLAP',
    })
    await expect(coordinator.enterExclusiveMaintenance()).rejects.toMatchObject({
      code: 'OVERLAP',
    })
  })

  test('UNKNOWN: generic throw => treated as BLOCKED', async () => {
    const port = new FakeMaintenancePort()
    port.enterMode = 'unknown'
    const coordinator = new MaintenanceCoordinator(port)

    await expect(coordinator.enterExclusiveMaintenance()).rejects.toThrow(
      /BLOCKED/i,
    )
    expect(coordinator.getState()).toBe('BLOCKED')
  })

  test('RELEASE FAILURE + RETRY: first rejects, state held, retry succeeds', async () => {
    const port = new FakeMaintenancePort()
    port.releaseRejectsFirst = true
    const coordinator = new MaintenanceCoordinator(port)
    const lease = await coordinator.enterExclusiveMaintenance()

    await expect(lease.release()).rejects.toThrow(/release failed/i)
    // The coordinator MUST NOT go IDLE on a release failure.
    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')

    // The SAME handle can be retried; the platform release now succeeds.
    await lease.release()
    expect(coordinator.getState()).toBe('IDLE')
    expect(port.releaseCallCount).toBe(2)
  })

  test('CONCURRENT RELEASE: two concurrent release() => one platform release call', async () => {
    const port = new FakeMaintenancePort()
    const coordinator = new MaintenanceCoordinator(port)
    const lease = await coordinator.enterExclusiveMaintenance()

    await Promise.all([lease.release(), lease.release()])
    expect(port.releaseCallCount).toBe(1)
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('STALE RELEASE: old lease A cannot release future lease B', async () => {
    const port = new FakeMaintenancePort()
    const coordinator = new MaintenanceCoordinator(port)

    const a = await coordinator.enterExclusiveMaintenance()
    await a.release()
    expect(coordinator.getState()).toBe('IDLE')

    const b = await coordinator.enterExclusiveMaintenance()
    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')

    // A is stale; its release must be a NO-OP and must NOT release B's barrier.
    await a.release()
    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')
    expect(port.releaseCallCount).toBe(1) // only A's real release counted

    await b.release()
    expect(coordinator.getState()).toBe('IDLE')
    expect(port.releaseCallCount).toBe(2)
  })

  test('ExclusiveMaintenanceLease errors carry the PERSISTENCE_FAILED code', async () => {
    const port = new FakeMaintenancePort()
    port.enterMode = 'blocked'
    const coordinator = new MaintenanceCoordinator(port)
    try {
      await coordinator.enterExclusiveMaintenance()
      throw new Error('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(MaintenanceCoordinatorError)
      expect((error as MaintenanceCoordinatorError).code).toBe(
        'PERSISTENCE_FAILED',
      )
    }
  })
})
