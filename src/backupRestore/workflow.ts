/**
 * P6-S8 · Backup Restore workflow
 *
 * The APPLICATION-level orchestration of one DATABASE RESTORE V1:
 *
 *   enterExclusiveMaintenance()
 *     → generate operationId
 *     → BackupRestoreService.apply()
 *     → release, or hand back a blocked session
 *
 * The release rule is the whole point of this module and it is NOT a plain
 * `finally`:
 *
 *   RESTORED / known RECOVERABLE failure → release the exclusive lease
 *   BLOCKED / ambiguous                  → DO NOT release
 *
 * An unprovable outcome must never release the strong barrier: releasing it
 * would re-open ordinary persistence on top of a database whose state nobody
 * has proven, which is precisely the failure this slice exists to prevent.
 *
 * `BlockedBackupRestoreSession` is the application-level, opaque handle that
 * keeps the barrier alive across that uncertainty. It exposes the operation
 * identity and a `reconcile()` that re-proves the outcome; it exposes NO native
 * owner token, NO platform lease id, and NO filesystem path.
 */

import type { ExclusiveMaintenanceLease } from '@/maintenance/model'

import {
  BackupRestoreError,
  createRestoreOperationId,
  type BackupRestoreErrorCode,
  type BackupRestoreReconcileOutcome,
  type BackupRestoreReconcileReason,
} from './model'
import type { BackupRestoreService } from './service'

/**
 * The narrow slice of the coordinator this workflow needs. Typed structurally so
 * the workflow never depends on coordinator internals.
 */
export interface BackupRestoreMaintenanceEntry {
  enterExclusiveMaintenance(): Promise<ExclusiveMaintenanceLease>
}

export interface BackupRestoreWorkflowDeps {
  readonly coordinator: BackupRestoreMaintenanceEntry
  readonly service: BackupRestoreService
  /**
   * Operation-id generator. Injectable so tests are deterministic; production
   * uses a canonical UUID v4.
   */
  readonly generateOperationId?: () => string
}

/** The restore is proven applied AND the barrier has been released. */
export interface BackupRestoreSuccess {
  readonly status: 'RESTORED'
  readonly operationId: string
  readonly backupId: string
  readonly safetyBackupId: string
  readonly restoredChecksumSha256: string
}

/** A PROVEN-safe failure. The barrier has been released. */
export interface BackupRestoreFailure {
  readonly status: 'FAILED'
  readonly operationId: string
  readonly backupId: string
  readonly code: BackupRestoreErrorCode
  readonly message: string
}

/** The outcome is unprovable. The barrier is STILL HELD by `session`. */
export interface BackupRestoreBlocked {
  readonly status: 'BLOCKED'
  readonly operationId: string
  readonly backupId: string
  readonly code: BackupRestoreErrorCode
  readonly message: string
  readonly session: BlockedBackupRestoreSession
}

export type BackupRestoreWorkflowResult =
  | BackupRestoreSuccess
  | BackupRestoreFailure
  | BackupRestoreBlocked

/** Result of a blocked session's `reconcile()`. */
export type BlockedSessionReconcileResult =
  | {
      /** The outcome is now proven; the platform barrier has been released. */
      readonly status: 'SETTLED'
      readonly outcome: Exclude<BackupRestoreReconcileOutcome, 'INDETERMINATE'>
    }
  | {
      /** Still unprovable. The barrier stays held; call `reconcile()` again. */
      readonly status: 'STILL_BLOCKED'
      readonly reasonCode?: BackupRestoreReconcileReason
    }

/**
 * The application-level handle for an unproven restore.
 *
 * It RETAINS the exclusive maintenance lease: as long as it is unsettled,
 * ordinary persistence stays blocked and the coordinator stays in
 * EXCLUSIVE_MAINTENANCE. It can only be settled by re-proving the outcome, at
 * which point it releases the platform barrier.
 *
 * It deliberately exposes no platform identity of any kind.
 */
export interface BlockedBackupRestoreSession {
  readonly operationId: string
  readonly backupId: string
  /** True once the outcome is proven and the barrier has been released. */
  isSettled(): boolean
  /**
   * Re-prove the outcome and, once provable, release the barrier.
   *
   * Rejects only when the proof attempt itself fails — in which case the
   * session stays unsettled and the barrier stays held. It NEVER releases on an
   * unproven outcome.
   */
  reconcile(): Promise<BlockedSessionReconcileResult>
}

class BlockedRestoreSession implements BlockedBackupRestoreSession {
  public readonly operationId: string
  public readonly backupId: string

  // TRUE ECMAScript private fields, not the `private` keyword. A TypeScript
  // `private` member is only a compile-time nicety: it still exists as an own,
  // enumerable property at runtime, so `Object.keys(session)` (or a spread)
  // would hand out the held lease. `#` fields cannot be reached from outside
  // the class at all.
  readonly #service: BackupRestoreService
  readonly #lease: ExclusiveMaintenanceLease
  #settled: BlockedSessionReconcileResult | null = null

  constructor(
    operationId: string,
    backupId: string,
    service: BackupRestoreService,
    lease: ExclusiveMaintenanceLease,
  ) {
    this.operationId = operationId
    this.backupId = backupId
    this.#service = service
    this.#lease = lease
  }

  isSettled(): boolean {
    return this.#settled !== null
  }

  async reconcile(): Promise<BlockedSessionReconcileResult> {
    // Idempotent: once settled, the barrier is gone and there is nothing left to
    // prove — re-querying a released barrier would be unsafe.
    if (this.#settled !== null) {
      return this.#settled
    }

    const result = await this.#service.reconcile({
      operationId: this.operationId,
      backupId: this.backupId,
    })

    if (result.outcome === 'INDETERMINATE') {
      // Deliberately NOT cached: "still unknown" is not a terminal answer.
      return { status: 'STILL_BLOCKED', reasonCode: result.reasonCode }
    }

    // Provable. Release the barrier BEFORE reporting settlement — a lease that
    // failed to release throws, leaving the session unsettled and retryable.
    await this.#lease.release()

    const settled: BlockedSessionReconcileResult = {
      status: 'SETTLED',
      outcome: result.outcome,
    }
    this.#settled = settled
    return settled
  }
}

/** Normalize an unknown throw into the domain error type. */
function toRestoreError(error: unknown): BackupRestoreError {
  if (error instanceof BackupRestoreError) {
    return error
  }
  // An unexpected shape is, by definition, not a proven-safe failure.
  return new BackupRestoreError(
    'INTERNAL',
    'The restore could not be completed.',
    'BLOCKED',
  )
}

export class BackupRestoreWorkflow {
  private readonly coordinator: BackupRestoreMaintenanceEntry
  private readonly service: BackupRestoreService
  private readonly generateOperationId: () => string

  constructor(deps: BackupRestoreWorkflowDeps) {
    this.coordinator = deps.coordinator
    this.service = deps.service
    this.generateOperationId = deps.generateOperationId ?? createRestoreOperationId
  }

  /**
   * Run one restore attempt.
   *
   * `operationId` may be supplied to REUSE the identity of a previous attempt
   * (a transport retry must never mint a new operation id); otherwise a fresh
   * one is generated.
   *
   * Entry failures (`OVERLAP` / `PERSISTENCE_FAILED`) propagate: at that point
   * no lease was obtained, and the caller must handle a possibly-BLOCKED
   * coordinator rather than have it disguised as a restore failure.
   */
  async run(
    backupId: string,
    options?: { readonly operationId?: string },
  ): Promise<BackupRestoreWorkflowResult> {
    const operationId = options?.operationId ?? this.generateOperationId()
    const lease = await this.coordinator.enterExclusiveMaintenance()

    let applied: { safetyBackupId: string; restoredChecksumSha256: string }
    try {
      applied = await this.service.apply({ operationId, backupId })
    } catch (caught: unknown) {
      const error = toRestoreError(caught)
      if (error.disposition === 'RECOVERABLE') {
        // The live database is PROVEN safe, so releasing is correct.
        await lease.release()
        return {
          status: 'FAILED',
          operationId,
          backupId,
          code: error.code,
          message: error.safeMessage,
        }
      }
      // BLOCKED: never release. The caller receives a handle that keeps it.
      return {
        status: 'BLOCKED',
        operationId,
        backupId,
        code: error.code,
        message: error.safeMessage,
        session: new BlockedRestoreSession(
          operationId,
          backupId,
          this.service,
          lease,
        ),
      }
    }

    try {
      await lease.release()
    } catch {
      // The database WAS restored, but the barrier release is unproven. That is
      // not a failed restore — it is a held barrier, so it takes the blocked
      // path rather than a plain failure.
      return {
        status: 'BLOCKED',
        operationId,
        backupId,
        code: 'INTERNAL',
        message: 'The restore completed but the barrier could not be released.',
        session: new BlockedRestoreSession(
          operationId,
          backupId,
          this.service,
          lease,
        ),
      }
    }

    return {
      status: 'RESTORED',
      operationId,
      backupId,
      safetyBackupId: applied.safetyBackupId,
      restoredChecksumSha256: applied.restoredChecksumSha256,
    }
  }
}
