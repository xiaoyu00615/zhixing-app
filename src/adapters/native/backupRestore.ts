/**
 * Native backup restore adapter (P6-S8).
 *
 * Implements the shared `BackupRestorePort` against the P6-S8 Tauri commands
 * `native_backup_restore_apply` / `native_backup_restore_reconcile`.
 *
 * Two things make this adapter more than a transport wrapper.
 *
 * 1. IT NEVER HOLDS THE OWNER TOKEN. The raw native owner id lives in a closure
 *    inside `NativeMaintenancePort`; all this adapter can do is ask that port for
 *    a purpose-bound capability and call one of its two methods. There is no way
 *    to obtain the token, and no generic privileged invoke.
 *
 * 2. IT NEVER TREATS AN UNKNOWN AS A FAILURE. An IPC acknowledgement can be lost
 *    AFTER the destructive switch has already happened. So when an apply is
 *    rejected with something that is not a well-formed Rust `{code, disposition}`
 *    error — or when it succeeds but the payload is malformed — this adapter does
 *    NOT report "restore failed". It immediately reconciles the SAME operation
 *    (same `operationId`, same `backupId`, same hidden owner token) and reports
 *    what the disk actually says. Reporting a failure there would be a lie with
 *    real consequences: the caller would release the barrier over a database
 *    that may have just been replaced.
 */

import {
  BackupRestoreError,
  dispositionForRestoreCode,
  isBackupRestoreErrorCode,
  isBackupRestoreReconcileOutcome,
  isBackupRestoreReconcileReason,
  isRestoreSha256Hex,
  isRestoreUuid,
  safeMessageForRestoreCode,
  type BackupRestoreApplyResult,
  type BackupRestoreDisposition,
  type BackupRestoreErrorCode,
  type BackupRestorePort,
  type BackupRestoreReconcileResult,
  type BackupRestoreRequest,
} from '@/backupRestore/model'
import {
  platformMaintenancePort,
  type MaintenanceOwnerCapability,
  type MaintenanceOwnerCapabilitySource,
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
function restoreError(
  code: BackupRestoreErrorCode,
  reported?: BackupRestoreDisposition,
): BackupRestoreError {
  const local = dispositionForRestoreCode(code)
  const disposition: BackupRestoreDisposition =
    local === 'BLOCKED' || reported === 'BLOCKED'
      ? 'BLOCKED'
      : 'RECOVERABLE'
  return new BackupRestoreError(
    code,
    safeMessageForRestoreCode(code),
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
): { code: BackupRestoreErrorCode; disposition: BackupRestoreDisposition } | null {
  if (!isRecord(error)) return null
  const code = error['code']
  const disposition = error['disposition']
  if (!isBackupRestoreErrorCode(code)) return null
  if (disposition !== 'RECOVERABLE' && disposition !== 'BLOCKED') return null
  return { code, disposition }
}

/** Strict parse of the apply success DTO, echoing the request back. */
function parseApplyResult(
  raw: unknown,
  request: BackupRestoreRequest,
): BackupRestoreApplyResult | null {
  if (!isRecord(raw)) return null
  const { operationId, backupId, outcome, safetyBackupId, restoredChecksumSha256 } =
    raw
  if (outcome !== 'RESTORED') return null
  if (operationId !== request.operationId || backupId !== request.backupId) {
    // A payload describing a different operation is unusable.
    return null
  }
  if (!isRestoreUuid(safetyBackupId)) return null
  if (!isRestoreSha256Hex(restoredChecksumSha256)) return null
  return {
    operationId,
    backupId,
    outcome: 'RESTORED',
    safetyBackupId,
    restoredChecksumSha256,
  }
}

function parseReconcileResult(
  raw: unknown,
  request: BackupRestoreRequest,
): BackupRestoreReconcileResult | null {
  if (!isRecord(raw)) return null
  const {
    operationId,
    backupId,
    outcome,
    reasonCode,
    safetyBackupId,
    restoredChecksumSha256,
  } = raw
  if (operationId !== request.operationId || backupId !== request.backupId) {
    return null
  }
  if (!isBackupRestoreReconcileOutcome(outcome)) return null

  // Validate EVERY present optional field before trusting any of them, so an
  // invalid trailing field can never be hidden behind a valid leading one.
  const hasReason = reasonCode !== undefined && reasonCode !== null
  if (hasReason && !isBackupRestoreReconcileReason(reasonCode)) return null
  const hasSafety = safetyBackupId !== undefined && safetyBackupId !== null
  if (hasSafety && !isRestoreUuid(safetyBackupId)) return null
  const hasChecksum =
    restoredChecksumSha256 !== undefined && restoredChecksumSha256 !== null
  if (hasChecksum && !isRestoreSha256Hex(restoredChecksumSha256)) return null

  // A reason code explains INDETERMINATE, and only INDETERMINATE. Any other
  // combination is contradictory and must not be interpreted.
  const isIndeterminate = outcome === 'INDETERMINATE'
  if (isIndeterminate !== hasReason) return null

  return {
    operationId,
    backupId,
    outcome,
    ...(hasReason
      ? { reasonCode: reasonCode as BackupRestoreReconcileResult['reasonCode'] }
      : {}),
    // `hasSafety` / `hasChecksum` are aliased type predicates, so the value is
    // already narrowed to `string` here — an assertion would be redundant.
    ...(hasSafety ? { safetyBackupId } : {}),
    ...(hasChecksum ? { restoredChecksumSha256 } : {}),
  }
}

export class NativeBackupRestoreAdapter implements BackupRestorePort {
  private readonly ownerSource: MaintenanceOwnerCapabilitySource

  constructor(ownerSource: MaintenanceOwnerCapabilitySource) {
    this.ownerSource = ownerSource
  }

  async applyBackupRestore(
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreApplyResult> {
    const capability = this.ownerSource.ownerCapability()
    if (capability === null) {
      // No owner token ⇒ this adapter is not the barrier owner. Nothing was
      // attempted, so the live database is provably untouched.
      throw restoreError('OWNER_UNAVAILABLE')
    }

    let raw: unknown
    try {
      raw = await capability.applyRestore(request)
    } catch (caught: unknown) {
      const structured = parseStructuredError(caught)
      if (structured !== null) {
        // A KNOWN failure: its code and disposition are authoritative.
        throw restoreError(structured.code, structured.disposition)
      }
      // Unknown rejection / transport acknowledgement ambiguity. The switch may
      // already have happened — reconcile instead of guessing.
      return await this.reconcileAmbiguity(capability, request)
    }

    const applied = parseApplyResult(raw, request)
    if (applied === null) {
      // Malformed success is just as ambiguous as an unknown rejection.
      return await this.reconcileAmbiguity(capability, request)
    }
    return applied
  }

  async reconcileBackupRestore(
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreReconcileResult> {
    const capability = this.ownerSource.ownerCapability()
    if (capability === null) {
      throw restoreError('OWNER_UNAVAILABLE')
    }
    return await this.callReconcile(capability, request)
  }

  /**
   * Resolve an ambiguous apply by re-proving the outcome on disk.
   *
   * Deliberately NOT a plain "look at the journal": the backend measures the live
   * database. Whatever it proves, this adapter reports the truth — success when
   * the restore is proven applied, a RECOVERABLE failure when the original
   * database is proven authoritative, and BLOCKED when nothing is provable.
   */
  private async reconcileAmbiguity(
    capability: MaintenanceOwnerCapability,
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreApplyResult> {
    const result = await this.callReconcile(capability, request)

    switch (result.outcome) {
      case 'COMMITTED': {
        // The restore IS applied. It may only be reported as a success when the
        // full result is present; a partial proof stays BLOCKED (fail closed).
        if (
          result.safetyBackupId === undefined ||
          result.restoredChecksumSha256 === undefined
        ) {
          throw restoreError('PROTOCOL_INVALID')
        }
        return {
          operationId: result.operationId,
          backupId: result.backupId,
          outcome: 'RESTORED',
          safetyBackupId: result.safetyBackupId,
          restoredChecksumSha256: result.restoredChecksumSha256,
        }
      }
      case 'NOT_COMMITTED':
        // The original database is authoritative: nothing was installed.
        throw restoreError('SWITCH_FAILED')
      case 'ROLLED_BACK':
        throw restoreError('ROLLED_BACK')
      case 'INDETERMINATE':
        throw restoreError('SWITCH_INDETERMINATE')
    }
  }

  /** One reconcile call, with its own ambiguity handling. */
  private async callReconcile(
    capability: MaintenanceOwnerCapability,
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreReconcileResult> {
    let raw: unknown
    try {
      raw = await capability.reconcileRestore(request)
    } catch (caught: unknown) {
      const structured = parseStructuredError(caught)
      if (structured !== null) {
        throw restoreError(structured.code, structured.disposition)
      }
      // The reconcile itself is unanswerable. NEVER report that as a failure:
      // the barrier must stay held.
      throw restoreError('TRANSPORT_AMBIGUOUS')
    }

    const result = parseReconcileResult(raw, request)
    if (result === null) {
      throw restoreError('PROTOCOL_INVALID')
    }
    return result
  }
}

/**
 * Production Native backup restore port, bound to the production maintenance
 * port so the owner token stays inside that one module.
 *
 * Not yet part of any composition root: the Restore UI is deferred, so nothing
 * constructs a `BackupRestoreWorkflow` in production yet.
 */
export const nativeBackupRestoreAdapter: BackupRestorePort =
  new NativeBackupRestoreAdapter(platformMaintenancePort)
