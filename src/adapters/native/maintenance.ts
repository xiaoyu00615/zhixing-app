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
 * maintenance-owned operation (a database restore). It is therefore treated as a
 * secret and kept in a closure owned by this module:
 *
 *   - it is never returned to the Coordinator / React / the shared restore
 *     domain, and it is deliberately NOT reachable through any accessor — there
 *     is no `getToken()`, no `rawOwnerId()`, and no token field anywhere;
 *   - the only way to use it is `ownerCapability()`, which hands out an object
 *     with EXACTLY two methods, each bound to ONE privileged Tauri command. The
 *     raw token appears only as an argument inside those two closures.
 *
 * There is deliberately NO generic `invokeAsMaintenanceOwner(command, args)`
 * helper: a generic privileged command bus would turn "may restore" into "may
 * run anything as the barrier owner", which is exactly the escalation this
 * design refuses.
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
 * The ONLY privileged surface a maintenance owner hands out (P6-S8).
 *
 * Purpose-bound by construction: two methods, each hard-wired to one Tauri
 * command, and nothing else. The raw owner id is captured in the closure that
 * builds this object and never leaves it.
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
 * A source of the current owner capability. Implemented by
 * `NativeMaintenancePort`; typed separately so the restore adapter depends on
 * the narrow contract instead of the whole maintenance port.
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
 * Bind the raw owner id into two command-specific closures.
 *
 * `ownerLeaseId` is captured here and appears ONLY as an argument of the two
 * `invoke` calls below — it is never returned, stored on an object, or logged.
 */
function buildOwnerCapability(
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

export class NativeMaintenancePort
  implements PersistenceMaintenancePort, MaintenanceOwnerCapabilitySource
{
  /**
   * The current owner capability, or null. The raw owner token itself lives
   * INSIDE the closure this holds — it is never stored as a field, so nothing
   * can read it off this instance.
   *
   * A TRUE ECMAScript private field, not the `private` keyword: a TypeScript
   * `private` member is compile-time only and still exists as an own,
   * enumerable property at runtime, so anyone holding this port could read
   * `.capability` — or spread the object — and walk away with a live privileged
   * capability. `#` makes that unreachable from outside the class.
   */
  #capability: MaintenanceOwnerCapability | null = null

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

    // Publish the purpose-bound capability for the whole lifetime of this lease.
    this.#capability = buildOwnerCapability(nativeOwnerId)

    // The RAW native owner id is never exposed. The lease handed back carries an
    // OPAQUE, local-only identity, and the token survives only inside the two
    // closures above (capability) and below (release). Nothing outside this
    // function can read it — not the Coordinator, not React, not the restore
    // domain, and not a consumer of `lease.leaseId`.
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
        // ONLY after a proven release: retract the capability. A failed exit
        // (e.g. `MAINTENANCE_BUSY` while a restore is still in flight) keeps it,
        // because the barrier is still held and the same lease stays retryable.
        this.#capability = null
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
    return this.#capability
  }
}

/** Production Native platform persistence port. */
export const platformMaintenancePort: NativeMaintenancePort =
  new NativeMaintenancePort()
