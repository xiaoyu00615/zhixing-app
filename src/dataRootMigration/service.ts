/**
 * P6-S9 · Data Root Migration service
 *
 * A thin application-layer wrapper over the platform `DataRootMigrationPort`, so
 * callers (and the workflow) depend on an application service rather than a
 * platform adapter.
 *
 * It exposes TWO operations and nothing else:
 *   - `apply()`     — perform the migration,
 *   - `reconcile()` — re-prove which folder is authoritative.
 *
 * It deliberately performs NO orchestration: entering / releasing the strong
 * maintenance barrier belongs to `DataRootMigrationWorkflow`, which is the only
 * place that knows the release rule (release on success and on a PROVEN
 * recoverable failure; never release while the outcome is unprovable).
 *
 * The request shape is validated here, at the domain boundary, so a malformed id
 * or an unusable destination can never reach a platform adapter.
 */

import {
  DataRootMigrationError,
  isMigrationUuid,
  isUsableTargetDataRoot,
  type DataRootMigrationApplyResult,
  type DataRootMigrationPort,
  type DataRootMigrationReconcileResult,
  type DataRootMigrationRequest,
} from './model'

function requireUuid(value: string, field: string): string {
  if (!isMigrationUuid(value)) {
    throw new DataRootMigrationError(
      'REQUEST_INVALID',
      `The ${field} was not a valid identifier.`,
    )
  }
  return value
}

function requireTargetDataRoot(value: string): string {
  if (!isUsableTargetDataRoot(value)) {
    throw new DataRootMigrationError(
      'REQUEST_INVALID',
      'The destination folder was not a usable path.',
    )
  }
  return value
}

export class DataRootMigrationService {
  private readonly port: DataRootMigrationPort

  constructor(port: DataRootMigrationPort) {
    this.port = port
  }

  /**
   * Apply one SIMPLE DATA ROOT MIGRATION V1.
   *
   * Resolves only when the migration is PROVEN applied. An unprovable outcome is
   * reported as a BLOCKED `DataRootMigrationError` — never as a failure — so the
   * caller keeps the barrier and reconciles instead of releasing it.
   *
   * `async` on purpose: a request-validation failure must arrive as a REJECTED
   * PROMISE. A method declared `Promise<T>` that throws synchronously would
   * escape a caller's `.catch()` / `try`-around-`await` discipline.
   */
  async apply(
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationApplyResult> {
    const operationId = requireUuid(request.operationId, 'operation id')
    const targetDataRoot = requireTargetDataRoot(request.targetDataRoot)
    return await this.port.applyDataRootMigration({
      operationId,
      targetDataRoot,
    })
  }

  /**
   * Re-prove what a possibly-ambiguous operation actually did.
   *
   * Uses the SAME `operationId` / `targetDataRoot` as the original apply, so it
   * answers a question about a specific attempt rather than starting a new one.
   */
  async reconcile(
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationReconcileResult> {
    const operationId = requireUuid(request.operationId, 'operation id')
    const targetDataRoot = requireTargetDataRoot(request.targetDataRoot)
    return await this.port.reconcileDataRootMigration({
      operationId,
      targetDataRoot,
    })
  }
}
