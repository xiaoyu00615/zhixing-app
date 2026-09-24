/**
 * P6-S2R · Editor Quiesce Correctness Repair · Coordinator unit tests
 *
 * Covers the required matrix:
 *   A. no participants -> prepare resolves
 *   B. active participant flush pending -> prepare waits then resolves
 *   C. active flush rejects -> prepare rejects, safe non-maintenance state
 *   D. overlap during PREPARING/FLUSHING -> second prepare rejected predictably
 *   E. retiring participant pending -> prepare awaits the retirement
 *   F. retiring completion rejects -> prepare fails (failure not forgotten)
 *   G. StrictMode-like register/retire/register -> ACTIVE + RETIRING coexist
 *   H. same logical id: RETIRING A + ACTIVE B -> prepare waits A even after B
 *      flush resolves (a remount must NOT cancel a pending retirement)
 *   I. same logical id: a rejected retirement survives a remount and blocks
 *      prepare (the new instance must not clear the failure evidence)
 *   J. PREPARED lease ownership: second prepare rejected while PREPARED, explicit
 *      release returns IDLE, prepare again allowed
 *   K. latched fault survives remount; explicit acknowledgement recovers it
 *   L. acknowledging an unknown logical id is a NO-OP
 *   M. acknowledgement is selective (Note cleared, Diary fault remains)
 *   N. release is idempotent + owner-scoped; stale lease cannot unlock a newer one
 *   O. a failed preparation never yields a usable lease
 */

import { describe, expect, test } from 'vitest'

import { MaintenanceCoordinator } from './coordinator'
import type { MaintenanceFlushParticipant } from './model'

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

describe('MaintenanceCoordinator', () => {
  test('A. no participants: prepare resolves immediately', async () => {
    const coordinator = new MaintenanceCoordinator()
    await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    expect(coordinator.getActiveCount()).toBe(0)
    expect(coordinator.getRetiringCount()).toBe(0)
  })

  test('B. active participant flush pending: prepare waits then resolves', async () => {
    const coordinator = new MaintenanceCoordinator()
    const flush = deferred<void>()
    const participant: MaintenanceFlushParticipant = {
      id: 'p1',
      flush: () => flush.promise,
    }
    coordinator.register(participant)

    let resolved = false
    const prepared = coordinator.prepareForMaintenance().then(() => {
      resolved = true
    })

    // Prepare must remain pending while the flush is pending.
    await tick()
    expect(resolved).toBe(false)
    expect(coordinator.getState()).toBe('FLUSHING_EDITORS')

    flush.resolve()
    await prepared
    expect(resolved).toBe(true)
    expect(coordinator.getState()).toBe('PREPARED')
  })

  test('C. active flush rejects: prepare rejects and returns to safe state', async () => {
    const coordinator = new MaintenanceCoordinator()
    const participant: MaintenanceFlushParticipant = {
      id: 'p1',
      flush: () => Promise.reject(new Error('save failed')),
    }
    coordinator.register(participant)

    await expect(coordinator.prepareForMaintenance()).rejects.toThrow('save failed')
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('D. overlap: second prepare while first is active is rejected', async () => {
    const coordinator = new MaintenanceCoordinator()
    const flush = deferred<void>()
    coordinator.register({ id: 'p1', flush: () => flush.promise })

    const first = coordinator.prepareForMaintenance()
    const second = coordinator.prepareForMaintenance()

    expect(coordinator.getState()).toBe('FLUSHING_EDITORS')
    await expect(second).rejects.toThrow(/already in progress|prepared/i)

    flush.resolve()
    // A successful preparation owns a PREPARED lease.
    const prepared = await first
    expect(typeof prepared.release).toBe('function')
    expect(coordinator.getState()).toBe('PREPARED')

    prepared.release()
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('E. retiring participant pending: prepare awaits the retirement', async () => {
    const coordinator = new MaintenanceCoordinator()
    const registration = coordinator.register({ id: 'p1', flush: () => Promise.resolve() })
    const completion = deferred<void>()
    registration.retire(completion.promise)

    expect(coordinator.getActiveCount()).toBe(0)
    expect(coordinator.getRetiringCount()).toBe(1)

    let resolved = false
    const prepared = coordinator.prepareForMaintenance().then(() => {
      resolved = true
    })

    await tick()
    expect(resolved).toBe(false)

    completion.resolve()
    await prepared
    expect(resolved).toBe(true)
    expect(coordinator.getRetiringCount()).toBe(0)
    expect(coordinator.getState()).toBe('PREPARED')
  })

  test('F. retiring completion rejects: prepare fails and the failure is not forgotten', async () => {
    const coordinator = new MaintenanceCoordinator()
    const registration = coordinator.register({ id: 'p1', flush: () => Promise.resolve() })
    registration.retire(Promise.reject(new Error('retire failed')))

    // The failure is captured even before prepare is called.
    await expect(coordinator.prepareForMaintenance()).rejects.toThrow('retire failed')
    expect(coordinator.getState()).toBe('IDLE')

    // A later prepare must still discover the failure (not silently succeed).
    await expect(coordinator.prepareForMaintenance()).rejects.toThrow('retire failed')
  })

  test('G. StrictMode-like lifecycle: instance A retires, instance B (same id) mounts -> both tracked', async () => {
    const coordinator = new MaintenanceCoordinator()
    const completion = Promise.resolve()

    const r1 = coordinator.register({ id: 'p1', flush: () => Promise.resolve() })
    expect(coordinator.getActiveCount()).toBe(1)
    r1.retire(completion)
    expect(coordinator.getActiveCount()).toBe(0)
    expect(coordinator.getRetiringCount()).toBe(1)

    // Remount: a NEW instance for the same logical id. It must NOT cancel or
    // clear A's retirement — both instances are tracked until they settle.
    coordinator.register({ id: 'p1', flush: () => Promise.resolve() })
    expect(coordinator.getActiveCount()).toBe(1)
    expect(coordinator.getRetiringCount()).toBe(1)

    await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    expect(coordinator.getActiveCount()).toBe(1)
    expect(coordinator.getRetiringCount()).toBe(0)
  })

  test('H. same logical id: RETIRING A + ACTIVE B -> prepare waits A even after B flush resolves', async () => {
    const coordinator = new MaintenanceCoordinator()
    const aRegistration = coordinator.register({
      id: 'note-editor',
      flush: () => Promise.resolve(),
    })
    const aCompletion = deferred<void>()
    aRegistration.retire(aCompletion.promise)

    // Instance B mounts with the SAME logical id (StrictMode / route remount).
    const bFlush = deferred<void>()
    coordinator.register({
      id: 'note-editor',
      flush: () => bFlush.promise,
    })

    // Old token RETIRING and new token ACTIVE coexist.
    expect(coordinator.getActiveCount()).toBe(1)
    expect(coordinator.getRetiringCount()).toBe(1)

    let resolved = false
    let lease: unknown = null
    const prepared = coordinator.prepareForMaintenance().then((value) => {
      resolved = true
      lease = value
    })

    await tick()
    expect(resolved).toBe(false)

    // B's flush resolves first, but A is still retiring: prepare MUST stay pending.
    bFlush.resolve()
    await tick()
    expect(resolved).toBe(false)
    expect(coordinator.getRetiringCount()).toBe(1)

    // Only once A's retirement settles can preparation continue.
    aCompletion.resolve()
    await prepared
    expect(resolved).toBe(true)
    expect(lease).not.toBeNull()
    expect(coordinator.getState()).toBe('PREPARED')
    expect(coordinator.getRetiringCount()).toBe(0)
  })

  test('I. same logical id: a rejected retirement survives a remount and blocks prepare', async () => {
    const coordinator = new MaintenanceCoordinator()
    const aRegistration = coordinator.register({
      id: 'note-editor',
      flush: () => Promise.resolve(),
    })
    aRegistration.retire(Promise.reject(new Error('A retirement failed')))
    await tick()

    expect(coordinator.getRetiredFailureCount()).toBe(1)

    // New instance B of the same logical editor must NOT clear A's failure
    // evidence, even though B itself would flush successfully.
    coordinator.register({
      id: 'note-editor',
      flush: () => Promise.resolve(),
    })
    expect(coordinator.getActiveCount()).toBe(1)
    expect(coordinator.getRetiredFailureCount()).toBe(1)

    await expect(coordinator.prepareForMaintenance()).rejects.toThrow(
      'A retirement failed',
    )
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('J. PREPARED ownership: second prepare rejected, release returns IDLE, prepare again allowed', async () => {
    const coordinator = new MaintenanceCoordinator()
    const prepared = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    expect(typeof prepared.release).toBe('function')

    // A held PREPARED lease blocks a second high-risk preparation.
    await expect(coordinator.prepareForMaintenance()).rejects.toThrow(
      /already in progress|prepared/i,
    )
    expect(coordinator.getState()).toBe('PREPARED')

    // Only an explicit release returns the coordinator to IDLE.
    prepared.release()
    expect(coordinator.getState()).toBe('IDLE')

    const again = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    again.release()
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('K. latched fault: remount keeps it, prepare fails, explicit acknowledgement recovers', async () => {
    const coordinator = new MaintenanceCoordinator()
    const aRegistration = coordinator.register({
      id: 'note-editor',
      flush: () => Promise.resolve(),
    })
    aRegistration.retire(Promise.reject(new Error('A retirement failed')))
    await tick()

    // Fault is LATCHED: it survives a remount of the same logical editor.
    coordinator.register({ id: 'note-editor', flush: () => Promise.resolve() })
    expect(coordinator.getRetiredFailureCount()).toBe(1)
    expect(coordinator.getRetiredFailureIds()).toEqual(['note-editor'])

    // Fail closed while the fault is latched.
    await expect(coordinator.prepareForMaintenance()).rejects.toThrow(
      'A retirement failed',
    )
    expect(coordinator.getState()).toBe('IDLE')

    // Explicit acknowledgement (upper layer handled / surfaced the failure).
    coordinator.acknowledgeRetiredFailure('note-editor')
    expect(coordinator.getRetiredFailureCount()).toBe(0)

    // The coordinator is NOT permanently poisoned: a healthy active flush can
    // now prepare successfully.
    const prepared = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    prepared.release()
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('L. acknowledging an unknown logical id is a NO-OP', async () => {
    const coordinator = new MaintenanceCoordinator()
    const registration = coordinator.register({
      id: 'note-editor',
      flush: () => Promise.resolve(),
    })
    registration.retire(Promise.reject(new Error('save failed')))
    await tick()

    expect(() => {
      coordinator.acknowledgeRetiredFailure('diary-editor')
    }).not.toThrow()
    // The real fault is untouched.
    expect(coordinator.getRetiredFailureCount()).toBe(1)
    await expect(coordinator.prepareForMaintenance()).rejects.toThrow('save failed')
  })

  test('M. acknowledgement is selective: Note acknowledged, Diary fault remains', async () => {
    const coordinator = new MaintenanceCoordinator()
    const note = coordinator.register({
      id: 'note-editor',
      flush: () => Promise.resolve(),
    })
    note.retire(Promise.reject(new Error('note draft lost')))
    const diary = coordinator.register({
      id: 'diary-editor',
      flush: () => Promise.resolve(),
    })
    diary.retire(Promise.reject(new Error('diary draft lost')))
    await tick()

    expect([...coordinator.getRetiredFailureIds()].sort()).toEqual([
      'diary-editor',
      'note-editor',
    ])

    coordinator.acknowledgeRetiredFailure('note-editor')
    expect(coordinator.getRetiredFailureIds()).toEqual(['diary-editor'])

    // The remaining Diary fault still blocks preparation.
    await expect(coordinator.prepareForMaintenance()).rejects.toThrow(
      'diary draft lost',
    )

    coordinator.acknowledgeRetiredFailure('diary-editor')
    const prepared = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    prepared.release()
  })

  test('N. release is idempotent and owner-scoped; a stale lease cannot unlock a newer preparation', async () => {
    const coordinator = new MaintenanceCoordinator()
    const a = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')

    a.release()
    expect(coordinator.getState()).toBe('IDLE')
    // Second release of the SAME handle is a NO-OP (no throw, no corruption).
    a.release()
    expect(coordinator.getState()).toBe('IDLE')

    const b = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    // Distinct preparation identity.
    expect(b.leaseId).not.toBe(a.leaseId)

    // Stale handle A must NOT unlock preparation B.
    a.release()
    expect(coordinator.getState()).toBe('PREPARED')

    // Only the owner returns to IDLE.
    b.release()
    expect(coordinator.getState()).toBe('IDLE')

    const c = await coordinator.prepareForMaintenance()
    expect(c.leaseId).not.toBe(b.leaseId)
    c.release()
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('O. a failed preparation never yields a usable lease', async () => {
    const coordinator = new MaintenanceCoordinator()
    let calls = 0
    coordinator.register({
      id: 'note-editor',
      flush: () => {
        calls += 1
        return calls === 1
          ? Promise.reject(new Error('save failed'))
          : Promise.resolve()
      },
    })

    await expect(coordinator.prepareForMaintenance()).rejects.toThrow('save failed')
    // No PREPARED state was entered, so there is no lease that could later
    // release someone else's preparation.
    expect(coordinator.getState()).toBe('IDLE')

    const healthy = await coordinator.prepareForMaintenance()
    expect(coordinator.getState()).toBe('PREPARED')
    healthy.release()
    expect(coordinator.getState()).toBe('IDLE')
  })
})
