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
 */

import { invoke } from '@tauri-apps/api/core'
import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from '@/maintenance/model'

const ENTER_COMMAND = 'native_maintenance_enter'
const EXIT_COMMAND = 'native_maintenance_exit'

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

export class NativeMaintenancePort implements PersistenceMaintenancePort {
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

    const leaseId = parseLease(raw)
    if (leaseId === null) {
      // Malformed success response → BLOCKED.
      throw new PersistenceMaintenanceError(
        'MALFORMED_LEASE',
        'BLOCKED',
        'Native maintenance enter returned a malformed lease',
      )
    }

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
          // Real Tauri camelCase argument contract.
          await invoke(EXIT_COMMAND, { leaseId })
        } catch {
          // Keep retry-capable: clear single-flight so the SAME handle can retry.
          releasePromise = null
          throw new PersistenceMaintenanceError(
            'NATIVE_EXIT_FAILED',
            'BLOCKED',
            'Native maintenance exit rejected; barrier release unproven',
          )
        }
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
}

/** Production Native platform persistence port. */
export const platformMaintenancePort: PersistenceMaintenancePort =
  new NativeMaintenancePort()
