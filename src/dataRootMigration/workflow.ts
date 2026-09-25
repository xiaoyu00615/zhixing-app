/**
 * P6-S9 · Data Root Migration workflow
 *
 * The APPLICATION-level orchestration of one SIMPLE DATA ROOT MIGRATION V1:
 *
 *   enterExclusiveMaintenance()
 *     → generate operationId
 *     → DataRootMigrationService.apply()
 *     → release, or hand back a blocked session
 *
 * The release rule is the whole point of this module and it is NOT a plain
 * `finally`:
 *
 *   MIGRATED / known RECOVERABLE failure → release the exclusive lease
 *   BLOCKED / ambiguous                  → DO NOT release
 *
 * An unprovable outcome must never release the strong barrier: releasing it
 * would re-open ordinary persistence on top of a data folder whose
 * authoritativeness nobody has proven, which is precisely the failure this
 * slice exists to prevent.
 *
 * `BlockedDataRootMigrationSession` is the application-level, opaque handle that
 * keeps the barrier alive across that uncertainty. It exposes the operation
 * identity and a `reconcile()` that re-proves the outcome; it exposes NO native
 * owner token, NO platform lease id, and NO hidden filesystem path.
 */

import type { ExclusiveMaintenanceLease } from '@/maintenance/model'

import {
  DataRootMigrationError,
  createDataRootMigrationOperationId,
  type DataRootMigrationErrorCode,
  type DataRootMigrationReconcileOutcome,
  type DataRootMigrationReconcileReason,
} from './model'
import type { DataRootMigrationService } from './service'

/**
 * The narrow slice of the coordinator this workflow needs. Typed structurally so
 * the workflow never depends on coordinator internals.
 */
export interface DataRootMigrationMaintenanceEntry {
  enterExclusiveMaintenance(): Promise<ExclusiveMaintenanceLease>
}

export interface DataRootMigrationWorkflowDeps {
  readonly coordinator: DataRootMigrationMaintenanceEntry
  readonly service: DataRootMigrationService
  /**
   * Operation-id generator. Injectable so tests are deterministic; production
   * uses a canonical UUID v4.
   */
  readonly generateOperationId?: () => string
}

/** The migration is proven applied AND the barrier has been released. */
export interface DataRootMigrationSuccess {
  readonly status: 'MIGRATED'
  readonly operationId: string
  readonly targetDataRoot: string
  readonly safetyBackupId: string
}

/** A PROVEN-safe failure. The barrier has been released. */
export interface DataRootMigrationFailure {
  readonly status: 'FAILED'
  readonly operationId: string
  readonly targetDataRoot: string
  readonly code: DataRootMigrationErrorCode
  readonly message: string
}

/** The outcome is unprovable. The barrier is STILL HELD by `session`. */
export interface DataRootMigrationBlocked {
  readonly status: 'BLOCKED'
  readonly operationId: string
  readonly targetDataRoot: string
  readonly code: DataRootMigrationErrorCode
  readonly message: string
  readonly session: BlockedDataRootMigrationSession
}

export type DataRootMigrationWorkflowResult =
  | DataRootMigrationSuccess
  | DataRootMigrationFailure
  | DataRootMigrationBlocked

/** Result of a blocked session's `reconcile()`. */
export type BlockedMigrationSessionReconcileResult =
  | {
      /** The outcome is now proven; the platform barrier has been released. */
      readonly status: 'SETTLED'
      readonly outcome: Exclude<
        DataRootMigrationReconcileOutcome,
        'INDETERMINATE'
      >
    }
  | {
      /** Still unprovable. The barrier stays held; call `reconcile()` again. */
      readonly status: 'STILL_BLOCKED'
      readonly reasonCode?: DataRootMigrationReconcileReason
    }

/**
 * The application-level handle for an unproven migration.
 *
 * It RETAINS the exclusive maintenance lease: as long as it is unsettled,
 * ordinary persistence stays blocked and the coordinator stays in
 * EXCLUSIVE_MAINTENANCE. It can only be settled by re-proving the outcome, at
 * which point it releases the platform barrier.
 *
 * It deliberately exposes no platform identity of any kind.
 */
export interface BlockedDataRootMigrationSession {
  readonly operationId: string
  readonly targetDataRoot: string
  /** True once the outcome is proven and the barrier has been released. */
  isSettled(): boolean
  /**
   * Re-prove the outcome and, once provable, release the barrier.
   *
   * Rejects only when the proof attempt itself fails — in which case the
   * session stays unsettled and the barrier stays held. It NEVER releases on an
   * unproven outcome.
   */
  reconcile(): Promise<BlockedMigrationSessionReconcileResult>
}

class BlockedMigrationSession implements BlockedDataRootMigrationSession {
  public readonly operationId: string
  public readonly targetDataRoot: string

  // TRUE ECMAScript private fields, not the `private` keyword. A TypeScript
  // `private` member is only a compile-time nicety: it still exists as an own,
  // enumerable property at runtime, so `Object.keys(session)` (or a spread)
  // would hand out the held lease. `#` fields cannot be reached from outside
  // the class at all.
  readonly #service: DataRootMigrationService
  readonly #lease: ExclusiveMaintenanceLease
  #settled: BlockedMigrationSessionReconcileResult | null = null

  constructor(
    operationId: string,
    targetDataRoot: string,
    service: DataRootMigrationService,
    lease: ExclusiveMaintenanceLease,
  ) {
    this.operationId = operationId
    this.targetDataRoot = targetDataRoot
    this.#service = service
    this.#lease = lease
  }

  isSettled(): boolean {
    return this.#settled !== null
  }

  async reconcile(): Promise<BlockedMigrationSessionReconcileResult> {
    // Idempotent: once settled, the barrier is gone and there is nothing left to
    // prove — re-querying a released barrier would be unsafe.
    if (this.#settled !== null) {
      return this.#settled
    }

    const result = await this.#service.reconcile({
      operationId: this.operationId,
      targetDataRoot: this.targetDataRoot,
    })

    if (result.outcome === 'INDETERMINATE') {
      // Deliberately NOT cached: "still unknown" is not a terminal answer.
      return { status: 'STILL_BLOCKED', reasonCode: result.reasonCode }
    }

    // Provable. Release the barrier BEFORE reporting settlement — a lease that
    // failed to release throws, leaving the session unsettled and retryable.
    await this.#lease.release()

    const settled: BlockedMigrationSessionReconcileResult = {
      status: 'SETTLED',
      outcome: result.outcome,
    }
    this.#settled = settled
    return settled
  }
}

/** Normalize an unknown throw into the domain error type. */
function toMigrationError(error: unknown): DataRootMigrationError {
  if (error instanceof DataRootMigrationError) {
    return error
  }
  // An unexpected shape is, by definition, not a proven-safe failure.
  return new DataRootMigrationError(
    'INTERNAL',
    'The move could not be completed.',
    'BLOCKED',
  )
}

export class DataRootMigrationWorkflow {
  private readonly coordinator: DataRootMigrationMaintenanceEntry
  private readonly service: DataRootMigrationService
  private readonly generateOperationId: () => string

  constructor(deps: DataRootMigrationWorkflowDeps) {
    this.coordinator = deps.coordinator
    this.service = deps.service
    this.generateOperationId =
      deps.generateOperationId ?? createDataRootMigrationOperationId
  }

  /**
   * Run one migration attempt.
   *
   * `operationId` may be supplied to REUSE the identity of a previous attempt
   * (a transport retry must never mint a new operation id); otherwise a fresh
   * one is generated.
   *
   * Entry failures (`OVERLAP` / `PERSISTENCE_FAILED`) propagate: at that point
   * no lease was obtained, and the caller must handle a possibly-BLOCKED
   * coordinator rather than have it disguised as a migration failure.
   */
  async run(
    targetDataRoot: string,
    options?: { readonly operationId?: string },
  ): Promise<DataRootMigrationWorkflowResult> {
    const operationId = options?.operationId ?? this.generateOperationId()
    const lease = await this.coordinator.enterExclusiveMaintenance()

    let applied: { safetyBackupId: string }
    try {
      applied = await this.service.apply({ operationId, targetDataRoot })
    } catch (caught: unknown) {
      const error = toMigrationError(caught)
      if (error.disposition === 'RECOVERABLE') {
        // The authoritative Data Root is PROVEN safe, so releasing is correct.
        await lease.release()
        return {
          status: 'FAILED',
          operationId,
          targetDataRoot,
          code: error.code,
          message: error.safeMessage,
        }
      }
      // BLOCKED: never release. The caller receives a handle that keeps it.
      return {
        status: 'BLOCKED',
        operationId,
        targetDataRoot,
        code: error.code,
        message: error.safeMessage,
        session: new BlockedMigrationSession(
          operationId,
          targetDataRoot,
          this.service,
          lease,
        ),
      }
    }

    try {
      await lease.release()
    } catch {
      // The data WAS moved, but the barrier release is unproven. That is not a
      // failed migration — it is a held barrier, so it takes the blocked path
      // rather than a plain failure.
      return {
        status: 'BLOCKED',
        operationId,
        targetDataRoot,
        code: 'INTERNAL',
        message: 'The move completed but the barrier could not be released.',
        session: new BlockedMigrationSession(
          operationId,
          targetDataRoot,
          this.service,
          lease,
        ),
      }
    }

    return {
      status: 'MIGRATED',
      operationId,
      targetDataRoot,
      safetyBackupId: applied.safetyBackupId,
    }
  }
}
