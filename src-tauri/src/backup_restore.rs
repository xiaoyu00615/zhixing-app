//! Native Backup Restore V1 (P6-S8).
//!
//! Restore is a STRONG-quiescence, OWNER-AUTHORIZED, destructive operation. It
//! is the only subsystem in the application allowed to replace the live
//! database file.
//!
//! Scope (frozen): **DATABASE RESTORE V1** — `database = true`,
//! `attachments = false`, `portable_settings = false`. It is never called
//! "full restore" or "all-data restore", and it never claims to recover
//! anything the bundle does not contain.
//!
//! # Authorization
//!
//! Rust refuses the work unless the caller presents the EXACT current owner id
//! and receives a `MaintenanceOwnedPermit` — a type no ordinary command can
//! obtain. Ordinary admission is already closed by the owner, so the operation
//! runs with zero ordinary writers; while the permit is alive,
//! `end_maintenance` fails closed with `MAINTENANCE_BUSY`, so a concurrent
//! frontend `lease.release()` cannot re-open ordinary admission mid-restore.
//! The owner id is never exposed to the frontend.
//!
//! # Disk pipeline (apply)
//!
//! ```text
//! owner proof (MaintenanceOwnedPermit)
//!  → resolve authoritative roots (bootstrap → Existing Data Root → metadata/ + backup/)
//!  → re-verify the selected bundle INSIDE the barrier   (the TOCTOU boundary)
//!  → create metadata/restore/<operationId>/
//!  → SAFETY BACKUP of the current live database         (must succeed first)
//!  → copy the verified bundle database → replacement.db (+ sync_all)
//!  → validate replacement.db READ-ONLY (size / SHA-256 / integrity / schema / single-file)
//!  → checkpoint the live database (wal_checkpoint(TRUNCATE), require busy == 0)
//!  → quarantine stale live sidecars (MOVE, never delete)
//!  → journal PREPARED (.part → sync_all → rename)
//!  → ATOMIC replace: live ← replacement, old live → rollback.db
//!  → journal SWITCHED
//!  → post-switch validation READ-ONLY ONLY (integrity / schema / SHA-256)
//!  → journal COMMITTED
//! ```
//!
//! # Startup recovery gate (process-restart reconciliation)
//!
//! A process crash destroys the in-memory maintenance barrier but leaves
//! `metadata/restore/<operationId>/operation.json` behind, so the in-process
//! `BlockedBackupRestoreSession` alone cannot prove crash safety. The Existing
//! startup path therefore runs [`recover_or_classify_pending_operations`]
//! AFTER the Data Root has been validated and BEFORE the production database is
//! opened:
//!
//! ```text
//! Bootstrap Valid
//!  → Data Root Existing validation
//!  → restore recovery gate   (READ-ONLY classification + terminal journal)
//!  → only if proven safe
//!  → open_existing_configured_connection
//!  → MigrationRunner
//! ```
//!
//! It needs no owner token: ordinary admission has not started yet, so this is
//! process-start recovery, not a maintenance-owner operation.
//!
//! # Hard rules (frozen)
//!
//! - The bundle database NEVER becomes the live writable database directly: it
//!   is always copied into restore staging first.
//! - The Safety Backup is fully built, published and verified BEFORE the live
//!   WAL is checkpointed, BEFORE any sidecar is relocated and BEFORE the live
//!   file is replaced. No destructive step may precede it.
//! - NOTHING is ever created empty: a missing live database, a missing Data
//!   Root, a missing `metadata/` or a missing `backup/` root all FAIL CLOSED.
//!   `metadata/` is a fixed FirstBoot subdir and is never repaired implicitly.
//! - The selected backup bundle is NEVER modified or deleted. All validation of
//!   a bundle is read-only.
//! - The Safety Backup and the rollback candidate are NEVER deleted — Restore
//!   V1 has no retention / cleanup.
//! - No `std::fs::copy` of a live SQLite database: the Safety Backup goes
//!   through the shared SQLite Online Backup primitive (WAL-safe).
//! - The destructive step is ONE platform atomic replace. There is no
//!   `remove-then-rename`, no `copy-over-live`, no `truncate-live` fallback:
//!   if the OS atomic replace cannot be expressed, the answer is UNSUPPORTED /
//!   failed, never a "best effort" replacement.
//! - Non-Windows builds have no atomic replacement primitive, so Restore V1 is
//!   `UNSUPPORTED_PLATFORM` there and fails closed before touching anything.
//! - The shared restore domain contains NO Windows concept; only
//!   `atomic_replace_live_database` is platform-specific.
//! - Startup recovery NEVER repairs: it is read-only classification plus a
//!   terminal journal update. It never replaces, never rolls back, never
//!   creates a database and never deletes evidence — an unprovable live
//!   database becomes `RuntimeStatus::Degraded`, not a best-effort fix.

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use thiserror::Error;
use uuid::Uuid;

use crate::backup::{
    build_and_publish_backup_bundle, current_schema_version, resolve_existing_backup_root,
    resolve_existing_data_root, resolve_existing_metadata_root, BackupManifest, BackupScope,
    FORMAT_VERSION, METADATA_DIR_NAME,
};
use crate::backup_inventory::{
    is_sha256_hex, locate_and_verify, read_only_integrity_check, BackupInventoryError,
    BackupReasonCode, LocatedVerification,
};
use crate::db::checksum::sha256_file_hex;
use crate::db::policy::open_existing_configured_connection;
use crate::maintenance::{
    MaintenanceOwnedPermit, NativeMaintenanceErrorDto, NativeMaintenanceState,
};
use crate::storage::manifest::{DataRootManifest, DB_RELATIVE_PATH};
use crate::storage::DataRootService;

// ============================================================
// Layout constants
// ============================================================

/// Runtime-created directory under the fixed `metadata/` root.
const RESTORE_DIR_NAME: &str = "restore";
/// Durable, portable operation journal. Written BEFORE the destructive switch.
const OPERATION_JOURNAL_FILENAME: &str = "operation.json";
/// The verified bundle database, copied into staging. Becomes the live file.
const REPLACEMENT_DB_FILENAME: &str = "replacement.db";
/// The pre-switch live database, produced by the OS atomic replace itself.
const ROLLBACK_DB_FILENAME: &str = "rollback.db";
/// A post-switch validation failure that could NOT be rolled back: kept as
/// evidence, never destroyed.
const REJECTED_DB_FILENAME: &str = "rejected.db";
/// Where stale live sidecars are quarantined (moved, never deleted).
const SIDECARS_DIR_NAME: &str = "sidecars";
/// Exact derived sidecar suffixes of the live database file.
const SIDECAR_SUFFIXES: [&str; 3] = ["-wal", "-shm", "-journal"];
/// Fixed, small upper bound on OS atomic-replace attempts (1 + retries).
const REPLACE_MAX_ATTEMPTS: u32 = 6;
/// Fixed, short delay between those attempts. No unbounded backoff.
const REPLACE_RETRY_DELAY: Duration = Duration::from_millis(50);

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================================================
// Error model
// ============================================================

/// Failure disposition, mirroring the shared TS contract.
///
/// - `RECOVERABLE`: the live database state has been PROVEN safe — either it
///   was never modified, or a failed switch was proven to have left it
///   untouched, or a rollback restored and verified it. The coordinator may
///   release the exclusive lease and the operation may be retried later.
/// - `BLOCKED`: the live database state, or the commit state of this
///   operation, cannot be proven. The barrier must stay active until a
///   reconcile proves otherwise.
///
/// This mapping is the whole point of the module: it is what lets the frontend
/// decide whether releasing the strong barrier is safe. It is assigned variant
/// by variant, never inferred.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreErrorDisposition {
    Recoverable,
    Blocked,
}

impl RestoreErrorDisposition {
    fn as_str(self) -> &'static str {
        match self {
            RestoreErrorDisposition::Recoverable => "RECOVERABLE",
            RestoreErrorDisposition::Blocked => "BLOCKED",
        }
    }
}

/// Structured restore failure. The concrete `String` detail is for Rust tracing
/// only and never crosses the boundary.
#[derive(Debug, Error)]
pub(crate) enum BackupRestoreError {
    /// Pre-mutation only: the authoritative roots (bootstrap / Data Root /
    /// `metadata/` / `backup/`) could not be resolved or read. Nothing was
    /// created, nothing was written.
    #[error("restore unavailable: {0}")]
    Unavailable(String),
    /// The request itself is unusable (non-UUID id, or an operation directory
    /// that already holds a journal for this operation id).
    #[error("restore request invalid: {0}")]
    RequestInvalid(String),
    /// No bundle claims the requested id.
    #[error("backup not found: {0}")]
    BackupNotFound(String),
    /// Several bundles claim the requested id — identity use is unsafe.
    #[error("backup id ambiguous: {0}")]
    BackupAmbiguous(String),
    /// The bundle exists but this build cannot restore from it (foreign format,
    /// non-V1 scope, or a different schema). NEVER reported as corrupt.
    #[error("backup unsupported for restore: {0}")]
    BackupUnsupported(String),
    /// The bundle is damaged / incomplete.
    #[error("backup invalid: {0}")]
    BackupInvalid(String),
    /// Inside the barrier the bundle failed size / SHA-256 / integrity.
    #[error("backup verification failed inside the barrier: {0}")]
    BackupVerifyFailed(String),
    /// The caller could not prove maintenance ownership. No mutation was
    /// attempted, so the live database is provably untouched.
    #[error("owner proof failed: {0}")]
    OwnerMismatch(String),
    /// The Safety Backup of the current live database could not be produced.
    /// Nothing was switched.
    #[error("safety backup failed: {0}")]
    SafetyBackupFailed(String),
    /// The restore staging database could not be built or validated.
    #[error("restore staging failed: {0}")]
    StagingFailed(String),
    /// The live database could not be checkpointed (`busy != 0` or I/O error).
    /// No sidecar was moved and no switch was attempted.
    #[error("live checkpoint failed: {0}")]
    CheckpointFailed(String),
    /// A stale sidecar could not be safely quarantined. Failing BEFORE the
    /// switch keeps the checkpointed live database usable.
    #[error("sidecar quarantine failed: {0}")]
    SidecarFailed(String),
    /// The atomic replace failed AND the live database was proven byte-identical
    /// to its pre-switch state.
    #[error("live switch failed: {0}")]
    SwitchFailed(String),
    /// The atomic replace failed and the live database state could NOT be
    /// proven — the switch outcome is indeterminate.
    #[error("live switch outcome indeterminate: {0}")]
    SwitchIndeterminate(String),
    /// The post-switch validation failed and the pre-switch database was
    /// successfully restored AND re-verified.
    #[error("restore rolled back: {0}")]
    RolledBack(String),
    /// The post-switch validation failed and the rollback could not be proven.
    /// Evidence is preserved; the barrier must stay active.
    #[error("restore rollback failed: {0}")]
    RollbackFailed(String),
    /// An internal invariant was violated after the point of no return.
    #[error("restore internal failure: {0}")]
    Internal(String),
}

impl BackupRestoreError {
    /// Coarse, UI-safe machine code.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            BackupRestoreError::Unavailable(_) => "UNAVAILABLE",
            BackupRestoreError::RequestInvalid(_) => "REQUEST_INVALID",
            BackupRestoreError::BackupNotFound(_) => "BACKUP_NOT_FOUND",
            BackupRestoreError::BackupAmbiguous(_) => "BACKUP_AMBIGUOUS",
            BackupRestoreError::BackupUnsupported(_) => "BACKUP_UNSUPPORTED",
            BackupRestoreError::BackupInvalid(_) => "BACKUP_INVALID",
            BackupRestoreError::BackupVerifyFailed(_) => "BACKUP_VERIFY_FAILED",
            BackupRestoreError::OwnerMismatch(_) => "OWNER_MISMATCH",
            BackupRestoreError::SafetyBackupFailed(_) => "SAFETY_BACKUP_FAILED",
            BackupRestoreError::StagingFailed(_) => "STAGING_FAILED",
            BackupRestoreError::CheckpointFailed(_) => "CHECKPOINT_FAILED",
            BackupRestoreError::SidecarFailed(_) => "SIDECAR_FAILED",
            BackupRestoreError::SwitchFailed(_) => "SWITCH_FAILED",
            BackupRestoreError::SwitchIndeterminate(_) => "SWITCH_INDETERMINATE",
            BackupRestoreError::RolledBack(_) => "ROLLED_BACK",
            BackupRestoreError::RollbackFailed(_) => "ROLLBACK_FAILED",
            BackupRestoreError::Internal(_) => "INTERNAL",
        }
    }

    /// Fixed, UI-safe human message (no path / SQLite / win32 internals).
    pub(crate) fn safe_message(&self) -> &'static str {
        match self {
            BackupRestoreError::Unavailable(_) => "Restore is currently unavailable.",
            BackupRestoreError::RequestInvalid(_) => "The restore request was invalid.",
            BackupRestoreError::BackupNotFound(_) => "The selected backup was not found.",
            BackupRestoreError::BackupAmbiguous(_) => {
                "The selected backup id is ambiguous and cannot be used."
            }
            BackupRestoreError::BackupUnsupported(_) => {
                "This backup cannot be restored by this version."
            }
            BackupRestoreError::BackupInvalid(_) => {
                "The selected backup is damaged and cannot be restored."
            }
            BackupRestoreError::BackupVerifyFailed(_) => {
                "The selected backup failed verification and was not restored."
            }
            BackupRestoreError::OwnerMismatch(_) => {
                "The restore was not authorized and nothing was changed."
            }
            BackupRestoreError::SafetyBackupFailed(_) => {
                "The current data could not be backed up, so nothing was restored."
            }
            BackupRestoreError::StagingFailed(_) => {
                "The restore could not be prepared, so nothing was changed."
            }
            BackupRestoreError::CheckpointFailed(_) => {
                "The current database could not be quiesced, so nothing was changed."
            }
            BackupRestoreError::SidecarFailed(_) => {
                "The current database files could not be secured, so nothing was changed."
            }
            BackupRestoreError::SwitchFailed(_) => {
                "The restore could not be applied; the current data is unchanged."
            }
            BackupRestoreError::SwitchIndeterminate(_) => {
                "The restore outcome could not be confirmed."
            }
            BackupRestoreError::RolledBack(_) => {
                "The restore failed and the previous data was recovered."
            }
            BackupRestoreError::RollbackFailed(_) => {
                "The restore failed and the previous data could not be confirmed."
            }
            BackupRestoreError::Internal(_) => "The restore could not be completed.",
        }
    }

    /// The disposition the frontend MUST respect. Assigned explicitly per
    /// variant: a RECOVERABLE claim is a safety claim about the live database.
    pub(crate) fn disposition(&self) -> RestoreErrorDisposition {
        match self {
            // Nothing was mutated yet, or the failed step is proven to have left
            // the live database untouched.
            BackupRestoreError::Unavailable(_)
            | BackupRestoreError::RequestInvalid(_)
            | BackupRestoreError::BackupNotFound(_)
            | BackupRestoreError::BackupAmbiguous(_)
            | BackupRestoreError::BackupUnsupported(_)
            | BackupRestoreError::BackupInvalid(_)
            | BackupRestoreError::BackupVerifyFailed(_)
            | BackupRestoreError::OwnerMismatch(_)
            | BackupRestoreError::SafetyBackupFailed(_)
            | BackupRestoreError::StagingFailed(_)
            | BackupRestoreError::CheckpointFailed(_)
            | BackupRestoreError::SidecarFailed(_)
            | BackupRestoreError::SwitchFailed(_)
            | BackupRestoreError::RolledBack(_) => RestoreErrorDisposition::Recoverable,
            // The live database / commit state cannot be proven.
            BackupRestoreError::SwitchIndeterminate(_)
            | BackupRestoreError::RollbackFailed(_)
            | BackupRestoreError::Internal(_) => RestoreErrorDisposition::Blocked,
        }
    }
}

/// Transport error DTO. Carries the disposition so the Native adapter can tell
/// "proven recoverable" apart from "unknown" — an unknown rejection must NEVER
/// be silently classified as recoverable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRestoreCommandErrorDto {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
    pub(crate) disposition: &'static str,
}

impl From<BackupRestoreError> for BackupRestoreCommandErrorDto {
    fn from(error: BackupRestoreError) -> Self {
        tracing::warn!(
            target: "zhixing::backup_restore",
            error = %error,
            code = error.code(),
            disposition = error.disposition().as_str(),
            "native backup restore failure"
        );
        Self {
            code: error.code(),
            message: error.safe_message(),
            disposition: error.disposition().as_str(),
        }
    }
}

// ============================================================
// Durable operation journal
// ============================================================

/// Journal phases. The journal is a HINT for reconciliation, never the
/// authority: reconcile always measures the live database.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum RestoreJournalPhase {
    /// Written immediately BEFORE the destructive switch.
    Prepared,
    /// The atomic replace returned success.
    Switched,
    /// The post-switch validation passed.
    Committed,
    /// The switch was undone and the pre-switch database was re-verified.
    RolledBack,
    /// The operation provably never installed its target: the pre-switch
    /// database is live and no rollback was needed (restart reconciliation).
    NotCommitted,
    /// The outcome could not be proven.
    Blocked,
}

impl RestoreJournalPhase {
    /// A TERMINAL phase states that the operation is finished and its outcome
    /// is known, so the startup recovery gate may ignore it (and never deletes
    /// it). Everything else — including `Blocked` and a malformed / missing
    /// journal — needs recovery.
    fn is_terminal(self) -> bool {
        matches!(self, Self::Committed | Self::RolledBack | Self::NotCommitted)
    }
}

/// The durable, portable, NON-SECRET record of one restore operation.
///
/// Deliberately carries NO native owner token, NO absolute Data Root path, NO
/// trust secret and NO device credential: it must be safe to read (and later to
/// display) without leaking platform internals.
///
/// `original_live_sha256` is the only way to prove later that the current live
/// file is the ORIGINAL one, so it is recorded for every operation.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct RestoreOperationJournal {
    pub(crate) operation_id: String,
    pub(crate) backup_id: String,
    /// SHA-256 of the bundle database this operation intends to install.
    pub(crate) expected_target_sha256: String,
    /// SHA-256 of the live database exactly as it was immediately before the
    /// destructive switch (after the checkpoint and sidecar quarantine).
    pub(crate) original_live_sha256: String,
    /// The Safety Backup bundle created before any mutation.
    pub(crate) safety_backup_id: String,
    pub(crate) phase: RestoreJournalPhase,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

/// How a journal read went. "File exists but is unreadable" must NOT be
/// confused with "there is no journal" — the absence of a journal is itself
/// evidence (the journal is written before the switch).
enum JournalRead {
    Absent,
    Present(Box<RestoreOperationJournal>),
    Unreadable,
}

fn operation_dir(metadata_root: &Path, operation_id: &str) -> PathBuf {
    metadata_root.join(RESTORE_DIR_NAME).join(operation_id)
}

fn journal_path(op_dir: &Path) -> PathBuf {
    op_dir.join(OPERATION_JOURNAL_FILENAME)
}

/// Write `operation.json` atomically: `.part` → write → `sync_all` → rename.
fn write_journal(
    op_dir: &Path,
    journal: &RestoreOperationJournal,
) -> Result<(), BackupRestoreError> {
    let json = serde_json::to_string_pretty(journal)
        .map_err(|e| BackupRestoreError::Internal(format!("serialize journal: {e}")))?;
    let part = op_dir.join(format!("{OPERATION_JOURNAL_FILENAME}.part"));
    {
        let mut file = fs::File::create(&part)
            .map_err(|e| BackupRestoreError::Internal(format!("create journal part: {e}")))?;
        use std::io::Write;
        file.write_all(json.as_bytes())
            .map_err(|e| BackupRestoreError::Internal(format!("write journal part: {e}")))?;
        file.sync_all()
            .map_err(|e| BackupRestoreError::Internal(format!("sync journal part: {e}")))?;
    }
    fs::rename(&part, journal_path(op_dir))
        .map_err(|e| BackupRestoreError::Internal(format!("rename journal: {e}")))
}

fn read_journal(op_dir: &Path) -> JournalRead {
    let path = journal_path(op_dir);
    match fs::symlink_metadata(&path) {
        Err(_) => JournalRead::Absent,
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => JournalRead::Unreadable,
        Ok(_) => match fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<RestoreOperationJournal>(&bytes).ok())
        {
            Some(journal) => JournalRead::Present(Box::new(journal)),
            None => JournalRead::Unreadable,
        },
    }
}

/// Best-effort journal phase update. A failure here is NOT fatal: the measured
/// live-database state always outranks the journal, so losing a phase update
/// degrades diagnosis, never safety.
fn record_phase(op_dir: &Path, journal: &mut RestoreOperationJournal, phase: RestoreJournalPhase) {
    journal.phase = phase;
    journal.updated_at_ms = now_ms();
    if let Err(e) = write_journal(op_dir, journal) {
        tracing::warn!(
            target: "zhixing::backup_restore",
            error = %e,
            "restore journal phase update skipped"
        );
    }
}

// ============================================================
// Roots
// ============================================================

struct ResolvedRoots {
    data_root: PathBuf,
    data_manifest: DataRootManifest,
    metadata_root: PathBuf,
}

fn resolve_roots(app_config_dir: &Path) -> Result<ResolvedRoots, BackupRestoreError> {
    let (data_root, data_manifest) =
        resolve_existing_data_root(app_config_dir).map_err(BackupRestoreError::Unavailable)?;
    // `metadata/` is a fixed FirstBoot subdir: a missing one FAILS CLOSED. Only
    // the runtime descendants (`restore/`, `restore/<operationId>/`) may be
    // created. The fixed Root layout is never repaired implicitly.
    let metadata_root = resolve_existing_metadata_root(&data_root)
        .map_err(BackupRestoreError::Unavailable)?;
    // `backup/` must exist for the Safety Backup; a missing root fails closed.
    resolve_existing_backup_root(&data_root).map_err(BackupRestoreError::Unavailable)?;
    Ok(ResolvedRoots {
        data_root,
        data_manifest,
        metadata_root,
    })
}

fn normalize_uuid(value: &str) -> Result<String, BackupRestoreError> {
    Uuid::parse_str(value.trim())
        .map(|uuid| uuid.to_string())
        .map_err(|e| BackupRestoreError::RequestInvalid(format!("not a UUID: {e}")))
}

// ============================================================
// Bundle re-verification (the TOCTOU boundary is this operation)
// ============================================================

fn map_inventory_error(error: BackupInventoryError) -> BackupRestoreError {
    match error {
        BackupInventoryError::Unavailable(detail) => BackupRestoreError::Unavailable(detail),
        BackupInventoryError::NotFound(detail) => BackupRestoreError::BackupNotFound(detail),
        BackupInventoryError::Ambiguous(detail) => BackupRestoreError::BackupAmbiguous(detail),
        BackupInventoryError::RequestInvalid(detail) => {
            BackupRestoreError::RequestInvalid(detail)
        }
        BackupInventoryError::Unsupported(detail) => BackupRestoreError::BackupUnsupported(detail),
        // A scan/read failure happened before anything was mutated.
        BackupInventoryError::Internal(detail) => BackupRestoreError::Unavailable(detail),
    }
}

/// Re-locate and FULLY re-verify the selected bundle INSIDE the barrier.
///
/// A cached `native_backup_verify` result, or a `VERIFIED` badge the UI obtained
/// earlier, is NEVER trusted: the bundle may have changed in between. The TOCTOU
/// boundary is exactly this privileged operation.
///
/// On top of the structural + checksum + integrity verification, Restore V1
/// adds the three compatibility gates (format, scope, schema) and fails closed
/// with `Unsupported` when any of them does not match — a foreign or
/// differently-versioned bundle is never treated as corrupt.
fn reverify_restorable_bundle(
    app_config_dir: &Path,
    backup_id: &str,
) -> Result<(PathBuf, BackupManifest, String), BackupRestoreError> {
    match locate_and_verify(app_config_dir, backup_id) {
        Ok(LocatedVerification::Verified {
            bundle_dir,
            manifest,
            checksum_sha256,
            ..
        }) => {
            if manifest.format_version != FORMAT_VERSION {
                return Err(BackupRestoreError::BackupUnsupported(format!(
                    "backup format version {} is not restorable by this build",
                    manifest.format_version
                )));
            }
            // Scope: exactly V1. A bundle carrying attachments / portable
            // settings cannot be consumed by a database-only restore.
            if manifest.scope != BackupScope::v1() {
                return Err(BackupRestoreError::BackupUnsupported(
                    "backup scope is not the V1 database-only scope".into(),
                ));
            }
            // Schema: Restore V1 NEVER runs migrations. An older OR newer schema
            // is refused rather than silently installed.
            let current = current_schema_version();
            if manifest.schema_version != current {
                return Err(BackupRestoreError::BackupUnsupported(format!(
                    "backup schema version {} does not match the current schema version {current}",
                    manifest.schema_version
                )));
            }
            // The bundle database path is the canonical V1 relative path — the
            // structural check already proved it cannot point outside the bundle.
            let bundle_db = bundle_dir.join(DB_RELATIVE_PATH);
            Ok((bundle_db, manifest, checksum_sha256))
        }
        // Distinguish a STRUCTURAL defect (the bundle is not whole / not
        // coherent) from an EXPENSIVE-check failure (size, streaming SHA-256 or a
        // real integrity check disagreed). Both refuse the restore; only the code
        // differs, so the two are never conflated in diagnostics.
        Ok(LocatedVerification::Damaged { reason, .. }) => Err(match reason {
            BackupReasonCode::ChecksumMismatch
            | BackupReasonCode::IntegrityFailed
            | BackupReasonCode::DatabaseUnreadable
            | BackupReasonCode::SizeMismatch => BackupRestoreError::BackupVerifyFailed(format!(
                "selected backup failed verification inside the barrier: {reason:?}"
            )),
            other => BackupRestoreError::BackupInvalid(format!(
                "selected backup is structurally unusable: {other:?}"
            )),
        }),
        Err(error) => Err(map_inventory_error(error)),
    }
}

/// Manifest checksum of a bundle, used only to CROSS-CHECK a journal during
/// reconcile. Returns `None` when the bundle cannot be fully trusted, so a
/// tampered manifest can never become the expected value.
fn cross_check_bundle_sha(app_config_dir: &Path, backup_id: &str) -> Option<String> {
    match locate_and_verify(app_config_dir, backup_id) {
        Ok(LocatedVerification::Verified {
            checksum_sha256, ..
        }) => Some(checksum_sha256),
        _ => None,
    }
}

// ============================================================
// Database measurement (read-only)
// ============================================================

/// Highest applied migration version recorded in `schema_migrations`.
///
/// READ-ONLY: never opens for write, never migrates, never creates the table.
/// A missing / unreadable / empty history yields `None`, which every caller
/// treats as "schema not proven".
fn read_schema_version(db: &Path) -> Option<u32> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .ok()?;
    u32::try_from(version).ok()
}

/// Journal mode as reported by a read-only connection (never changes it).
fn read_journal_mode(db: &Path) -> Option<String> {
    let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).ok()?;
    conn.query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
        .ok()
        .map(|mode| mode.to_lowercase())
}

struct DbMeasurement {
    sha256: String,
    integrity_ok: bool,
    schema_version: Option<u32>,
}

/// Measure a database file READ-ONLY. Returns `None` when the file is absent /
/// not a regular file / not readable.
///
/// Note on WAL: a read-only open of a WAL-mode database whose `-wal`/`-shm` are
/// absent SUCCEEDS (verified against the bundled SQLite) and leaves the MAIN
/// FILE byte-identical — it only materialises an empty `-wal` / `-shm`. That is
/// why the "the live file stays byte-stable" guarantee holds even though the
/// measurement itself is not free of filesystem side effects.
fn measure_database(db: &Path) -> Option<DbMeasurement> {
    let meta = fs::symlink_metadata(db).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    let sha256 = sha256_file_hex(db).ok()?;
    let integrity_ok = read_only_integrity_check(db).unwrap_or(false);
    let schema_version = read_schema_version(db);
    Some(DbMeasurement {
        sha256,
        integrity_ok,
        schema_version,
    })
}

fn is_regular_file(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Ok(meta) if meta.is_file() && !meta.file_type().is_symlink())
}

// ============================================================
// Staging
// ============================================================

/// Copy a file and flush it to disk.
///
/// A hand-rolled streaming copy (rather than `fs::copy`) because the
/// destination must be `sync_all`-ed, and `sync_all` needs a handle opened WITH
/// WRITE ACCESS — reopening a read-only handle and flushing it is not portable
/// (FlushFileBuffers requires write access on Windows).
///
/// This copy is legitimate here ONLY because the source is a static, already
/// verified BACKUP copy — never a live SQLite database.
fn copy_file_synced(src: &Path, dst: &Path) -> io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut output = fs::File::create(dst)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()?;
    Ok(())
}

/// Validate the staging database before it may become the live one.
///
/// Everything here is READ-ONLY and the journal mode is never modified. The
/// extra "single self-contained file" gate matters: the atomic replace moves
/// ONLY the main file, so a WAL-mode replacement carrying unmerged frames would
/// silently lose data. Every V1 bundle normalises to `journal_mode=delete`
/// (P6-S5), and this gate proves it instead of assuming it.
fn validate_staging_database(
    replacement: &Path,
    manifest: &BackupManifest,
    expected_sha: &str,
) -> Result<(), BackupRestoreError> {
    let meta = fs::symlink_metadata(replacement)
        .map_err(|e| BackupRestoreError::StagingFailed(format!("stat staging db: {e}")))?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err(BackupRestoreError::StagingFailed(
            "staging database is not a regular file".into(),
        ));
    }
    if meta.len() != manifest.database.size_bytes {
        return Err(BackupRestoreError::StagingFailed(
            "staging database size does not match the manifest".into(),
        ));
    }
    let sha = sha256_file_hex(replacement)
        .map_err(|e| BackupRestoreError::StagingFailed(format!("staging sha256: {e}")))?;
    if sha != expected_sha {
        return Err(BackupRestoreError::StagingFailed(
            "staging database checksum does not match the selected backup".into(),
        ));
    }
    match read_journal_mode(replacement) {
        Some(mode) if mode == "delete" => {}
        _ => {
            return Err(BackupRestoreError::StagingFailed(
                "staging database is not a single self-contained file".into(),
            ))
        }
    }
    match read_only_integrity_check(replacement) {
        Ok(true) => {}
        _ => {
            return Err(BackupRestoreError::StagingFailed(
                "staging database failed its integrity check".into(),
            ))
        }
    }
    if read_schema_version(replacement) != Some(current_schema_version()) {
        return Err(BackupRestoreError::StagingFailed(
            "staging database schema version does not match".into(),
        ));
    }
    Ok(())
}

// ============================================================
// Live checkpoint + sidecars
// ============================================================

fn live_sidecar_paths(live_db: &Path) -> Vec<PathBuf> {
    let Some(name) = live_db.file_name().map(|n| n.to_string_lossy().into_owned()) else {
        return Vec::new();
    };
    SIDECAR_SUFFIXES
        .iter()
        .map(|suffix| live_db.with_file_name(format!("{name}{suffix}")))
        .collect()
}

/// Quiesce the live database: merge every committed WAL frame into the main
/// file and prove it (`busy == 0`).
///
/// Runs through the project's connection policy (so any hot journal is resolved
/// and the file is normalised to the production journal mode) and the
/// connection is FUNCTION-SCOPED: it is dropped before any sidecar handling or
/// switch, so at the destructive step there are zero restore live connections
/// and — because ordinary admission is closed — zero ordinary operations.
fn checkpoint_live_database(live_db: &Path) -> Result<(), BackupRestoreError> {
    let conn = open_existing_configured_connection(live_db)
        .map_err(|e| BackupRestoreError::CheckpointFailed(format!("open live db: {e}")))?;
    let (busy, _log, _checkpointed): (i64, i64, i64) = conn
        .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?))
        })
        .map_err(|e| BackupRestoreError::CheckpointFailed(format!("wal_checkpoint: {e}")))?;
    if busy != 0 {
        return Err(BackupRestoreError::CheckpointFailed(format!(
            "wal_checkpoint(TRUNCATE) could not complete (busy={busy})"
        )));
    }
    Ok(())
}

/// Move every stale live sidecar into the operation's quarantine directory.
///
/// MOVE, never delete: a sidecar is evidence, and deleting one next to a live
/// database is exactly the kind of shortcut this slice forbids. Failing here
/// happens BEFORE the switch, while the checkpointed live database is still
/// perfectly usable.
fn quarantine_sidecars(
    live_db: &Path,
    sidecar_dir: &Path,
) -> Result<Vec<String>, BackupRestoreError> {
    let mut quarantined = Vec::new();
    for path in live_sidecar_paths(live_db) {
        // Never follow a redirection: a symlinked sidecar entry must not be able
        // to move something outside the Data Root.
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            // Absent is the normal case (a clean checkpoint removes them).
            Err(_) => continue,
        };
        if !meta.is_file() || meta.file_type().is_symlink() {
            return Err(BackupRestoreError::SidecarFailed(
                "a live database sidecar is not a regular file".into(),
            ));
        }
        let name = match path.file_name() {
            Some(name) => name.to_string_lossy().into_owned(),
            None => {
                return Err(BackupRestoreError::SidecarFailed(
                    "a live database sidecar has no file name".into(),
                ))
            }
        };
        fs::create_dir_all(sidecar_dir).map_err(|e| {
            BackupRestoreError::SidecarFailed(format!("create sidecar dir: {e}"))
        })?;
        fs::rename(&path, sidecar_dir.join(&name))
            .map_err(|e| BackupRestoreError::SidecarFailed(format!("quarantine sidecar: {e}")))?;
        quarantined.push(name);
    }
    Ok(quarantined)
}

// ============================================================
// The platform atomic replace
// ============================================================

/// One attempt's outcome.
enum ReplaceAttempt {
    Done,
    /// Another process holds a handle (or a lock) on one of the files. Retryable
    /// within a fixed bound.
    Contended(String),
    /// Any other failure. Not retryable.
    Failed(String),
}

/// Bounded retry: a FIXED upper bound and a FIXED short delay. No infinite
/// loop, no unbounded backoff, no "sleep a bit longer and hope".
fn run_with_bounded_retry<F>(mut attempt: F) -> Result<(), ReplaceAttempt>
where
    F: FnMut() -> ReplaceAttempt,
{
    let mut attempt_number: u32 = 0;
    loop {
        attempt_number += 1;
        match attempt() {
            ReplaceAttempt::Done => return Ok(()),
            ReplaceAttempt::Failed(detail) => return Err(ReplaceAttempt::Failed(detail)),
            ReplaceAttempt::Contended(detail) => {
                if attempt_number >= REPLACE_MAX_ATTEMPTS {
                    return Err(ReplaceAttempt::Contended(detail));
                }
                std::thread::sleep(REPLACE_RETRY_DELAY);
            }
        }
    }
}

/// Why a bounded run of OS atomic replacements did not produce a switch.
#[derive(Debug)]
enum SwitchFailure {
    /// The OS refused. The live database may or may not have been touched — the
    /// caller MEASURES the live file to decide RECOVERABLE vs INDETERMINATE.
    CouldNotSwitch(String),
    /// This build has no atomic replacement primitive on this platform.
    /// Constructed only by the non-Windows implementation of
    /// `atomic_replace_live_database`.
    #[cfg_attr(windows, allow(dead_code))]
    UnsupportedPlatform,
}

/// ONE platform atomic replace, with a rollback copy, as a single step.
#[cfg(windows)]
fn atomic_replace_live_database(
    live: &Path,
    replacement: &Path,
    rollback: &Path,
) -> Result<(), SwitchFailure> {
    match run_with_bounded_retry(|| replace_file_once(live, replacement, rollback)) {
        Ok(()) => Ok(()),
        Err(ReplaceAttempt::Failed(detail)) => Err(SwitchFailure::CouldNotSwitch(detail)),
        Err(_) => Err(SwitchFailure::CouldNotSwitch(
            "the operating system refused the atomic replace after bounded retries".into(),
        )),
    }
}

/// Non-Windows: Restore V1 has NO atomic-replace primitive, so it fails closed
/// BEFORE touching anything. Android gets its own implementation in a later
/// slice; the shared restore domain never mentions Windows concepts.
#[cfg(not(windows))]
fn atomic_replace_live_database(
    _live: &Path,
    _replacement: &Path,
    _rollback: &Path,
) -> Result<(), SwitchFailure> {
    Err(SwitchFailure::UnsupportedPlatform)
}

/// `ReplaceFileW` — replace `live` with `replacement`, saving the previous
/// `live` to `rollback`, in ONE operating-system operation.
#[cfg(windows)]
fn replace_file_once(live: &Path, replacement: &Path, rollback: &Path) -> ReplaceAttempt {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION,
    };
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0u16))
            .collect()
    }

    let live_w = wide(live);
    let replacement_w = wide(replacement);
    let rollback_w = wide(rollback);
    // SAFETY: all three pointers are NUL-terminated UTF-16 buffers that outlive
    // the call; the two reserved parameters are documented as NULL.
    let ok = unsafe {
        ReplaceFileW(
            live_w.as_ptr(),
            replacement_w.as_ptr(),
            rollback_w.as_ptr(),
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok != 0 {
        return ReplaceAttempt::Done;
    }
    let code = unsafe { GetLastError() };
    let detail = format!("replace file failed (win32 error {code})");
    if code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION {
        ReplaceAttempt::Contended(detail)
    } else {
        ReplaceAttempt::Failed(detail)
    }
}

/// Classify a failed switch from MEASURED facts, never from the error code.
///
/// If the live database is still byte-identical to its pre-switch state, the
/// switch provably did not happen and the operation is recoverable. Anything
/// else (including a missing live file) is indeterminate: the barrier stays
/// active.
fn classify_switch_failure(
    live_db: &Path,
    original_live_sha256: &str,
    failure: SwitchFailure,
) -> BackupRestoreError {
    let detail = match failure {
        SwitchFailure::CouldNotSwitch(detail) => detail,
        SwitchFailure::UnsupportedPlatform => "atomic replace is unsupported on this platform".into(),
    };
    match measure_database(live_db) {
        Some(measured) if measured.sha256 == original_live_sha256 => {
            BackupRestoreError::SwitchFailed(detail)
        }
        _ => BackupRestoreError::SwitchIndeterminate(detail),
    }
}

// ============================================================
// Post-switch validation and rollback
// ============================================================

/// Validate a database that is now at the live path.
///
/// READ-ONLY ONLY: it never uses `open_existing_configured_connection`, never
/// changes the journal mode and never writes, so the live file stays
/// byte-stable — which is what makes an IPC-ambiguous reconcile able to prove
/// the outcome by checksum.
fn validate_live_database_read_only(
    live_db: &Path,
    expected_sha256: &str,
) -> Result<String, &'static str> {
    let meta = fs::symlink_metadata(live_db).map_err(|_| "live database is missing")?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return Err("live database is not a regular file");
    }
    let sha = sha256_file_hex(live_db).map_err(|_| "live database is unreadable")?;
    if sha != expected_sha256 {
        return Err("live database checksum does not match");
    }
    match read_only_integrity_check(live_db) {
        Ok(true) => {}
        _ => return Err("live database failed its integrity check"),
    }
    match read_schema_version(live_db) {
        Some(version) if version == current_schema_version() => {}
        _ => return Err("live database schema version does not match"),
    }
    Ok(sha)
}

// Test-only, single-shot fault injection for the post-switch validation.
//
// The rollback path is the most safety-critical branch in this module and it is
// otherwise unreachable in a test: the staging database and the installed live
// database are the same verified bytes, so no honest I/O fault can make the
// post-switch check fail. The injection is thread-local and CONSUMES itself, so
// it can never leak into another test on the same thread.
#[cfg(test)]
thread_local! {
    static INJECT_POST_SWITCH_FAILURE: std::cell::Cell<bool> =
        const { std::cell::Cell::new(false) };
}

#[cfg(test)]
fn arm_injected_post_switch_failure() {
    INJECT_POST_SWITCH_FAILURE.with(|flag| flag.set(true));
}

#[cfg(test)]
fn take_injected_post_switch_failure() -> bool {
    INJECT_POST_SWITCH_FAILURE.with(|flag| flag.replace(false))
}

/// The post-switch validation actually used by `apply_backup_restore`.
fn post_switch_validation(
    live_db: &Path,
    expected_sha256: &str,
) -> Result<String, &'static str> {
    #[cfg(test)]
    if take_injected_post_switch_failure() {
        return Err("injected post-switch validation failure");
    }
    validate_live_database_read_only(live_db, expected_sha256)
}

/// Restore the pre-switch database after a failed post-switch validation.
///
/// Invariants: the failed new file is preserved as evidence (never destroyed),
/// the rollback copy is never deleted, and success is claimed only after the
/// rolled-back database has been re-VERIFIED read-only against
/// `original_live_sha256`.
fn attempt_rollback(
    op_dir: &Path,
    journal: &mut RestoreOperationJournal,
    live_db: &Path,
    reason: String,
) -> BackupRestoreError {
    let rollback = op_dir.join(ROLLBACK_DB_FILENAME);
    let rejected = op_dir.join(REJECTED_DB_FILENAME);

    if is_regular_file(&rollback) {
        if is_regular_file(live_db) {
            // Preserve the rejected database; install the previous one.
            let _ = atomic_replace_live_database(live_db, &rollback, &rejected);
        }
        // The replaced file can be absent when the OS replace failed in its
        // second stage. The live path is then EMPTY, so a single rename is
        // atomic and safe — there is no window with no database at the live
        // path.
        if !is_regular_file(live_db) && is_regular_file(&rollback) {
            let _ = fs::rename(&rollback, live_db);
        }
        if validate_live_database_read_only(live_db, &journal.original_live_sha256).is_ok() {
            record_phase(op_dir, journal, RestoreJournalPhase::RolledBack);
            return BackupRestoreError::RolledBack(reason);
        }
    }

    record_phase(op_dir, journal, RestoreJournalPhase::Blocked);
    BackupRestoreError::RollbackFailed(reason)
}

// ============================================================
// Apply
// ============================================================

/// Result DTO of a successful apply. Carries no path and no platform token.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRestoreApplyResultDto {
    pub(crate) operation_id: String,
    pub(crate) backup_id: String,
    pub(crate) outcome: BackupRestoreApplyOutcome,
    /// The Safety Backup bundle created before the switch (for a future UI).
    pub(crate) safety_backup_id: String,
    pub(crate) restored_checksum_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum BackupRestoreApplyOutcome {
    Restored,
}

/// Apply one restore. `_permit` proves maintenance ownership and keeps the
/// barrier from being released while this runs.
pub(crate) fn apply_backup_restore(
    app_config_dir: &Path,
    operation_id: &str,
    backup_id: &str,
    _permit: MaintenanceOwnedPermit,
) -> Result<BackupRestoreApplyResultDto, BackupRestoreError> {
    let operation_id = normalize_uuid(operation_id)?;
    let backup_id = normalize_uuid(backup_id)?;

    let roots = resolve_roots(app_config_dir)?;
    let live_db = DataRootService::resolve_database_path(&roots.data_root, &roots.data_manifest);

    // 1. Re-verify the selected bundle INSIDE the barrier.
    let (bundle_db, manifest, expected_sha) =
        reverify_restorable_bundle(app_config_dir, &backup_id)?;

    // 2. Operation directory. Created at runtime UNDER the fixed `metadata/`
    //    root; never at the Data Root top level.
    let op_dir = operation_dir(&roots.metadata_root, &operation_id);
    fs::create_dir_all(&op_dir).map_err(|e| {
        BackupRestoreError::StagingFailed(format!("create operation dir: {e}"))
    })?;
    if !matches!(read_journal(&op_dir), JournalRead::Absent) {
        // Never overwrite the record (and evidence) of an operation id that was
        // already used.
        return Err(BackupRestoreError::RequestInvalid(
            "this operation id already has a restore record".into(),
        ));
    }

    // 3. SAFETY BACKUP of the CURRENT live database, before ANY mutation. It is
    //    a normal Backup V1 bundle, produced by the same shared primitive as an
    //    ordinary backup — under a maintenance-owned permit instead of an
    //    ordinary one.
    let safety = build_and_publish_backup_bundle(&roots.data_root, &roots.data_manifest)
        .map_err(|e| BackupRestoreError::SafetyBackupFailed(e.code().to_string()))?;

    // 4. Copy the verified BUNDLE database into staging. The bundle is a static,
    //    already-verified backup copy — it never becomes the live database
    //    directly.
    let replacement = op_dir.join(REPLACEMENT_DB_FILENAME);
    copy_file_synced(&bundle_db, &replacement)
        .map_err(|e| BackupRestoreError::StagingFailed(format!("copy replacement: {e}")))?;

    // 5. Validate staging READ-ONLY.
    validate_staging_database(&replacement, &manifest, &expected_sha)?;

    // 6. Quiesce the live database and prove it.
    checkpoint_live_database(&live_db)?;

    // 7. Quarantine stale sidecars (move, never delete) BEFORE the switch.
    let sidecars = quarantine_sidecars(&live_db, &op_dir.join(SIDECARS_DIR_NAME))?;
    if !sidecars.is_empty() {
        tracing::info!(
            target: "zhixing::backup_restore",
            count = sidecars.len(),
            "live database sidecars quarantined"
        );
    }

    // 8. Measure the exact bytes the switch is about to displace. Everything
    //    above is complete, so this is the authoritative pre-switch state.
    let original_live_sha256 = sha256_file_hex(&live_db).map_err(|e| {
        BackupRestoreError::CheckpointFailed(format!("measure pre-switch live db: {e}"))
    })?;

    // 9. Durable journal BEFORE the destructive switch. A failure here means the
    //    switch never happened.
    let now = now_ms();
    let mut journal = RestoreOperationJournal {
        operation_id: operation_id.clone(),
        backup_id: backup_id.clone(),
        expected_target_sha256: expected_sha.clone(),
        original_live_sha256,
        safety_backup_id: safety.backup_id.clone(),
        phase: RestoreJournalPhase::Prepared,
        created_at_ms: now,
        updated_at_ms: now,
    };
    write_journal(&op_dir, &journal)?;

    // 10. THE destructive step: one OS atomic replace.
    let rollback = op_dir.join(ROLLBACK_DB_FILENAME);
    if let Err(failure) = atomic_replace_live_database(&live_db, &replacement, &rollback) {
        return Err(classify_switch_failure(
            &live_db,
            &journal.original_live_sha256,
            failure,
        ));
    }
    record_phase(&op_dir, &mut journal, RestoreJournalPhase::Switched);

    // 11. Post-switch validation — READ-ONLY ONLY, so the live file stays
    //     byte-stable for an IPC-ambiguous reconcile.
    let live_sha = match post_switch_validation(&live_db, &expected_sha) {
        Ok(sha) => sha,
        Err(reason) => {
            return Err(attempt_rollback(
                &op_dir,
                &mut journal,
                &live_db,
                reason.to_string(),
            ))
        }
    };

    record_phase(&op_dir, &mut journal, RestoreJournalPhase::Committed);

    Ok(BackupRestoreApplyResultDto {
        operation_id,
        backup_id,
        outcome: BackupRestoreApplyOutcome::Restored,
        safety_backup_id: safety.backup_id,
        restored_checksum_sha256: live_sha,
    })
}

// ============================================================
// Reconcile
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum BackupRestoreReconcileOutcome {
    /// The restored database is proven authoritative.
    Committed,
    /// The original database is proven authoritative; the operation never
    /// committed.
    NotCommitted,
    /// The original database was put back and proven.
    RolledBack,
    /// The state could not be proven. The barrier must stay active.
    Indeterminate,
}

/// Safe, UI-exposable reconcile reason codes. Never a raw OS / SQLite message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum RestoreReconcileReason {
    RootUnavailable,
    ExpectedTargetUnknown,
    JournalContradictory,
    JournalUnreadable,
    LiveMissing,
    LiveInvalid,
    LiveSchemaMismatch,
    LiveUnknownDatabase,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupRestoreReconcileResultDto {
    pub(crate) operation_id: String,
    pub(crate) backup_id: String,
    pub(crate) outcome: BackupRestoreReconcileOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<RestoreReconcileReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) safety_backup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) restored_checksum_sha256: Option<String>,
}

fn indeterminate(
    operation_id: &str,
    backup_id: &str,
    reason: RestoreReconcileReason,
) -> BackupRestoreReconcileResultDto {
    BackupRestoreReconcileResultDto {
        operation_id: operation_id.to_string(),
        backup_id: backup_id.to_string(),
        outcome: BackupRestoreReconcileOutcome::Indeterminate,
        reason_code: Some(reason),
        safety_backup_id: None,
        restored_checksum_sha256: None,
    }
}

/// Determine what actually happened to the live database.
///
/// The journal is read but NEVER believed on its own: the decision rests on
/// MEASURING the current live database (checksum, integrity, schema). The
/// journal phase only refines the label between two equally-safe outcomes.
///
/// Preconditions relied upon: the strong barrier is still active, so there is no
/// ordinary writer, and no other maintenance-owned operation is running.
pub(crate) fn reconcile_backup_restore(
    app_config_dir: &Path,
    operation_id: &str,
    backup_id: &str,
    _permit: MaintenanceOwnedPermit,
) -> Result<BackupRestoreReconcileResultDto, BackupRestoreError> {
    let operation_id = normalize_uuid(operation_id)?;
    let backup_id = normalize_uuid(backup_id)?;

    // A reconcile that cannot even see the roots cannot prove anything. Report
    // it as INDETERMINATE (the fail-closed answer) rather than as a crash.
    let Ok(roots) = resolve_roots(app_config_dir) else {
        return Ok(indeterminate(
            &operation_id,
            &backup_id,
            RestoreReconcileReason::RootUnavailable,
        ));
    };
    let live_db = DataRootService::resolve_database_path(&roots.data_root, &roots.data_manifest);
    let op_dir = operation_dir(&roots.metadata_root, &operation_id);
    let journal = read_journal(&op_dir);

    // Expected target checksum: the journal AND the bundle must agree when both
    // are available — a tampered journal can never override a verified bundle.
    let journal_sha = match &journal {
        JournalRead::Present(entry) if is_sha256_hex(&entry.expected_target_sha256) => {
            Some(entry.expected_target_sha256.clone())
        }
        _ => None,
    };
    let bundle_sha = cross_check_bundle_sha(app_config_dir, &backup_id);
    if let (Some(from_journal), Some(from_bundle)) = (&journal_sha, &bundle_sha) {
        if from_journal != from_bundle {
            return Ok(indeterminate(
                &operation_id,
                &backup_id,
                RestoreReconcileReason::JournalContradictory,
            ));
        }
    }
    let expected = journal_sha.or(bundle_sha);
    let Some(expected) = expected else {
        return Ok(indeterminate(
            &operation_id,
            &backup_id,
            RestoreReconcileReason::ExpectedTargetUnknown,
        ));
    };

    let original = match &journal {
        JournalRead::Present(entry) if is_sha256_hex(&entry.original_live_sha256) => {
            Some(entry.original_live_sha256.clone())
        }
        _ => None,
    };
    let safety_backup_id = match &journal {
        JournalRead::Present(entry) => Some(entry.safety_backup_id.clone()),
        _ => None,
    };

    let measured = match measure_database(&live_db) {
        Some(measured) => measured,
        None => {
            return Ok(indeterminate(
                &operation_id,
                &backup_id,
                RestoreReconcileReason::LiveMissing,
            ))
        }
    };
    if !measured.integrity_ok {
        return Ok(indeterminate(
            &operation_id,
            &backup_id,
            RestoreReconcileReason::LiveInvalid,
        ));
    }
    if measured.schema_version != Some(current_schema_version()) {
        return Ok(indeterminate(
            &operation_id,
            &backup_id,
            RestoreReconcileReason::LiveSchemaMismatch,
        ));
    }

    // COMMITTED — proven by measurement alone, whatever the journal claims (the
    // process may have died before it could record SWITCHED / COMMITTED).
    if measured.sha256 == expected {
        return Ok(BackupRestoreReconcileResultDto {
            operation_id,
            backup_id,
            outcome: BackupRestoreReconcileOutcome::Committed,
            reason_code: None,
            safety_backup_id,
            restored_checksum_sha256: Some(measured.sha256),
        });
    }

    // The live file is a VALID database, but it is not the target. Whether we
    // may call that safe depends on proving it is the ORIGINAL database.
    let original_matches = match &original {
        Some(original) => original == &measured.sha256,
        // Without a recorded original checksum, "the live database is valid and
        // the operation provably never committed" is the strongest available
        // proof — exactly the frozen NOT_COMMITTED rule.
        None => true,
    };

    let outcome = match (&journal, original_matches) {
        // A journal whose phase claims COMMITTED while the bytes are not the
        // target's is self-contradictory: never trust it.
        (JournalRead::Present(entry), _) if entry.phase == RestoreJournalPhase::Committed => {
            return Ok(indeterminate(
                &operation_id,
                &backup_id,
                RestoreReconcileReason::JournalContradictory,
            ))
        }
        (JournalRead::Present(entry), _) if entry.phase == RestoreJournalPhase::Blocked => {
            return Ok(indeterminate(
                &operation_id,
                &backup_id,
                RestoreReconcileReason::JournalContradictory,
            ))
        }
        (JournalRead::Unreadable, _) => {
            return Ok(indeterminate(
                &operation_id,
                &backup_id,
                RestoreReconcileReason::JournalUnreadable,
            ))
        }
        // The switch succeeded and the previous database was put back.
        (JournalRead::Present(entry), true)
            if matches!(
                entry.phase,
                RestoreJournalPhase::Switched | RestoreJournalPhase::RolledBack
            ) =>
        {
            BackupRestoreReconcileOutcome::RolledBack
        }
        // The journal is written BEFORE the switch, so either its absence or a
        // PREPARED phase proves no switch was committed.
        (_, true) => BackupRestoreReconcileOutcome::NotCommitted,
        // A valid database that is neither the target nor the recorded original.
        (_, false) => {
            return Ok(indeterminate(
                &operation_id,
                &backup_id,
                RestoreReconcileReason::LiveUnknownDatabase,
            ))
        }
    };

    Ok(BackupRestoreReconcileResultDto {
        operation_id,
        backup_id,
        outcome,
        reason_code: None,
        safety_backup_id,
        restored_checksum_sha256: Some(measured.sha256),
    })
}

// ============================================================
// Startup recovery gate (process-restart reconciliation)
// ============================================================

/// Why the startup recovery gate refuses to let the application continue.
///
/// Every variant maps to a STABLE, machine-readable token (see
/// [`RestoreRecoveryBlockerCode::kind`]) so a future UI / diagnostics panel can
/// recognise a restore-recovery stop condition without parsing prose.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum RestoreRecoveryBlockerCode {
    /// `metadata/restore/` exists but could not be enumerated.
    RestoreRootUnreadable,
    /// The restore tree holds something that is not a valid operation record.
    RestoreRootMalformed,
    /// More than one non-terminal operation record is present.
    MultiplePendingOperations,
    /// A non-terminal operation record has no readable journal.
    JournalMalformed,
    /// A non-terminal journal does not carry the checksums required to prove the
    /// live database's identity.
    JournalIncomplete,
    /// The live database is absent, or is not a readable regular file.
    LiveUnprovable,
    /// The live database failed its integrity check.
    LiveIntegrityFailed,
    /// The live database schema is not the current schema.
    LiveSchemaMismatch,
    /// The live database is a valid current-schema database, but it is neither
    /// the proven target nor the proven original of the pending operation.
    LiveUnknownDatabase,
    /// Two pieces of recovery evidence disagree (e.g. the rollback candidate
    /// does not match the recorded original database).
    EvidenceContradictory,
}

impl RestoreRecoveryBlockerCode {
    /// Stable machine-readable token.
    ///
    /// Every token carries the `RESTORE_RECOVERY_` prefix, so both an exact
    /// match and a single prefix match identify the whole class; the frozen
    /// UI-facing token for an unprovable live database is
    /// `RESTORE_RECOVERY_REQUIRED`.
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::RestoreRootUnreadable => "RESTORE_RECOVERY_ROOT_UNREADABLE",
            Self::RestoreRootMalformed => "RESTORE_RECOVERY_ROOT_MALFORMED",
            Self::MultiplePendingOperations => "RESTORE_RECOVERY_MULTIPLE_PENDING",
            Self::JournalMalformed => "RESTORE_RECOVERY_JOURNAL_MALFORMED",
            Self::JournalIncomplete => "RESTORE_RECOVERY_JOURNAL_INCOMPLETE",
            Self::LiveUnprovable => "RESTORE_RECOVERY_LIVE_MISSING",
            Self::LiveIntegrityFailed => "RESTORE_RECOVERY_LIVE_INVALID",
            Self::LiveSchemaMismatch => "RESTORE_RECOVERY_LIVE_SCHEMA_MISMATCH",
            Self::LiveUnknownDatabase => "RESTORE_RECOVERY_REQUIRED",
            Self::EvidenceContradictory => "RESTORE_RECOVERY_EVIDENCE_CONTRADICTORY",
        }
    }
}

/// One structured startup stop condition. Never a bare `String`: the code, the
/// offending path and the human detail travel together.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct RestoreRecoveryBlocker {
    pub(crate) code: RestoreRecoveryBlockerCode,
    pub(crate) path: Option<PathBuf>,
    pub(crate) detail: String,
}

fn recovery_blocker(
    code: RestoreRecoveryBlockerCode,
    path: Option<&Path>,
    detail: impl Into<String>,
) -> RestoreRecoveryBlocker {
    RestoreRecoveryBlocker {
        code,
        path: path.map(Path::to_path_buf),
        detail: detail.into(),
    }
}

/// What the startup gate concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum RestoreRecoveryOutcome {
    /// No pending operation, or only TERMINAL history. Startup may continue.
    Clear,
    /// Exactly one pending operation was proven terminal from DISK TRUTH and
    /// its journal was terminalized. Startup may continue.
    Reconciled {
        operation_id: String,
        phase: RestoreJournalPhase,
    },
}

/// One non-terminal operation record found on disk.
struct PendingRestore {
    dir: PathBuf,
    journal: RestoreOperationJournal,
}

/// List the plain operation directories under `metadata/restore/`.
///
/// An ABSENT restore tree is NOT a failure: it means no restore operation was
/// ever started under this Data Root (and on FirstBoot the whole `metadata/`
/// tree is absent). Failing closed merely because `metadata/` is missing would
/// silently change the behaviour of an otherwise healthy Existing Data Root, so
/// absence is reported as "no operations".
fn collect_operation_dirs(restore_root: &Path) -> Result<Vec<PathBuf>, RestoreRecoveryBlocker> {
    let entries = match fs::read_dir(restore_root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(recovery_blocker(
                RestoreRecoveryBlockerCode::RestoreRootUnreadable,
                Some(restore_root),
                format!("restore metadata root cannot be enumerated: {e}"),
            ))
        }
    };

    let mut dirs: Vec<PathBuf> = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(e) => {
                return Err(recovery_blocker(
                    RestoreRecoveryBlockerCode::RestoreRootUnreadable,
                    Some(restore_root),
                    format!("a restore metadata entry cannot be read: {e}"),
                ))
            }
        };
        let path = entry.path();
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(e) => {
                return Err(recovery_blocker(
                    RestoreRecoveryBlockerCode::RestoreRootUnreadable,
                    Some(&path),
                    format!("a restore metadata entry cannot be inspected: {e}"),
                ))
            }
        };
        // Never follow a redirection: the restore tree holds nothing but plain
        // operation directories, so anything else fails closed.
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return Err(recovery_blocker(
                RestoreRecoveryBlockerCode::RestoreRootMalformed,
                Some(&path),
                "an entry under metadata/restore is not a plain operation directory",
            ));
        }
        dirs.push(path);
    }
    dirs.sort();
    Ok(dirs)
}

/// Find THE one non-terminal operation, if any.
///
/// Terminal history is ignored (and never deleted). More than one pending
/// operation is never resolved by guessing: no ordering, no directory name and
/// no timestamp is allowed to pick a winner.
fn find_pending_operation(
    operation_dirs: &[PathBuf],
) -> Result<Option<PendingRestore>, RestoreRecoveryBlocker> {
    let mut identities: BTreeSet<String> = BTreeSet::new();
    let mut pending: Option<PendingRestore> = None;

    for dir in operation_dirs {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        // The operation id is the directory name, and it must be canonical: an
        // unrecognisable name means the record cannot be trusted.
        let identity = match Uuid::parse_str(&name) {
            Ok(uuid) => uuid.to_string(),
            Err(_) => {
                return Err(recovery_blocker(
                    RestoreRecoveryBlockerCode::RestoreRootMalformed,
                    Some(dir),
                    "an operation directory name is not a canonical operation id",
                ))
            }
        };
        if !identities.insert(identity) {
            return Err(recovery_blocker(
                RestoreRecoveryBlockerCode::RestoreRootMalformed,
                Some(dir),
                "two operation directories denote the same operation id",
            ));
        }

        match read_journal(dir) {
            JournalRead::Present(journal) => {
                if journal.phase.is_terminal() {
                    continue;
                }
                if pending.is_some() {
                    return Err(recovery_blocker(
                        RestoreRecoveryBlockerCode::MultiplePendingOperations,
                        Some(dir),
                        "more than one restore operation is still pending",
                    ));
                }
                pending = Some(PendingRestore {
                    dir: dir.clone(),
                    journal: *journal,
                });
            }
            // The journal is written BEFORE the destructive switch, so an
            // operation directory whose journal is missing or unreadable is an
            // INCOMPLETE record. It is never read as "nothing happened": the
            // recovery evidence required to prove the live database is absent
            // either way, so this fails closed.
            JournalRead::Absent => {
                return Err(recovery_blocker(
                    RestoreRecoveryBlockerCode::JournalMalformed,
                    Some(dir),
                    "an operation directory carries no journal",
                ))
            }
            JournalRead::Unreadable => {
                return Err(recovery_blocker(
                    RestoreRecoveryBlockerCode::JournalMalformed,
                    Some(dir),
                    "an operation journal is present but unreadable",
                ))
            }
        }
    }
    Ok(pending)
}

/// READ-ONLY reconciliation of a restore operation left behind by a crash.
///
/// Runs at PROCESS START, after the Existing Data Root has been validated and
/// before the production database is opened with the normal policy. It is NOT a
/// maintenance-owner operation and needs no owner token: ordinary admission has
/// not started yet, so nothing can race it and no old owner id is ever
/// fabricated into the journal.
///
/// The journal is never believed on its own (exactly as in
/// [`reconcile_backup_restore`]): the verdict rests on MEASURING the live
/// database. This function never repairs — there is no rollback, no replace, no
/// creation and no deletion here. Anything it cannot prove is returned as a
/// [`RestoreRecoveryBlocker`], which the caller turns into
/// `RuntimeStatus::Degraded(...)` so every ordinary Native DB command keeps
/// failing closed.
pub(crate) fn recover_or_classify_pending_operations(
    data_root: &Path,
    manifest: &DataRootManifest,
) -> Result<RestoreRecoveryOutcome, RestoreRecoveryBlocker> {
    let restore_root = data_root.join(METADATA_DIR_NAME).join(RESTORE_DIR_NAME);
    let operation_dirs = collect_operation_dirs(&restore_root)?;
    let Some(pending) = find_pending_operation(&operation_dirs)? else {
        return Ok(RestoreRecoveryOutcome::Clear);
    };

    // Required recovery evidence, straight from the journal: without both
    // checksums nothing about the live database can be proven.
    if !is_sha256_hex(&pending.journal.expected_target_sha256)
        || !is_sha256_hex(&pending.journal.original_live_sha256)
    {
        return Err(recovery_blocker(
            RestoreRecoveryBlockerCode::JournalIncomplete,
            Some(&pending.dir),
            "the pending operation journal does not carry the checksums required to prove the live database",
        ));
    }

    // Corroborating evidence. When the OS atomic replace ran it saved the
    // displaced database as `rollback.db`, so those bytes MUST equal the
    // recorded original. Disagreement is never resolved by preference.
    //
    // Its ABSENCE is not a failure: a crash before the switch legitimately has
    // no rollback candidate yet, and nothing here ever acts on it (§13: startup
    // recovery is read-only, with no automatic destructive rollback).
    let rollback = pending.dir.join(ROLLBACK_DB_FILENAME);
    if is_regular_file(&rollback) {
        match sha256_file_hex(&rollback) {
            Ok(sha) if sha == pending.journal.original_live_sha256 => {}
            _ => {
                return Err(recovery_blocker(
                    RestoreRecoveryBlockerCode::EvidenceContradictory,
                    Some(&rollback),
                    "the rollback candidate does not match the recorded original database",
                ))
            }
        }
    }

    // Disk truth. Read-only throughout, so the live file stays byte-stable.
    let live_db = DataRootService::resolve_database_path(data_root, manifest);
    let measured = measure_database(&live_db).ok_or_else(|| {
        recovery_blocker(
            RestoreRecoveryBlockerCode::LiveUnprovable,
            Some(&live_db),
            "the live database is absent or is not a readable regular file",
        )
    })?;
    if !measured.integrity_ok {
        return Err(recovery_blocker(
            RestoreRecoveryBlockerCode::LiveIntegrityFailed,
            Some(&live_db),
            "the live database failed its integrity check",
        ));
    }
    if measured.schema_version != Some(current_schema_version()) {
        return Err(recovery_blocker(
            RestoreRecoveryBlockerCode::LiveSchemaMismatch,
            Some(&live_db),
            "the live database schema is not the current schema",
        ));
    }

    // The journal phase is a HINT; the measured bytes are the authority. A
    // crash after the switch (SWITCHED, or BLOCKED) is still a proven commit.
    let phase = if measured.sha256 == pending.journal.expected_target_sha256 {
        RestoreJournalPhase::Committed
    } else if measured.sha256 == pending.journal.original_live_sha256 {
        // The pre-switch database is live: the target was provably never
        // installed. A journal that reached SWITCHED means the previous
        // database was put back; anything earlier never switched at all.
        match pending.journal.phase {
            RestoreJournalPhase::Switched => RestoreJournalPhase::RolledBack,
            _ => RestoreJournalPhase::NotCommitted,
        }
    } else {
        return Err(recovery_blocker(
            RestoreRecoveryBlockerCode::LiveUnknownDatabase,
            Some(&live_db),
            "the live database is valid but is neither the pending operation's target nor its original",
        ));
    };

    // Terminalize the journal from disk truth, with the same atomic
    // `.part → sync_all → rename` write used everywhere else (never a truncate
    // of the live journal). Best-effort: the measured state always outranks the
    // journal, so losing this update degrades diagnosis, never safety — the
    // next startup simply re-proves the same verdict.
    let mut journal = pending.journal;
    journal.phase = phase;
    journal.updated_at_ms = now_ms();
    if let Err(e) = write_journal(&pending.dir, &journal) {
        tracing::warn!(
            target: "zhixing::backup_restore",
            error = %e,
            "startup restore journal finalization skipped"
        );
    }

    Ok(RestoreRecoveryOutcome::Reconciled {
        operation_id: journal.operation_id,
        phase,
    })
}

// ============================================================
// Tauri commands
// ============================================================

/// Prove maintenance ownership. Every failure mode is an authorization failure;
/// nothing has been mutated at this point.
fn owner_proof(
    app: &tauri::AppHandle,
    owner_lease_id: &str,
) -> Result<MaintenanceOwnedPermit, BackupRestoreCommandErrorDto> {
    app.state::<NativeMaintenanceState>()
        .acquire_owner_permit(owner_lease_id)
        .map_err(|error: NativeMaintenanceErrorDto| {
            BackupRestoreCommandErrorDto::from(BackupRestoreError::OwnerMismatch(
                error.code.to_string(),
            ))
        })
}

fn app_config_dir_or_unavailable(
    app: &tauri::AppHandle,
) -> Result<PathBuf, BackupRestoreCommandErrorDto> {
    app.path().app_config_dir().map_err(|_| {
        BackupRestoreCommandErrorDto::from(BackupRestoreError::Unavailable(
            "app_config_dir unavailable".into(),
        ))
    })
}

/// Apply one DATABASE RESTORE V1.
///
/// `owner_lease_id` is the raw native maintenance owner id. It is injected by
/// the purpose-bound Native capability and NEVER travels through React, the
/// coordinator, or the shared restore domain.
#[tauri::command]
pub(crate) async fn native_backup_restore_apply(
    app: tauri::AppHandle,
    owner_lease_id: String,
    operation_id: String,
    backup_id: String,
) -> Result<BackupRestoreApplyResultDto, BackupRestoreCommandErrorDto> {
    // Owner proof FIRST: nothing is opened or resolved before authorization.
    let permit = owner_proof(&app, &owner_lease_id)?;
    let app_config_dir = app_config_dir_or_unavailable(&app)?;

    let joined = tauri::async_runtime::spawn_blocking(move || {
        apply_backup_restore(&app_config_dir, &operation_id, &backup_id, permit)
            .map_err(BackupRestoreCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        // A panicking task may have died anywhere, including after the switch:
        // the outcome is unprovable, so this is BLOCKED, never RECOVERABLE.
        Err(_) => Err(BackupRestoreCommandErrorDto::from(
            BackupRestoreError::Internal("restore task failed to complete".into()),
        )),
    }
}

/// Reconcile an ambiguous restore and report what actually happened on disk.
#[tauri::command]
pub(crate) async fn native_backup_restore_reconcile(
    app: tauri::AppHandle,
    owner_lease_id: String,
    operation_id: String,
    backup_id: String,
) -> Result<BackupRestoreReconcileResultDto, BackupRestoreCommandErrorDto> {
    let permit = owner_proof(&app, &owner_lease_id)?;
    let app_config_dir = app_config_dir_or_unavailable(&app)?;

    let joined = tauri::async_runtime::spawn_blocking(move || {
        reconcile_backup_restore(&app_config_dir, &operation_id, &backup_id, permit)
            .map_err(BackupRestoreCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        Err(_) => Err(BackupRestoreCommandErrorDto::from(
            BackupRestoreError::Internal("reconcile task failed to complete".into()),
        )),
    }
}

// ============================================================
// Tests — tempdir sandbox only. No real AppData, Data Root, backup/ or
// zhixing.db is ever touched by this suite.
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{acquire_backup_permit, create_backup, BackupResultDto};
    use crate::backup_inventory::{
        list_backups, verify_backup, BackupInventoryStatus, BackupVerificationStatus,
    };
    use crate::maintenance::NativeMaintenanceState;
    use serde_json::json;
    use std::sync::Arc;
    use tempfile::tempdir;

    // ---------- sandbox helpers ----------

    /// Valid bootstrap + FirstBoot-initialized Data Root in a tempdir.
    fn make_root(tmp: &Path) -> (PathBuf, PathBuf) {
        let cfg = tmp.join("cfg");
        fs::create_dir_all(&cfg).unwrap();
        let data_root = tmp.join("data");
        DataRootService::get_and_ensure(&data_root, crate::storage::InitMode::FirstBoot)
            .expect("FirstBoot initialize");
        let bootstrap = json!({
            "bootstrap_version": 1,
            "device_id": Uuid::new_v4().to_string(),
            "data_root": data_root,
        });
        fs::write(
            cfg.join("bootstrap.json"),
            serde_json::to_string_pretty(&bootstrap).unwrap(),
        )
        .unwrap();
        (cfg, data_root)
    }

    fn live_path(data_root: &Path) -> PathBuf {
        data_root.join(DB_RELATIVE_PATH)
    }

    fn sidecar_path(live: &Path, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}{suffix}", live.display()))
    }

    fn live_sha(data_root: &Path) -> String {
        sha256_file_hex(&live_path(data_root)).unwrap()
    }

    /// Write a valid CURRENT-schema database at an explicit path and return its
    /// streaming SHA-256.
    ///
    /// A hand-written history table (rather than the real migration runner) is
    /// deliberate: Restore V1 must never migrate, so the fixtures must not
    /// either. Only `MAX(version)` is ever read.
    fn write_current_db_at(path: &Path, rows: &[&str]) -> String {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        let conn = crate::db::policy::open_configured_connection(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE schema_migrations (
                 version INTEGER PRIMARY KEY NOT NULL,
                 id TEXT NOT NULL UNIQUE,
                 checksum_sha256 TEXT NOT NULL,
                 applied_at_ms INTEGER NOT NULL
             );
             CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO schema_migrations(version,id,checksum_sha256,applied_at_ms) \
             VALUES (?1,'current','0000000000000000000000000000000000000000000000000000000000000000',0)",
            [i64::from(current_schema_version())],
        )
        .unwrap();
        for row in rows {
            conn.execute("INSERT INTO t(v) VALUES (?1)", [row]).unwrap();
        }
        drop(conn);
        sha256_file_hex(path).unwrap()
    }

    /// (Re)create the live database holding `rows`.
    fn seed_live(data_root: &Path, rows: &[&str]) {
        let path = live_path(data_root);
        for suffix in SIDECAR_SUFFIXES {
            let _ = fs::remove_file(sidecar_path(&path, suffix));
        }
        let _ = fs::remove_file(&path);
        write_current_db_at(&path, rows);
    }

    /// Seed the live database with `rows` and return its SHA-256.
    fn seed_live_sha(data_root: &Path, rows: &[&str]) -> String {
        seed_live(data_root, rows);
        live_sha(data_root)
    }

    /// The authoritative manifest of an already-initialized Data Root.
    fn manifest_of(data_root: &Path) -> DataRootManifest {
        DataRootService::get_and_ensure(data_root, crate::storage::InitMode::Existing)
            .expect("Existing Data Root")
            .1
    }

    /// Write the durable journal of one (possibly pending) restore operation.
    /// Returns the operation directory.
    fn write_pending_journal(
        data_root: &Path,
        operation_id: &str,
        expected_target_sha256: &str,
        original_live_sha256: &str,
        phase: RestoreJournalPhase,
    ) -> PathBuf {
        let dir = op_dir_of(data_root, operation_id);
        fs::create_dir_all(&dir).unwrap();
        let journal = RestoreOperationJournal {
            operation_id: operation_id.to_string(),
            backup_id: uid(),
            expected_target_sha256: expected_target_sha256.to_string(),
            original_live_sha256: original_live_sha256.to_string(),
            safety_backup_id: uid(),
            phase,
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_000,
        };
        write_journal(&dir, &journal).unwrap();
        dir
    }

    /// Read `t.v` READ-ONLY, ordered by insertion (rowid).
    fn rows_of(db: &Path) -> Vec<String> {
        let conn = Connection::open_with_flags(db, OpenFlags::SQLITE_OPEN_READ_ONLY).unwrap();
        let mut stmt = conn.prepare("SELECT v FROM t ORDER BY id").unwrap();
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .unwrap()
            .map(|r| r.unwrap())
            .collect();
        rows
    }

    fn bundle_dir_of(data_root: &Path, dto: &BackupResultDto) -> PathBuf {
        data_root.join(crate::backup::BACKUP_DIR_NAME).join(
            dto.bundle_relative_path
                .trim_start_matches(&format!("{}/", crate::backup::BACKUP_DIR_NAME)),
        )
    }

    fn bundle_db_of(data_root: &Path, dto: &BackupResultDto) -> PathBuf {
        bundle_dir_of(data_root, dto).join(DB_RELATIVE_PATH)
    }

    fn backup_entries(data_root: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(data_root.join(crate::backup::BACKUP_DIR_NAME))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        names
    }

    /// Seed the live database and produce a real P6-S5 bundle of it.
    fn make_bundle(cfg: &Path, data_root: &Path, rows: &[&str]) -> BackupResultDto {
        seed_live(data_root, rows);
        let permit = acquire_backup_permit(&NativeMaintenanceState::new()).expect("permit");
        create_backup(cfg, permit).expect("backup")
    }

    fn owner() -> (Arc<NativeMaintenanceState>, String) {
        let state = Arc::new(NativeMaintenanceState::new());
        let id = state.begin_maintenance().expect("begin");
        (state, id)
    }

    fn op_dir_of(data_root: &Path, operation_id: &str) -> PathBuf {
        data_root
            .join("metadata")
            .join(RESTORE_DIR_NAME)
            .join(operation_id)
    }

    fn phase_of(op_dir: &Path) -> Option<RestoreJournalPhase> {
        match read_journal(op_dir) {
            JournalRead::Present(journal) => Some(journal.phase),
            _ => None,
        }
    }

    fn uid() -> String {
        Uuid::new_v4().to_string()
    }

    // ---------- hand-built bundle helpers (compatibility-gate tests) ----------

    fn make_candidate(data_root: &Path, name: &str) -> PathBuf {
        let dir = data_root.join(crate::backup::BACKUP_DIR_NAME).join(name);
        fs::create_dir_all(dir.join("database")).unwrap();
        dir
    }

    /// Write a real, valid, single-file SQLite database at the canonical bundle
    /// path. Returns `(size, sha256)`.
    fn write_bundle_db(dir: &Path, rows: &[&str]) -> (u64, String) {
        let path = dir.join(DB_RELATIVE_PATH);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);")
            .unwrap();
        for row in rows {
            conn.execute("INSERT INTO t(v) VALUES (?1)", [row]).unwrap();
        }
        drop(conn);
        let size = fs::metadata(&path).unwrap().len();
        (size, sha256_file_hex(&path).unwrap())
    }

    /// A complete, structurally valid hand-built bundle.
    fn hand_bundle(
        data_root: &Path,
        name: &str,
        rows: &[&str],
        schema_version: u32,
    ) -> (PathBuf, String) {
        let dir = make_candidate(data_root, name);
        let (size, sha) = write_bundle_db(&dir, rows);
        let backup_id = uid();
        let value = json!({
            "manifest_kind": crate::backup::MANIFEST_KIND,
            "format_version": crate::backup::FORMAT_VERSION,
            "backup_id": backup_id,
            "created_at_ms": 1_700_000_000_000i64,
            "app_version": "0.0.0-test",
            "schema_version": schema_version,
            "scope": {"database": true, "attachments": false, "portable_settings": false},
            "database": {
                "relative_path": DB_RELATIVE_PATH,
                "size_bytes": size,
                "sha256": sha,
                "integrity_check_ok": true,
            },
        });
        fs::write(
            dir.join(crate::backup::MANIFEST_FILENAME),
            serde_json::to_string_pretty(&value).unwrap(),
        )
        .unwrap();
        (dir, backup_id)
    }

    fn rewrite_manifest(dir: &Path, mutate: impl FnOnce(&mut serde_json::Value)) {
        let path = dir.join(crate::backup::MANIFEST_FILENAME);
        let mut value: serde_json::Value =
            serde_json::from_str(&fs::read_to_string(&path).unwrap()).unwrap();
        mutate(&mut value);
        fs::write(&path, serde_json::to_string_pretty(&value).unwrap()).unwrap();
    }

    // ============================================================
    // happy path
    // ============================================================

    #[test]
    fn happy_restore_replaces_live_and_keeps_every_piece_of_evidence() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1", "bak-2"]);
        let target_sha = sha256_file_hex(&bundle_db_of(&data_root, &dto)).unwrap();

        // The CURRENT live data differs from the bundle.
        seed_live(&data_root, &["live-1", "live-2", "live-3"]);
        let original_sha = live_sha(&data_root);
        let before = backup_entries(&data_root);

        let (state, owner_id) = owner();
        let op = uid();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = apply_backup_restore(&cfg, &op, &dto.backup_id, permit).expect("restore");

        assert_eq!(result.outcome, BackupRestoreApplyOutcome::Restored);
        assert_eq!(result.operation_id, op);
        assert_eq!(result.backup_id, dto.backup_id);
        assert_eq!(result.restored_checksum_sha256, target_sha);

        // The live database IS the bundle's database now.
        assert_eq!(rows_of(&live_path(&data_root)), vec!["bak-1", "bak-2"]);
        assert_eq!(live_sha(&data_root), target_sha);

        // The pre-switch database is retained as the rollback candidate — and it
        // is byte-for-byte the database that was live a moment ago.
        let op_dir = op_dir_of(&data_root, &op);
        let rollback = op_dir.join(ROLLBACK_DB_FILENAME);
        assert!(rollback.is_file(), "rollback candidate must be retained");
        assert_eq!(sha256_file_hex(&rollback).unwrap(), original_sha);
        assert_eq!(rows_of(&rollback), vec!["live-1", "live-2", "live-3"]);

        // The selected bundle is untouched.
        assert!(bundle_dir_of(&data_root, &dto).is_dir());
        assert_eq!(sha256_file_hex(&bundle_db_of(&data_root, &dto)).unwrap(), target_sha);

        // The durable journal records the proven outcome.
        assert_eq!(phase_of(&op_dir), Some(RestoreJournalPhase::Committed));

        // Exactly one bundle appeared: the Safety Backup.
        assert_eq!(backup_entries(&data_root).len(), before.len() + 1);
    }

    #[test]
    fn the_safety_backup_is_a_normal_verifiable_v1_bundle_of_the_pre_restore_data() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1", "live-2"]);

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = apply_backup_restore(&cfg, &uid(), &dto.backup_id, permit).expect("restore");

        // Inventory (cheap structural scan) accepts it as a normal bundle...
        let items = list_backups(&cfg).unwrap();
        let safety = items
            .iter()
            .find(|item| item.backup_id.as_deref() == Some(result.safety_backup_id.as_str()))
            .expect("the safety backup must be visible to the inventory");
        assert_eq!(safety.inventory_status, BackupInventoryStatus::StructurallyValid);
        assert_eq!(safety.schema_version, Some(current_schema_version()));

        // ...an explicit verify proves it...
        let verified = verify_backup(&cfg, &result.safety_backup_id).unwrap();
        assert_eq!(verified.verification_status, BackupVerificationStatus::Verified);

        // ...and it holds the data that was live BEFORE the restore.
        let safety_db = data_root
            .join(crate::backup::BACKUP_DIR_NAME)
            .join(
                safety
                    .bundle_relative_path
                    .trim_start_matches(&format!("{}/", crate::backup::BACKUP_DIR_NAME)),
            )
            .join(DB_RELATIVE_PATH);
        assert_eq!(rows_of(&safety_db), vec!["live-1", "live-2"]);
    }

    // ============================================================
    // TOCTOU — a cached VERIFIED badge is never trusted
    // ============================================================

    #[test]
    fn a_previously_verified_bundle_is_reverified_inside_the_barrier() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);
        let before = backup_entries(&data_root);

        // A VERIFIED result obtained BEFORE the restore...
        let verified = verify_backup(&cfg, &dto.backup_id).unwrap();
        assert_eq!(verified.verification_status, BackupVerificationStatus::Verified);

        // ...must not survive the bundle changing underneath it.
        let db = bundle_db_of(&data_root, &dto);
        let mut bytes = fs::read(&db).unwrap();
        bytes.extend_from_slice(b"tampered-after-verify");
        fs::write(&db, &bytes).unwrap();

        let (state, owner_id) = owner();
        let op = uid();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &op, &dto.backup_id, permit).unwrap_err();

        assert_eq!(error.code(), "BACKUP_VERIFY_FAILED");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);

        // The refusal happened before ANY mutation: no safety backup, no
        // operation directory, live database byte-identical.
        assert_eq!(backup_entries(&data_root), before);
        assert!(!op_dir_of(&data_root, &op).exists());
        assert_eq!(live_sha(&data_root), original_sha);
        assert_eq!(rows_of(&live_path(&data_root)), vec!["live-1"]);
    }

    // ============================================================
    // owner authorization
    // ============================================================

    #[test]
    fn a_non_owner_and_a_stale_owner_are_rejected_and_nothing_is_touched() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);
        let before = backup_entries(&data_root);

        let (state, owner_id) = owner();

        // A well-formed but WRONG owner id.
        let bogus = format!("native-maint-{}", Uuid::new_v4());
        let error = state.acquire_owner_permit(&bogus).unwrap_err();
        assert_eq!(error.code, "MAINTENANCE_OWNER_MISMATCH");

        // A STALE owner id from a previous session.
        state.end_maintenance(&owner_id).unwrap();
        let fresh = state.begin_maintenance().unwrap();
        let error = state.acquire_owner_permit(&owner_id).unwrap_err();
        assert_eq!(error.code, "MAINTENANCE_OWNER_MISMATCH");
        assert!(state.acquire_owner_permit(&fresh).is_ok());

        // No permit was ever handed out, so nothing can have been mutated.
        assert_eq!(backup_entries(&data_root), before);
        assert!(!data_root.join("metadata").join(RESTORE_DIR_NAME).exists());
        assert_eq!(live_sha(&data_root), original_sha);
        assert!(bundle_dir_of(&data_root, &dto).is_dir());
    }

    #[test]
    fn no_owner_permit_can_be_obtained_without_an_active_session() {
        let tmp = tempdir().unwrap();
        let (_cfg, data_root) = make_root(tmp.path());
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);

        let state = NativeMaintenanceState::new();
        let error = state.acquire_owner_permit("native-maint-anything").unwrap_err();
        assert_eq!(error.code, "MAINTENANCE_NOT_ACTIVE");
        assert_eq!(live_sha(&data_root), original_sha);
    }

    // ============================================================
    // compatibility gates: schema / scope / format
    // ============================================================

    #[test]
    fn an_older_or_newer_schema_bundle_is_unsupported_and_mutates_nothing() {
        for delta in [-1i64, 1i64] {
            let tmp = tempdir().unwrap();
            let (cfg, data_root) = make_root(tmp.path());
            seed_live(&data_root, &["live-1"]);
            let original_sha = live_sha(&data_root);

            let schema = u32::try_from(i64::from(current_schema_version()) + delta).unwrap();
            let (dir, backup_id) =
                hand_bundle(&data_root, &format!("backup_9_schema_{delta}"), &["bak-1"], schema);

            let (state, owner_id) = owner();
            let op = uid();
            let permit = state.acquire_owner_permit(&owner_id).unwrap();
            let error = apply_backup_restore(&cfg, &op, &backup_id, permit).unwrap_err();

            assert_eq!(error.code(), "BACKUP_UNSUPPORTED", "schema delta {delta}");
            assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);
            assert_eq!(live_sha(&data_root), original_sha);
            assert!(!op_dir_of(&data_root, &op).exists());
            assert!(!data_root.join("metadata").join(RESTORE_DIR_NAME).exists());
            assert!(dir.is_dir(), "the refused bundle is left exactly as it was");
        }
    }

    #[test]
    fn a_non_v1_scope_or_foreign_format_bundle_is_unsupported_and_mutates_nothing() {
        for case in ["scope", "format"] {
            let tmp = tempdir().unwrap();
            let (cfg, data_root) = make_root(tmp.path());
            seed_live(&data_root, &["live-1"]);
            let original_sha = live_sha(&data_root);

            let (dir, backup_id) = hand_bundle(
                &data_root,
                &format!("backup_9_{case}"),
                &["bak-1"],
                current_schema_version(),
            );
            match case {
                "scope" => rewrite_manifest(&dir, |value| {
                    value["scope"]["attachments"] = json!(true);
                }),
                _ => rewrite_manifest(&dir, |value| {
                    value["format_version"] = json!(crate::backup::FORMAT_VERSION + 1);
                }),
            }

            let (state, owner_id) = owner();
            let permit = state.acquire_owner_permit(&owner_id).unwrap();
            let error = apply_backup_restore(&cfg, &uid(), &backup_id, permit).unwrap_err();

            assert_eq!(error.code(), "BACKUP_UNSUPPORTED", "case {case}");
            assert_eq!(live_sha(&data_root), original_sha);
            assert!(!data_root.join("metadata").join(RESTORE_DIR_NAME).exists());
        }
    }

    #[test]
    fn non_uuid_identifiers_are_refused_before_anything_is_touched() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);
        let before = backup_entries(&data_root);

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, "not-a-uuid", &dto.backup_id, permit).unwrap_err();
        assert_eq!(error.code(), "REQUEST_INVALID");

        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &uid(), "not-a-uuid", permit).unwrap_err();
        assert_eq!(error.code(), "REQUEST_INVALID");

        assert_eq!(backup_entries(&data_root), before);
        assert_eq!(live_sha(&data_root), original_sha);
        assert!(!data_root.join("metadata").join(RESTORE_DIR_NAME).exists());
    }

    #[test]
    fn an_absent_backup_id_is_reported_as_not_found() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &uid(), &uid(), permit).unwrap_err();
        assert_eq!(error.code(), "BACKUP_NOT_FOUND");
        assert_eq!(live_sha(&data_root), original_sha);
    }

    #[test]
    fn an_operation_id_can_never_be_reused() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);

        let (state, owner_id) = owner();
        let op = uid();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        apply_backup_restore(&cfg, &op, &dto.backup_id, permit).expect("first restore");
        let restored_sha = live_sha(&data_root);

        let (state2, owner2) = owner();
        let permit2 = state2.acquire_owner_permit(&owner2).unwrap();
        let error = apply_backup_restore(&cfg, &op, &dto.backup_id, permit2).unwrap_err();
        assert_eq!(error.code(), "REQUEST_INVALID");
        assert_eq!(live_sha(&data_root), restored_sha, "the restored data must stay put");
    }

    // ============================================================
    // fail-closed: missing roots and a missing live database
    // ============================================================

    #[test]
    fn a_missing_metadata_root_fails_closed_and_is_never_repaired() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);

        fs::remove_dir_all(data_root.join(crate::backup::METADATA_DIR_NAME)).unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &uid(), &dto.backup_id, permit).unwrap_err();

        assert_eq!(error.code(), "UNAVAILABLE");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);
        assert!(
            !data_root.join(crate::backup::METADATA_DIR_NAME).exists(),
            "a fixed FirstBoot subdir must never be repaired implicitly"
        );
        assert_eq!(live_sha(&data_root), original_sha);
    }

    #[test]
    fn a_missing_backup_root_fails_closed_and_is_never_repaired() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        seed_live(&data_root, &["live-1"]);
        let original_sha = live_sha(&data_root);

        fs::remove_dir_all(data_root.join(crate::backup::BACKUP_DIR_NAME)).unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &uid(), &uid(), permit).unwrap_err();

        assert_eq!(error.code(), "UNAVAILABLE");
        assert!(
            !data_root.join(crate::backup::BACKUP_DIR_NAME).exists(),
            "a fixed FirstBoot subdir must never be repaired implicitly"
        );
        assert_eq!(live_sha(&data_root), original_sha);
    }

    #[test]
    fn a_missing_live_database_is_never_re_created_empty() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);

        let live = live_path(&data_root);
        for suffix in SIDECAR_SUFFIXES {
            let _ = fs::remove_file(sidecar_path(&live, suffix));
        }
        fs::remove_file(&live).unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &uid(), &dto.backup_id, permit).unwrap_err();

        assert_eq!(error.code(), "SAFETY_BACKUP_FAILED");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);
        assert!(
            !live.exists(),
            "restore must never fabricate an empty live database"
        );
        // The failed safety backup leaves no staging litter behind.
        assert!(
            backup_entries(&data_root)
                .iter()
                .all(|name| !name.starts_with(crate::backup::STAGING_PREFIX)),
            "no staging directory may survive a failed safety backup"
        );
    }

    // ============================================================
    // sidecars
    // ============================================================

    #[test]
    fn stale_sidecars_are_moved_never_deleted() {
        let tmp = tempdir().unwrap();
        let (_cfg, data_root) = make_root(tmp.path());
        seed_live(&data_root, &["live-1"]);
        let live = live_path(&data_root);
        assert_eq!(rows_of(&live), vec!["live-1"]);

        let created: Vec<PathBuf> = SIDECAR_SUFFIXES
            .iter()
            .map(|suffix| {
                let path = sidecar_path(&live, suffix);
                fs::write(&path, b"stale-sidecar").unwrap();
                path
            })
            .collect();

        let sidecar_dir = op_dir_of(&data_root, "quarantine-probe").join(SIDECARS_DIR_NAME);
        let moved = quarantine_sidecars(&live, &sidecar_dir).unwrap();
        assert_eq!(moved.len(), SIDECAR_SUFFIXES.len());

        for path in &created {
            assert!(!path.exists(), "a stale sidecar must not remain beside the live database");
        }
        let mut quarantined: Vec<String> = fs::read_dir(&sidecar_dir)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        quarantined.sort();
        assert_eq!(
            quarantined,
            vec![
                "zhixing.db-journal".to_string(),
                "zhixing.db-shm".to_string(),
                "zhixing.db-wal".to_string(),
            ]
        );
    }

    #[test]
    fn no_sidecar_remains_beside_the_restored_live_database() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        apply_backup_restore(&cfg, &uid(), &dto.backup_id, permit).expect("restore");

        for path in live_sidecar_paths(&live_path(&data_root)) {
            assert!(
                !path.exists(),
                "a stale sidecar must never sit beside the restored database: {}",
                path.display()
            );
        }
    }

    // ============================================================
    // the platform atomic replace
    // ============================================================

    #[cfg(windows)]
    #[test]
    fn the_atomic_replace_installs_the_replacement_and_keeps_the_original() {
        let tmp = tempdir().unwrap();
        let live = tmp.path().join("zhixing.db");
        let replacement = tmp.path().join("replacement.db");
        let rollback = tmp.path().join("rollback.db");
        fs::write(&live, b"LIVE-ORIGINAL").unwrap();
        fs::write(&replacement, b"NEW-CONTENT").unwrap();

        atomic_replace_live_database(&live, &replacement, &rollback).expect("atomic replace");

        assert_eq!(fs::read(&live).unwrap(), b"NEW-CONTENT");
        assert_eq!(fs::read(&rollback).unwrap(), b"LIVE-ORIGINAL");
        assert!(
            !replacement.exists(),
            "the replacement file is consumed by the atomic replace"
        );
    }

    #[cfg(windows)]
    #[test]
    fn a_failed_atomic_replace_leaves_the_original_recoverable() {
        let tmp = tempdir().unwrap();
        let live = tmp.path().join("zhixing.db");
        let replacement = tmp.path().join("does-not-exist.db");
        let rollback = tmp.path().join("rollback.db");
        fs::write(&live, b"LIVE-ORIGINAL").unwrap();

        let failure = atomic_replace_live_database(&live, &replacement, &rollback).unwrap_err();
        assert!(matches!(failure, SwitchFailure::CouldNotSwitch(_)));
        assert_eq!(
            fs::read(&live).unwrap(),
            b"LIVE-ORIGINAL",
            "the original must survive a failed replace untouched"
        );
        assert!(!rollback.exists());
    }

    #[test]
    fn the_bounded_retry_stops_at_a_fixed_upper_bound() {
        let mut attempts = 0u32;
        let outcome = run_with_bounded_retry(|| {
            attempts += 1;
            ReplaceAttempt::Contended("held".into())
        });
        assert!(matches!(outcome, Err(ReplaceAttempt::Contended(_))));
        assert_eq!(attempts, REPLACE_MAX_ATTEMPTS, "the retry bound must be fixed and finite");

        let mut attempts = 0u32;
        let outcome = run_with_bounded_retry(|| {
            attempts += 1;
            if attempts == 2 {
                ReplaceAttempt::Done
            } else {
                ReplaceAttempt::Contended("held".into())
            }
        });
        assert!(outcome.is_ok());
        assert_eq!(attempts, 2);

        let mut attempts = 0u32;
        let outcome = run_with_bounded_retry(|| {
            attempts += 1;
            ReplaceAttempt::Failed("fatal".into())
        });
        assert!(matches!(outcome, Err(ReplaceAttempt::Failed(_))));
        assert_eq!(attempts, 1, "a non-contention failure must never be retried");
    }

    #[test]
    fn a_switch_failure_is_classified_from_measured_bytes_not_from_the_error() {
        let tmp = tempdir().unwrap();
        let live = tmp.path().join("zhixing.db");
        fs::write(&live, b"ORIGINAL-BYTES").unwrap();
        let original = sha256_file_hex(&live).unwrap();

        // Byte-identical ⇒ provably never switched ⇒ RECOVERABLE.
        let error = classify_switch_failure(
            &live,
            &original,
            SwitchFailure::CouldNotSwitch("probe".into()),
        );
        assert_eq!(error.code(), "SWITCH_FAILED");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);

        // Live gone ⇒ the outcome cannot be proven ⇒ BLOCKED.
        fs::remove_file(&live).unwrap();
        let error = classify_switch_failure(
            &live,
            &original,
            SwitchFailure::CouldNotSwitch("probe".into()),
        );
        assert_eq!(error.code(), "SWITCH_INDETERMINATE");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Blocked);
    }

    // ============================================================
    // rollback after a failed post-switch validation
    // ============================================================

    #[test]
    fn a_failed_post_switch_validation_is_rolled_back_and_proven() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1", "bak-2"]);
        seed_live(&data_root, &["live-1", "live-2"]);
        let original_sha = live_sha(&data_root);

        let (state, owner_id) = owner();
        let op = uid();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        arm_injected_post_switch_failure();
        let error = apply_backup_restore(&cfg, &op, &dto.backup_id, permit).unwrap_err();

        assert_eq!(error.code(), "ROLLED_BACK");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);

        // The previous database is authoritative again, byte-for-byte.
        assert_eq!(live_sha(&data_root), original_sha);
        assert_eq!(rows_of(&live_path(&data_root)), vec!["live-1", "live-2"]);

        // The failed database is preserved as evidence, never destroyed.
        let op_dir = op_dir_of(&data_root, &op);
        let rejected = op_dir.join(REJECTED_DB_FILENAME);
        assert!(rejected.is_file(), "the rejected database must be kept");
        assert_eq!(rows_of(&rejected), vec!["bak-1", "bak-2"]);
        assert_eq!(phase_of(&op_dir), Some(RestoreJournalPhase::RolledBack));
    }

    // ============================================================
    // reconcile
    // ============================================================

    #[test]
    fn reconcile_proves_committed_from_the_restored_bytes() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        let target_sha = sha256_file_hex(&bundle_db_of(&data_root, &dto)).unwrap();

        let (state, owner_id) = owner();
        let op = uid();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        apply_backup_restore(&cfg, &op, &dto.backup_id, permit).expect("restore");

        // A fresh owner permit (the same barrier, one more owned operation).
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = reconcile_backup_restore(&cfg, &op, &dto.backup_id, permit).unwrap();

        assert_eq!(result.outcome, BackupRestoreReconcileOutcome::Committed);
        assert_eq!(
            result.restored_checksum_sha256.as_deref(),
            Some(target_sha.as_str())
        );
    }

    #[test]
    fn reconcile_reports_not_committed_when_the_original_is_still_live() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        // No journal, no switch: the live database is a valid database that is
        // simply not the target.
        let result = reconcile_backup_restore(&cfg, &uid(), &dto.backup_id, permit).unwrap();
        assert_eq!(result.outcome, BackupRestoreReconcileOutcome::NotCommitted);
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_live_database_is_gone() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        fs::remove_file(live_path(&data_root)).unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = reconcile_backup_restore(&cfg, &uid(), &dto.backup_id, permit).unwrap();

        assert_eq!(result.outcome, BackupRestoreReconcileOutcome::Indeterminate);
        assert_eq!(result.reason_code, Some(RestoreReconcileReason::LiveMissing));
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_journal_contradicts_the_bytes() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);

        // A journal that claims COMMITTED while the live bytes are provably NOT
        // the target's: self-contradictory, so it must never be believed.
        let op = uid();
        let op_dir = op_dir_of(&data_root, &op);
        fs::create_dir_all(&op_dir).unwrap();
        write_journal(
            &op_dir,
            &RestoreOperationJournal {
                operation_id: op.clone(),
                backup_id: dto.backup_id.clone(),
                expected_target_sha256: sha256_file_hex(&bundle_db_of(&data_root, &dto)).unwrap(),
                original_live_sha256: live_sha(&data_root),
                safety_backup_id: uid(),
                phase: RestoreJournalPhase::Committed,
                created_at_ms: 0,
                updated_at_ms: 0,
            },
        )
        .unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = reconcile_backup_restore(&cfg, &op, &dto.backup_id, permit).unwrap();

        assert_eq!(result.outcome, BackupRestoreReconcileOutcome::Indeterminate);
        assert_eq!(
            result.reason_code,
            Some(RestoreReconcileReason::JournalContradictory)
        );
    }

    #[test]
    fn reconcile_reports_rolled_back_when_the_original_is_live_after_a_switch() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);
        let live_digest = live_sha(&data_root);

        let op = uid();
        let op_dir = op_dir_of(&data_root, &op);
        fs::create_dir_all(&op_dir).unwrap();
        write_journal(
            &op_dir,
            &RestoreOperationJournal {
                operation_id: op.clone(),
                backup_id: dto.backup_id.clone(),
                expected_target_sha256: sha256_file_hex(&bundle_db_of(&data_root, &dto)).unwrap(),
                original_live_sha256: live_digest,
                safety_backup_id: uid(),
                phase: RestoreJournalPhase::Switched,
                created_at_ms: 0,
                updated_at_ms: 0,
            },
        )
        .unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = reconcile_backup_restore(&cfg, &op, &dto.backup_id, permit).unwrap();

        assert_eq!(result.outcome, BackupRestoreReconcileOutcome::RolledBack);
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_bundle_can_no_longer_be_read() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);

        // The selected bundle is destroyed, and there is no journal: nothing can
        // pin down the expected target, so the answer is INDETERMINATE.
        let dir = bundle_dir_of(&data_root, &dto);
        fs::remove_dir_all(&dir).unwrap();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let result = reconcile_backup_restore(&cfg, &uid(), &dto.backup_id, permit).unwrap();

        assert_eq!(result.outcome, BackupRestoreReconcileOutcome::Indeterminate);
        assert_eq!(
            result.reason_code,
            Some(RestoreReconcileReason::ExpectedTargetUnknown)
        );
    }

    // ============================================================
    // the durable journal
    // ============================================================

    #[test]
    fn the_journal_is_portable_and_carries_no_secret() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);
        seed_live(&data_root, &["live-1"]);

        let (state, owner_id) = owner();
        let op = uid();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        apply_backup_restore(&cfg, &op, &dto.backup_id, permit).expect("restore");

        let raw = fs::read_to_string(op_dir_of(&data_root, &op).join(OPERATION_JOURNAL_FILENAME))
            .unwrap();
        let data_root_text = data_root.to_string_lossy().into_owned();
        assert!(
            !raw.contains(&data_root_text),
            "the journal must never record an absolute data-root path"
        );
        assert!(
            !raw.contains(&owner_id),
            "the journal must never record the native owner token"
        );
        assert!(!raw.contains("native-maint-"), "no platform token may leak");

        let parsed: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert!(is_sha256_hex(parsed["expected_target_sha256"].as_str().unwrap()));
        assert!(is_sha256_hex(parsed["original_live_sha256"].as_str().unwrap()));
    }

    #[test]
    fn an_absent_journal_is_distinguishable_from_an_unreadable_one() {
        let tmp = tempdir().unwrap();
        let op_dir = tmp.path().join("op");
        assert!(matches!(read_journal(&op_dir), JournalRead::Absent));

        // A file that exists but is not a valid journal is NOT "absent": the
        // journal is written BEFORE the switch, so that distinction matters.
        fs::create_dir_all(&op_dir).unwrap();
        fs::write(journal_path(&op_dir), b"{ not json").unwrap();
        assert!(matches!(read_journal(&op_dir), JournalRead::Unreadable));

        fs::write(journal_path(&op_dir), b"[]").unwrap();
        assert!(matches!(read_journal(&op_dir), JournalRead::Unreadable));
    }

    // ============================================================
    // Startup recovery gate (P6-S8R)
    // ============================================================

    /// A self-consistent crash sandbox: a healthy Data Root plus byte-exact
    /// copies of the two databases a restore can leave at the live path.
    ///
    /// The two copies are taken from REAL seeds (never synthesised), so no test
    /// depends on SQLite producing identical bytes twice.
    struct CrashFixture {
        tmp: tempfile::TempDir,
        data_root: PathBuf,
        /// Exact pre-switch live bytes (what `rollback.db` must equal).
        original_bytes: PathBuf,
        original_sha: String,
        /// Exact installed-target bytes.
        target_bytes: PathBuf,
        target_sha: String,
    }

    fn crash_fixture() -> CrashFixture {
        let tmp = tempdir().unwrap();
        let (_cfg, data_root) = make_root(tmp.path());

        let original_sha = seed_live_sha(&data_root, &["original-row"]);
        let original_bytes = tmp.path().join("original.db");
        fs::copy(live_path(&data_root), &original_bytes).unwrap();

        let target_sha = seed_live_sha(&data_root, &["target-row"]);
        let target_bytes = tmp.path().join("target.db");
        fs::copy(live_path(&data_root), &target_bytes).unwrap();

        CrashFixture {
            tmp,
            data_root,
            original_bytes,
            original_sha,
            target_bytes,
            target_sha,
        }
    }

    /// Place exactly `bytes` at the live path, with no sidecars beside it.
    fn put_live(fixture: &CrashFixture, bytes: &Path) {
        let live = live_path(&fixture.data_root);
        for suffix in SIDECAR_SUFFIXES {
            let _ = fs::remove_file(sidecar_path(&live, suffix));
        }
        fs::copy(bytes, &live).unwrap();
    }

    fn recover(data_root: &Path) -> Result<RestoreRecoveryOutcome, RestoreRecoveryBlocker> {
        recover_or_classify_pending_operations(data_root, &manifest_of(data_root))
    }

    /// §16 — a crash AFTER the switch: the target's bytes are live and the
    /// atomic replace left the previous database as the rollback candidate.
    #[test]
    fn startup_proves_committed_after_a_crash_following_the_switch() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);
        let operation_id = uid();
        let dir = write_pending_journal(
            data_root,
            &operation_id,
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Switched,
        );
        fs::copy(&fixture.original_bytes, dir.join(ROLLBACK_DB_FILENAME)).unwrap();

        let outcome = recover(data_root).expect("a proven commit must not block startup");

        assert_eq!(
            outcome,
            RestoreRecoveryOutcome::Reconciled {
                operation_id,
                phase: RestoreJournalPhase::Committed,
            }
        );
        assert_eq!(phase_of(&dir), Some(RestoreJournalPhase::Committed));
        // The gate is read-only: the restored database is byte-identical.
        assert_eq!(live_sha(data_root), fixture.target_sha);
    }

    /// §17 — a crash BEFORE the switch: the original database is still live.
    #[test]
    fn startup_proves_not_committed_after_a_crash_before_the_switch() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.original_bytes);
        let operation_id = uid();
        let dir = write_pending_journal(
            data_root,
            &operation_id,
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Prepared,
        );

        let outcome = recover(data_root).expect("the original is provably live");

        assert_eq!(
            outcome,
            RestoreRecoveryOutcome::Reconciled {
                operation_id,
                phase: RestoreJournalPhase::NotCommitted,
            }
        );
        assert_eq!(phase_of(&dir), Some(RestoreJournalPhase::NotCommitted));
        assert_eq!(live_sha(data_root), fixture.original_sha);
    }

    /// A journal that reached SWITCHED while the ORIGINAL is live means the
    /// switch was undone: the accurate terminal phase is ROLLED_BACK.
    #[test]
    fn startup_reports_rolled_back_when_a_switched_operation_was_undone() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.original_bytes);
        let operation_id = uid();
        let dir = write_pending_journal(
            data_root,
            &operation_id,
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Switched,
        );

        let outcome = recover(data_root).expect("the original is provably live");
        assert_eq!(
            outcome,
            RestoreRecoveryOutcome::Reconciled {
                operation_id,
                phase: RestoreJournalPhase::RolledBack,
            }
        );
        assert_eq!(phase_of(&dir), Some(RestoreJournalPhase::RolledBack));
    }

    /// §18 — a BLOCKED journal must never override disk truth: the target's
    /// exact bytes are live, so the operation COMMITTED.
    #[test]
    fn startup_disk_truth_outranks_a_blocked_journal() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);
        let operation_id = uid();
        let dir = write_pending_journal(
            data_root,
            &operation_id,
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Blocked,
        );
        fs::copy(&fixture.original_bytes, dir.join(ROLLBACK_DB_FILENAME)).unwrap();

        let outcome = recover(data_root).expect("disk truth must prove the commit");
        assert_eq!(
            outcome,
            RestoreRecoveryOutcome::Reconciled {
                operation_id,
                phase: RestoreJournalPhase::Committed,
            }
        );
        assert_eq!(phase_of(&dir), Some(RestoreJournalPhase::Committed));
    }

    /// §19 — the live database is valid and current, but it is neither the
    /// target nor the original: nothing can be proven, so startup must stop.
    #[test]
    fn startup_is_indeterminate_when_the_live_database_is_a_third_database() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        let third = fixture.tmp.path().join("third.db");
        let third_sha = write_current_db_at(&third, &["third-row"]);
        assert_ne!(third_sha, fixture.target_sha);
        assert_ne!(third_sha, fixture.original_sha);
        put_live(&fixture, &third);
        write_pending_journal(
            data_root,
            &uid(),
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Prepared,
        );

        let error = recover(data_root).unwrap_err();
        assert_eq!(
            error.code,
            RestoreRecoveryBlockerCode::LiveUnknownDatabase
        );
        assert_eq!(error.code.kind(), "RESTORE_RECOVERY_REQUIRED");
    }

    /// §20 — a journal that exists but cannot be read FAILS CLOSED, and so does
    /// an operation directory with no journal at all.
    #[test]
    fn startup_fails_closed_on_a_malformed_or_missing_journal() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);

        let malformed = op_dir_of(data_root, &uid());
        fs::create_dir_all(&malformed).unwrap();
        fs::write(journal_path(&malformed), b"{ not json").unwrap();
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::JournalMalformed);

        // No journal at all: the journal is written BEFORE the switch, so an
        // operation directory without one is an incomplete record, never
        // "nothing happened".
        fs::remove_file(journal_path(&malformed)).unwrap();
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::JournalMalformed);
        assert_eq!(error.code.kind(), "RESTORE_RECOVERY_JOURNAL_MALFORMED");
    }

    /// §21 — more than one pending operation is never resolved by picking one.
    #[test]
    fn startup_fails_closed_on_multiple_pending_operations() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);
        write_pending_journal(
            data_root,
            &uid(),
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Prepared,
        );
        write_pending_journal(
            data_root,
            &uid(),
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Switched,
        );

        let error = recover(data_root).unwrap_err();
        assert_eq!(
            error.code,
            RestoreRecoveryBlockerCode::MultiplePendingOperations
        );
        assert_eq!(error.code.kind(), "RESTORE_RECOVERY_MULTIPLE_PENDING");
        // Neither journal was touched: no winner was chosen.
        for entry in fs::read_dir(data_root.join("metadata").join(RESTORE_DIR_NAME)).unwrap() {
            let dir = entry.unwrap().path();
            assert!(!matches!(
                phase_of(&dir),
                Some(RestoreJournalPhase::Committed) | Some(RestoreJournalPhase::NotCommitted)
            ));
        }
    }

    /// §22 — only TERMINAL history: startup continues and nothing is deleted or
    /// rewritten.
    #[test]
    fn startup_ignores_terminal_history_and_never_deletes_it() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);
        let dirs: Vec<PathBuf> = [
            RestoreJournalPhase::Committed,
            RestoreJournalPhase::RolledBack,
            RestoreJournalPhase::NotCommitted,
        ]
        .into_iter()
        .map(|phase| {
            write_pending_journal(
                data_root,
                &uid(),
                &fixture.target_sha,
                &fixture.original_sha,
                phase,
            )
        })
        .collect();
        let before: Vec<Vec<u8>> = dirs
            .iter()
            .map(|dir| fs::read(journal_path(dir)).unwrap())
            .collect();

        let outcome = recover(data_root).expect("terminal history never blocks startup");

        assert_eq!(outcome, RestoreRecoveryOutcome::Clear);
        for (dir, bytes) in dirs.iter().zip(before.iter()) {
            assert_eq!(
                &fs::read(journal_path(dir)).unwrap(),
                bytes,
                "terminal history must never be rewritten or deleted"
            );
        }
    }

    /// A clean Data Root has no restore tree at all: the gate is a no-op and
    /// leaves the live database byte-identical.
    #[test]
    fn startup_is_a_no_op_without_a_restore_tree() {
        let tmp = tempdir().unwrap();
        let (_cfg, data_root) = make_root(tmp.path());
        seed_live(&data_root, &["live-row"]);
        let before = live_sha(&data_root);

        assert_eq!(recover(&data_root).unwrap(), RestoreRecoveryOutcome::Clear);
        assert_eq!(live_sha(&data_root), before);
    }

    /// A valid database that is neither proven identity, a missing live
    /// database and a schema mismatch all FAIL CLOSED — and the missing case
    /// must never fabricate an empty database.
    #[test]
    fn startup_fails_closed_when_the_live_database_cannot_be_proven() {
        // (a) missing live database.
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        let live = live_path(data_root);
        for suffix in SIDECAR_SUFFIXES {
            let _ = fs::remove_file(sidecar_path(&live, suffix));
        }
        fs::remove_file(&live).unwrap();
        write_pending_journal(
            data_root,
            &uid(),
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Prepared,
        );
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::LiveUnprovable);
        assert_eq!(error.code.kind(), "RESTORE_RECOVERY_LIVE_MISSING");
        assert!(
            !live.exists(),
            "startup recovery must never create an empty live database"
        );

        // (b) schema mismatch: intact, but not the current schema.
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.original_bytes);
        write_pending_journal(
            data_root,
            &uid(),
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Prepared,
        );
        {
            let conn = Connection::open(live_path(data_root)).unwrap();
            conn.execute_batch("UPDATE schema_migrations SET version = version + 1;")
                .unwrap();
        }
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::LiveSchemaMismatch);
        assert_eq!(error.code.kind(), "RESTORE_RECOVERY_LIVE_SCHEMA_MISMATCH");
    }

    /// A journal that cannot carry the required checksums, and a rollback
    /// candidate that contradicts the recorded original, both FAIL CLOSED.
    #[test]
    fn startup_fails_closed_on_incomplete_or_contradictory_evidence() {
        // (a) the journal does not record a usable target checksum.
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.original_bytes);
        write_pending_journal(
            data_root,
            &uid(),
            "not-a-sha256",
            &fixture.original_sha,
            RestoreJournalPhase::Prepared,
        );
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::JournalIncomplete);

        // (b) rollback.db exists but is NOT the recorded original.
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);
        let dir = write_pending_journal(
            data_root,
            &uid(),
            &fixture.target_sha,
            &fixture.original_sha,
            RestoreJournalPhase::Switched,
        );
        fs::copy(&fixture.target_bytes, dir.join(ROLLBACK_DB_FILENAME)).unwrap();
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::EvidenceContradictory);
        assert_eq!(
            error.code.kind(),
            "RESTORE_RECOVERY_EVIDENCE_CONTRADICTORY"
        );
    }

    /// Anything under `metadata/restore/` that is not a plain, uniquely named
    /// operation directory FAILS CLOSED.
    #[test]
    fn startup_fails_closed_on_a_malformed_restore_tree() {
        let fixture = crash_fixture();
        let data_root = &fixture.data_root;
        put_live(&fixture, &fixture.target_bytes);
        let restore_root = data_root.join("metadata").join(RESTORE_DIR_NAME);
        fs::create_dir_all(&restore_root).unwrap();

        // A stray FILE where only operation directories may live.
        fs::write(restore_root.join("stray.txt"), b"x").unwrap();
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::RestoreRootMalformed);
        fs::remove_file(restore_root.join("stray.txt")).unwrap();

        // A directory whose name is not a canonical operation id.
        fs::create_dir_all(restore_root.join("not-an-operation-id")).unwrap();
        let error = recover(data_root).unwrap_err();
        assert_eq!(error.code, RestoreRecoveryBlockerCode::RestoreRootMalformed);
    }

    /// Every blocker token is machine-readable and carries the frozen
    /// `RESTORE_RECOVERY_` prefix, so a future UI can identify the class.
    #[test]
    fn every_recovery_blocker_kind_is_prefixed_and_machine_readable() {
        use RestoreRecoveryBlockerCode as Code;
        for code in [
            Code::RestoreRootUnreadable,
            Code::RestoreRootMalformed,
            Code::MultiplePendingOperations,
            Code::JournalMalformed,
            Code::JournalIncomplete,
            Code::LiveUnprovable,
            Code::LiveIntegrityFailed,
            Code::LiveSchemaMismatch,
            Code::LiveUnknownDatabase,
            Code::EvidenceContradictory,
        ] {
            assert!(
                code.kind().starts_with("RESTORE_RECOVERY_"),
                "unprefixed recovery token: {}",
                code.kind()
            );
        }
        assert_eq!(
            Code::LiveUnknownDatabase.kind(),
            "RESTORE_RECOVERY_REQUIRED"
        );
    }

    /// §3 — a Safety Backup that fails must precede EVERY destructive step: no
    /// checkpoint, no sidecar relocation and no switch, and the failure must be
    /// RECOVERABLE so the workflow may release maintenance.
    #[test]
    fn a_failed_safety_backup_precedes_every_destructive_step() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_bundle(&cfg, &data_root, &["bak-1"]);

        // The selected bundle still verifies (step 1), but the live path does not
        // hold a readable SQLite database, so the Safety Backup (step 3) fails.
        // Had the checkpoint (step 6) run first it would have reported
        // CHECKPOINT_FAILED instead — the code itself therefore proves which step
        // was reached.
        let live = live_path(&data_root);
        fs::write(&live, b"not a database").unwrap();
        let live_bytes_before = fs::read(&live).unwrap();

        let operation_id = uid();
        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).unwrap();
        let error = apply_backup_restore(&cfg, &operation_id, &dto.backup_id, permit).unwrap_err();

        assert_eq!(error.code(), "SAFETY_BACKUP_FAILED");
        assert_eq!(error.disposition(), RestoreErrorDisposition::Recoverable);
        // NO switch: the live path still holds exactly the same bytes.
        assert_eq!(fs::read(&live).unwrap(), live_bytes_before);

        let op_dir = op_dir_of(&data_root, &operation_id);
        // NO sidecar relocation: quarantine can only move sidecars INTO the
        // operation directory, and it holds no quarantine at all.
        assert!(!op_dir.join(SIDECARS_DIR_NAME).exists());
        // NO staging and NO journal: the replacement copy (step 4) and the
        // durable record (step 9) both come after the Safety Backup.
        assert!(!op_dir.join(REPLACEMENT_DB_FILENAME).exists());
        assert!(!op_dir.join(ROLLBACK_DB_FILENAME).exists());
        assert!(matches!(read_journal(&op_dir), JournalRead::Absent));
    }
}
