//! Native Strong Maintenance Barrier (P6-S4B).
//!
//! Authoritative Native DB-command admission gate. This module owns the
//! exclusive maintenance lease and the in-flight operation counter that backs
//! the strong-quiescence proof:
//!
//!   maintenance enter success  ⟺
//!     1. ordinary admission is closed (no new command may open a Connection)
//!     2. every already-admitted operation has completed
//!     3. every corresponding `rusqlite::Connection` has been dropped
//!     4. no later ordinary command can open a Connection
//!
//! Design constraints (frozen by spec):
//! - No long-held `RwLock`. State is guarded by a short-critical-section
//!   `Mutex<Inner>` + `Condvar` for the drain wait only.
//! - A `NativeDbOperationPermit` is NOT a lock. The DB operation runs without
//!   holding the state mutex. The permit only represents one admitted operation
//!   and decrements the in-flight counter on `Drop`.
//! - `CommandDbLease<C>` bundles a live `Connection` with its permit and
//!   guarantees, by struct field declaration order, that the Connection is
//!   dropped BEFORE the permit is released. Therefore `in_flight == 0` proves
//!   there is no live ordinary-command Connection.
//! - No new tokio dependency; drain wait runs off the synchronous Tauri command
//!   thread via `tauri::async_runtime::spawn_blocking`.
//! - Independent of `RuntimeStatus` (no `RuntimeStatus::Maintenance` hack).

use std::ops::{Deref, DerefMut};
use std::sync::{Arc, Condvar, Mutex};

use serde::{Deserialize, Serialize};
use tauri::Manager;
use uuid::Uuid;

/// Inner synchronized maintenance state.
struct MaintenanceInner {
    /// Currently active maintenance owner, if any. Its presence CLOSES ordinary
    /// admission — `acquire_operation_permit` rejects while this is `Some`.
    ///
    /// P6-S8: the id is a HIGH-ENTROPY `native-maint-<uuid-v4>` rather than a
    /// predictable monotonic sequence (`native-maint-<n>`). A guessable owner id
    /// was the one residual weakness of the S4B barrier: anything that could
    /// spell the next integer could impersonate the owner of a privileged
    /// maintenance-owned operation. The token is never exposed to the frontend
    /// (see `src/adapters/native/maintenance.ts`).
    active_owner: Option<String>,
    /// Number of ordinary DB commands currently admitted (permit alive).
    in_flight: u64,
    /// P6-S8: number of MAINTENANCE-OWNED operations currently admitted
    /// (`MaintenanceOwnedPermit` alive). Deliberately a SEPARATE counter from
    /// `in_flight`: an owner operation is not an ordinary operation and must
    /// never be mistaken for one (or be counted as evidence of ordinary
    /// quiescence). While this is > 0 the owner may not release the barrier —
    /// `end_maintenance` fails closed with `MAINTENANCE_BUSY`.
    owner_ops_in_flight: u64,
}

/// Shared core. `Arc`-owned so a `NativeDbOperationPermit` can hold a handle to
/// it independently of the `NativeMaintenanceState` managed by Tauri.
pub(crate) struct NativeMaintenanceCore {
    inner: Mutex<MaintenanceInner>,
    /// Woken when `in_flight` reaches 0 (a permit dropped).
    condvar: Condvar,
}

/// Managed Tauri state. Cheap to reference via `app.state::<NativeMaintenanceState>()`.
pub(crate) struct NativeMaintenanceState {
    core: Arc<NativeMaintenanceCore>,
}

/// RAII token representing one admitted ordinary Native DB operation.
///
/// Holding this does NOT lock anything. Dropping it decrements `in_flight` and,
/// if it reaches 0, wakes any waiting maintenance drain. The drop is
/// panic-safe: a poisoned mutex is recovered via `into_inner` and the count is
/// still released best-effort so the barrier can never be permanently stuck.
pub(crate) struct NativeDbOperationPermit {
    core: Arc<NativeMaintenanceCore>,
    #[cfg(test)]
    drop_log: Option<Arc<Mutex<Vec<&'static str>>>>,
}

/// RAII token representing one admitted MAINTENANCE-OWNED operation (P6-S8).
///
/// **A different type from `NativeDbOperationPermit`, on purpose.** An ordinary
/// command may never obtain one: `acquire_owner_permit` requires the exact
/// current owner id, and the two permit types are not interchangeable at the
/// type level, so an ordinary code path cannot accidentally — or deliberately —
/// borrow owner authority.
///
/// Holding this does NOT lock anything and does NOT close ordinary admission
/// (that is already closed by the active owner). It only keeps the barrier from
/// being released underneath a privileged operation: while any owner permit is
/// alive, `end_maintenance` fails closed with `MAINTENANCE_BUSY` instead of
/// quietly re-opening ordinary admission.
///
/// The `Drop` is panic-safe (poisoned mutex recovered via `into_inner`) but —
/// unlike the ordinary permit — it must NEVER be shared with, or degenerate
/// into, the ordinary in-flight semantics: it decrements `owner_ops_in_flight`
/// only, so a leaked owner permit can never masquerade as ordinary quiescence.
pub(crate) struct MaintenanceOwnedPermit {
    core: Arc<NativeMaintenanceCore>,
}

/// Deliberately opaque: a permit carries no readable state, so a `Debug` render
/// can never leak an owner id or an internal counter into a log or a test
/// failure message.
impl std::fmt::Debug for MaintenanceOwnedPermit {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MaintenanceOwnedPermit")
    }
}

impl Drop for MaintenanceOwnedPermit {
    fn drop(&mut self) {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            // Even a poisoned mutex must not permanently wedge the barrier.
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.owner_ops_in_flight > 0 {
            guard.owner_ops_in_flight -= 1;
        }
    }
}

/// Production connection wrapper so `CommandDbLease` can be generic over the
/// connection type without `rusqlite::Connection` needing to `Deref` to itself.
pub(crate) struct NativeConnection(pub rusqlite::Connection);

impl Deref for NativeConnection {
    type Target = rusqlite::Connection;
    fn deref(&self) -> &rusqlite::Connection {
        &self.0
    }
}

impl DerefMut for NativeConnection {
    fn deref_mut(&mut self) -> &mut rusqlite::Connection {
        &mut self.0
    }
}

/// A command DB lease: a live connection bundled with its operation permit.
///
/// **Drop order is the hard gate.** Fields are declared `connection` first,
/// `_permit` second, so Rust drops the `Connection` (closing it) BEFORE the
/// permit is released. The maintenance drain only completes when `in_flight == 0`,
/// which can only happen after every admitted Connection has already been dropped.
pub(crate) struct CommandDbLease<C: DerefMut<Target = rusqlite::Connection>> {
    connection: C,
    _permit: NativeDbOperationPermit,
}

impl<C: DerefMut<Target = rusqlite::Connection>> CommandDbLease<C> {
    pub(crate) fn new(connection: C, permit: NativeDbOperationPermit) -> Self {
        Self {
            connection,
            _permit: permit,
        }
    }
}

impl<C: DerefMut<Target = rusqlite::Connection>> Deref for CommandDbLease<C> {
    type Target = rusqlite::Connection;
    fn deref(&self) -> &rusqlite::Connection {
        self.connection.deref()
    }
}

impl<C: DerefMut<Target = rusqlite::Connection>> DerefMut for CommandDbLease<C> {
    fn deref_mut(&mut self) -> &mut rusqlite::Connection {
        self.connection.deref_mut()
    }
}

/// Transport DTO returned by `native_maintenance_enter`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMaintenanceLeaseDto {
    pub(crate) lease_id: String,
}

/// Transport error DTO for the native maintenance commands.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct NativeMaintenanceErrorDto {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl NativeMaintenanceState {
    pub(crate) fn new() -> Self {
        Self {
            core: Arc::new(NativeMaintenanceCore {
                inner: Mutex::new(MaintenanceInner {
                    active_owner: None,
                    in_flight: 0,
                    owner_ops_in_flight: 0,
                }),
                condvar: Condvar::new(),
            }),
        }
    }

    /// Acquire a permit for one ordinary DB command.
    ///
    /// Returns `None` immediately when maintenance admission is closed (strong
    /// barrier active) — the command must NOT open a Connection. On success the
    /// in-flight counter is incremented and a `NativeDbOperationPermit` is
    /// returned. The state mutex is released before returning; the DB operation
    /// runs without holding it.
    pub(crate) fn acquire_operation_permit(&self) -> Option<NativeDbOperationPermit> {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            // Fail-safe recovery: a poisoned mutex must not wedge the barrier.
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.active_owner.is_some() {
            return None;
        }
        guard.in_flight += 1;
        Some(NativeDbOperationPermit {
            core: Arc::clone(&self.core),
            #[cfg(test)]
            drop_log: None,
        })
    }

    /// Close ordinary admission and allocate a unique, HIGH-ENTROPY owner id.
    ///
    /// Fails deterministically if a maintenance owner is already active (no
    /// unbounded maintenance queue).
    ///
    /// P6-S8: the id is `native-maint-<uuid-v4>`. Ownership is the ONLY thing
    /// that authorizes a maintenance-owned operation, so it must not be
    /// guessable from a previous lease id.
    pub(crate) fn begin_maintenance(&self) -> Result<String, NativeMaintenanceErrorDto> {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.active_owner.is_some() {
            return Err(NativeMaintenanceErrorDto {
                code: "MAINTENANCE_ALREADY_ACTIVE",
                message: "Another maintenance session is already active.",
            });
        }
        let owner_id = format!("native-maint-{}", Uuid::new_v4());
        guard.active_owner = Some(owner_id.clone());
        Ok(owner_id)
    }

    /// Acquire a permit for one MAINTENANCE-OWNED operation (P6-S8).
    ///
    /// Semantics (frozen): the caller must present the EXACT current owner id.
    /// On success `owner_ops_in_flight` is incremented and a
    /// `MaintenanceOwnedPermit` — a type NO ordinary command can obtain — is
    /// returned.
    ///
    /// Every failure mode fails closed and mutates nothing:
    ///   - no active owner      → `MAINTENANCE_NOT_ACTIVE`
    ///   - a different/stale id → `MAINTENANCE_OWNER_MISMATCH`
    ///
    /// Possessing a `MaintenanceOwnedPermit` is NOT permission to write
    /// anything: it is the proof that the caller is the barrier's owner, so the
    /// caller may perform the privileged work *inside* the already-acquired
    /// barrier. Ordinary admission stays closed for the whole time.
    pub(crate) fn acquire_owner_permit(
        &self,
        owner_id: &str,
    ) -> Result<MaintenanceOwnedPermit, NativeMaintenanceErrorDto> {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.active_owner.as_deref() {
            Some(current) if current == owner_id => {
                guard.owner_ops_in_flight += 1;
                Ok(MaintenanceOwnedPermit {
                    core: Arc::clone(&self.core),
                })
            }
            Some(_) => Err(NativeMaintenanceErrorDto {
                code: "MAINTENANCE_OWNER_MISMATCH",
                message: "Provided owner id is not the active maintenance owner.",
            }),
            None => Err(NativeMaintenanceErrorDto {
                code: "MAINTENANCE_NOT_ACTIVE",
                message: "No maintenance session is active.",
            }),
        }
    }

    /// Block (off the sync command thread) until every admitted ordinary
    /// operation has finished AND every corresponding Connection has been
    /// dropped, i.e. `in_flight == 0`.
    ///
    /// Admission is already closed by `begin_maintenance`, so no new operation
    /// can increment the counter; it can only decrease. The wait re-checks the
    /// condition after every wakeup (spurious-wakeup safe) and re-verifies
    /// ownership so a lost owner aborts the drain rather than hanging.
    pub(crate) fn drain_until_idle(
        &self,
        owner_id: &str,
    ) -> Result<(), NativeMaintenanceErrorDto> {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        loop {
            match guard.active_owner.as_deref() {
                Some(current) if current == owner_id => {}
                _ => {
                    return Err(NativeMaintenanceErrorDto {
                        code: "MAINTENANCE_OWNER_MISMATCH",
                        message: "Maintenance ownership changed during drain.",
                    });
                }
            }
            if guard.in_flight == 0 {
                return Ok(());
            }
            guard = match self.core.condvar.wait(guard) {
                Ok(g) => g,
                Err(_) => {
                    return Err(NativeMaintenanceErrorDto {
                        code: "MAINTENANCE_DRAIN_FAILED",
                        message: "Maintenance drain wait was interrupted.",
                    });
                }
            };
        }
    }

    /// Release the barrier.
    ///
    /// - No active owner → safe NO-OP success (matches Web owner contract).
    /// - `lease_id` matches the current owner AND no maintenance-owned operation
    ///   is in flight → release; ordinary admission resumes.
    /// - `lease_id` matches but a maintenance-owned operation IS in flight →
    ///   `MAINTENANCE_BUSY`; the barrier REMAINS ACTIVE. We never wait for the
    ///   operation and never release underneath it. This is the P6-S8 hard gate:
    ///   even if the frontend wrongly calls `restore` and `lease.release()`
    ///   concurrently, Rust cannot re-open ordinary admission while a
    ///   destructive restore is mid-flight.
    /// - `lease_id` is wrong/stale → `MAINTENANCE_OWNER_MISMATCH`; the current
    ///   barrier stays active (a stale owner can never release a newer owner).
    pub(crate) fn end_maintenance(
        &self,
        lease_id: &str,
    ) -> Result<(), NativeMaintenanceErrorDto> {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        match guard.active_owner {
            None => Ok(()),
            Some(ref current) if current == lease_id => {
                if guard.owner_ops_in_flight > 0 {
                    // Fail closed: the barrier stays exactly as it is. The
                    // frontend maps this to BLOCKED and keeps the SAME lease
                    // retry-capable, so a later release after the operation
                    // settled succeeds.
                    return Err(NativeMaintenanceErrorDto {
                        code: "MAINTENANCE_BUSY",
                        message: "A maintenance-owned operation is still in flight.",
                    });
                }
                guard.active_owner = None;
                Ok(())
            }
            Some(_) => Err(NativeMaintenanceErrorDto {
                code: "MAINTENANCE_OWNER_MISMATCH",
                message: "Provided lease id is not the active maintenance owner.",
            }),
        }
    }

    /// Test/diagnostic helper: current maintenance-owned in-flight count.
    #[cfg(test)]
    pub(crate) fn owner_ops_in_flight_count(&self) -> u64 {
        match self.core.inner.lock() {
            Ok(g) => g.owner_ops_in_flight,
            Err(poisoned) => poisoned.into_inner().owner_ops_in_flight,
        }
    }

    /// Test/diagnostic helper: current in-flight count.
    pub(crate) fn in_flight_count(&self) -> u64 {
        match self.core.inner.lock() {
            Ok(g) => g.in_flight,
            Err(poisoned) => poisoned.into_inner().in_flight,
        }
    }

    /// Test/diagnostic helper: current active owner id, if any.
    #[cfg(test)]
    pub(crate) fn active_owner_id(&self) -> Option<String> {
        match self.core.inner.lock() {
            Ok(g) => g.active_owner.clone(),
            Err(poisoned) => poisoned.into_inner().active_owner.clone(),
        }
    }

    /// Test-only permit acquisition that records its `Drop` into `log`, used to
    /// prove the `CommandDbLease` drop order (Connection before permit).
    #[cfg(test)]
    pub(crate) fn acquire_traced(
        &self,
        log: Arc<Mutex<Vec<&'static str>>>,
    ) -> NativeDbOperationPermit {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        guard.in_flight += 1;
        NativeDbOperationPermit {
            core: Arc::clone(&self.core),
            drop_log: Some(log),
        }
    }
}

impl Drop for NativeDbOperationPermit {
    fn drop(&mut self) {
        let mut guard = match self.core.inner.lock() {
            Ok(g) => g,
            // Even a poisoned mutex must not permanently wedge the barrier.
            Err(poisoned) => poisoned.into_inner(),
        };
        if guard.in_flight > 0 {
            guard.in_flight -= 1;
        }
        if guard.in_flight == 0 {
            self.core.condvar.notify_all();
        }
        #[cfg(test)]
        if let Some(log) = &self.drop_log {
            log.lock().unwrap().push("permit");
        }
    }
}

// ============================================================
// Tauri maintenance commands
// ============================================================

/// Begin an exclusive native maintenance session.
///
/// Atomic order (spec §14):
/// 1. short admission-close under lock + allocate unique owner id,
/// 2. wait (off the sync command thread) until `in_flight == 0`.
///
/// The returned lease is the strong-barrier success proof: by the time it
/// resolves, no new ordinary command can open a Connection and every previously
/// admitted operation's Connection has been dropped.
#[tauri::command]
pub(crate) async fn native_maintenance_enter(
    app: tauri::AppHandle,
) -> Result<NativeMaintenanceLeaseDto, NativeMaintenanceErrorDto> {
    // Phase 1: short admission-close + owner allocation.
    let owner_id = app.state::<NativeMaintenanceState>().begin_maintenance()?;

    // Phase 2: drain off the synchronous command thread.
    let owner_for_wait = owner_id.clone();
    let wait_app = app.clone();
    let drain = tauri::async_runtime::spawn_blocking(move || {
        let state = wait_app.state::<NativeMaintenanceState>();
        state.drain_until_idle(&owner_for_wait)
    });

    match drain.await {
        Ok(Ok(())) => Ok(NativeMaintenanceLeaseDto { lease_id: owner_id }),
        Ok(Err(e)) => {
            // Drain infra failure → fail closed. The owner stays published so
            // ordinary admission remains closed; only a correct owner exit can
            // release it. We do NOT hand back a lease.
            Err(e)
        }
        Err(_) => Err(NativeMaintenanceErrorDto {
            code: "MAINTENANCE_DRAIN_FAILED",
            message: "Maintenance drain task failed to complete.",
        }),
    }
}

/// End the native maintenance session identified by `lease_id`.
///
/// Does not open/close any database (spec §20). Owner-checked; a stale or
/// wrong owner cannot release a newer barrier.
#[tauri::command]
pub(crate) fn native_maintenance_exit(
    app: tauri::AppHandle,
    lease_id: String,
) -> Result<(), NativeMaintenanceErrorDto> {
    app.state::<NativeMaintenanceState>().end_maintenance(&lease_id)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::ops::{Deref, DerefMut};
    use std::sync::{mpsc, Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    /// Drop-observable connection used to prove the `CommandDbLease` drop order.
    struct ObservableConnection {
        inner: rusqlite::Connection,
        log: Arc<Mutex<Vec<&'static str>>>,
    }

    impl Deref for ObservableConnection {
        type Target = rusqlite::Connection;
        fn deref(&self) -> &rusqlite::Connection {
            &self.inner
        }
    }

    impl DerefMut for ObservableConnection {
        fn deref_mut(&mut self) -> &mut rusqlite::Connection {
            &mut self.inner
        }
    }

    impl Drop for ObservableConnection {
        fn drop(&mut self) {
            self.log.lock().unwrap().push("connection");
        }
    }

    /// N-A — Cutoff + drain: an already-admitted operation keeps the drain
    /// pending; a new operation is rejected; dropping the operation completes
    /// the drain. No timers.
    #[test]
    fn n_a_cutoff_and_drain() {
        let state = Arc::new(NativeMaintenanceState::new());
        // An ordinary command has already been admitted (in-flight).
        let permit_a = state.acquire_operation_permit().expect("permit A");
        assert_eq!(state.in_flight_count(), 1);

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let sc = Arc::clone(&state);
        let drain = thread::spawn(move || {
            let owner = sc.begin_maintenance().expect("begin");
            started_tx.send(()).unwrap();
            let ok = sc.drain_until_idle(&owner).is_ok();
            let _ = done_tx.send(ok);
        });

        // Owner published, drain now waiting on the in-flight operation.
        started_rx.recv().unwrap();
        // A new ordinary operation is rejected immediately.
        assert!(
            state.acquire_operation_permit().is_none(),
            "permit B must be rejected while barrier active"
        );
        // Drain must NOT have completed (permit A still alive).
        assert!(
            done_rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "drain must not complete while permit A is alive"
        );
        // Drop the in-flight operation.
        drop(permit_a);
        // Now the drain completes.
        assert!(
            done_rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "drain must complete after permit A dropped"
        );
        drain.join().unwrap();
        assert_eq!(state.in_flight_count(), 0);
    }

    /// N-B — Multiple in-flight: the drain waits for the full count to reach 0,
    /// not just one command.
    #[test]
    fn n_b_multiple_in_flight() {
        let state = Arc::new(NativeMaintenanceState::new());
        let pa = state.acquire_operation_permit().unwrap();
        let pb = state.acquire_operation_permit().unwrap();
        let pc = state.acquire_operation_permit().unwrap();
        assert_eq!(state.in_flight_count(), 3);

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let sc = Arc::clone(&state);
        let drain = thread::spawn(move || {
            let owner = sc.begin_maintenance().unwrap();
            started_tx.send(()).unwrap();
            let ok = sc.drain_until_idle(&owner).is_ok();
            let _ = done_tx.send(ok);
        });
        started_rx.recv().unwrap();

        // Release A → count 2, drain still pending.
        drop(pa);
        assert!(
            done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "drain pending after A released"
        );
        // Release B → count 1, still pending.
        drop(pb);
        assert!(
            done_rx.recv_timeout(Duration::from_millis(200)).is_err(),
            "drain pending after B released"
        );
        // Release C → count 0, drain completes.
        drop(pc);
        assert!(
            done_rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "drain must complete after C released"
        );
        drain.join().unwrap();
        assert_eq!(state.in_flight_count(), 0);
    }

    /// N-C — Overlap: a second concurrent enter fails deterministically; the
    /// first owner remains and ordinary operations stay blocked.
    #[test]
    fn n_c_overlap() {
        let state = Arc::new(NativeMaintenanceState::new());
        let id_a = state.begin_maintenance().expect("A begin");
        let r = state.begin_maintenance();
        assert!(r.is_err(), "overlap must fail");
        assert_eq!(r.unwrap_err().code, "MAINTENANCE_ALREADY_ACTIVE");
        // Ordinary operation still blocked.
        assert!(state.acquire_operation_permit().is_none());
        // Correct exit by A restores admission.
        state.end_maintenance(&id_a).expect("exit A");
        assert!(state.acquire_operation_permit().is_some());
    }

    /// N-D — Stale owner: a stale lease cannot release a newer barrier.
    #[test]
    fn n_d_stale_owner() {
        let state = Arc::new(NativeMaintenanceState::new());
        let id_a = state.begin_maintenance().unwrap();
        state.end_maintenance(&id_a).unwrap(); // A released
        let id_b = state.begin_maintenance().unwrap(); // B now active
        // Stale A exit must fail and leave B active.
        let stale = state.end_maintenance(&id_a);
        assert!(stale.is_err());
        assert_eq!(stale.unwrap_err().code, "MAINTENANCE_OWNER_MISMATCH");
        assert!(
            state.acquire_operation_permit().is_none(),
            "B still blocks ordinary operations"
        );
        // Only B can release.
        state.end_maintenance(&id_b).unwrap();
        assert!(state.acquire_operation_permit().is_some());
    }

    /// N-E — Inactive exit: with no active maintenance, exit is a safe NO-OP.
    #[test]
    fn n_e_inactive_exit() {
        let state = Arc::new(NativeMaintenanceState::new());
        assert!(state.end_maintenance("native-maint-999").is_ok());
        assert!(state.acquire_operation_permit().is_some());
    }

    /// N-F — Ordinary resumes: enter → drain → ordinary rejected → correct exit
    /// → ordinary succeeds again.
    #[test]
    fn n_f_ordinary_resumes() {
        let state = Arc::new(NativeMaintenanceState::new());
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, _done_rx) = mpsc::channel();
        let sc = Arc::clone(&state);
        let drain = thread::spawn(move || {
            let owner = sc.begin_maintenance().unwrap();
            started_tx.send(()).unwrap();
            let ok = sc.drain_until_idle(&owner).is_ok();
            let _ = done_tx.send(ok);
        });
        started_rx.recv().unwrap();
        // Owner granted; admission closed.
        assert!(
            state.acquire_operation_permit().is_none(),
            "ordinary operation must be blocked during maintenance"
        );
        let owner = state.active_owner_id().expect("active owner");
        state.end_maintenance(&owner).unwrap();
        drain.join().unwrap();
        // Admission resumes.
        assert!(state.acquire_operation_permit().is_some());
    }

    /// N-G — No in-flight: enter with an empty in-flight set acquires the
    /// exclusive lease immediately, without opening any database.
    #[test]
    fn n_g_no_in_flight() {
        let state = Arc::new(NativeMaintenanceState::new());
        let (done_tx, done_rx) = mpsc::channel();
        let sc = Arc::clone(&state);
        let drain = thread::spawn(move || {
            let owner = sc.begin_maintenance().unwrap();
            // No in-flight → drain returns immediately.
            let ok = sc.drain_until_idle(&owner).is_ok();
            let _ = done_tx.send(ok);
        });
        // Lease acquired without opening any DB.
        assert!(
            done_rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "drain must complete immediately with no in-flight"
        );
        drain.join().unwrap();
        assert_eq!(state.in_flight_count(), 0);
        assert!(state.active_owner_id().is_some());
        let owner = state.active_owner_id().unwrap();
        state.end_maintenance(&owner).unwrap();
    }

    /// N-H — Command DB lease spans the DB operation: while a `CommandDbLease`
    /// is alive, the drain cannot complete and new operations are blocked; only
    /// after the lease drops (Connection first, then permit) does the drain
    /// finish. Also proves the explicit drop order.
    #[test]
    fn n_h_command_db_lease_spans_db_op() {
        let state = Arc::new(NativeMaintenanceState::new());

        // Simulate an ordinary command that has already been admitted and opened
        // a (live, in-memory) DB connection.
        let permit = state.acquire_operation_permit().expect("permit");
        let conn = rusqlite::Connection::open(":memory:").unwrap();
        let lease = CommandDbLease::new(NativeConnection(conn), permit);
        assert_eq!(state.in_flight_count(), 1);

        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let sc = Arc::clone(&state);
        let drain = thread::spawn(move || {
            let owner = sc.begin_maintenance().expect("begin");
            started_tx.send(()).unwrap();
            let ok = sc.drain_until_idle(&owner).is_ok();
            let _ = done_tx.send(ok);
        });
        started_rx.recv().unwrap();

        // Lease alive ⇒ drain cannot complete and new ops are rejected.
        assert!(
            done_rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "drain must be blocked while the command DB lease is alive"
        );
        assert!(state.acquire_operation_permit().is_none());

        // Drop the lease ⇒ Connection closes (first), then permit releases
        // ⇒ in_flight 0 ⇒ drain completes.
        drop(lease);
        assert!(
            done_rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "drain must complete after the command DB lease is dropped"
        );
        drain.join().unwrap();
        assert_eq!(state.in_flight_count(), 0);

        // Explicit drop-order proof: Connection dropped before permit.
        let log = Arc::new(Mutex::new(Vec::new()));
        let conn2 = ObservableConnection {
            inner: rusqlite::Connection::open(":memory:").unwrap(),
            log: Arc::clone(&log),
        };
        let permit2 = state.acquire_traced(Arc::clone(&log));
        let lease2 = CommandDbLease::new(conn2, permit2);
        assert_eq!(state.in_flight_count(), 1);
        drop(lease2);
        assert_eq!(state.in_flight_count(), 0);
        let observed = log.lock().unwrap().clone();
        assert_eq!(
            observed,
            vec!["connection", "permit"],
            "drop order must be Connection before permit"
        );
    }

    /// N-native_ping — the ping command is independent of the barrier; it is
    /// unaffected by an active maintenance session.
    #[test]
    fn n_native_ping_unaffected() {
        let state = Arc::new(NativeMaintenanceState::new());
        let _owner = state.begin_maintenance().unwrap();
        assert_eq!(crate::commands::native_ping(), "pong");
        let owner = state.active_owner_id().unwrap();
        state.end_maintenance(&owner).unwrap();
    }

    // ============================================================
    // P6-S8 — owner authorization matrix
    // ============================================================

    /// O-A — the owner id is a high-entropy, well-formed, non-reused token: it
    /// carries a UUID v4 and two successive sessions never collide.
    #[test]
    fn o_a_owner_id_is_random_uuid_and_unique() {
        let state = Arc::new(NativeMaintenanceState::new());
        let mut seen = Vec::new();
        for _ in 0..64 {
            let owner = state.begin_maintenance().expect("begin");
            let raw = owner
                .strip_prefix("native-maint-")
                .expect("owner id must carry the native-maint- prefix");
            let uuid = Uuid::parse_str(raw).expect("owner suffix must be a UUID");
            assert_eq!(uuid.get_version_num(), 4, "owner must be a UUID v4");
            assert!(
                !seen.contains(&raw.to_string()),
                "owner ids must never be reused"
            );
            seen.push(raw.to_string());
            state.end_maintenance(&owner).unwrap();
        }
        assert_eq!(seen.len(), 64);
    }

    /// O-B — owner permit: the exact owner id is accepted, ordinary admission
    /// stays closed, and the granted permit is an owner permit (not an ordinary
    /// one — a distinct type, so this is a compile-time property too).
    #[test]
    fn o_b_owner_permit_exact_match() {
        let state = NativeMaintenanceState::new();
        let owner = state.begin_maintenance().unwrap();
        let permit: MaintenanceOwnedPermit = state.acquire_owner_permit(&owner).expect("permit");
        assert_eq!(state.owner_ops_in_flight_count(), 1);
        assert!(
            state.acquire_operation_permit().is_none(),
            "ordinary admission stays closed while the owner works"
        );
        drop(permit);
        assert_eq!(state.owner_ops_in_flight_count(), 0);
        state.end_maintenance(&owner).unwrap();
    }

    /// O-C — a wrong owner id is rejected and mutates nothing.
    #[test]
    fn o_c_wrong_owner_rejected() {
        let state = NativeMaintenanceState::new();
        let owner = state.begin_maintenance().unwrap();
        let err = state.acquire_owner_permit("native-maint-00000000-0000-4000-8000-000000000000");
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, "MAINTENANCE_OWNER_MISMATCH");
        assert_eq!(
            state.owner_ops_in_flight_count(),
            0,
            "a rejected permit must not be counted"
        );
        // The real owner is still the only one who can work/release.
        state.acquire_owner_permit(&owner).expect("real owner");
        state.end_maintenance(&owner).unwrap();
    }

    /// O-D — a stale owner id (a lease that has already been released) is
    /// rejected; it can never act inside a newer barrier.
    #[test]
    fn o_d_stale_owner_rejected() {
        let state = NativeMaintenanceState::new();
        let stale = state.begin_maintenance().unwrap();
        state.end_maintenance(&stale).unwrap();

        let fresh = state.begin_maintenance().unwrap();
        let err = state.acquire_owner_permit(&stale);
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, "MAINTENANCE_OWNER_MISMATCH");
        assert_eq!(state.owner_ops_in_flight_count(), 0);
        // The fresh owner is unaffected.
        state.acquire_owner_permit(&fresh).expect("fresh owner");
        drop(state.acquire_owner_permit(&fresh).unwrap());
        state.end_maintenance(&fresh).unwrap();
    }

    /// O-E — with NO active barrier there is no owner to prove, so no owner
    /// permit can be obtained (fail closed, never "owner-less privileged work").
    #[test]
    fn o_e_no_active_owner_rejected() {
        let state = NativeMaintenanceState::new();
        let err = state.acquire_owner_permit("native-maint-whatever");
        assert!(err.is_err());
        assert_eq!(err.unwrap_err().code, "MAINTENANCE_NOT_ACTIVE");
        assert_eq!(state.owner_ops_in_flight_count(), 0);
        // Ordinary work is unaffected by a failed owner request.
        assert!(state.acquire_operation_permit().is_some());
    }

    /// O-F — during an active barrier an ordinary permit is DENIED, while the
    /// correct owner permit is ALLOWED. The two admission paths never blur.
    #[test]
    fn o_f_ordinary_denied_owner_allowed() {
        let state = NativeMaintenanceState::new();
        let owner = state.begin_maintenance().unwrap();
        assert!(state.acquire_operation_permit().is_none(), "ordinary denied");
        let permit = state.acquire_owner_permit(&owner).expect("owner allowed");
        assert!(state.acquire_operation_permit().is_none(), "ordinary still denied");
        drop(permit);
        state.end_maintenance(&owner).unwrap();
        assert!(state.acquire_operation_permit().is_some(), "ordinary resumes");
    }

    /// O-G — `owner_ops_in_flight` counts owner operations only; ordinary
    /// in-flight bookkeeping is untouched by owner permits and vice versa.
    #[test]
    fn o_g_owner_ops_count_is_separate_from_ordinary() {
        let state = NativeMaintenanceState::new();

        // Two ordinary operations before the barrier.
        let ordinary_a = state.acquire_operation_permit().unwrap();
        let ordinary_b = state.acquire_operation_permit().unwrap();
        assert_eq!(state.in_flight_count(), 2);
        assert_eq!(
            state.owner_ops_in_flight_count(),
            0,
            "ordinary permits must never be counted as owner operations"
        );
        drop(ordinary_a);
        drop(ordinary_b);

        let owner = state.begin_maintenance().unwrap();
        let first = state.acquire_owner_permit(&owner).unwrap();
        let second = state.acquire_owner_permit(&owner).unwrap();
        assert_eq!(state.owner_ops_in_flight_count(), 2);
        assert_eq!(
            state.in_flight_count(),
            0,
            "owner permits must never be counted as ordinary in-flight"
        );
        drop(first);
        assert_eq!(state.owner_ops_in_flight_count(), 1);
        drop(second);
        assert_eq!(state.owner_ops_in_flight_count(), 0);
        state.end_maintenance(&owner).unwrap();
    }

    /// O-H — THE hard gate: while an owner operation is in flight,
    /// `end_maintenance` fails with `MAINTENANCE_BUSY`, the barrier REMAINS
    /// ACTIVE (ordinary admission stays closed), and it is not silently
    /// released later. Once the owner permit drops, the SAME owner can release
    /// successfully.
    #[test]
    fn o_h_end_maintenance_busy_while_owner_op_active() {
        let state = NativeMaintenanceState::new();
        let owner = state.begin_maintenance().unwrap();
        let permit = state.acquire_owner_permit(&owner).expect("owner permit");

        let busy = state.end_maintenance(&owner);
        assert!(busy.is_err(), "release must fail while an owner op is active");
        assert_eq!(busy.unwrap_err().code, "MAINTENANCE_BUSY");
        assert!(
            state.acquire_operation_permit().is_none(),
            "the barrier must REMAIN active after MAINTENANCE_BUSY"
        );
        assert_eq!(state.active_owner_id().as_deref(), Some(owner.as_str()));

        // A retry while still busy fails identically — never a silent release.
        assert_eq!(
            state.end_maintenance(&owner).unwrap_err().code,
            "MAINTENANCE_BUSY"
        );

        // Drop the owner operation → the owner can now release.
        drop(permit);
        assert_eq!(state.owner_ops_in_flight_count(), 0);
        state.end_maintenance(&owner).expect("release after op settled");
        assert!(state.acquire_operation_permit().is_some(), "ordinary resumes");
    }

    /// O-I — the ordinary permit's `Drop` and the owner permit's `Drop` are
    /// independent: an ordinary permit releasing does not unblock a BUSY
    /// release, and the owner-op drop does not disturb ordinary bookkeeping.
    #[test]
    fn o_i_owner_op_drop_does_not_share_ordinary_semantics() {
        let state = Arc::new(NativeMaintenanceState::new());
        let owner = state.begin_maintenance().unwrap();
        let owner_permit = state.acquire_owner_permit(&owner).unwrap();

        // An ordinary permit cannot even be obtained here; but even if an
        // ordinary count existed it must not let the release through.
        assert!(state.acquire_operation_permit().is_none());
        assert_eq!(
            state.end_maintenance(&owner).unwrap_err().code,
            "MAINTENANCE_BUSY"
        );

        // Drop order irrelevant: only the owner-op counter gates the release.
        drop(owner_permit);
        assert_eq!(state.in_flight_count(), 0);
        assert_eq!(state.owner_ops_in_flight_count(), 0);
        state.end_maintenance(&owner).unwrap();
    }
}
