/**
 * P6-S8 · Backup Restore service
 *
 * A thin application-layer wrapper over the platform `BackupRestorePort`, so
 * callers (and the workflow) depend on an application service rather than a
 * platform adapter.
 *
 * It exposes TWO operations and nothing else:
 *   - `apply()`     — perform the restore,
 *   - `reconcile()` — re-prove what actually happened.
 *
 * It deliberately performs NO orchestration: entering / releasing the strong
 * maintenance barrier belongs to `BackupRestoreWorkflow`, which is the only
 * place that knows the release rule (release on success and on a PROVEN
 * recoverable failure; never release while the outcome is unprovable).
 *
 * The request shape is validated here, at the domain boundary, so a malformed
 * id can never reach a platform adapter.
 */

import {
  BackupRestoreError,
  isRestoreUuid,
  type BackupRestoreApplyResult,
  type BackupRestorePort,
  type BackupRestoreReconcileResult,
  type BackupRestoreRequest,
} from './model'

function requireUuid(value: string, field: string): string {
  if (!isRestoreUuid(value)) {
    throw new BackupRestoreError(
      'REQUEST_INVALID',
      `The ${field} was not a valid identifier.`,
    )
  }
  return value
}

export class BackupRestoreService {
  private readonly port: BackupRestorePort

  constructor(port: BackupRestorePort) {
    this.port = port
  }

  /**
   * Apply one DATABASE RESTORE V1.
   *
   * Resolves only when the restore is PROVEN applied. An unprovable outcome is
   * reported as a BLOCKED `BackupRestoreError` — never as a failure — so the
   * caller keeps the barrier and reconciles instead of releasing it.
   *
   * `async` on purpose: a request-validation failure must arrive as a REJECTED
   * PROMISE. A method declared `Promise<T>` that throws synchronously would
   * escape a caller's `.catch()` / `try`-around-`await` discipline.
   */
  async apply(request: BackupRestoreRequest): Promise<BackupRestoreApplyResult> {
    const operationId = requireUuid(request.operationId, 'operation id')
    const backupId = requireUuid(request.backupId, 'backup id')
    return await this.port.applyBackupRestore({ operationId, backupId })
  }

  /**
   * Re-prove what a possibly-ambiguous operation actually did.
   *
   * Uses the SAME `operationId` / `backupId` as the original apply, so it
   * answers a question about a specific attempt rather than starting a new one.
   */
  async reconcile(
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreReconcileResult> {
    const operationId = requireUuid(request.operationId, 'operation id')
    const backupId = requireUuid(request.backupId, 'backup id')
    return await this.port.reconcileBackupRestore({ operationId, backupId })
  }
}
