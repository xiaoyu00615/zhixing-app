/**
 * P6-S4C · Web Platform Maintenance Adapter
 *
 * Implements the shared `PersistenceMaintenancePort` using the FROZEN Web strong
 * barrier primitives from `WebTaskRepository`:
 *   - `reserveSharedWebPersistenceSlot()`
 *   - `reservation.retireGeneration()`
 *   - `reservation.release()`
 *
 * The `MaintenanceCoordinator` / React MUST NOT import `WebTaskRepository`,
 * `TaskWorkerClient`, `Worker`, or generation state directly — this adapter is the
 * single boundary that knows about them (spec §6). Every outcome of
 * `retireGeneration()` is mapped to either RECOVERABLE or BLOCKED, matching the
 * ownership rules the Web barrier already enforces.
 */

import {
  reserveSharedWebPersistenceSlot,
  type SharedWebPersistenceReservation,
} from './WebTaskRepository'
import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from '@/maintenance/model'

export class WebMaintenancePort implements PersistenceMaintenancePort {
  async enterStrongMaintenance(): Promise<PersistenceMaintenanceLease> {
    const slot = reserveSharedWebPersistenceSlot()
    if (!slot.ok) {
      // OVERLAP: we never obtained any owner, so there is nothing to release. The
      // real owner is unaffected. This is a clean RECOVERABLE refusal.
      throw new PersistenceMaintenanceError(
        'RESERVATION_OVERLAP',
        'RECOVERABLE',
        'A shared web persistence slot reservation is already held',
      )
    }

    const reservation: SharedWebPersistenceReservation = slot.reservation
    try {
      const outcome = await reservation.retireGeneration()
      if (
        outcome.ok &&
        (outcome.status === 'RETIRED' || outcome.status === 'NO_RUNTIME')
      ) {
        return {
          leaseId: reservation.reservationId,
          // Release only re-opens Web admission; it does NOT recreate the runtime
          // or remount routes (spec §33).
          release: async (): Promise<void> => {
            await reservation.release()
          },
        }
      }

      // Failure paths. `outcome` is a closed union; handle each reason.
      if (!outcome.ok) {
        switch (outcome.reason) {
          case 'BARRIER_UNAVAILABLE':
            // We ARE the reservation owner, so we make the EXPLICIT abort policy:
            // release the slot, then report RECOVERABLE. This is not the low-level
            // primitive auto-releasing — it is the new platform owner deciding to
            // abort (spec §9).
            await reservation.release()
            throw new PersistenceMaintenanceError(
              'BARRIER_UNAVAILABLE',
              'RECOVERABLE',
              'Web worker maintenance lease not yet acquired; strict close cannot begin',
            )
          case 'NORMAL_CLOSE_FAILED':
            // The failed generation stays published and future opens return
            // RUNTIME_CLOSE_FAILED; no second Worker is created. The persistence
            // layer stays fail-closed on its own, so we release the reservation
            // and report RECOVERABLE (spec §10).
            await reservation.release()
            throw new PersistenceMaintenanceError(
              'NORMAL_CLOSE_FAILED',
              'RECOVERABLE',
              'Web runtime normal close already failed; generation stays published',
            )
          case 'CLOSE_INDETERMINATE':
            // BLOCKED: do NOT release the reservation, do NOT retry the close, do
            // NOT terminate the client. The slot reservation stays held and the
            // coordinator must stay blocked (spec §11).
            throw new PersistenceMaintenanceError(
              'CLOSE_INDETERMINATE',
              'BLOCKED',
              'Web runtime close outcome indeterminate; barrier must stay held',
            )
          case 'NOT_OWNER':
            // Ownership drifted internally: we can no longer prove we own the
            // barrier. BLOCKED — do NOT release something whose ownership is
            // unproven (spec §12).
            throw new PersistenceMaintenanceError(
              'NOT_OWNER',
              'BLOCKED',
              'Web reservation ownership drifted during retirement',
            )
          default:
            throw new PersistenceMaintenanceError(
              'UNKNOWN_RETIREMENT',
              'BLOCKED',
              'Unknown web retirement failure',
            )
        }
      }

      // Defensive: the union is exhaustive, but stay fail-closed if it is not.
      throw new PersistenceMaintenanceError(
        'UNKNOWN_RETIREMENT',
        'BLOCKED',
        'Unknown web retirement outcome',
      )
    } catch (error) {
      if (error instanceof PersistenceMaintenanceError) {
        throw error
      }
      // Unexpected throw / transport-like unknown from retireGeneration → fail
      // closed (spec §12).
      throw new PersistenceMaintenanceError(
        'RETIREMENT_TRANSPORT',
        'BLOCKED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}

/** Production Web platform persistence port. */
export const platformMaintenancePort: PersistenceMaintenancePort =
  new WebMaintenancePort()
