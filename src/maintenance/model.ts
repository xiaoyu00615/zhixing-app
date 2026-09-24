/**
 * P6-S2 · Editor Quiesce Foundation · Domain model
 *
 * This slice introduces ONLY the App-level editor flush coordinator. It tracks
 * dirty Note/Diary page-local drafts so that an upcoming maintenance operation
 * (Backup / Restore / Data-Root Migration — all deferred to later slices) can
 * EXPLICITLY await every in-flight editor flush before it begins.
 *
 * Out of scope for this slice (deliberately NOT implemented here):
 *   - Web Worker drain / `TaskWorkerClient.shutdown()`
 *   - Native maintenance state / central invoke wrapper
 *   - Backup / Restore / Data Root Migration / Backup Manifest / OPFS snapshot
 *   - Cross-repository write barrier
 *
 * States are intentionally minimal. The full
 * `DRAINING_PERSISTENCE → EXCLUSIVE_MAINTENANCE → REOPEN` chain belongs to the
 * persistence-drain slice.
 */

/**
 * Coordinator lifecycle states for this slice.
 *
 * - IDLE: no operation in progress.
 * - PREPARING: `prepareForMaintenance()` entered, about to flush editors.
 * - FLUSHING_EDITORS: awaiting active + retiring editor flush completions.
 * - PREPARED: all tracked editor drafts have settled AND a preparation lease is
 *   held. A maintenance operation may now proceed. The lease is released
 *   explicitly via `PreparedMaintenance.release()` (paired with the actual
 *   maintenance execution, which is a later slice). Until release, a second
 *   `prepareForMaintenance()` is rejected with OVERLAP so two high-risk
 *   operations cannot be prepared at once.
 */
export type CoordinatorState = 'IDLE' | 'PREPARING' | 'FLUSHING_EDITORS' | 'PREPARED'

/**
 * Minimal editor flush participant.
 *
 * Only pages with a page-local dirty autosave buffer register as participants.
 * Note and Diary qualify; Task / Canvas / Project / Tag / Archive / Trash /
 * Search do NOT (they have no page-local dirty draft buffer).
 */
export interface MaintenanceFlushParticipant {
  /**
   * Stable LOGICAL editor identity (e.g. `note-editor`). It identifies WHICH
   * editor this is, NOT the mount instance: the coordinator issues a separate
   * registration token per `register()` call, so multiple instances of the same
   * logical id can coexist as RETIRING + ACTIVE.
   */
  readonly id: string
  /** Persist the latest page-local draft. Must reject if the save fails. */
  flush(): Promise<void>
}

/**
 * Handle returned by `MaintenanceCoordinator.register()`. The handle is scoped
 * to the SINGLE mount instance that called `register()`. The page holds this for
 * its lifetime and calls `retire()` when THAT instance unmounts, handing the
 * coordinator the completion promise of its flush + dispose sequence so the
 * coordinator keeps tracking it as RETIRING.
 *
 * `retire()` only affects this instance's token. A later mount of the SAME
 * logical editor id is a distinct registration/handle and must NEVER cancel or
 * clear this retirement — a retiring draft must stay visible to maintenance
 * until its completion settles, even across a StrictMode remount.
 */
export interface EditorRegistration {
  /**
   * Retire THIS editor instance. The coordinator removes it from ACTIVE and
   * tracks `completion` as a RETIRING participant until it settles.
   *
   * `completion` is the promise of this instance's unmount flush + runtime
   * dispose. It MUST be handed to the coordinator: a fire-and-forget
   * `void completion` is NOT a safe guarantee.
   */
  retire(completion: Promise<void>): void
}

/**
 * Lease returned by a successful `MaintenanceCoordinator.prepareForMaintenance()`.
 *
 * Holding this lease means the coordinator is in the PREPARED state and a
 * maintenance operation may proceed. The caller MUST call `release()` once the
 * maintenance work (a later slice) is done, returning the coordinator to IDLE.
 * Until released, a second `prepareForMaintenance()` is rejected with OVERLAP.
 *
 * Owner-scoped identity: every successful preparation gets a UNIQUE `leaseId`.
 * `release()` only unlocks the preparation that this handle owns; calling it
 * again (or after a newer preparation has taken over) is a NO-OP and can never
 * release someone else's preparation.
 */
export interface PreparedMaintenance {
  /** Unique identity of THIS preparation. Never reused. */
  readonly leaseId: string
  /**
   * Release the prepared state and return the coordinator to IDLE, but ONLY if
   * this handle still owns the current preparation. Idempotent and stale-safe.
   */
  release(): void
}

/**
 * Error type thrown by the coordinator when preparation cannot complete.
 */
export class MaintenanceCoordinatorError extends Error {
  public readonly code: 'OVERLAP' | 'FLUSH_FAILED' | 'RETIRE_FAILED'

  constructor(code: MaintenanceCoordinatorError['code'], message: string) {
    super(message)
    this.name = 'MaintenanceCoordinatorError'
    this.code = code
  }
}
