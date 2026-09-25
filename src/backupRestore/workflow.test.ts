/**
 * P6-S8 · Backup Restore workflow tests
 *
 * The release rule is the safety-critical part of this slice:
 *
 *   RESTORED / proven RECOVERABLE failure -> release the exclusive lease
 *   BLOCKED / ambiguous                   -> NEVER release
 *
 * A blocked outcome must hand back a session that KEEPS the barrier. Releasing
 * there would re-open ordinary persistence on top of a database whose state
 * nobody has proven.
 */

import { describe, expect, test, vi } from 'vitest'

import { MaintenanceCoordinator } from '@/maintenance/coordinator'
import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from '@/maintenance/model'

import {
  BackupRestoreError,
  type BackupRestorePort,
  type BackupRestoreReconcileOutcome,
} from './model'
import { BackupRestoreService } from './service'
import {
  BackupRestoreWorkflow,
  type BackupRestoreBlocked,
  type BackupRestoreWorkflowResult,
} from './workflow'

const OP = '11111111-1111-4111-8111-111111111111'
const BACKUP = '22222222-2222-4222-8222-222222222222'
const SAFETY = '33333333-3333-4333-8333-333333333333'
const SHA = 'a'.repeat(64)

// ---------- fakes ----------

interface FakeRestorePortState {
  applyMode: 'restored' | 'recoverable' | 'blocked'
  reconcileOutcome: BackupRestoreReconcileOutcome
  reconcileThrows: boolean
}

function makeRestorePort(overrides?: Partial<FakeRestorePortState>) {
  const state: FakeRestorePortState = {
    applyMode: 'restored',
    reconcileOutcome: 'COMMITTED',
    reconcileThrows: false,
    ...overrides,
  }
  // Explicit `Promise.resolve` / `Promise.reject` instead of `async`: these
  // stubs never await anything, so an `async` wrapper is pure noise.
  const applyBackupRestore = vi.fn<
    BackupRestorePort['applyBackupRestore']
  >(() => {
    switch (state.applyMode) {
      case 'recoverable':
        return Promise.reject(
          new BackupRestoreError('SWITCH_FAILED', 'not applied'),
        )
      case 'blocked':
        return Promise.reject(
          new BackupRestoreError('SWITCH_INDETERMINATE', 'unknown'),
        )
      default:
        return Promise.resolve({
          operationId: OP,
          backupId: BACKUP,
          outcome: 'RESTORED' as const,
          safetyBackupId: SAFETY,
          restoredChecksumSha256: SHA,
        })
    }
  })
  const reconcileBackupRestore = vi.fn<
    BackupRestorePort['reconcileBackupRestore']
  >(() => {
    if (state.reconcileThrows) {
      return Promise.reject(
        new BackupRestoreError('TRANSPORT_AMBIGUOUS', 'unanswerable'),
      )
    }
    if (state.reconcileOutcome === 'INDETERMINATE') {
      return Promise.resolve({
        operationId: OP,
        backupId: BACKUP,
        outcome: 'INDETERMINATE' as const,
        reasonCode: 'LIVE_INVALID' as const,
      })
    }
    return Promise.resolve({
      operationId: OP,
      backupId: BACKUP,
      outcome: state.reconcileOutcome,
      safetyBackupId: SAFETY,
      restoredChecksumSha256: SHA,
    })
  })
  const port: BackupRestorePort = { applyBackupRestore, reconcileBackupRestore }
  return { port, state, applyBackupRestore, reconcileBackupRestore }
}

/** A maintenance entry that hands out one lease with a controllable release. */
function makeEntry() {
  let releaseCalls = 0
  let releaseRejects = false
  const lease: PersistenceMaintenanceLease = {
    leaseId: 'native-lease-opaque',
    release: (): Promise<void> => {
      releaseCalls += 1
      if (releaseRejects) {
        return Promise.reject(
          new PersistenceMaintenanceError('NATIVE_EXIT_FAILED', 'BLOCKED', 'no'),
        )
      }
      return Promise.resolve()
    },
  }
  const entry = {
    enterExclusiveMaintenance: vi.fn(() => Promise.resolve(lease)),
  }
  return {
    entry,
    lease,
    releaseCalls: () => releaseCalls,
    setReleaseRejects: (value: boolean) => {
      releaseRejects = value
    },
  }
}

function makeWorkflow(
  restore: ReturnType<typeof makeRestorePort>,
  entry: ReturnType<typeof makeEntry>,
) {
  return new BackupRestoreWorkflow({
    coordinator: entry.entry,
    service: new BackupRestoreService(restore.port),
    generateOperationId: () => OP,
  })
}

function expectBlocked(result: BackupRestoreWorkflowResult): BackupRestoreBlocked {
  if (result.status !== 'BLOCKED') {
    throw new Error(`expected BLOCKED, got ${result.status}`)
  }
  return result
}

/**
 * Every name a caller can reach on `value`: own enumerable keys PLUS all
 * prototype members (excluding `constructor`).
 *
 * `Object.keys` alone is not enough for a leakage check — a class method or a
 * leaked getter lives on the prototype and would be invisible to it. This is
 * the honest "what can the caller touch" set.
 */
function reachableNames(value: object): string[] {
  const names = new Set<string>(Object.keys(value))
  let proto = Object.getPrototypeOf(value) as object | null
  while (proto !== null && proto !== Object.prototype) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name !== 'constructor') names.add(name)
    }
    proto = Object.getPrototypeOf(proto) as object | null
  }
  return [...names].sort()
}

// ---------- happy path ----------

describe('BackupRestoreWorkflow · success', () => {
  test('releases the exclusive lease and reports the restore', async () => {
    const restore = makeRestorePort()
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)

    const result = await workflow.run(BACKUP)

    expect(result).toEqual({
      status: 'RESTORED',
      operationId: OP,
      backupId: BACKUP,
      safetyBackupId: SAFETY,
      restoredChecksumSha256: SHA,
    })
    expect(restore.applyBackupRestore).toHaveBeenCalledWith({
      operationId: OP,
      backupId: BACKUP,
    })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a supplied operationId is reused verbatim', async () => {
    const restore = makeRestorePort()
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const reused = '44444444-4444-4444-8444-444444444444'

    await workflow.run(BACKUP, { operationId: reused })

    expect(restore.applyBackupRestore).toHaveBeenCalledWith({
      operationId: reused,
      backupId: BACKUP,
    })
  })

  test('an unknown entry failure propagates without releasing anything', async () => {
    const restore = makeRestorePort()
    const entry = makeEntry()
    entry.entry.enterExclusiveMaintenance.mockRejectedValueOnce(
      new PersistenceMaintenanceError('FAKE', 'BLOCKED', 'barrier blocked'),
    )
    const workflow = makeWorkflow(restore, entry)

    await expect(workflow.run(BACKUP)).rejects.toMatchObject({ code: 'FAKE' })
    expect(restore.applyBackupRestore).not.toHaveBeenCalled()
    expect(entry.releaseCalls()).toBe(0)
  })
})

// ---------- recoverable failure ----------

describe('BackupRestoreWorkflow · recoverable failure', () => {
  test('releases the exclusive lease and reports a failure', async () => {
    const restore = makeRestorePort({ applyMode: 'recoverable' })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)

    const result = await workflow.run(BACKUP)

    expect(result.status).toBe('FAILED')
    expect(result).toMatchObject({ code: 'SWITCH_FAILED', operationId: OP })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a non-domain throw is treated as BLOCKED, not as a safe failure', async () => {
    const restore = makeRestorePort()
    restore.applyBackupRestore.mockRejectedValueOnce(new Error('transport died'))
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)

    const result = await workflow.run(BACKUP)

    expect(result.status).toBe('BLOCKED')
    expect(result).toMatchObject({ code: 'INTERNAL' })
    expect(entry.releaseCalls()).toBe(0)
  })
})

// ---------- blocked ----------

describe('BackupRestoreWorkflow · blocked', () => {
  test('a BLOCKED apply does NOT release and returns a live session', async () => {
    const restore = makeRestorePort({ applyMode: 'blocked' })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)

    const result = expectBlocked(await workflow.run(BACKUP))

    expect(result.code).toBe('SWITCH_INDETERMINATE')
    expect(result.operationId).toBe(OP)
    expect(result.backupId).toBe(BACKUP)
    expect(entry.releaseCalls()).toBe(0)
    expect(result.session.isSettled()).toBe(false)
    expect(result.session.operationId).toBe(OP)
    expect(result.session.backupId).toBe(BACKUP)
  })

  test('the session exposes no platform identity', async () => {
    const restore = makeRestorePort({ applyMode: 'blocked' })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const result = expectBlocked(await workflow.run(BACKUP))

    // The whole REACHABLE surface, not just own enumerable keys: a class method
    // lives on the prototype, and a leaked getter would live there too, so
    // `Object.keys` alone would not be able to see a leak.
    const keys = reachableNames(result.session)
    expect(keys).not.toContain('leaseId')
    expect(keys).not.toContain('nativeOwnerId')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('lease')
    expect(keys.sort()).toEqual([
      'backupId',
      'isSettled',
      'operationId',
      'reconcile',
    ])
  })

  test('an unprovable reconcile keeps the barrier and stays retryable', async () => {
    const restore = makeRestorePort({
      applyMode: 'blocked',
      reconcileOutcome: 'INDETERMINATE',
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const result = expectBlocked(await workflow.run(BACKUP))

    const first = await result.session.reconcile()
    expect(first).toEqual({ status: 'STILL_BLOCKED', reasonCode: 'LIVE_INVALID' })
    expect(entry.releaseCalls()).toBe(0)
    expect(result.session.isSettled()).toBe(false)

    // The outcome becomes provable later: NOW the barrier is released.
    restore.state.reconcileOutcome = 'COMMITTED'
    const second = await result.session.reconcile()
    expect(second).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(entry.releaseCalls()).toBe(1)
    expect(result.session.isSettled()).toBe(true)
  })

  test('a throwing reconcile keeps the session unsettled', async () => {
    const restore = makeRestorePort({
      applyMode: 'blocked',
      reconcileThrows: true,
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const result = expectBlocked(await workflow.run(BACKUP))

    await expect(result.session.reconcile()).rejects.toMatchObject({
      code: 'TRANSPORT_AMBIGUOUS',
      disposition: 'BLOCKED',
    })
    expect(entry.releaseCalls()).toBe(0)
    expect(result.session.isSettled()).toBe(false)
  })

  test('ROLLED_BACK settles the session and releases', async () => {
    const restore = makeRestorePort({
      applyMode: 'blocked',
      reconcileOutcome: 'ROLLED_BACK',
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const result = expectBlocked(await workflow.run(BACKUP))

    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'ROLLED_BACK' })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('NOT_COMMITTED settles the session and releases', async () => {
    const restore = makeRestorePort({
      applyMode: 'blocked',
      reconcileOutcome: 'NOT_COMMITTED',
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const result = expectBlocked(await workflow.run(BACKUP))

    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'NOT_COMMITTED' })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a settled session is idempotent and never re-queries', async () => {
    const restore = makeRestorePort({ applyMode: 'blocked' })
    const entry = makeEntry()
    const workflow = makeWorkflow(restore, entry)
    const result = expectBlocked(await workflow.run(BACKUP))

    await result.session.reconcile()
    const reconcileCallsAfterSettle = restore.reconcileBackupRestore.mock.calls.length
    const again = await result.session.reconcile()

    expect(again).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(restore.reconcileBackupRestore).toHaveBeenCalledTimes(
      reconcileCallsAfterSettle,
    )
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a release failure AFTER a successful restore is BLOCKED, not a failure', async () => {
    const restore = makeRestorePort()
    const entry = makeEntry()
    entry.setReleaseRejects(true)
    const workflow = makeWorkflow(restore, entry)

    const result = expectBlocked(await workflow.run(BACKUP))

    // The restore DID apply; reporting FAILED would be a lie.
    expect(restore.applyBackupRestore).toHaveBeenCalledTimes(1)
    expect(entry.releaseCalls()).toBe(1)

    // The session can still settle, because the barrier is still held.
    entry.setReleaseRejects(false)
    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(entry.releaseCalls()).toBe(2)
  })
})

// ---------- real-coordinator integration ----------

class FakePlatformPort implements PersistenceMaintenancePort {
  releaseCallCount = 0
  enterCallCount = 0

  enterStrongMaintenance(): Promise<PersistenceMaintenanceLease> {
    this.enterCallCount += 1
    return Promise.resolve({
      leaseId: 'native-lease-opaque',
      release: (): Promise<void> => {
        this.releaseCallCount += 1
        return Promise.resolve()
      },
    })
  }
}

describe('BackupRestoreWorkflow · real coordinator', () => {
  test('a blocked restore keeps ordinary persistence blocked until reconciled', async () => {
    const platform = new FakePlatformPort()
    const coordinator = new MaintenanceCoordinator(platform)
    const restore = makeRestorePort({
      applyMode: 'blocked',
      reconcileOutcome: 'INDETERMINATE',
    })
    const workflow = new BackupRestoreWorkflow({
      coordinator,
      service: new BackupRestoreService(restore.port),
      generateOperationId: () => OP,
    })

    const result = expectBlocked(await workflow.run(BACKUP))

    // The barrier is genuinely still held, not merely "not released".
    expect(coordinator.getState()).toBe('EXCLUSIVE_MAINTENANCE')
    expect(platform.releaseCallCount).toBe(0)
    // ...which means ordinary persistence is still blocked: a second high-risk
    // session cannot start.
    await expect(coordinator.enterExclusiveMaintenance()).rejects.toMatchObject({
      code: 'OVERLAP',
    })

    // The owner token is nowhere in the application-level result.
    expect(JSON.stringify(Object.keys(result))).not.toContain('native')
    expect(JSON.stringify(Object.keys(result.session))).not.toContain('native')

    // Once the outcome is provable, the session releases and the coordinator
    // returns to IDLE.
    restore.state.reconcileOutcome = 'COMMITTED'
    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(platform.releaseCallCount).toBe(1)
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('a recoverable failure releases and returns the coordinator to IDLE', async () => {
    const platform = new FakePlatformPort()
    const coordinator = new MaintenanceCoordinator(platform)
    const restore = makeRestorePort({ applyMode: 'recoverable' })
    const workflow = new BackupRestoreWorkflow({
      coordinator,
      service: new BackupRestoreService(restore.port),
      generateOperationId: () => OP,
    })

    const result = await workflow.run(BACKUP)

    expect(result.status).toBe('FAILED')
    expect(coordinator.getState()).toBe('IDLE')
    expect(platform.releaseCallCount).toBe(1)
  })
})
