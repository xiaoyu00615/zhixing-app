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
/**
 * Coordinator lifecycle states.
 *
 * P6-S2 (Editor Quiesce): IDLE / PREPARING / FLUSHING_EDITORS / PREPARED.
 *
 * P6-S4C (Platform Maintenance Handoff) ADDS three states that the new
 * `enterExclusiveMaintenance()` flow passes through / lands in:
 *   - DRAINING_PERSISTENCE: editors flushed, now acquiring the platform strong
 *     persistence barrier (Web slot reservation / Native maintenance lease).
 *   - EXCLUSIVE_MAINTENANCE: the platform barrier is held and an
 *     `ExclusiveMaintenanceLease` has been returned to the caller.
 *   - BLOCKED: a platform persistence failure that cannot be proven released
 *     (RECOVERABLE/BLOCKED disposition, or an unclassifiable unexpected error).
 *     The coordinator MUST NOT return to IDLE from BLOCKED — a second
 *     `prepareForMaintenance()` / `enterExclusiveMaintenance()` is refused with
 *     OVERLAP until an out-of-band recovery (future slice) clears it. No
 *     recovery UI is implemented in this slice.
 */
export type CoordinatorState =
  | 'IDLE'
  | 'PREPARING'
  | 'FLUSHING_EDITORS'
  | 'PREPARED'
  | 'DRAINING_PERSISTENCE'
  | 'EXCLUSIVE_MAINTENANCE'
  | 'BLOCKED'

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
  public readonly code:
    | 'OVERLAP'
    | 'FLUSH_FAILED'
    | 'RETIRE_FAILED'
    | 'PERSISTENCE_FAILED'

  constructor(code: MaintenanceCoordinatorError['code'], message: string) {
    super(message)
    this.name = 'MaintenanceCoordinatorError'
    this.code = code
  }
}

// ============================================================
// P6-S4C · Platform Maintenance Handoff · Shared Port contract
// ============================================================
//
// A deliberately NARROW common contract shared by the Web and Native platform
// adapters. It describes ONLY:
//   - enter an exclusive persistence state,
//   - release that exclusive persistence state.
// It deliberately does NOT mention Backup / Restore / Migration / SQLite / OPFS /
// Worker / Tauri. Those belong to future slices that consume this lease.

/**
 * A held exclusive persistence barrier. The caller performs its high-risk work
 * (Backup / Restore / Data-Root Migration — future slices) while this lease is
 * alive, then calls `release()`.
 */
export interface PersistenceMaintenanceLease {
  /** Stable identity of the underlying platform owner (e.g. web-reservation-N). */
  readonly leaseId: string
  /** Release the platform persistence barrier. Safe to call once. */
  release(): Promise<void>
}

/**
 * The platform-agnostic strong-maintenance barrier entry point. Implemented by
 * `WebMaintenancePort` (Web adapter) and `NativeMaintenancePort` (Native adapter).
 */
export interface PersistenceMaintenancePort {
  /**
   * Acquire the platform strong persistence barrier. Resolves only when the
   * platform can PROVE admission is closed and in-flight work has settled.
   * Rejects with a `PersistenceMaintenanceError` carrying a disposition.
   */
  enterStrongMaintenance(): Promise<PersistenceMaintenanceLease>
}

/**
 * Two failure dispositions a platform adapter must distinguish:
 *
 * - RECOVERABLE: the adapter has already safely cleaned up any platform owner it
 *   obtained, so the coordinator may return to IDLE and the operation can be
 *   retried later.
 * - BLOCKED: the persistence layer is in a fail-closed uncertain state that may
 *   still be locked or whose release cannot be proven. The coordinator MUST NOT
 *   pretend persistence recovered — it stays BLOCKED, never IDLE.
 */
export type PersistenceMaintenanceDisposition = 'RECOVERABLE' | 'BLOCKED'

/**
 * Typed error returned by a `PersistenceMaintenancePort`. Carries both a coarse
 * `code` and the all-important `disposition` so the coordinator can decide
 * whether returning to IDLE is safe.
 */
export class PersistenceMaintenanceError extends Error {
  public readonly code: string
  public readonly disposition: PersistenceMaintenanceDisposition

  constructor(
    code: string,
    disposition: PersistenceMaintenanceDisposition,
    message: string,
  ) {
    super(message)
    this.name = 'PersistenceMaintenanceError'
    this.code = code
    this.disposition = disposition
  }
}

/**
 * Coordinator-level exclusive lease returned by a successful
 * `enterExclusiveMaintenance()`. This is the OWNER the caller holds; it must NOT
 * expose the underlying web reservation id, web worker lease, or native-maint-N
 * id. Its `release()` first awaits the platform barrier release, THEN clears
 * coordinator ownership.
 */
export interface ExclusiveMaintenanceLease {
  /** Unique identity of THIS exclusive session. Never reused. */
  readonly leaseId: string
  /**
   * Release the exclusive session. FIRST awaits the platform persistence release,
   * THEN returns the coordinator to IDLE. On platform release failure the
   * coordinator stays in EXCLUSIVE_MAINTENANCE and the same handle may retry.
   */
  release(): Promise<void>
}
