/**
 * P6-S2 · Editor Quiesce Foundation · Coordinator
 *
 * Tracks page-local editor flush participants across route changes so that a
 * maintenance operation can explicitly await every dirty editor draft before it
 * begins.
 *
 * Registration identity vs logical editor identity
 * -----------------------------------------------
 * `logical editor identity != registration lifecycle identity`. A page registers
 * with a stable LOGICAL id (e.g. `note-editor`), but the coordinator issues a
 * unique per-mount registration TOKEN for every `register()` call and keys the
 * ACTIVE / RETIRING maps by that token.
 *
 * Consequence (the frozen invariant): a RETIRING registration NEVER disappears
 * from the coordinator's horizon because the same logical editor mounts again.
 * Under StrictMode (mount -> cleanup -> remount) the old instance stays RETIRING
 * while the new instance is ACTIVE; both are awaited during preparation.
 *
 * Active vs Retiring
 * ------------------
 * - ACTIVE: the editor is mounted and registered; `flush()` can be called now.
 * - RETIRING: the editor is unmounting; its unmount flush + dispose completion
 *   promise is still pending and must also be awaited during preparation. We
 *   MUST keep Retiring participants in view, otherwise a route change that
 *   triggers a background flush would vanish from the coordinator's horizon and a
 *   concurrent maintenance operation could start before the draft is persisted.
 *
 * Failure semantics (latched, recoverable only by explicit acknowledgement)
 * -------------------------------------------------------------------------
 * - An ACTIVE `flush()` that rejects => `prepareForMaintenance()` rejects and the
 *   coordinator returns to a safe non-maintenance state (IDLE).
 * - A RETIRING completion that rejects LATCHES a maintenance-blocking fault for
 *   that logical editor id. Every later `prepareForMaintenance()` fails closed
 *   until the fault is acknowledged. Registering a NEW instance of the same
 *   logical id must not clear it: a new mount proves nothing about the old
 *   unsaved draft.
 * - The fault is NOT a permanent poison. `acknowledgeRetiredFailure(id)` is the
 *   single explicit recovery entry point: it means "the upper layer has handled
 *   / surfaced this save failure", NOT "the draft was successfully persisted".
 *   Acknowledging an unknown id is a NO-OP, and acknowledging one editor never
 *   clears another editor's fault.
 *
 * Overlap / lease
 * ---------------
 * Only one preparation may be held at a time. A second `prepareForMaintenance()`
 * while the first is PREPARING / FLUSHING_EDITORS OR PREPARED is rejected
 * predictably; it is never queued indefinitely. A successful preparation returns
 * a `PreparedMaintenance` lease with a UNIQUE `leaseId`; `release()` is
 * owner-scoped and idempotent, so a stale handle can never unlock a newer
 * preparation. Only an owning `release()` returns the coordinator to IDLE.
 */

import {
  MaintenanceCoordinatorError,
  type CoordinatorState,
  type EditorRegistration,
  type MaintenanceFlushParticipant,
  type PreparedMaintenance,
} from './model'

function toError(reason: unknown): Error {
  return reason instanceof Error ? reason : new Error(String(reason))
}

export class MaintenanceCoordinator {
  private readonly active = new Map<
    string,
    { id: string; participant: MaintenanceFlushParticipant }
  >()
  private readonly retiring = new Map<
    string,
    { id: string; completion: Promise<void> }
  >()
  /**
   * Latched retirement failures, keyed by LOGICAL editor id. Never cleared by
   * `register()`: a new mount of the same logical editor must not erase the
   * evidence that an earlier instance failed to persist its draft. Only
   * `acknowledgeRetiredFailure(id)` clears an entry.
   */
  private readonly retiredFailures = new Map<string, Error>()
  private state: CoordinatorState = 'IDLE'
  private tokenSeq = 0
  private leaseSeq = 0
  private currentLeaseId: string | null = null

  /**
   * Register an editor instance as ACTIVE and return a handle scoped to THIS
   * mount instance. The handle's `retire()` only retires this instance.
   */
  register(participant: MaintenanceFlushParticipant): EditorRegistration {
    // A NEW token per call: the registration lifecycle identity is NOT the
    // logical id. Two instances of the same logical editor may coexist
    // (one RETIRING, one ACTIVE) and both must be awaited.
    const token = `reg-${this.tokenSeq++}`
    this.active.set(token, { id: participant.id, participant })

    return {
      retire: (completion: Promise<void>): void => {
        const instance = this.active.get(token)
        // Already retired / superseded for THIS token: nothing to track.
        if (instance === undefined) {
          return
        }
        this.active.delete(token)
        this.retiring.set(token, { id: instance.id, completion })
        // Observe completion without swallowing its rejection: keep `completion`
        // itself in the map so prepareForMaintenance can allSettled it, and only
        // move bookkeeping + cache the failure once it settles.
        void completion.then(
          () => {
            this.retiring.delete(token)
          },
          (reason: unknown) => {
            this.retiring.delete(token)
            this.retiredFailures.set(instance.id, toError(reason))
          },
        )
      },
    }
  }

  getState(): CoordinatorState {
    return this.state
  }

  getActiveCount(): number {
    return this.active.size
  }

  getRetiringCount(): number {
    return this.retiring.size
  }

  getRetiredFailureCount(): number {
    return this.retiredFailures.size
  }

  /** Logical editor ids with a latched maintenance-blocking fault. */
  getRetiredFailureIds(): readonly string[] {
    return [...this.retiredFailures.keys()]
  }

  /**
   * Explicitly acknowledge a latched retirement failure for one logical editor
   * id, clearing the maintenance-blocking fault.
   *
   * Semantics — this is an ACKNOWLEDGEMENT, not a proof of recovery:
   *   - Call it only after the upper layer has handled / surfaced the save
   *     failure to the user. It does NOT mean the lost draft was persisted.
   *   - Unknown id => NO-OP (never throws), so the API stays easy for future UI.
   *   - Selective: acknowledging `note-editor` leaves `diary-editor` latched.
   */
  acknowledgeRetiredFailure(id: string): void {
    this.retiredFailures.delete(id)
  }

  /**
   * Await every ACTIVE editor flush and every RETIRING completion. Rejects
   * (without entering a maintenance state) if any of them fails, so maintenance
   * must NOT proceed. On success returns the PREPARED lease.
   */
  async prepareForMaintenance(): Promise<PreparedMaintenance> {
    // PREPARING / FLUSHING_EDITORS / PREPARED all hold the operation: only one
    // preparation may exist at a time and a held lease is still a preparation.
    if (this.state !== 'IDLE') {
      throw new MaintenanceCoordinatorError(
        'OVERLAP',
        'maintenance preparation is already in progress or prepared',
      )
    }
    this.state = 'PREPARING'
    try {
      this.state = 'FLUSHING_EDITORS'
      const activeFlushes = [...this.active.values()].map((entry) =>
        entry.participant.flush(),
      )
      const retiringCompletions = [...this.retiring.values()].map(
        (entry) => entry.completion,
      )
      const settled = await Promise.allSettled([
        ...activeFlushes,
        ...retiringCompletions,
      ])

      for (const result of settled) {
        if (result.status === 'rejected') {
          throw toError(result.reason)
        }
      }

      // Fail closed on any latched fault, even if it completed before
      // preparation began (it is no longer in RETIRING, so allSettled above
      // cannot see it).
      if (this.retiredFailures.size > 0) {
        const reason = [...this.retiredFailures.values()][0]
        if (reason !== undefined) {
          throw reason
        }
      }

      this.state = 'PREPARED'
      // Unique preparation identity: a stale lease can never unlock a newer one.
      const leaseId = `prep-${this.leaseSeq++}`
      this.currentLeaseId = leaseId
      return {
        leaseId,
        release: (): void => {
          // Owner-scoped + idempotent: only the CURRENT lease holder may return
          // the coordinator to IDLE. A stale handle is a silent NO-OP.
          if (this.state !== 'PREPARED') {
            return
          }
          if (this.currentLeaseId !== leaseId) {
            return
          }
          this.currentLeaseId = null
          this.state = 'IDLE'
        },
      }
    } catch (error) {
      // Never leave the coordinator in a maintenance state on failure.
      this.state = 'IDLE'
      if (error instanceof MaintenanceCoordinatorError) {
        throw error
      }
      throw new MaintenanceCoordinatorError(
        'FLUSH_FAILED',
        error instanceof Error ? error.message : String(error),
      )
    }
  }
}
