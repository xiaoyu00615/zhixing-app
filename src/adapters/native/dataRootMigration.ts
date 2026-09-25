/**
 * Native Data Root Migration adapter (P6-S9).
 *
 * Implements the shared `DataRootMigrationPort` against the P6-S9 Tauri commands
 * `native_data_root_migration_apply` / `native_data_root_migration_reconcile`.
 *
 * Two things make this adapter more than a transport wrapper.
 *
 * 1. IT NEVER HOLDS THE OWNER TOKEN. The raw native owner id lives in a closure
 *    inside `NativeMaintenancePort`; all this adapter can do is ask that port for
 *    a purpose-bound capability and call one of its methods. There is no way to
 *    obtain the token, and no generic privileged invoke.
 *
 * 2. IT NEVER TREATS AN UNKNOWN AS A FAILURE. An IPC acknowledgement can be lost
 *    AFTER the destructive bootstrap switch has already happened. So when an
 *    apply is rejected with something that is not a well-formed Rust
 *    `{code, disposition}` error — or when it succeeds but the payload is
 *    malformed — this adapter does NOT report "the move failed". It immediately
 *    reconciles the SAME operation (same `operationId`, same `targetDataRoot`,
 *    same hidden owner token) and reports what the disk actually says. Either
 *    way the answer matters: reporting a plain failure there would release the
 *    barrier over a data folder nobody has proven.
 *
 * A NOTE ON `targetDataRoot` ECHOING. Unlike the restore ids, the target root is
 * NOT required to come back character-for-character. The backend returns the
 * AUTHORITATIVE root from its own journal (canonicalised parent + the requested
 * folder name), so `D:\Data\zhixing` and a caller's `d:/data/zhixing` legitimately
 * differ while denoting the same directory. Demanding an exact echo would reject
 * a correct answer; the operation identity is what must match.
 */

import {
  DataRootMigrationError,
  dispositionForMigrationCode,
  isDataRootMigrationErrorCode,
  isDataRootMigrationReconcileOutcome,
  isDataRootMigrationReconcileReason,
  isMigrationUuid,
  safeMessageForMigrationCode,
  type DataRootMigrationApplyResult,
  type DataRootMigrationDisposition,
  type DataRootMigrationErrorCode,
  type DataRootMigrationPort,
  type DataRootMigrationReconcileResult,
  type DataRootMigrationRequest,
} from '@/dataRootMigration/model'
import {
  platformMaintenancePort,
  type DataRootMigrationCapabilitySource,
  type DataRootMigrationOwnerCapability,
} from './maintenance'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Build the domain error for a code, honouring the maximum of the locally
 * declared disposition and any disposition reported by the backend. A code the
 * backend calls RECOVERABLE but this build considers BLOCKED stays BLOCKED — the
 * conservative answer always wins.
 */
function migrationError(
  code: DataRootMigrationErrorCode,
  reported?: DataRootMigrationDisposition,
): DataRootMigrationError {
  const local = dispositionForMigrationCode(code)
  const disposition: DataRootMigrationDisposition =
    local === 'BLOCKED' || reported === 'BLOCKED' ? 'BLOCKED' : 'RECOVERABLE'
  return new DataRootMigrationError(
    code,
    safeMessageForMigrationCode(code),
    disposition,
  )
}

/**
 * A WELL-FORMED backend error: `{ code, disposition }` where both are values
 * this build knows. Anything else (a string, a Tauri internals object, an
 * unknown code, a missing disposition) is NOT a structured failure — it is an
 * unknown, and an unknown must be reconciled rather than believed.
 */
function parseStructuredError(
  error: unknown,
): { code: DataRootMigrationErrorCode; disposition: DataRootMigrationDisposition } | null {
  if (!isRecord(error)) return null
  const code = error['code']
  const disposition = error['disposition']
  if (!isDataRootMigrationErrorCode(code)) return null
  if (disposition !== 'RECOVERABLE' && disposition !== 'BLOCKED') return null
  return { code, disposition }
}

/** A non-empty authoritative root string, as the backend renders it. */
function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

/** Strict parse of the apply success DTO. */
function parseApplyResult(
  raw: unknown,
  request: DataRootMigrationRequest,
): DataRootMigrationApplyResult | null {
  if (!isRecord(raw)) return null
  const { operationId, targetDataRoot, outcome, safetyBackupId } = raw
  if (outcome !== 'MIGRATED') return null
  if (operationId !== request.operationId) {
    // A payload describing a different operation is unusable.
    return null
  }
  if (!isNonEmptyString(targetDataRoot)) return null
  if (!isMigrationUuid(safetyBackupId)) return null
  return {
    operationId,
    targetDataRoot,
    outcome: 'MIGRATED',
    safetyBackupId,
  }
}

function parseReconcileResult(
  raw: unknown,
  request: DataRootMigrationRequest,
): DataRootMigrationReconcileResult | null {
  if (!isRecord(raw)) return null
  const { operationId, targetDataRoot, outcome, reasonCode, safetyBackupId } = raw
  if (operationId !== request.operationId) return null
  if (!isNonEmptyString(targetDataRoot)) return null
  if (!isDataRootMigrationReconcileOutcome(outcome)) return null

  // Validate EVERY present optional field before trusting any of them, so an
  // invalid trailing field can never be hidden behind a valid leading one.
  const hasReason = reasonCode !== undefined && reasonCode !== null
  if (hasReason && !isDataRootMigrationReconcileReason(reasonCode)) return null
  const hasSafety = safetyBackupId !== undefined && safetyBackupId !== null
  if (hasSafety && !isMigrationUuid(safetyBackupId)) return null

  // A reason code explains INDETERMINATE, and only INDETERMINATE. Any other
  // combination is contradictory and must not be interpreted.
  const isIndeterminate = outcome === 'INDETERMINATE'
  if (isIndeterminate !== hasReason) return null

  return {
    operationId,
    targetDataRoot,
    outcome,
    ...(hasReason
      ? {
          reasonCode:
            reasonCode as DataRootMigrationReconcileResult['reasonCode'],
        }
      : {}),
    // `hasSafety` is an aliased type predicate, so the value is already narrowed
    // to `string` here — an assertion would be redundant.
    ...(hasSafety ? { safetyBackupId } : {}),
  }
}

export class NativeDataRootMigrationAdapter implements DataRootMigrationPort {
  /**
   * The narrow MIGRATION source. This adapter cannot see — at compile time or at
   * runtime — a restore method, and it is never handed anything else.
   */
  private readonly ownerSource: DataRootMigrationCapabilitySource

  constructor(ownerSource: DataRootMigrationCapabilitySource) {
    this.ownerSource = ownerSource
  }

  async applyDataRootMigration(
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationApplyResult> {
    const capability = this.ownerSource.dataRootMigrationCapability()
    if (capability === null) {
      // No owner token ⇒ this adapter is not the barrier owner. Nothing was
      // attempted, so the Data Root is provably untouched.
      throw migrationError('OWNER_UNAVAILABLE')
    }

    let raw: unknown
    try {
      raw = await capability.applyDataRootMigration(request)
    } catch (caught: unknown) {
      const structured = parseStructuredError(caught)
      if (structured !== null) {
        // A KNOWN failure: its code and disposition are authoritative.
        throw migrationError(structured.code, structured.disposition)
      }
      // Unknown rejection / transport acknowledgement ambiguity. The bootstrap
      // switch may already have happened — reconcile instead of guessing.
      return await this.reconcileAmbiguity(capability, request)
    }

    const applied = parseApplyResult(raw, request)
    if (applied === null) {
      // Malformed success is just as ambiguous as an unknown rejection.
      return await this.reconcileAmbiguity(capability, request)
    }
    return applied
  }

  async reconcileDataRootMigration(
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationReconcileResult> {
    const capability = this.ownerSource.dataRootMigrationCapability()
    if (capability === null) {
      throw migrationError('OWNER_UNAVAILABLE')
    }
    return await this.callReconcile(capability, request)
  }

  /**
   * Resolve an ambiguous apply by re-proving which root is authoritative.
   *
   * Deliberately NOT a plain "look at the journal": the backend measures the
   * bootstrap, the target and the source on disk. Whatever it proves, this
   * adapter reports the truth — success when the migration is proven applied, a
   * RECOVERABLE failure when the source is proven authoritative, and BLOCKED
   * when nothing is provable.
   */
  private async reconcileAmbiguity(
    capability: DataRootMigrationOwnerCapability,
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationApplyResult> {
    const result = await this.callReconcile(capability, request)

    switch (result.outcome) {
      case 'COMMITTED': {
        // The migration IS applied. It may only be reported as a success when
        // the full result is present; a partial proof stays BLOCKED (fail
        // closed).
        if (result.safetyBackupId === undefined) {
          throw migrationError('PROTOCOL_INVALID')
        }
        return {
          operationId: result.operationId,
          targetDataRoot: result.targetDataRoot,
          outcome: 'MIGRATED',
          safetyBackupId: result.safetyBackupId,
        }
      }
      case 'NOT_COMMITTED':
        // The source root is authoritative again: the switch did not stick.
        throw migrationError('BOOTSTRAP_SWITCH_FAILED')
      case 'ROLLED_BACK':
        throw migrationError('ROLLED_BACK')
      case 'INDETERMINATE':
        throw migrationError('SWITCH_INDETERMINATE')
    }
  }

  /** One reconcile call, with its own ambiguity handling. */
  private async callReconcile(
    capability: DataRootMigrationOwnerCapability,
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationReconcileResult> {
    let raw: unknown
    try {
      raw = await capability.reconcileDataRootMigration(request)
    } catch (caught: unknown) {
      const structured = parseStructuredError(caught)
      if (structured !== null) {
        throw migrationError(structured.code, structured.disposition)
      }
      // The reconcile itself is unanswerable. NEVER report that as a failure:
      // the barrier must stay held.
      throw migrationError('TRANSPORT_AMBIGUOUS')
    }

    const result = parseReconcileResult(raw, request)
    if (result === null) {
      throw migrationError('PROTOCOL_INVALID')
    }
    return result
  }
}

/**
 * Production Native data root migration port, bound to the production
 * maintenance port so the owner token stays inside that one module.
 *
 * Not yet part of any composition root: the migration UI is deferred, so nothing
 * constructs a `DataRootMigrationWorkflow` in production yet.
 */
export const nativeDataRootMigrationAdapter: DataRootMigrationPort =
  new NativeDataRootMigrationAdapter(platformMaintenancePort)
