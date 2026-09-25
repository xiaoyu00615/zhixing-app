/**
 * P6-S9 · Data Root Migration workflow tests
 *
 * The release rule is the safety-critical part of this slice:
 *
 *   MIGRATED / proven RECOVERABLE failure -> release the exclusive lease
 *   BLOCKED / ambiguous                   -> NEVER release
 *
 * A blocked outcome must hand back a session that KEEPS the barrier. Releasing
 * there would re-open ordinary persistence on top of a data folder whose
 * authoritativeness nobody has proven.
 */

import { describe, expect, test, vi } from 'vitest'

import { MaintenanceCoordinator } from '@/maintenance/coordinator'
import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from '@/maintenance/model'

import {
  DataRootMigrationError,
  type DataRootMigrationPort,
  type DataRootMigrationReconcileOutcome,
} from './model'
import { DataRootMigrationService } from './service'
import {
  DataRootMigrationWorkflow,
  type DataRootMigrationBlocked,
  type DataRootMigrationWorkflowResult,
} from './workflow'

const OP = '11111111-1111-4111-8111-111111111111'
const SAFETY = '33333333-3333-4333-8333-333333333333'
const TARGET = 'D:\\Data\\zhixing'

// ---------- fakes ----------

interface FakeMigrationPortState {
  applyMode: 'migrated' | 'recoverable' | 'blocked'
  reconcileOutcome: DataRootMigrationReconcileOutcome
  reconcileThrows: boolean
}

function makeMigrationPort(overrides?: Partial<FakeMigrationPortState>) {
  const state: FakeMigrationPortState = {
    applyMode: 'migrated',
    reconcileOutcome: 'COMMITTED',
    reconcileThrows: false,
    ...overrides,
  }
  // Explicit `Promise.resolve` / `Promise.reject` instead of `async`: these
  // stubs never await anything, so an `async` wrapper is pure noise.
  const applyDataRootMigration = vi.fn<
    DataRootMigrationPort['applyDataRootMigration']
  >(() => {
    switch (state.applyMode) {
      case 'recoverable':
        return Promise.reject(
          new DataRootMigrationError('COPY_FAILED', 'not copied'),
        )
      case 'blocked':
        return Promise.reject(
          new DataRootMigrationError('SWITCH_INDETERMINATE', 'unknown'),
        )
      default:
        return Promise.resolve({
          operationId: OP,
          targetDataRoot: TARGET,
          outcome: 'MIGRATED' as const,
          safetyBackupId: SAFETY,
        })
    }
  })
  const reconcileDataRootMigration = vi.fn<
    DataRootMigrationPort['reconcileDataRootMigration']
  >(() => {
    if (state.reconcileThrows) {
      return Promise.reject(
        new DataRootMigrationError('TRANSPORT_AMBIGUOUS', 'unanswerable'),
      )
    }
    if (state.reconcileOutcome === 'INDETERMINATE') {
      return Promise.resolve({
        operationId: OP,
        targetDataRoot: TARGET,
        outcome: 'INDETERMINATE' as const,
        reasonCode: 'TARGET_INVALID' as const,
      })
    }
    return Promise.resolve({
      operationId: OP,
      targetDataRoot: TARGET,
      outcome: state.reconcileOutcome,
      safetyBackupId: SAFETY,
    })
  })
  const port: DataRootMigrationPort = {
    applyDataRootMigration,
    reconcileDataRootMigration,
  }
  return {
    port,
    state,
    applyDataRootMigration,
    reconcileDataRootMigration,
  }
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
  migration: ReturnType<typeof makeMigrationPort>,
  entry: ReturnType<typeof makeEntry>,
) {
  return new DataRootMigrationWorkflow({
    coordinator: entry.entry,
    service: new DataRootMigrationService(migration.port),
    generateOperationId: () => OP,
  })
}

function expectBlocked(
  result: DataRootMigrationWorkflowResult,
): DataRootMigrationBlocked {
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

describe('DataRootMigrationWorkflow · success', () => {
  test('releases the exclusive lease and reports the migration', async () => {
    const migration = makeMigrationPort()
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)

    const result = await workflow.run(TARGET)

    expect(result).toEqual({
      status: 'MIGRATED',
      operationId: OP,
      targetDataRoot: TARGET,
      safetyBackupId: SAFETY,
    })
    expect(migration.applyDataRootMigration).toHaveBeenCalledWith({
      operationId: OP,
      targetDataRoot: TARGET,
    })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a supplied operationId is reused verbatim', async () => {
    const migration = makeMigrationPort()
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const reused = '44444444-4444-4444-8444-444444444444'

    await workflow.run(TARGET, { operationId: reused })

    expect(migration.applyDataRootMigration).toHaveBeenCalledWith({
      operationId: reused,
      targetDataRoot: TARGET,
    })
  })

  test('an unknown entry failure propagates without releasing anything', async () => {
    const migration = makeMigrationPort()
    const entry = makeEntry()
    entry.entry.enterExclusiveMaintenance.mockRejectedValueOnce(
      new PersistenceMaintenanceError('FAKE', 'BLOCKED', 'barrier blocked'),
    )
    const workflow = makeWorkflow(migration, entry)

    await expect(workflow.run(TARGET)).rejects.toMatchObject({ code: 'FAKE' })
    expect(migration.applyDataRootMigration).not.toHaveBeenCalled()
    expect(entry.releaseCalls()).toBe(0)
  })
})

// ---------- recoverable failure ----------

describe('DataRootMigrationWorkflow · recoverable failure', () => {
  test('releases the exclusive lease and reports a failure', async () => {
    const migration = makeMigrationPort({ applyMode: 'recoverable' })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)

    const result = await workflow.run(TARGET)

    expect(result.status).toBe('FAILED')
    expect(result).toMatchObject({ code: 'COPY_FAILED', operationId: OP })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a non-domain throw is treated as BLOCKED, not as a safe failure', async () => {
    const migration = makeMigrationPort()
    migration.applyDataRootMigration.mockRejectedValueOnce(
      new Error('transport died'),
    )
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)

    const result = await workflow.run(TARGET)

    expect(result.status).toBe('BLOCKED')
    expect(result).toMatchObject({ code: 'INTERNAL' })
    expect(entry.releaseCalls()).toBe(0)
  })
})

// ---------- blocked ----------

describe('DataRootMigrationWorkflow · blocked', () => {
  test('a BLOCKED apply does NOT release and returns a live session', async () => {
    const migration = makeMigrationPort({ applyMode: 'blocked' })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)

    const result = expectBlocked(await workflow.run(TARGET))

    expect(result.code).toBe('SWITCH_INDETERMINATE')
    expect(result.operationId).toBe(OP)
    expect(result.targetDataRoot).toBe(TARGET)
    expect(entry.releaseCalls()).toBe(0)
    expect(result.session.isSettled()).toBe(false)
    expect(result.session.operationId).toBe(OP)
    expect(result.session.targetDataRoot).toBe(TARGET)
  })

  test('the session exposes no platform identity', async () => {
    const migration = makeMigrationPort({ applyMode: 'blocked' })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const result = expectBlocked(await workflow.run(TARGET))

    // The whole REACHABLE surface, not just own enumerable keys: a class method
    // lives on the prototype, and a leaked getter would live there too, so
    // `Object.keys` alone would not be able to see a leak.
    const keys = reachableNames(result.session)
    expect(keys).not.toContain('leaseId')
    expect(keys).not.toContain('nativeOwnerId')
    expect(keys).not.toContain('token')
    expect(keys).not.toContain('lease')
    expect(keys.sort()).toEqual([
      'isSettled',
      'operationId',
      'reconcile',
      'targetDataRoot',
    ])
  })

  test('an unprovable reconcile keeps the barrier and stays retryable', async () => {
    const migration = makeMigrationPort({
      applyMode: 'blocked',
      reconcileOutcome: 'INDETERMINATE',
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const result = expectBlocked(await workflow.run(TARGET))

    const first = await result.session.reconcile()
    expect(first).toEqual({
      status: 'STILL_BLOCKED',
      reasonCode: 'TARGET_INVALID',
    })
    expect(entry.releaseCalls()).toBe(0)
    expect(result.session.isSettled()).toBe(false)

    // The outcome becomes provable later: NOW the barrier is released.
    migration.state.reconcileOutcome = 'COMMITTED'
    const second = await result.session.reconcile()
    expect(second).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(entry.releaseCalls()).toBe(1)
    expect(result.session.isSettled()).toBe(true)
  })

  test('a throwing reconcile keeps the session unsettled', async () => {
    const migration = makeMigrationPort({
      applyMode: 'blocked',
      reconcileThrows: true,
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const result = expectBlocked(await workflow.run(TARGET))

    await expect(result.session.reconcile()).rejects.toMatchObject({
      code: 'TRANSPORT_AMBIGUOUS',
      disposition: 'BLOCKED',
    })
    expect(entry.releaseCalls()).toBe(0)
    expect(result.session.isSettled()).toBe(false)
  })

  test('ROLLED_BACK settles the session and releases', async () => {
    const migration = makeMigrationPort({
      applyMode: 'blocked',
      reconcileOutcome: 'ROLLED_BACK',
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const result = expectBlocked(await workflow.run(TARGET))

    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'ROLLED_BACK' })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('NOT_COMMITTED settles the session and releases', async () => {
    const migration = makeMigrationPort({
      applyMode: 'blocked',
      reconcileOutcome: 'NOT_COMMITTED',
    })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const result = expectBlocked(await workflow.run(TARGET))

    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'NOT_COMMITTED' })
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a settled session is idempotent and never re-queries', async () => {
    const migration = makeMigrationPort({ applyMode: 'blocked' })
    const entry = makeEntry()
    const workflow = makeWorkflow(migration, entry)
    const result = expectBlocked(await workflow.run(TARGET))

    await result.session.reconcile()
    const reconcileCallsAfterSettle =
      migration.reconcileDataRootMigration.mock.calls.length
    const again = await result.session.reconcile()

    expect(again).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(migration.reconcileDataRootMigration).toHaveBeenCalledTimes(
      reconcileCallsAfterSettle,
    )
    expect(entry.releaseCalls()).toBe(1)
  })

  test('a release failure AFTER a successful migration is BLOCKED, not a failure', async () => {
    const migration = makeMigrationPort()
    const entry = makeEntry()
    entry.setReleaseRejects(true)
    const workflow = makeWorkflow(migration, entry)

    const result = expectBlocked(await workflow.run(TARGET))

    // The data DID move; reporting FAILED would be a lie.
    expect(migration.applyDataRootMigration).toHaveBeenCalledTimes(1)
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

describe('DataRootMigrationWorkflow · real coordinator', () => {
  test('a blocked migration keeps ordinary persistence blocked until reconciled', async () => {
    const platform = new FakePlatformPort()
    const coordinator = new MaintenanceCoordinator(platform)
    const migration = makeMigrationPort({
      applyMode: 'blocked',
      reconcileOutcome: 'INDETERMINATE',
    })
    const workflow = new DataRootMigrationWorkflow({
      coordinator,
      service: new DataRootMigrationService(migration.port),
      generateOperationId: () => OP,
    })

    const result = expectBlocked(await workflow.run(TARGET))

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
    migration.state.reconcileOutcome = 'COMMITTED'
    const settled = await result.session.reconcile()
    expect(settled).toEqual({ status: 'SETTLED', outcome: 'COMMITTED' })
    expect(platform.releaseCallCount).toBe(1)
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('a recoverable failure releases and returns the coordinator to IDLE', async () => {
    const platform = new FakePlatformPort()
    const coordinator = new MaintenanceCoordinator(platform)
    const migration = makeMigrationPort({ applyMode: 'recoverable' })
    const workflow = new DataRootMigrationWorkflow({
      coordinator,
      service: new DataRootMigrationService(migration.port),
      generateOperationId: () => OP,
    })

    const result = await workflow.run(TARGET)

    expect(result.status).toBe('FAILED')
    expect(coordinator.getState()).toBe('IDLE')
    expect(platform.releaseCallCount).toBe(1)
  })
})
