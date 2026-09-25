/**
 * P6-S4C · Native Platform Maintenance Adapter
 *
 * Implements the shared `PersistenceMaintenancePort` by invoking the FROZEN Tauri
 * commands added in P6-S4B:
 *   - `native_maintenance_enter`  (no args; AppHandle auto-injected) → { leaseId }
 *   - `native_maintenance_exit`   ({ leaseId })                  → unit
 *
 * This is the ONLY place allowed to call `invoke` for maintenance (spec §13).
 * The Coordinator / React never invoke directly. Every enter/exit failure is
 * conservatively treated as BLOCKED because the Native barrier may already be
 * active and the frontend has no reliable owner proof (spec §15).
 *
 * ---------------------------------------------------------------------------
 * P6-S8 · hidden owner token + PURPOSE-BOUND owner capability
 * ---------------------------------------------------------------------------
 *
 * The native owner id (`native-maint-<uuid-v4>`) returned by
 * `native_maintenance_enter` is the ONLY thing that authorizes a
 * maintenance-owned operation. It is therefore treated as a secret and kept in
 * closures owned by this module:
 *
 *   - it is never returned to the Coordinator / React / any restore or migration
 *     domain, and it is deliberately NOT reachable through any accessor — there
 *     is no `getToken()`, no `rawOwnerId()`, and no token field anywhere;
 *   - there is deliberately NO generic `invokeAsMaintenanceOwner(command, args)`
 *     helper: a generic privileged command bus would turn "may restore" into
 *     "may run anything as the barrier owner", which is exactly the escalation
 *     this design refuses.
 *
 * ---------------------------------------------------------------------------
 * P6-S9R · ONE owner, TWO purpose-bound capabilities
 * ---------------------------------------------------------------------------
 *
 * Restore privilege is NOT Data Root Migration privilege. A single capability
 * object carrying all four commands would mean "whoever may restore may also
 * move the whole Data Root", which is not the authority model this task is
 * granted. So the ONE owner token yields TWO independent capabilities, each with
 * exactly two hard-wired commands:
 *
 *   restore capability    -> native_backup_restore_apply
 *                            native_backup_restore_reconcile
 *   migration capability  -> native_data_root_migration_apply
 *                            native_data_root_migration_reconcile
 *
 * The separation is real, not cosmetic: each is constructed by its own builder,
 * typed by its own interface, and handed out through its own narrow source. No
 * consumer ever receives an object that answers both purposes, so no `Pick<...>`
 * narrowing at the call site is needed — or even possible.
 *
 * The raw token appears only as an argument inside the closures below. It is
 * still ONE token shared by both capabilities: being handed a capability is not
 * a way to obtain the other one, and neither capability can reach it.
 */

import { invoke } from '@tauri-apps/api/core'

import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from '@/maintenance/model'

const ENTER_COMMAND = 'native_maintenance_enter'
const EXIT_COMMAND = 'native_maintenance_exit'
const RESTORE_APPLY_COMMAND = 'native_backup_restore_apply'
const RESTORE_RECONCILE_COMMAND = 'native_backup_restore_reconcile'
const MIGRATION_APPLY_COMMAND = 'native_data_root_migration_apply'
const MIGRATION_RECONCILE_COMMAND = 'native_data_root_migration_reconcile'

/**
 * Strict parse of the enter response. Returns null on ANY malformation so a
 * malformed success is treated as BLOCKED rather than silently trusting a missing
 * owner id (spec §14).
 */
function parseLease(raw: unknown): string | null {
  if (raw === null || typeof raw !== 'object') {
    return null
  }
  const obj = raw as Record<string, unknown>
  const leaseId = obj['leaseId']
  if (typeof leaseId !== 'string' || leaseId.length === 0) {
    return null
  }
  return leaseId
}

/**
 * One maintenance-owned restore request. Carries only portable ids — never a
 * platform token, a lease id, or a filesystem path.
 */
export interface MaintenanceOwnedRestoreRequest {
  readonly operationId: string
  readonly backupId: string
}

/**
 * One maintenance-owned Data Root Migration request (P6-S9).
 *
 * `targetDataRoot` is the user's own destination folder — the same value the
 * caller already holds — and never a hidden platform path. It is the ONLY path
 * this request carries.
 */
export interface MaintenanceOwnedMigrationRequest {
  readonly operationId: string
  readonly targetDataRoot: string
}

/**
 * The RESTORE surface (P6-S8). Exactly two methods, nothing else.
 *
 * Purpose-bound by construction: each method is hard-wired to ONE Tauri command
 * (the two restore ones) inside `buildRestoreOwnerCapability`, and there is no
 * third method, no command-name parameter, and no generic invoke.
 *
 * The returned values are UNVALIDATED transport payloads; re-validating them is
 * the consuming adapter's job, so a malformed payload can never be mistaken for
 * a domain fact here.
 */
export interface MaintenanceOwnerCapability {
  applyRestore(request: MaintenanceOwnedRestoreRequest): Promise<unknown>
  reconcileRestore(request: MaintenanceOwnedRestoreRequest): Promise<unknown>
}

/**
 * The DATA ROOT MIGRATION surface (P6-S9R). Exactly two methods, nothing else.
 *
 * Deliberately a SEPARATE interface sharing nothing with
 * `MaintenanceOwnerCapability`: "may restore" must not imply "may move the whole
 * Data Root". Both capabilities are derived from the same hidden owner token,
 * but neither can reach the other, and no object ever answers both purposes.
 */
export interface DataRootMigrationOwnerCapability {
  applyDataRootMigration(
    request: MaintenanceOwnedMigrationRequest,
  ): Promise<unknown>
  reconcileDataRootMigration(
    request: MaintenanceOwnedMigrationRequest,
  ): Promise<unknown>
}

/**
 * A source of the current RESTORE capability. Implemented by
 * `NativeMaintenancePort`; typed separately so the restore adapter depends on
 * this narrow contract — and can never see a migration method even structurally.
 */
export interface MaintenanceOwnerCapabilitySource {
  /**
   * The capability bound to the CURRENT owner token, or `null` when this source
   * is not (or no longer) the active owner. A `null` is an authorization
   * failure, never a transient state to retry blindly.
   */
  ownerCapability(): MaintenanceOwnerCapability | null
}

/**
 * A source of the current DATA ROOT MIGRATION capability. The analogue of
 * `MaintenanceOwnerCapabilitySource` for the migration purpose — implemented by
 * the same port, consumed by a different adapter, and never interchangeable with
 * the restore one.
 */
export interface DataRootMigrationCapabilitySource {
  dataRootMigrationCapability(): DataRootMigrationOwnerCapability | null
}

/**
 * Bind the raw owner id into the two RESTORE closures.
 *
 * `ownerLeaseId` is captured here and appears ONLY as an argument of the two
 * `invoke` calls below — it is never returned, stored on an object, or logged.
 * It accepts no command name and produces no migration method.
 */
function buildRestoreOwnerCapability(
  ownerLeaseId: string,
): MaintenanceOwnerCapability {
  return {
    applyRestore: ({
      operationId,
      backupId,
    }: MaintenanceOwnedRestoreRequest): Promise<unknown> =>
      invoke(RESTORE_APPLY_COMMAND, { ownerLeaseId, operationId, backupId }),
    reconcileRestore: ({
      operationId,
      backupId,
    }: MaintenanceOwnedRestoreRequest): Promise<unknown> =>
      invoke(RESTORE_RECONCILE_COMMAND, { ownerLeaseId, operationId, backupId }),
  }
}

/**
 * Bind the raw owner id into the two DATA ROOT MIGRATION closures.
 *
 * The SAME hidden token is reused — one owner legitimately holds several
 * purpose-bound authorities — but this builder yields nothing the restore surface
 * exposes, just as the restore builder yields nothing this one exposes.
 */
function buildDataRootMigrationCapability(
  ownerLeaseId: string,
): DataRootMigrationOwnerCapability {
  return {
    applyDataRootMigration: ({
      operationId,
      targetDataRoot,
    }: MaintenanceOwnedMigrationRequest): Promise<unknown> =>
      invoke(MIGRATION_APPLY_COMMAND, {
        ownerLeaseId,
        operationId,
        targetDataRoot,
      }),
    reconcileDataRootMigration: ({
      operationId,
      targetDataRoot,
    }: MaintenanceOwnedMigrationRequest): Promise<unknown> =>
      invoke(MIGRATION_RECONCILE_COMMAND, {
        ownerLeaseId,
        operationId,
        targetDataRoot,
      }),
  }
}

export class NativeMaintenancePort
  implements
    PersistenceMaintenancePort,
    MaintenanceOwnerCapabilitySource,
    DataRootMigrationCapabilitySource
{
  /**
   * The two current capabilities, or null. The raw owner token itself lives
   * INSIDE the closures these point at — it is never stored as a field, so
   * nothing can read it off this instance.
   *
   * TRUE ECMAScript private fields, not the `private` keyword: a TypeScript
   * `private` member is compile-time only and still exists as an own,
   * enumerable property at runtime, so anyone holding this port could read
   * `.restoreCapability` — or spread the object — and walk away with a live
   * privileged capability. `#` makes that unreachable from outside the class.
   *
   * They are two SEPARATE fields rather than one object holding both purposes:
   * a holder of one capability can never obtain the other, even by accident.
   */
  #restoreCapability: MaintenanceOwnerCapability | null = null
  #migrationCapability: DataRootMigrationOwnerCapability | null = null

  async enterStrongMaintenance(): Promise<PersistenceMaintenanceLease> {
    let raw: unknown
    try {
      // No arguments: Tauri injects AppHandle. Success returns camelCase `leaseId`.
      raw = await invoke(ENTER_COMMAND)
    } catch {
      // Unknown Tauri error / transport acknowledgement ambiguity → BLOCKED. The
      // Native barrier may already be active and we have no owner proof.
      throw new PersistenceMaintenanceError(
        'NATIVE_ENTER_FAILED',
        'BLOCKED',
        'Native maintenance enter rejected or transport ambiguous',
      )
    }

    const nativeOwnerId = parseLease(raw)
    if (nativeOwnerId === null) {
      // Malformed success response → BLOCKED.
      throw new PersistenceMaintenanceError(
        'MALFORMED_LEASE',
        'BLOCKED',
        'Native maintenance enter returned a malformed lease',
      )
    }

    // Publish BOTH purpose-bound capabilities for the whole lifetime of this
    // lease: one authority each, both derived from the same hidden token.
    this.#restoreCapability = buildRestoreOwnerCapability(nativeOwnerId)
    this.#migrationCapability = buildDataRootMigrationCapability(nativeOwnerId)

    // The RAW native owner id is never exposed. The lease handed back carries an
    // OPAQUE, local-only identity, and the token survives only inside the four
    // closures above (capabilities) and below (release). Nothing outside this
    // function can read it — not the Coordinator, not React, not the restore or
    // migration domain, and not a consumer of `lease.leaseId`.
    const leaseId = `native-lease-${crypto.randomUUID()}`

    // Single-flight release: concurrent release() calls collapse into one invoke;
    // after a FAILED exit the promise is cleared so the SAME handle can retry
    // (Native Rust treats inactive exit as a NO-OP success, so retrying a lost
    // acknowledgement is safe — spec §17). After a SUCCESSFUL exit the lease is
    // permanently released, so any later release() is a NO-OP (spec §42).
    let releasePromise: Promise<void> | null = null
    let released = false
    const doRelease = (): Promise<void> => {
      if (released) {
        return Promise.resolve()
      }
      if (releasePromise !== null) {
        return releasePromise
      }
      releasePromise = (async () => {
        try {
          // The command contract still carries the REAL owner id; only the
          // published lease identity is opaque.
          await invoke(EXIT_COMMAND, { leaseId: nativeOwnerId })
        } catch {
          // Keep retry-capable: clear single-flight so the SAME handle can retry.
          // The owner token WITHOUT the barrier is useless: Rust refuses every
          // owner-permitted operation once `active_owner` is cleared.
          releasePromise = null
          throw new PersistenceMaintenanceError(
            'NATIVE_EXIT_FAILED',
            'BLOCKED',
            'Native maintenance exit rejected; barrier release unproven',
          )
        }
        // ONLY after a proven release: retract BOTH capabilities. A failed exit
        // (e.g. `MAINTENANCE_BUSY` while an operation is still in flight) keeps
        // them, because the barrier is still held and the same lease stays
        // retryable. One barrier, one lifetime — never one capability released
        // while the other outlives it.
        this.#restoreCapability = null
        this.#migrationCapability = null
        released = true
        releasePromise = null
      })()
      return releasePromise
    }

    return {
      leaseId,
      release: doRelease,
    }
  }

  ownerCapability(): MaintenanceOwnerCapability | null {
    return this.#restoreCapability
  }

  dataRootMigrationCapability(): DataRootMigrationOwnerCapability | null {
    return this.#migrationCapability
  }
}

/** Production Native platform persistence port. */
export const platformMaintenancePort: NativeMaintenancePort =
  new NativeMaintenancePort()
