//! Native Simple Data Root Migration V1 (P6-S9).
//!
//! Moves an ENTIRE Simple Data Root to a new physical location without ever
//! exposing a half-migrated state:
//!
//! ```text
//! Strong Maintenance
//!   → Safety Backup of the current database
//!   → enumerate the source tree (AFTER the safety backup exists)
//!   → durable copy manifest
//!   → build + fully verify a sibling staging directory
//!   → ONE atomic directory publish  (staging → targetDataRoot)
//!   → ONE atomic bootstrap re-point (old root → new root)
//!   → post-switch read-only re-validation
//!   → journal COMMITTED
//! ```
//!
//! It is deliberately NOT "copy the folder and change a path string": the
//! source stays authoritative until the bootstrap switch succeeds, the switch
//! itself is one OS atomic replace, and every unprovable outcome fails closed.
//!
//! # Scope (V1, frozen)
//!
//! - Platform: **Native Windows only**. Every other platform fails closed with
//!   `UNSUPPORTED_PLATFORM` BEFORE touching anything (§77).
//! - Layout: **Simple Data Root only** (`manifest.json` + the five fixed
//!   subdirectories). Split storage is not modeled, let alone implemented.
//! - The whole root moves. This is not "move `database/zhixing.db`".
//!
//! # Hard rules (frozen)
//!
//! - **The old Data Root is NEVER deleted, moved or renamed** (§10, §66). A
//!   successful migration leaves it complete, apart from the Migration Safety
//!   Backup that was legitimately added to `oldRoot/backup/`.
//! - **The live database is never `fs::copy`-ed** (§23). The target database is
//!   the Safety Backup's database — a WAL-safe, verified, static, single-file
//!   snapshot produced by the shared SQLite Online Backup primitive.
//! - **No `DataRootService::initialize` / FirstBoot impersonation** (§26). The
//!   target is built by this module's own builder.
//! - **The target must not exist** (§4): it can only be published by renaming an
//!   operation-owned sibling staging directory onto it.
//! - Nothing here is ever guessed. An unprovable bootstrap / target / source is
//!   `INDETERMINATE` (barrier held) at runtime and `Degraded` at startup.
//!
//! # Where the journal lives, and why
//!
//! Unlike Restore, this operation switches the Data Root itself, so a journal
//! under `metadata/` would be ambiguous — it would move with the root it is
//! describing. The journal therefore lives in the **app config directory**
//! (`bootstrap.json`'s own directory), which stays reachable no matter which
//! root the bootstrap currently points at, and which is what makes the
//! process-crash startup gate possible (§14, §15).

use std::collections::BTreeSet;
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use tauri::Manager;
use thiserror::Error;
use uuid::Uuid;

use crate::backup::{
    build_and_publish_backup_bundle, current_schema_version, resolve_existing_data_root,
    BackupResultDto,
};
use crate::bootstrap::service::{rewrite_data_root_atomically, BootstrapRewriteError};
use crate::bootstrap::{BootstrapService, BootstrapState};
use crate::db::checksum::sha256_file_hex;
use crate::maintenance::{
    MaintenanceOwnedPermit, NativeMaintenanceErrorDto, NativeMaintenanceState,
};
use crate::platform_atomic_file::{available_space_bytes, write_file_atomic, write_file_durable};
use crate::storage::manifest::DB_RELATIVE_PATH;
use crate::storage::{DataRootService, InitMode, FIXED_SUBDIRS, MANIFEST_FILENAME};

// ============================================================
// Layout constants
// ============================================================

/// Runtime-created directory under the app config root (NOT under any Data
/// Root — see the module docs).
const MIGRATION_DIR_NAME: &str = "data-root-migration";
/// Durable operation journal.
const OPERATION_JOURNAL_FILENAME: &str = "operation.json";
/// The operation-level copy manifest. It is NOT a Backup Manifest and NOT a
/// Data Root Manifest (§28, §74).
const COPY_MANIFEST_FILENAME: &str = "copy-manifest.json";
/// Byte snapshot of `bootstrap.json` taken BEFORE the switch (§39).
const BOOTSTRAP_BEFORE_FILENAME: &str = "bootstrap.before.json";
/// Operation-owned staging directory name prefix, created as a SIBLING of the
/// final target so the publish rename stays on one volume (§25).
const STAGING_PREFIX: &str = ".zhixing-migration-";
/// The `database/` subdirectory of a Simple Data Root.
const DATABASE_DIR_NAME: &str = "database";
/// The only database entry names a Simple Data Root may contain (§8).
const ALLOWED_DATABASE_ENTRIES: [&str; 4] = [
    "zhixing.db",
    "zhixing.db-wal",
    "zhixing.db-shm",
    "zhixing.db-journal",
];
/// `FILE_ATTRIBUTE_REPARSE_POINT`. Any entry carrying it is refused (§6): a
/// symlink, a junction and every other reparse redirection would let a copy
/// escape the Data Root.
const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
/// Fixed, small upper bound on OS atomic-replace attempts is owned by
/// [`crate::platform_atomic_file`].

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ============================================================
// Error model
// ============================================================

/// Whether releasing the strong barrier after this failure is provable.
///
/// - `RECOVERABLE`: the authoritative Data Root is PROVEN to be either the
///   unchanged source or the fully verified target. Releasing is safe.
/// - `BLOCKED`: which root is authoritative cannot be proven. The barrier must
///   stay active until a reconcile proves otherwise.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationDisposition {
    Recoverable,
    Blocked,
}

impl MigrationDisposition {
    fn as_str(self) -> &'static str {
        match self {
            MigrationDisposition::Recoverable => "RECOVERABLE",
            MigrationDisposition::Blocked => "BLOCKED",
        }
    }
}

/// Structured migration failure. The `String` detail is Rust-side diagnosis
/// only and never crosses the boundary.
#[derive(Debug, Error)]
pub(crate) enum DataRootMigrationError {
    /// Pre-mutation: the authoritative bootstrap / source Data Root could not
    /// be resolved. Nothing was created or written.
    #[error("data root migration unavailable: {0}")]
    Unavailable(String),
    /// The request itself is unusable (bad operation id / non-absolute target).
    #[error("data root migration request invalid: {0}")]
    RequestInvalid(String),
    /// The target request is unsafe or unusable: not absolute, a network
    /// location, a missing parent, an already-existing target, or a path that
    /// aliases / contains the source.
    #[error("data root migration target invalid: {0}")]
    TargetInvalid(String),
    /// The source tree is not a Simple Data Root this build can migrate: an
    /// unknown top-level entry, a missing fixed subdirectory, an unexpected
    /// file inside `database/`, or a reparse point anywhere in the tree.
    #[error("unsupported source layout: {0}")]
    UnsupportedSourceLayout(String),
    /// The target volume has fewer free bytes than the operation needs. Copied
    /// nothing.
    #[error("insufficient space on the target volume: {0}")]
    InsufficientSpace(String),
    /// The Safety Backup of the CURRENT database could not be produced. Nothing
    /// was staged, published or switched.
    #[error("migration safety backup failed: {0}")]
    SafetyBackupFailed(String),
    /// Staging the target failed (copy / create / durability).
    #[error("target staging failed: {0}")]
    CopyFailed(String),
    /// The staged target did not match the copy manifest.
    #[error("target verification failed: {0}")]
    VerifyFailed(String),
    /// The atomic directory publish failed. The bootstrap still points at the
    /// source and the source is untouched.
    #[error("target publish failed: {0}")]
    TargetPublishFailed(String),
    /// The bootstrap could not be atomically re-pointed. The target is retained
    /// and the source remains authoritative.
    #[error("bootstrap switch failed: {0}")]
    BootstrapSwitchFailed(String),
    /// The bootstrap changed underneath this operation, so it must NOT be
    /// overwritten. Which root is authoritative is no longer provable by us.
    #[error("bootstrap changed during the migration: {0}")]
    BootstrapChanged(String),
    /// The switch was applied and then undone; the source was re-verified.
    #[error("migration rolled back: {0}")]
    RolledBack(String),
    /// The authoritative root cannot be proven (including a rollback that
    /// could not be proven).
    #[error("migration outcome indeterminate: {0}")]
    SwitchIndeterminate(String),
    /// This build has no migration implementation on this platform.
    #[error("data root migration is unsupported on this platform")]
    UnsupportedPlatform,
    /// An internal invariant was violated after the point of no return.
    #[error("data root migration internal failure: {0}")]
    Internal(String),
}

impl DataRootMigrationError {
    /// Coarse, UI-safe machine code (§109).
    pub(crate) fn code(&self) -> &'static str {
        match self {
            DataRootMigrationError::Unavailable(_) => "UNAVAILABLE",
            DataRootMigrationError::RequestInvalid(_) => "REQUEST_INVALID",
            DataRootMigrationError::TargetInvalid(_) => "TARGET_INVALID",
            DataRootMigrationError::UnsupportedSourceLayout(_) => "UNSUPPORTED_SOURCE_LAYOUT",
            DataRootMigrationError::InsufficientSpace(_) => "INSUFFICIENT_SPACE",
            DataRootMigrationError::SafetyBackupFailed(_) => "SAFETY_BACKUP_FAILED",
            DataRootMigrationError::CopyFailed(_) => "COPY_FAILED",
            DataRootMigrationError::VerifyFailed(_) => "VERIFY_FAILED",
            DataRootMigrationError::TargetPublishFailed(_) => "TARGET_PUBLISH_FAILED",
            DataRootMigrationError::BootstrapSwitchFailed(_) => "BOOTSTRAP_SWITCH_FAILED",
            DataRootMigrationError::BootstrapChanged(_) => "BOOTSTRAP_CHANGED",
            DataRootMigrationError::RolledBack(_) => "ROLLED_BACK",
            DataRootMigrationError::SwitchIndeterminate(_) => "SWITCH_INDETERMINATE",
            DataRootMigrationError::UnsupportedPlatform => "UNSUPPORTED_PLATFORM",
            DataRootMigrationError::Internal(_) => "INTERNAL",
        }
    }

    /// Assigned variant by variant — never inferred, never defaulted to
    /// RECOVERABLE.
    pub(crate) fn disposition(&self) -> MigrationDisposition {
        match self {
            // The bootstrap moved under us: which root is authoritative is
            // exactly what we can no longer prove (§38, §47).
            DataRootMigrationError::BootstrapChanged(_)
            | DataRootMigrationError::SwitchIndeterminate(_)
            | DataRootMigrationError::Internal(_) => MigrationDisposition::Blocked,
            _ => MigrationDisposition::Recoverable,
        }
    }

    /// UI-safe text. No OS error, no SQLite text, no path, no token on any
    /// path that does not already carry user-chosen input (§110).
    pub(crate) fn safe_message(&self) -> &'static str {
        match self {
            DataRootMigrationError::Unavailable(_) => "Data root migration is currently unavailable.",
            DataRootMigrationError::RequestInvalid(_) => "The migration request was invalid.",
            DataRootMigrationError::TargetInvalid(_) => "The target location is not usable.",
            DataRootMigrationError::UnsupportedSourceLayout(_) => {
                "The current data folder has an unsupported layout, so nothing was moved."
            }
            DataRootMigrationError::InsufficientSpace(_) => {
                "There is not enough free space at the target location."
            }
            DataRootMigrationError::SafetyBackupFailed(_) => {
                "The current data could not be backed up, so nothing was moved."
            }
            DataRootMigrationError::CopyFailed(_) => {
                "The data could not be copied; the current location is unchanged."
            }
            DataRootMigrationError::VerifyFailed(_) => {
                "The copied data failed verification, so nothing was moved."
            }
            DataRootMigrationError::TargetPublishFailed(_) => {
                "The new data folder could not be created; the current location is unchanged."
            }
            DataRootMigrationError::BootstrapSwitchFailed(_) => {
                "The app could not be pointed at the new location; the current location is unchanged."
            }
            DataRootMigrationError::BootstrapChanged(_) => {
                "The stored data location changed during the migration, so the outcome could not be confirmed."
            }
            DataRootMigrationError::RolledBack(_) => {
                "The migration failed and the previous location was restored."
            }
            DataRootMigrationError::SwitchIndeterminate(_) => {
                "The migration outcome could not be confirmed."
            }
            DataRootMigrationError::UnsupportedPlatform => {
                "Data root migration is not supported on this platform."
            }
            DataRootMigrationError::Internal(_) => "The migration could not be completed.",
        }
    }
}

/// Transport error DTO. `disposition` is what lets the workflow decide whether
/// releasing the strong barrier is provable.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationCommandErrorDto {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
    pub(crate) disposition: &'static str,
}

impl From<DataRootMigrationError> for MigrationCommandErrorDto {
    fn from(error: DataRootMigrationError) -> Self {
        tracing::warn!(
            target: "zhixing::data_root_migration",
            error = %error,
            code = error.code(),
            disposition = error.disposition().as_str(),
            "native data root migration failure"
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

/// Journal phases (§18). The journal is a HINT for reconciliation, never the
/// authority: reconcile always measures bootstrap + target + source on disk.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum MigrationJournalPhase {
    /// Written immediately after the operation directory is created.
    Preparing,
    /// The current-database Safety Backup was published and verified.
    SafetyBackupCreated,
    /// The target staging directory is complete and verified.
    TargetStaged,
    /// The staging directory was atomically published as the target root.
    TargetPublished,
    /// `bootstrap.json` now points at the target.
    BootstrapSwitched,
    /// Proven complete.
    Committed,
    /// The operation provably never became authoritative.
    NotCommitted,
    /// The switch was applied and then undone.
    RolledBack,
    /// The outcome could not be proven.
    Blocked,
}

impl MigrationJournalPhase {
    /// A TERMINAL phase states that the operation is finished and its outcome
    /// is known: the startup gate ignores it (and never deletes it).
    fn is_terminal(self) -> bool {
        matches!(self, Self::Committed | Self::NotCommitted | Self::RolledBack)
    }

    /// Whether the operation ever reached the bootstrap switch. This is what
    /// distinguishes `NOT_COMMITTED` from `ROLLED_BACK` when the source is
    /// proven authoritative again (§63, §51, §52).
    fn reached_bootstrap_switch(self) -> bool {
        matches!(self, Self::BootstrapSwitched | Self::Committed)
    }
}

/// The durable record of one migration operation.
///
/// It deliberately carries NO maintenance owner token, NO trust credential and
/// NO pairing secret (§16). It DOES carry the absolute source and target roots:
/// this is an explicitly device-local migration journal, not a portable backup
/// manifest, and both roots are the only way a later reconcile or a process
/// restart can tell which one is authoritative.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct MigrationOperationJournal {
    pub(crate) operation_id: String,
    pub(crate) source_data_root: PathBuf,
    pub(crate) target_data_root: PathBuf,
    /// The Safety Backup bundle this operation created (for diagnosis / a
    /// future UI). Empty until the safety backup exists.
    pub(crate) safety_backup_id: String,
    pub(crate) phase: MigrationJournalPhase,
    pub(crate) created_at_ms: i64,
    pub(crate) updated_at_ms: i64,
}

/// How a journal read went. "Existent but unreadable" must never be confused
/// with "absent": the absence of a journal in an operation directory is itself
/// evidence that the record is incomplete.
enum JournalRead {
    Absent,
    Present(Box<MigrationOperationJournal>),
    Unreadable,
}

/// The operation-level copy manifest (§28). Deliberately a THIRD manifest kind:
/// it is neither a Backup Manifest nor a Data Root Manifest, and the Backup
/// Format V1 is untouched.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct CopyManifest {
    pub(crate) manifest_kind: String,
    pub(crate) operation_id: String,
    pub(crate) source_data_root: PathBuf,
    pub(crate) target_data_root: PathBuf,
    /// Total bytes the target needs: the sum of every entry exactly once. The
    /// database appears once (`database/zhixing.db`), so there is no double
    /// count even though its bytes also live inside the copied Safety Backup.
    pub(crate) required_bytes: u64,
    pub(crate) entries: Vec<CopyManifestEntry>,
}

/// One migrated regular file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct CopyManifestEntry {
    /// Portable, `/`-relative path from the root.
    pub(crate) relative_path: String,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
}

const COPY_MANIFEST_KIND: &str = "data_root_migration_copy";

fn migration_root(app_config_dir: &Path) -> PathBuf {
    app_config_dir.join(MIGRATION_DIR_NAME)
}

fn operation_dir(app_config_dir: &Path, operation_id: &str) -> PathBuf {
    migration_root(app_config_dir).join(operation_id)
}

fn journal_path(op_dir: &Path) -> PathBuf {
    op_dir.join(OPERATION_JOURNAL_FILENAME)
}

fn copy_manifest_path(op_dir: &Path) -> PathBuf {
    op_dir.join(COPY_MANIFEST_FILENAME)
}

/// Write `operation.json` atomically: `.part` → write → `sync_all` → rename.
/// Never a truncate of the live journal (§19).
fn write_journal(
    op_dir: &Path,
    journal: &MigrationOperationJournal,
) -> Result<(), DataRootMigrationError> {
    let json = serde_json::to_string_pretty(journal)
        .map_err(|e| DataRootMigrationError::Internal(format!("serialize journal: {e}")))?;
    let part = op_dir.join(format!("{OPERATION_JOURNAL_FILENAME}.part"));
    write_file_durable(&part, json.as_bytes())
        .map_err(|e| DataRootMigrationError::Internal(format!("write journal part: {e}")))?;
    fs::rename(&part, journal_path(op_dir))
        .map_err(|e| DataRootMigrationError::Internal(format!("rename journal: {e}")))
}

fn read_journal(op_dir: &Path) -> JournalRead {
    let path = journal_path(op_dir);
    match fs::symlink_metadata(&path) {
        Err(_) => JournalRead::Absent,
        Ok(meta) if !meta.is_file() || meta.file_type().is_symlink() => JournalRead::Unreadable,
        Ok(_) => match fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<MigrationOperationJournal>(&bytes).ok())
        {
            Some(journal) => JournalRead::Present(Box::new(journal)),
            None => JournalRead::Unreadable,
        },
    }
}

/// Write the copy manifest durably (it is written exactly once) (§19).
fn write_copy_manifest(op_dir: &Path, manifest: &CopyManifest) -> Result<(), DataRootMigrationError> {
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| DataRootMigrationError::Internal(format!("serialize copy manifest: {e}")))?;
    write_file_atomic(&copy_manifest_path(op_dir), json.as_bytes())
        .map_err(|e| DataRootMigrationError::Internal(format!("write copy manifest: {e}")))
}

fn read_copy_manifest(op_dir: &Path) -> Option<CopyManifest> {
    let path = copy_manifest_path(op_dir);
    let meta = fs::symlink_metadata(&path).ok()?;
    if !meta.is_file() || meta.file_type().is_symlink() {
        return None;
    }
    serde_json::from_slice::<CopyManifest>(&fs::read(&path).ok()?).ok()
}

/// Best-effort journal phase update. Losing it degrades diagnosis, never
/// safety: disk truth always outranks the journal.
fn record_phase(
    op_dir: &Path,
    journal: &mut MigrationOperationJournal,
    phase: MigrationJournalPhase,
) {
    journal.phase = phase;
    journal.updated_at_ms = now_ms();
    if let Err(e) = write_journal(op_dir, journal) {
        tracing::warn!(
            target: "zhixing::data_root_migration",
            error = %e,
            "migration journal phase update skipped"
        );
    }
}

// ============================================================
// Small filesystem helpers
// ============================================================

fn is_regular_file(path: &Path) -> bool {
    matches!(fs::symlink_metadata(path), Ok(meta) if meta.is_file() && !meta.file_type().is_symlink())
}

/// Whether `meta` denotes a Windows reparse point (symlink / junction / any
/// other redirection). Rust's `FileType::is_symlink` does NOT cover junctions,
/// which is exactly why the attribute is examined explicitly (§6).
fn is_reparse_point(meta: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return is_reparse_attribute(meta.file_attributes());
    }
    #[cfg(not(windows))]
    {
        let _ = meta;
        false
    }
}

/// The pure reparse decision: does this Windows attribute word carry
/// `FILE_ATTRIBUTE_REPARSE_POINT`?
///
/// Split out of [`is_reparse_point`] for exactly one reason — it can be proven
/// by a unit test that never touches the filesystem. Creating a REAL junction or
/// symlink needs privileges a CI machine may not hold (P6-S9R2/§11), while THIS
/// comparison is what actually keeps a byte inside the Data Root. The tree
/// scanner and the unit test therefore consult one and the same function, so a
/// test of the predicate is a test of the policy.
#[cfg(windows)]
fn is_reparse_attribute(file_attributes: u32) -> bool {
    file_attributes & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

/// A directory / regular file entry that is safe to walk.
enum SafeEntry {
    Dir,
    File,
}

/// Inspect one entry and refuse anything that is neither a plain directory nor
/// a plain regular file (§6, §9).
fn inspect_entry(path: &Path) -> Result<SafeEntry, DataRootMigrationError> {
    let meta = fs::symlink_metadata(path).map_err(|e| {
        DataRootMigrationError::Unavailable(format!("stat {}: {e}", path.display()))
    })?;
    if meta.file_type().is_symlink() || is_reparse_point(&meta) {
        return Err(DataRootMigrationError::UnsupportedSourceLayout(format!(
            "{} is a link or reparse point",
            path.display()
        )));
    }
    if meta.is_dir() {
        return Ok(SafeEntry::Dir);
    }
    if meta.is_file() {
        return Ok(SafeEntry::File);
    }
    Err(DataRootMigrationError::UnsupportedSourceLayout(
        format!("{} is neither a directory nor a regular file", path.display()),
    ))
}

/// A `/`-separated portable relative path.
fn portable_relative(parent: &str, name: &str) -> String {
    if parent.is_empty() {
        name.to_string()
    } else {
        format!("{parent}/{name}")
    }
}

fn dir_entries(dir: &Path) -> Result<Vec<(String, PathBuf)>, DataRootMigrationError> {
    let mut out = Vec::new();
    let entries = fs::read_dir(dir).map_err(|e| {
        DataRootMigrationError::Unavailable(format!("read dir {}: {e}", dir.display()))
    })?;
    for entry in entries {
        let entry = entry.map_err(|e| {
            DataRootMigrationError::Unavailable(format!("read dir {}: {e}", dir.display()))
        })?;
        out.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.path(),
        ));
    }
    out.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(out)
}

/// Streaming copy + `sync_all`. The destination must be a NEW file.
///
/// `io::copy` streams (a fixed internal buffer) — the file is never loaded into
/// memory (§31).
fn copy_file_synced(src: &Path, dst: &Path) -> io::Result<()> {
    let mut input = fs::File::open(src)?;
    let mut output = fs::File::create(dst)?;
    io::copy(&mut input, &mut output)?;
    output.sync_all()
}

/// Build a SQLite `file:` URI for `path` with every byte that is not plainly
/// unreserved percent-escaped.
///
/// `Connection::open_with_flags` hands the string to `sqlite3_open_v2` as UTF-8,
/// where a `?` or `#` in a user-chosen target folder would otherwise be read as
/// the start of the URI's query / fragment and silently address a DIFFERENT
/// file. `\` becomes `/` (the URI form of a Windows separator); the drive-letter
/// colon is kept.
fn to_file_uri(path: &Path) -> String {
    let mut uri = String::from("file:");
    for byte in path.to_string_lossy().as_bytes() {
        match byte {
            b'\\' => uri.push('/'),
            b'/' | b':' | b'-' | b'.' | b'_' | b'~' => uri.push(char::from(*byte)),
            b'0'..=b'9' | b'a'..=b'z' | b'A'..=b'Z' => uri.push(char::from(*byte)),
            _ => uri.push_str(&format!("%{byte:02X}")),
        }
    }
    uri.push_str("?mode=ro&immutable=1");
    uri
}

/// Open a database READ-ONLY in a way that CANNOT create a `-wal` / `-shm`
/// sidecar.
///
/// `SQLITE_OPEN_READ_ONLY` on its own is NOT enough: a WAL-mode database still
/// materialises its shared-memory index on open, which leaves
/// `zhixing.db-shm` and `zhixing.db-wal` next to the file. For a TARGET that is
/// a correctness bug, not a cosmetic one — it would make the strict
/// copy-manifest verification (§32) see files nobody migrated, and it would
/// destroy the byte-stability §43 depends on. `immutable=1` tells SQLite the
/// file cannot change, so it takes no lock and creates no sidecar.
///
/// The trade-off is deliberate: migration only ever validates STATIC snapshots
/// (the Safety Backup's database, a freshly staged target, or an authoritative
/// root at the moment strong maintenance is held). A `-wal` sitting beside a
/// validated TARGET would be caught by the manifest check as an unexpected file
/// — it fails closed rather than silently validating a different set of bytes.
fn open_readonly_immutable(db: &Path) -> Option<Connection> {
    Connection::open_with_flags(
        to_file_uri(db),
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_URI,
    )
    .ok()
}

fn integrity_is_ok(conn: &Connection) -> bool {
    conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        .map(|result| result.eq_ignore_ascii_case("ok"))
        .unwrap_or(false)
}

fn schema_version_of(conn: &Connection) -> Option<u32> {
    let version: i64 = conn
        .query_row("SELECT MAX(version) FROM schema_migrations", [], |row| {
            row.get(0)
        })
        .ok()?;
    u32::try_from(version).ok()
}

/// Read-only validity of a database that must be at the CURRENT schema.
///
/// Never mutates the file and never leaves a sidecar behind, so it can be
/// pointed at a target that is still being verified.
fn database_is_valid(db: &Path) -> bool {
    if !is_regular_file(db) {
        return false;
    }
    let Some(conn) = open_readonly_immutable(db) else {
        return false;
    };
    integrity_is_ok(&conn) && schema_version_of(&conn) == Some(current_schema_version())
}

// ============================================================
// Target request validation (§4, §5)
// ============================================================

/// Validate the caller's target request. Read-only: nothing is created here.
///
/// Path relation is decided on RELIABLY NORMALISED paths (`canonicalize`), never
/// on a string prefix: `C:\data` and `C:\data-2` share a textual prefix while
/// being unrelated, and a junction could make two different strings denote the
/// same directory.
fn validate_target_request(
    source_root: &Path,
    target: &Path,
) -> Result<(PathBuf, PathBuf), DataRootMigrationError> {
    if !target.is_absolute() {
        return Err(DataRootMigrationError::TargetInvalid(
            "the target must be an absolute path".into(),
        ));
    }
    if crate::storage::paths::is_network_share(target) {
        return Err(DataRootMigrationError::TargetInvalid(
            "the target must be a local filesystem path".into(),
        ));
    }
    let target_name = match target.file_name() {
        Some(name) if !name.is_empty() => name.to_os_string(),
        _ => {
            return Err(DataRootMigrationError::TargetInvalid(
                "the target must name a folder".into(),
            ))
        }
    };
    let target_parent = match target.parent() {
        Some(parent) if !parent.as_os_str().is_empty() => parent.to_path_buf(),
        _ => {
            return Err(DataRootMigrationError::TargetInvalid(
                "the target must have a parent folder".into(),
            ))
        }
    };

    // The target itself must NOT exist — in any form.
    match fs::symlink_metadata(target) {
        Ok(_) => {
            return Err(DataRootMigrationError::TargetInvalid(
                "the target folder already exists".into(),
            ))
        }
        Err(e) if e.kind() == io::ErrorKind::NotFound => {}
        Err(e) => {
            return Err(DataRootMigrationError::TargetInvalid(format!(
                "the target cannot be inspected: {e}"
            )))
        }
    }

    // The parent must exist, be a directory and be local.
    let parent_meta = fs::metadata(&target_parent).map_err(|e| {
        DataRootMigrationError::TargetInvalid(format!("the target parent is unavailable: {e}"))
    })?;
    if !parent_meta.is_dir() {
        return Err(DataRootMigrationError::TargetInvalid(
            "the target parent is not a directory".into(),
        ));
    }

    let source_canon = fs::canonicalize(source_root).map_err(|e| {
        DataRootMigrationError::Unavailable(format!("the source root cannot be normalised: {e}"))
    })?;
    let parent_canon = fs::canonicalize(&target_parent).map_err(|e| {
        DataRootMigrationError::TargetInvalid(format!(
            "the target parent cannot be normalised: {e}"
        ))
    })?;
    let target_canon = parent_canon.join(&target_name);

    // Component-wise (NOT string prefix) containment checks.
    if target_canon == source_canon {
        return Err(DataRootMigrationError::TargetInvalid(
            "the target is the current data folder".into(),
        ));
    }
    if target_canon.starts_with(&source_canon) {
        return Err(DataRootMigrationError::TargetInvalid(
            "the target is inside the current data folder".into(),
        ));
    }
    if source_canon.starts_with(&target_canon) {
        return Err(DataRootMigrationError::TargetInvalid(
            "the target would contain the current data folder".into(),
        ));
    }

    Ok((target_parent, target_name.into()))
}

// ============================================================
// Source tree enumeration (§7–§9, §28)
// ============================================================

/// What a source scan produced.
struct SourceScan {
    /// Every migrated regular file EXCEPT the database entry.
    entries: Vec<CopyManifestEntry>,
    /// The `database/zhixing.db` entry — sourced from the Safety Backup, not
    /// from the live file (§23, §30).
    database_entry: CopyManifestEntry,
    /// The validated manifest the target will receive (§27).
    target_manifest: DataRootManifestBytes,
}

/// The validated Data Root Manifest plus the exact bytes the target will hold.
struct DataRootManifestBytes {
    manifest: crate::storage::manifest::DataRootManifest,
    bytes: Vec<u8>,
}

/// Enumerate and validate the source tree. Read-only.
///
/// Layout rules (frozen):
/// - the top level is EXACTLY `manifest.json` + the five fixed subdirectories —
///   anything else fails closed, so a future unknown payload is never silently
///   dropped (§7);
/// - `database/` may contain only the four known names, all as regular files —
///   anything else fails closed so a future formal data file is never silently
///   lost (§8);
/// - the other four subtrees are preserved byte-for-byte, and unknown regular
///   files INSIDE them are expected and kept (§9);
/// - any symlink / reparse point anywhere fails closed (§6, §9).
fn scan_source_tree(
    source_root: &Path,
    data_manifest: &crate::storage::manifest::DataRootManifest,
) -> Result<SourceScan, DataRootMigrationError> {
    let mut entries: Vec<CopyManifestEntry> = Vec::new();
    let mut seen_manifest = false;
    let mut target_manifest: Option<DataRootManifestBytes> = None;

    let allowed_top: BTreeSet<&str> = FIXED_SUBDIRS.iter().copied().collect();

    for (name, path) in dir_entries(source_root)? {
        let kind = inspect_entry(&path)?;
        if name == MANIFEST_FILENAME {
            if !matches!(kind, SafeEntry::File) {
                return Err(DataRootMigrationError::UnsupportedSourceLayout(
                    "manifest.json is not a regular file".into(),
                ));
            }
            // Re-validate rather than trust the earlier resolution.
            let manifest = DataRootService::load_manifest(source_root).map_err(|e| {
                DataRootMigrationError::UnsupportedSourceLayout(format!("manifest.json: {e}"))
            })?;
            manifest
                .validate(&source_root.join(MANIFEST_FILENAME))
                .map_err(|e| {
                    DataRootMigrationError::UnsupportedSourceLayout(format!("manifest.json: {e}"))
                })?;
            let bytes = serde_json::to_string_pretty(&manifest)
                .map_err(|e| DataRootMigrationError::Internal(format!("serialize manifest: {e}")))?
                .into_bytes();
            // The copy manifest covers the target's OWN manifest bytes (§27):
            // the target receives a re-serialised, validated equivalent rather
            // than a blind byte copy, and the entry below is what verification
            // is measured against.
            entries.push(CopyManifestEntry {
                relative_path: MANIFEST_FILENAME.to_string(),
                size_bytes: bytes.len() as u64,
                sha256: crate::db::checksum::sha256_hex(&bytes),
            });
            seen_manifest = true;
            target_manifest = Some(DataRootManifestBytes { manifest, bytes });
            continue;
        }

        if !allowed_top.contains(name.as_str()) {
            return Err(DataRootMigrationError::UnsupportedSourceLayout(format!(
                "unknown top-level entry: {name}"
            )));
        }
        if !matches!(kind, SafeEntry::Dir) {
            return Err(DataRootMigrationError::UnsupportedSourceLayout(format!(
                "{name}/ is not a directory"
            )));
        }

        if name == DATABASE_DIR_NAME {
            // The database directory's contents are NEVER copied (§8): the
            // target database comes from the Safety Backup. Only the shape is
            // validated here.
            for (entry_name, entry_path) in dir_entries(&path)? {
                if !ALLOWED_DATABASE_ENTRIES.contains(&entry_name.as_str()) {
                    return Err(DataRootMigrationError::UnsupportedSourceLayout(format!(
                        "unknown entry in database/: {entry_name}"
                    )));
                }
                if !matches!(inspect_entry(&entry_path)?, SafeEntry::File) {
                    return Err(DataRootMigrationError::UnsupportedSourceLayout(format!(
                        "database/{entry_name} is not a regular file"
                    )));
                }
            }
            continue;
        }

        walk_subtree(&path, name.as_str(), &mut entries)?;
    }

    if !seen_manifest {
        return Err(DataRootMigrationError::UnsupportedSourceLayout(
            "manifest.json is missing".into(),
        ));
    }
    for sub in FIXED_SUBDIRS {
        if !source_root.join(sub).is_dir() {
            return Err(DataRootMigrationError::UnsupportedSourceLayout(format!(
                "the fixed subdirectory {sub}/ is missing"
            )));
        }
    }
    let target_manifest = target_manifest.expect("manifest presence checked above");

    if target_manifest.manifest.database.relative_path != data_manifest.database.relative_path {
        return Err(DataRootMigrationError::Internal(
            "the manifest changed between resolution and enumeration".into(),
        ));
    }

    Ok(SourceScan {
        entries,
        // Filled in by the caller, from the Safety Backup (§23, §30).
        database_entry: CopyManifestEntry {
            relative_path: DB_RELATIVE_PATH.to_string(),
            size_bytes: 0,
            sha256: String::new(),
        },
        target_manifest,
    })
}

/// Recursively collect every regular file of an approved subtree.
fn walk_subtree(
    dir: &Path,
    relative: &str,
    out: &mut Vec<CopyManifestEntry>,
) -> Result<(), DataRootMigrationError> {
    for (name, path) in dir_entries(dir)? {
        let relative_path = portable_relative(relative, &name);
        match inspect_entry(&path)? {
            SafeEntry::Dir => walk_subtree(&path, &relative_path, out)?,
            SafeEntry::File => {
                let size_bytes = fs::metadata(&path)
                    .map_err(|e| {
                        DataRootMigrationError::Unavailable(format!(
                            "stat {}: {e}",
                            path.display()
                        ))
                    })?
                    .len();
                let sha256 = sha256_file_hex(&path).map_err(|e| {
                    DataRootMigrationError::Unavailable(format!(
                        "hash {}: {e}",
                        path.display()
                    ))
                })?;
                out.push(CopyManifestEntry {
                    relative_path,
                    size_bytes,
                    sha256,
                });
            }
        }
    }
    Ok(())
}

// ============================================================
// Staging build + verification (§31, §32)
// ============================================================

/// Build the target staging directory from the copy manifest.
///
/// The database file is taken from the SAFETY BACKUP (a static, verified,
/// WAL-safe snapshot), never from the live database (§23).
fn build_target_staging(
    staging: &Path,
    source_root: &Path,
    scan: &SourceScan,
    copy_manifest: &CopyManifest,
    safety_db: &Path,
) -> Result<(), DataRootMigrationError> {
    fs::create_dir_all(staging).map_err(|e| {
        DataRootMigrationError::CopyFailed(format!("create staging dir: {e}"))
    })?;

    // 1. The validated manifest the target receives (§27).
    fs::write(staging.join(MANIFEST_FILENAME), &scan.target_manifest.bytes).map_err(|e| {
        DataRootMigrationError::CopyFailed(format!("write target manifest: {e}"))
    })?;

    // 2. The database, from the Safety Backup.
    let target_db = staging.join(DB_RELATIVE_PATH);
    if let Some(parent) = target_db.parent() {
        fs::create_dir_all(parent).map_err(|e| {
            DataRootMigrationError::CopyFailed(format!("create target database dir: {e}"))
        })?;
    }
    copy_file_synced(safety_db, &target_db).map_err(|e| {
        DataRootMigrationError::CopyFailed(format!("copy target database: {e}"))
    })?;

    // 3. Every other approved subtree, byte-for-byte.
    let mut created: BTreeSet<String> = BTreeSet::new();
    for entry in &copy_manifest.entries {
        if entry.relative_path == DB_RELATIVE_PATH
            || entry.relative_path == MANIFEST_FILENAME
        {
            continue;
        }
        // `backup/` etc. may be empty; make sure every top-level directory of
        // the Simple layout exists in the target even when it holds no file.
        let destination = staging.join(entry.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if let Some(parent) = destination.parent() {
            let key = parent.to_string_lossy().into_owned();
            if created.insert(key) {
                fs::create_dir_all(parent).map_err(|e| {
                    DataRootMigrationError::CopyFailed(format!("create target dir: {e}"))
                })?;
            }
        }
        let source = source_root.join(entry.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR));
        copy_file_synced(&source, &destination).map_err(|e| {
            DataRootMigrationError::CopyFailed(format!("copy {}: {e}", entry.relative_path))
        })?;
    }

    // 4. The five fixed subdirectories always exist in the target, so the
    //    published root is a well-formed Simple Data Root even if one of them
    //    is empty.
    for sub in FIXED_SUBDIRS {
        fs::create_dir_all(staging.join(sub)).map_err(|e| {
            DataRootMigrationError::CopyFailed(format!("create target {sub}/: {e}"))
        })?;
    }

    Ok(())
}

/// Verify the staged target against the copy manifest (§32).
///
/// Checks EVERY entry — never just the database — plus two things a manifest
/// alone cannot prove: no unexpected file appeared, and nothing is a link.
fn verify_target_against_copy_manifest(
    root: &Path,
    copy_manifest: &CopyManifest,
) -> Result<(), String> {
    let mut expected: BTreeSet<String> = BTreeSet::new();
    for entry in &copy_manifest.entries {
        let relative = entry.relative_path.replace('/', std::path::MAIN_SEPARATOR_STR);
        let path = root.join(&relative);
        let meta = fs::symlink_metadata(&path).map_err(|_| {
            format!("{} is missing from the target", entry.relative_path)
        })?;
        if !meta.is_file() || meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(format!(
                "{} is not a plain regular file in the target",
                entry.relative_path
            ));
        }
        if meta.len() != entry.size_bytes {
            return Err(format!("{} has the wrong size", entry.relative_path));
        }
        let sha = sha256_file_hex(&path)
            .map_err(|_| format!("{} cannot be hashed", entry.relative_path))?;
        if sha != entry.sha256 {
            return Err(format!("{} failed its checksum", entry.relative_path));
        }
        expected.insert(entry.relative_path.clone());
    }

    // No extra file, and nothing that is neither a plain directory nor a plain
    // regular file.
    let mut found: Vec<String> = Vec::new();
    collect_regular_files(root, "", &mut found)?;
    for relative in found {
        if !expected.contains(&relative) {
            return Err(format!("the target has an unexpected file: {relative}"));
        }
    }
    Ok(())
}

fn collect_regular_files(
    dir: &Path,
    relative: &str,
    out: &mut Vec<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("read {}: {e}", dir.display()))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("read {}: {e}", dir.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        let path = entry.path();
        let relative_path = portable_relative(relative, &name);
        let meta = fs::symlink_metadata(&path)
            .map_err(|e| format!("stat {}: {e}", path.display()))?;
        if meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(format!("{relative_path} is a link in the target"));
        }
        if meta.is_dir() {
            collect_regular_files(&path, &relative_path, out)?;
        } else if meta.is_file() {
            out.push(relative_path);
        } else {
            return Err(format!("{relative_path} is not a file in the target"));
        }
    }
    Ok(())
}

// ============================================================
// Apply (§20 — the frozen order)
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum MigrationApplyOutcome {
    Migrated,
}

/// Result DTO. `target_data_root` is the caller's own input, which the migration
/// domain already legitimately holds (§110); no source path, no temp path and no
/// token is exposed.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationApplyResultDto {
    pub(crate) operation_id: String,
    pub(crate) target_data_root: String,
    pub(crate) outcome: MigrationApplyOutcome,
    pub(crate) safety_backup_id: String,
}

/// Injectable free-space probe (§90). Production passes the real Windows call.
pub(crate) type SpaceProbe = fn(&Path) -> Result<u64, String>;

// -------- test-only failure injection (mirrors the Restore precedent) --------

#[cfg(test)]
mod injection {
    use std::sync::Mutex;

    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(super) enum InjectKind {
        PublishFailure,
        BootstrapSwitchFailure,
        PostSwitchFailure,
        RollbackFailure,
    }

    /// Keyed by operation id so concurrently running tests cannot consume each
    /// other's injection.
    static INJECTED: Mutex<Vec<(String, InjectKind)>> = Mutex::new(Vec::new());

    pub(super) fn arm(operation_id: &str, kind: InjectKind) {
        INJECTED.lock().unwrap().push((operation_id.to_string(), kind));
    }

    pub(super) fn take(operation_id: &str, kind: InjectKind) -> bool {
        let mut guard = INJECTED.lock().unwrap();
        if let Some(index) = guard
            .iter()
            .position(|(id, k)| id == operation_id && *k == kind)
        {
            guard.remove(index);
            return true;
        }
        false
    }
}

#[cfg(test)]
fn injected_publish_failure(operation_id: &str) -> bool {
    injection::take(operation_id, injection::InjectKind::PublishFailure)
}
#[cfg(not(test))]
fn injected_publish_failure(_operation_id: &str) -> bool {
    false
}

#[cfg(test)]
fn injected_bootstrap_switch_failure(operation_id: &str) -> bool {
    injection::take(operation_id, injection::InjectKind::BootstrapSwitchFailure)
}
#[cfg(not(test))]
fn injected_bootstrap_switch_failure(_operation_id: &str) -> bool {
    false
}

#[cfg(test)]
fn injected_post_switch_failure(operation_id: &str) -> bool {
    injection::take(operation_id, injection::InjectKind::PostSwitchFailure)
}
#[cfg(not(test))]
fn injected_post_switch_failure(_operation_id: &str) -> bool {
    false
}

#[cfg(test)]
fn injected_rollback_failure(operation_id: &str) -> bool {
    injection::take(operation_id, injection::InjectKind::RollbackFailure)
}
#[cfg(not(test))]
fn injected_rollback_failure(_operation_id: &str) -> bool {
    false
}

/// Apply one Simple Data Root migration.
///
/// The order below is FROZEN (§20). The caller must already hold a
/// `MaintenanceOwnedPermit`, which is released only after this returns.
pub(crate) fn apply_data_root_migration(
    app_config_dir: &Path,
    operation_id: &str,
    target_data_root: &Path,
    _permit: MaintenanceOwnedPermit,
) -> Result<MigrationApplyResultDto, DataRootMigrationError> {
    apply_data_root_migration_with_probe(
        app_config_dir,
        operation_id,
        target_data_root,
        available_space_bytes,
    )
}

pub(crate) fn apply_data_root_migration_with_probe(
    app_config_dir: &Path,
    operation_id: &str,
    target_data_root: &Path,
    space_probe: SpaceProbe,
) -> Result<MigrationApplyResultDto, DataRootMigrationError> {
    // §77: fail closed on a platform with no atomic primitives — BEFORE any
    // directory, backup or copy is created.
    if !cfg!(windows) {
        return Err(DataRootMigrationError::UnsupportedPlatform);
    }

    // 1. operation id.
    let operation_id = normalize_uuid(operation_id)?;

    // 2. Resolve the AUTHORITATIVE source root. It is never supplied by the
    //    caller (§75).
    let (source_root, data_manifest) =
        resolve_existing_data_root(app_config_dir).map_err(DataRootMigrationError::Unavailable)?;

    // 3. Validate the target request (read-only).
    let (target_parent, target_name) = validate_target_request(&source_root, target_data_root)?;
    let target_root = target_parent.join(&target_name);

    // 4. Operation directory + journal PREPARING. Created at runtime under the
    //    app config root, never under a Data Root.
    let op_dir = operation_dir(app_config_dir, &operation_id);
    fs::create_dir_all(&op_dir).map_err(|e| {
        DataRootMigrationError::Internal(format!("create operation dir: {e}"))
    })?;
    if !matches!(read_journal(&op_dir), JournalRead::Absent) {
        return Err(DataRootMigrationError::RequestInvalid(
            "this operation id already has a migration record".into(),
        ));
    }
    let now = now_ms();
    let mut journal = MigrationOperationJournal {
        operation_id: operation_id.clone(),
        source_data_root: source_root.clone(),
        target_data_root: target_root.clone(),
        safety_backup_id: String::new(),
        phase: MigrationJournalPhase::Preparing,
        created_at_ms: now,
        updated_at_ms: now,
    };
    write_journal(&op_dir, &journal)?;

    // 5. Safety Backup of the CURRENT database, before anything is copied.
    let safety: BackupResultDto =
        build_and_publish_backup_bundle(&source_root, &data_manifest).map_err(|e| {
            // §22: nothing was staged, published or switched. The record is
            // terminalized as NOT_COMMITTED so a restart needs no recovery.
            record_phase(&op_dir, &mut journal, MigrationJournalPhase::NotCommitted);
            DataRootMigrationError::SafetyBackupFailed(e.code().to_string())
        })?;
    let safety_db = source_root
        .join(&safety.bundle_relative_path)
        .join(DB_RELATIVE_PATH);
    if !is_regular_file(&safety_db) {
        record_phase(&op_dir, &mut journal, MigrationJournalPhase::NotCommitted);
        return Err(DataRootMigrationError::SafetyBackupFailed(
            "the safety backup database is missing".into(),
        ));
    }

    // 6. Journal SAFETY_BACKUP_CREATED.
    journal.safety_backup_id = safety.backup_id.clone();
    record_phase(
        &op_dir,
        &mut journal,
        MigrationJournalPhase::SafetyBackupCreated,
    );

    // 7. Enumerate the source tree AFTER the safety backup exists, so the
    //    target's `backup/` also contains this migration's own safety backup
    //    (§24).
    let mut scan = scan_source_tree(&source_root, &data_manifest)?;

    // The database entry is the SAFETY BACKUP database — a WAL-safe, verified,
    // static snapshot — never the live file (§23, §30).
    scan.database_entry = CopyManifestEntry {
        relative_path: DB_RELATIVE_PATH.to_string(),
        size_bytes: safety.size_bytes,
        sha256: safety.checksum_sha256.clone(),
    };

    // 8. Durable copy manifest (§28, §29).
    let mut all_entries = scan.entries.clone();
    all_entries.push(scan.database_entry.clone());
    let required_bytes: u64 = all_entries.iter().map(|e| e.size_bytes).sum();
    let copy_manifest = CopyManifest {
        manifest_kind: COPY_MANIFEST_KIND.to_string(),
        operation_id: operation_id.clone(),
        source_data_root: source_root.clone(),
        target_data_root: target_root.clone(),
        required_bytes,
        entries: all_entries,
    };
    write_copy_manifest(&op_dir, &copy_manifest)?;

    // 9. Free space (§33). Checked BEFORE a single target byte is written.
    let available = space_probe(&target_parent).map_err(|e| {
        DataRootMigrationError::TargetInvalid(format!("target volume unavailable: {e}"))
    })?;
    if available < copy_manifest.required_bytes {
        return Err(DataRootMigrationError::InsufficientSpace(format!(
            "need {} bytes, {} available",
            copy_manifest.required_bytes, available
        )));
    }

    // 10. Build the operation-owned sibling staging directory (§25, §26).
    let staging = target_parent.join(format!("{STAGING_PREFIX}{operation_id}"));
    if fs::symlink_metadata(&staging).is_ok() {
        return Err(DataRootMigrationError::Internal(
            "the staging directory already exists".into(),
        ));
    }
    build_target_staging(
        &staging,
        &source_root,
        &scan,
        &copy_manifest,
        &safety_db,
    )?;

    // 11. Verify the ENTIRE staging tree (§32) — never just the database.
    verify_target_against_copy_manifest(&staging, &copy_manifest)
        .map_err(DataRootMigrationError::VerifyFailed)?;
    if !database_is_valid(&staging.join(DB_RELATIVE_PATH)) {
        return Err(DataRootMigrationError::VerifyFailed(
            "the staged database is not a valid current-schema database".into(),
        ));
    }

    // 12. Journal TARGET_STAGED.
    record_phase(&op_dir, &mut journal, MigrationJournalPhase::TargetStaged);

    // 13. Publish: ONE atomic directory rename. The bootstrap still points at
    //     the source, so this is NOT a commit (§35).
    if injected_publish_failure(&operation_id) {
        return Err(DataRootMigrationError::TargetPublishFailed(
            "injected publish failure".into(),
        ));
    }
    fs::rename(&staging, &target_root).map_err(|e| {
        DataRootMigrationError::TargetPublishFailed(format!("publish rename failed: {e}"))
    })?;

    // 14. Journal TARGET_PUBLISHED.
    record_phase(&op_dir, &mut journal, MigrationJournalPhase::TargetPublished);

    // Bootstrap snapshot BEFORE the switch (§39) — recovery evidence, never part
    // of a Backup bundle.
    let bootstrap_path = BootstrapService::bootstrap_path(app_config_dir);
    let bootstrap_bytes = fs::read(&bootstrap_path).map_err(|e| {
        DataRootMigrationError::BootstrapSwitchFailed(format!("read bootstrap: {e}"))
    })?;
    write_file_durable(&op_dir.join(BOOTSTRAP_BEFORE_FILENAME), &bootstrap_bytes).map_err(|e| {
        DataRootMigrationError::BootstrapSwitchFailed(format!("snapshot bootstrap: {e}"))
    })?;

    // 15. THE switch: ONE atomic bootstrap re-point (§37–§40).
    if injected_bootstrap_switch_failure(&operation_id) {
        // The same conclusion as the real `Unavailable` / `Write` arms below: the
        // bootstrap could not be re-pointed, so the operation is provably NOT
        // committed and a restart must not have to reconcile it.
        record_phase(&op_dir, &mut journal, MigrationJournalPhase::NotCommitted);
        return Err(DataRootMigrationError::BootstrapSwitchFailed(
            "injected bootstrap switch failure".into(),
        ));
    }
    match rewrite_data_root_atomically(&bootstrap_path, &source_root, &target_root) {
        Ok(_) => {}
        // The bootstrap moved underneath us: fail closed and keep the barrier.
        Err(BootstrapRewriteError::Changed) => {
            record_phase(&op_dir, &mut journal, MigrationJournalPhase::Blocked);
            return Err(DataRootMigrationError::BootstrapChanged(
                "bootstrap.json no longer points at the migration source".into(),
            ));
        }
        // §94: the target is published and retained, the source stays
        // authoritative and the operation is provably NOT committed.
        Err(BootstrapRewriteError::Unavailable(detail)) => {
            record_phase(&op_dir, &mut journal, MigrationJournalPhase::NotCommitted);
            return Err(DataRootMigrationError::BootstrapSwitchFailed(detail));
        }
        Err(BootstrapRewriteError::Write(detail)) => {
            record_phase(&op_dir, &mut journal, MigrationJournalPhase::NotCommitted);
            return Err(DataRootMigrationError::BootstrapSwitchFailed(detail));
        }
    }

    // 16. Journal BOOTSTRAP_SWITCHED.
    record_phase(
        &op_dir,
        &mut journal,
        MigrationJournalPhase::BootstrapSwitched,
    );

    // 17. Post-switch re-validation, READ-ONLY so the target bytes stay stable
    //     for an ambiguity reconcile (§43).
    if let Err(reason) = post_switch_validation(
        &bootstrap_path,
        &target_root,
        &copy_manifest,
        injected_post_switch_failure(&operation_id),
    ) {
        // §45: try to put the bootstrap back.
        return Err(attempt_bootstrap_rollback(
            &op_dir,
            &mut journal,
            &bootstrap_path,
            &source_root,
            &target_root,
            reason,
            injected_rollback_failure(&operation_id),
        ));
    }

    // 18. Journal COMMITTED.
    record_phase(&op_dir, &mut journal, MigrationJournalPhase::Committed);

    Ok(MigrationApplyResultDto {
        operation_id,
        target_data_root: target_root.display().to_string(),
        outcome: MigrationApplyOutcome::Migrated,
        safety_backup_id: safety.backup_id,
    })
}

/// Re-prove the switch strictly from disk (§42, §43).
fn post_switch_validation(
    bootstrap_path: &Path,
    target_root: &Path,
    copy_manifest: &CopyManifest,
    inject_failure: bool,
) -> Result<(), String> {
    if inject_failure {
        return Err("injected post-switch validation failure".into());
    }
    match BootstrapService::load(bootstrap_path) {
        BootstrapState::Valid(loaded) => {
            if loaded.data_root != target_root {
                return Err("bootstrap.json does not point at the target".into());
            }
        }
        BootstrapState::Missing { .. } => return Err("bootstrap.json is missing".into()),
        BootstrapState::Degraded(_) => return Err("bootstrap.json is unreadable".into()),
    }
    verify_target_fully(target_root, copy_manifest)
}

/// §43/§62: Data Root Existing validation + full copy-manifest verification +
/// database integrity / schema.
fn verify_target_fully(target_root: &Path, copy_manifest: &CopyManifest) -> Result<(), String> {
    let (_root, manifest) = DataRootService::get_and_ensure(target_root, InitMode::Existing)
        .map_err(|e| format!("the target is not a valid data root: {e}"))?;
    verify_target_against_copy_manifest(target_root, copy_manifest)?;
    let db = DataRootService::resolve_database_path(target_root, &manifest);
    if !database_is_valid(&db) {
        return Err("the target database is not a valid current-schema database".into());
    }
    Ok(())
}

/// §63: the source root must still be the authoritative, valid root.
fn source_is_valid(source_root: &Path) -> Result<(), String> {
    let (_root, manifest) = DataRootService::get_and_ensure(source_root, InitMode::Existing)
        .map_err(|e| format!("the source is not a valid data root: {e}"))?;
    let db = DataRootService::resolve_database_path(source_root, &manifest);
    if !database_is_valid(&db) {
        return Err("the source database is not a valid current-schema database".into());
    }
    Ok(())
}

/// Undo the bootstrap switch after a failed post-switch validation (§45).
///
/// The TARGET is never deleted and never rolled back destructively (§46): only
/// the bootstrap is re-pointed, and only when the rollback itself can be
/// proven. An unprovable rollback is `SWITCH_INDETERMINATE` (barrier held).
#[allow(clippy::too_many_arguments)]
fn attempt_bootstrap_rollback(
    op_dir: &Path,
    journal: &mut MigrationOperationJournal,
    bootstrap_path: &Path,
    source_root: &Path,
    target_root: &Path,
    reason: String,
    inject_failure: bool,
) -> DataRootMigrationError {
    let rolled_back = if inject_failure {
        false
    } else {
        match rewrite_data_root_atomically(bootstrap_path, target_root, source_root) {
            Ok(_) => source_is_valid(source_root).is_ok(),
            Err(_) => false,
        }
    };

    if rolled_back {
        record_phase(op_dir, journal, MigrationJournalPhase::RolledBack);
        return DataRootMigrationError::RolledBack(reason);
    }

    record_phase(op_dir, journal, MigrationJournalPhase::Blocked);
    DataRootMigrationError::SwitchIndeterminate(reason)
}

fn normalize_uuid(value: &str) -> Result<String, DataRootMigrationError> {
    Uuid::parse_str(value.trim())
        .map(|uuid| uuid.to_string())
        .map_err(|e| DataRootMigrationError::RequestInvalid(format!("not a UUID: {e}")))
}

// ============================================================
// Same-process reconcile (§49–§53)
// ============================================================

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum MigrationReconcileOutcome {
    Committed,
    NotCommitted,
    RolledBack,
    Indeterminate,
}

/// Safe reason codes for an INDETERMINATE reconcile. Never a raw OS or SQLite
/// message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum MigrationReconcileReason {
    JournalMissing,
    JournalUnreadable,
    CopyManifestUnreadable,
    BootstrapMissing,
    BootstrapUnreadable,
    BootstrapPointsNeither,
    TargetInvalid,
    SourceInvalid,
    EvidenceContradictory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct MigrationReconcileResultDto {
    pub(crate) operation_id: String,
    pub(crate) target_data_root: String,
    pub(crate) outcome: MigrationReconcileOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<MigrationReconcileReason>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) safety_backup_id: Option<String>,
}

fn indeterminate(
    operation_id: &str,
    target: &Path,
    reason: MigrationReconcileReason,
) -> MigrationReconcileResultDto {
    MigrationReconcileResultDto {
        operation_id: operation_id.to_string(),
        target_data_root: target.display().to_string(),
        outcome: MigrationReconcileOutcome::Indeterminate,
        reason_code: Some(reason),
        safety_backup_id: None,
    }
}

/// Re-prove what a possibly-ambiguous migration actually did.
///
/// The journal phase is NEVER believed on its own: the verdict rests on the
/// bootstrap plus a full re-verification of whichever root the bootstrap points
/// at (§49).
pub(crate) fn reconcile_data_root_migration(
    app_config_dir: &Path,
    operation_id: &str,
    target_data_root: &Path,
    _permit: MaintenanceOwnedPermit,
) -> Result<MigrationReconcileResultDto, DataRootMigrationError> {
    let operation_id = normalize_uuid(operation_id)?;
    let op_dir = operation_dir(app_config_dir, &operation_id);

    let journal = match read_journal(&op_dir) {
        JournalRead::Present(journal) => *journal,
        JournalRead::Absent => {
            return Ok(indeterminate(
                &operation_id,
                target_data_root,
                MigrationReconcileReason::JournalMissing,
            ))
        }
        JournalRead::Unreadable => {
            return Ok(indeterminate(
                &operation_id,
                target_data_root,
                MigrationReconcileReason::JournalUnreadable,
            ))
        }
    };

    let source_root = journal.source_data_root.clone();
    let target_root = journal.target_data_root.clone();
    if !source_root.is_absolute() || !target_root.is_absolute() {
        return Ok(indeterminate(
            &operation_id,
            &target_root,
            MigrationReconcileReason::EvidenceContradictory,
        ));
    }

    let bootstrap_path = BootstrapService::bootstrap_path(app_config_dir);
    let loaded = match BootstrapService::load(&bootstrap_path) {
        BootstrapState::Valid(loaded) => loaded,
        BootstrapState::Missing { .. } => {
            return Ok(indeterminate(
                &operation_id,
                &target_root,
                MigrationReconcileReason::BootstrapMissing,
            ))
        }
        BootstrapState::Degraded(_) => {
            return Ok(indeterminate(
                &operation_id,
                &target_root,
                MigrationReconcileReason::BootstrapUnreadable,
            ))
        }
    };

    // §50 — the target is authoritative, so prove it in full.
    if loaded.data_root == target_root {
        let Some(copy_manifest) = read_copy_manifest(&op_dir) else {
            return Ok(indeterminate(
                &operation_id,
                &target_root,
                MigrationReconcileReason::CopyManifestUnreadable,
            ));
        };
        // The verification detail is deliberately dropped from the DTO (§110).
        if verify_target_fully(&target_root, &copy_manifest).is_err() {
            return Ok(indeterminate(
                &operation_id,
                &target_root,
                MigrationReconcileReason::TargetInvalid,
            ));
        }
        let mut finalized = journal.clone();
        terminalize(&op_dir, &mut finalized, MigrationJournalPhase::Committed);
        return Ok(MigrationReconcileResultDto {
            operation_id,
            target_data_root: target_root.display().to_string(),
            outcome: MigrationReconcileOutcome::Committed,
            reason_code: None,
            safety_backup_id: Some(finalized.safety_backup_id).filter(|s| !s.is_empty()),
        });
    }

    // §51 / §52 — the source is authoritative again.
    if loaded.data_root == source_root {
        if source_is_valid(&source_root).is_err() {
            return Ok(indeterminate(
                &operation_id,
                &target_root,
                MigrationReconcileReason::SourceInvalid,
            ));
        }
        let phase = if journal.phase.reached_bootstrap_switch() {
            MigrationJournalPhase::RolledBack
        } else {
            MigrationJournalPhase::NotCommitted
        };
        let mut finalized = journal.clone();
        terminalize(&op_dir, &mut finalized, phase);
        let outcome = if phase == MigrationJournalPhase::RolledBack {
            MigrationReconcileOutcome::RolledBack
        } else {
            MigrationReconcileOutcome::NotCommitted
        };
        return Ok(MigrationReconcileResultDto {
            operation_id,
            target_data_root: target_root.display().to_string(),
            outcome,
            reason_code: None,
            safety_backup_id: Some(finalized.safety_backup_id).filter(|s| !s.is_empty()),
        });
    }

    // §53 — the bootstrap points at neither root.
    Ok(indeterminate(
        &operation_id,
        &target_root,
        MigrationReconcileReason::BootstrapPointsNeither,
    ))
}

/// Terminalize a journal from disk truth (best-effort).
fn terminalize(op_dir: &Path, journal: &mut MigrationOperationJournal, phase: MigrationJournalPhase) {
    journal.phase = phase;
    journal.updated_at_ms = now_ms();
    if let Err(e) = write_journal(op_dir, journal) {
        tracing::warn!(
            target: "zhixing::data_root_migration",
            error = %e,
            "journal finalization skipped"
        );
    }
}

// ============================================================
// Startup recovery gate (§58–§65)
// ============================================================

/// Why the startup gate refuses to let the application continue.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum MigrationRecoveryBlockerCode {
    /// The migration tree exists but could not be enumerated.
    RootUnreadable,
    /// The migration tree holds something that is not a valid operation record.
    RootMalformed,
    /// More than one non-terminal operation record is present.
    MultiplePendingOperations,
    /// A non-terminal operation record has no readable journal.
    JournalMalformed,
    /// `bootstrap.json` is missing while a migration is pending.
    BootstrapMissing,
    /// `bootstrap.json` is present but unreadable / unsupported.
    BootstrapUnreadable,
    /// The bootstrap points at neither the pending operation's source nor its
    /// target.
    BootstrapPointsNeither,
    /// The bootstrap points at the target, but the target does not verify.
    TargetInvalid,
    /// The bootstrap points at the source, but the source does not verify.
    SourceInvalid,
    /// Two pieces of recovery evidence disagree.
    EvidenceContradictory,
}

impl MigrationRecoveryBlockerCode {
    /// Stable machine-readable token. Every token carries the
    /// `DATA_ROOT_MIGRATION_RECOVERY_` prefix so a future UI can match the whole
    /// class (§67).
    pub(crate) fn kind(self) -> &'static str {
        match self {
            Self::RootUnreadable => "DATA_ROOT_MIGRATION_RECOVERY_ROOT_UNREADABLE",
            Self::RootMalformed => "DATA_ROOT_MIGRATION_RECOVERY_ROOT_MALFORMED",
            Self::MultiplePendingOperations => "DATA_ROOT_MIGRATION_RECOVERY_MULTIPLE_PENDING",
            Self::JournalMalformed => "DATA_ROOT_MIGRATION_RECOVERY_JOURNAL_MALFORMED",
            Self::BootstrapMissing => "DATA_ROOT_MIGRATION_RECOVERY_BOOTSTRAP_MISSING",
            Self::BootstrapUnreadable => "DATA_ROOT_MIGRATION_RECOVERY_BOOTSTRAP_UNREADABLE",
            Self::BootstrapPointsNeither => "DATA_ROOT_MIGRATION_RECOVERY_POINTS_NEITHER",
            Self::TargetInvalid => "DATA_ROOT_MIGRATION_RECOVERY_TARGET_INVALID",
            Self::SourceInvalid => "DATA_ROOT_MIGRATION_RECOVERY_SOURCE_INVALID",
            Self::EvidenceContradictory => "DATA_ROOT_MIGRATION_RECOVERY_EVIDENCE_CONTRADICTORY",
        }
    }
}

/// One structured startup stop condition. Never a bare `String`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MigrationRecoveryBlocker {
    pub(crate) code: MigrationRecoveryBlockerCode,
    pub(crate) path: Option<PathBuf>,
    pub(crate) detail: String,
}

fn recovery_blocker(
    code: MigrationRecoveryBlockerCode,
    path: Option<&Path>,
    detail: impl Into<String>,
) -> MigrationRecoveryBlocker {
    MigrationRecoveryBlocker {
        code,
        path: path.map(Path::to_path_buf),
        detail: detail.into(),
    }
}

/// What the startup gate concluded.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MigrationRecoveryOutcome {
    /// No pending migration, or only TERMINAL history.
    Clear,
    /// Exactly one pending migration was proven terminal from DISK TRUTH and its
    /// journal was terminalized.
    Reconciled {
        operation_id: String,
        phase: MigrationJournalPhase,
    },
}

struct PendingMigration {
    dir: PathBuf,
    journal: MigrationOperationJournal,
}

/// List the plain operation directories under the migration root.
///
/// An ABSENT tree is NOT a failure: it means this device never migrated.
fn collect_operation_dirs(migration_root: &Path) -> Result<Vec<PathBuf>, MigrationRecoveryBlocker> {
    let entries = match fs::read_dir(migration_root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::RootUnreadable,
                Some(migration_root),
                format!("the migration journal root cannot be enumerated: {e}"),
            ))
        }
    };

    let mut dirs = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|e| {
            recovery_blocker(
                MigrationRecoveryBlockerCode::RootUnreadable,
                Some(migration_root),
                format!("a migration journal entry cannot be read: {e}"),
            )
        })?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|e| {
            recovery_blocker(
                MigrationRecoveryBlockerCode::RootUnreadable,
                Some(&path),
                format!("a migration journal entry cannot be inspected: {e}"),
            )
        })?;
        if !meta.is_dir() || meta.file_type().is_symlink() || is_reparse_point(&meta) {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::RootMalformed,
                Some(&path),
                "an entry under the migration root is not a plain operation directory",
            ));
        }
        dirs.push(path);
    }
    dirs.sort();
    Ok(dirs)
}

/// Find THE one non-terminal operation, if any. Terminal history is ignored and
/// never deleted; more than one pending operation is never resolved by guessing
/// (§15 in the Restore spec, §101/§102 here).
fn find_pending_migration(
    operation_dirs: &[PathBuf],
) -> Result<Option<PendingMigration>, MigrationRecoveryBlocker> {
    let mut identities: BTreeSet<String> = BTreeSet::new();
    let mut pending: Option<PendingMigration> = None;

    for dir in operation_dirs {
        let name = dir
            .file_name()
            .map(|n| n.to_string_lossy().into_owned())
            .unwrap_or_default();
        let identity = match Uuid::parse_str(&name) {
            Ok(uuid) => uuid.to_string(),
            Err(_) => {
                return Err(recovery_blocker(
                    MigrationRecoveryBlockerCode::RootMalformed,
                    Some(dir),
                    "an operation directory name is not a canonical operation id",
                ))
            }
        };
        if !identities.insert(identity) {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::RootMalformed,
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
                        MigrationRecoveryBlockerCode::MultiplePendingOperations,
                        Some(dir),
                        "more than one data root migration is still pending",
                    ));
                }
                pending = Some(PendingMigration {
                    dir: dir.clone(),
                    journal: *journal,
                });
            }
            // The journal is written immediately after the operation directory,
            // so a directory without a readable journal is an INCOMPLETE record
            // and fails closed.
            JournalRead::Absent => {
                return Err(recovery_blocker(
                    MigrationRecoveryBlockerCode::JournalMalformed,
                    Some(dir),
                    "an operation directory carries no migration journal",
                ))
            }
            JournalRead::Unreadable => {
                return Err(recovery_blocker(
                    MigrationRecoveryBlockerCode::JournalMalformed,
                    Some(dir),
                    "a migration journal is present but unreadable",
                ))
            }
        }
    }
    Ok(pending)
}

/// READ-ONLY classification of a migration left behind by a crash.
///
/// Runs at PROCESS START, after the config directory resolved and BEFORE
/// `BootstrapService::load`, because the journal lives in the app config
/// directory precisely so it survives the root switch (§14, §15, §59).
///
/// It never repairs: no bootstrap switch, no bootstrap rollback, no staging
/// cleanup, no target/source deletion, no initialisation (§65). Anything it
/// cannot prove becomes a `MigrationRecoveryBlocker`, which the caller turns
/// into `RuntimeStatus::Degraded(...)`.
pub(crate) fn recover_or_classify_pending_migrations(
    app_config_dir: &Path,
) -> Result<MigrationRecoveryOutcome, MigrationRecoveryBlocker> {
    let root = migration_root(app_config_dir);
    let operation_dirs = collect_operation_dirs(&root)?;
    let Some(pending) = find_pending_migration(&operation_dirs)? else {
        return Ok(MigrationRecoveryOutcome::Clear);
    };

    let source_root = pending.journal.source_data_root.clone();
    let target_root = pending.journal.target_data_root.clone();
    if !source_root.is_absolute() || !target_root.is_absolute() {
        return Err(recovery_blocker(
            MigrationRecoveryBlockerCode::EvidenceContradictory,
            Some(&pending.dir),
            "the pending migration journal does not carry absolute roots",
        ));
    }

    let bootstrap_path = BootstrapService::bootstrap_path(app_config_dir);
    let loaded = match BootstrapService::load(&bootstrap_path) {
        BootstrapState::Valid(loaded) => loaded,
        // §59: a pending migration must NEVER fall through into FirstBoot.
        BootstrapState::Missing { .. } => {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::BootstrapMissing,
                Some(&bootstrap_path),
                "a data root migration is pending but bootstrap.json is missing",
            ))
        }
        BootstrapState::Degraded(e) => {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::BootstrapUnreadable,
                Some(&bootstrap_path),
                format!("a data root migration is pending and bootstrap.json is unusable: {e}"),
            ))
        }
    };

    let phase = if loaded.data_root == target_root {
        // §62: prove the target in full.
        let Some(copy_manifest) = read_copy_manifest(&pending.dir) else {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::EvidenceContradictory,
                Some(&pending.dir),
                "the bootstrap points at the migration target but the copy manifest is unreadable",
            ));
        };
        if verify_target_fully(&target_root, &copy_manifest).is_err() {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::TargetInvalid,
                Some(&target_root),
                "the bootstrap points at the migration target but the target does not verify",
            ));
        }
        MigrationJournalPhase::Committed
    } else if loaded.data_root == source_root {
        // §63: prove the source is still authoritative.
        if source_is_valid(&source_root).is_err() {
            return Err(recovery_blocker(
                MigrationRecoveryBlockerCode::SourceInvalid,
                Some(&source_root),
                "the bootstrap points at the migration source but the source does not verify",
            ));
        }
        if pending.journal.phase.reached_bootstrap_switch() {
            MigrationJournalPhase::RolledBack
        } else {
            MigrationJournalPhase::NotCommitted
        }
    } else {
        return Err(recovery_blocker(
            MigrationRecoveryBlockerCode::BootstrapPointsNeither,
            Some(&bootstrap_path),
            "bootstrap.json points at neither the pending migration's source nor its target",
        ));
    };

    let mut journal = pending.journal;
    terminalize(&pending.dir, &mut journal, phase);

    Ok(MigrationRecoveryOutcome::Reconciled {
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
) -> Result<MaintenanceOwnedPermit, MigrationCommandErrorDto> {
    app.state::<NativeMaintenanceState>()
        .acquire_owner_permit(owner_lease_id)
        .map_err(|error: NativeMaintenanceErrorDto| {
            MigrationCommandErrorDto::from(DataRootMigrationError::Unavailable(
                error.code.to_string(),
            ))
        })
}

fn app_config_dir_or_unavailable(
    app: &tauri::AppHandle,
) -> Result<PathBuf, MigrationCommandErrorDto> {
    app.path().app_config_dir().map_err(|_| {
        MigrationCommandErrorDto::from(DataRootMigrationError::Unavailable(
            "app_config_dir unavailable".into(),
        ))
    })
}

/// Apply one Simple Data Root migration.
///
/// `owner_lease_id` is the raw native maintenance owner id. It is injected by
/// the purpose-bound Native capability and NEVER travels through React, the
/// coordinator, or the shared migration domain.
///
/// The SOURCE root is never accepted from the caller (§75): it always comes from
/// the authoritative bootstrap.
#[tauri::command]
pub(crate) async fn native_data_root_migration_apply(
    app: tauri::AppHandle,
    owner_lease_id: String,
    operation_id: String,
    target_data_root: String,
) -> Result<MigrationApplyResultDto, MigrationCommandErrorDto> {
    // Owner proof FIRST: nothing is opened or resolved before authorization.
    let permit = owner_proof(&app, &owner_lease_id)?;
    let app_config_dir = app_config_dir_or_unavailable(&app)?;
    let target = PathBuf::from(target_data_root);

    // §76: the tree hashing / copy / space probe / SQLite verification must not
    // block the async command executor.
    let joined = tauri::async_runtime::spawn_blocking(move || {
        apply_data_root_migration(&app_config_dir, &operation_id, &target, permit)
            .map_err(MigrationCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        // A panicking task may have died anywhere, including after the switch:
        // the outcome is unprovable, so this is BLOCKED, never RECOVERABLE.
        Err(_) => Err(MigrationCommandErrorDto::from(
            DataRootMigrationError::Internal("migration task failed to complete".into()),
        )),
    }
}

/// Reconcile an ambiguous migration and report what actually happened on disk.
#[tauri::command]
pub(crate) async fn native_data_root_migration_reconcile(
    app: tauri::AppHandle,
    owner_lease_id: String,
    operation_id: String,
    target_data_root: String,
) -> Result<MigrationReconcileResultDto, MigrationCommandErrorDto> {
    let permit = owner_proof(&app, &owner_lease_id)?;
    let app_config_dir = app_config_dir_or_unavailable(&app)?;
    let target = PathBuf::from(target_data_root);

    let joined = tauri::async_runtime::spawn_blocking(move || {
        reconcile_data_root_migration(&app_config_dir, &operation_id, &target, permit)
            .map_err(MigrationCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        Err(_) => Err(MigrationCommandErrorDto::from(
            DataRootMigrationError::Internal("reconcile task failed to complete".into()),
        )),
    }
}

// ============================================================
// Tests
// ============================================================

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maintenance::NativeMaintenanceState;
    use serde_json::json;
    use std::cell::RefCell;
    use std::sync::Arc;
    use tempfile::tempdir;

    // ---------- sandbox helpers ----------

    /// Valid bootstrap + FirstBoot-initialized Data Root in a tempdir.
    fn make_root(tmp: &Path) -> (PathBuf, PathBuf) {
        let cfg = tmp.join("cfg");
        fs::create_dir_all(&cfg).unwrap();
        let data_root = tmp.join("data");
        DataRootService::get_and_ensure(&data_root, InitMode::FirstBoot)
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

    fn uid() -> String {
        Uuid::new_v4().to_string()
    }

    fn owner() -> (Arc<NativeMaintenanceState>, String) {
        let state = Arc::new(NativeMaintenanceState::new());
        let id = state.begin_maintenance().expect("begin");
        (state, id)
    }

    fn bootstrap_root(cfg: &Path) -> PathBuf {
        match BootstrapService::load(&BootstrapService::bootstrap_path(cfg)) {
            BootstrapState::Valid(loaded) => loaded.data_root,
            _ => panic!("bootstrap.json is not Valid"),
        }
    }

    fn live_path(data_root: &Path) -> PathBuf {
        data_root.join(DB_RELATIVE_PATH)
    }

    fn sidecar_path(live: &Path, suffix: &str) -> PathBuf {
        PathBuf::from(format!("{}{suffix}", live.display()))
    }

    /// Write a valid CURRENT-schema database at an explicit path.
    ///
    /// A hand-written history table (rather than the real migration runner) is
    /// deliberate: Data Root Migration V1 must never migrate a schema, so the
    /// fixtures must not either. Only `MAX(version)` is ever read.
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
        for suffix in ["-wal", "-shm"] {
            let _ = fs::remove_file(sidecar_path(&path, suffix));
        }
        let _ = fs::remove_file(&path);
        write_current_db_at(&path, rows);
    }

    /// The operation directory a migration record lives in.
    fn op_dir_of(cfg: &Path, operation_id: &str) -> PathBuf {
        operation_dir(cfg, operation_id)
    }

    fn phase_of(op_dir: &Path) -> Option<MigrationJournalPhase> {
        match read_journal(op_dir) {
            JournalRead::Present(journal) => Some(journal.phase),
            _ => None,
        }
    }

    /// Hand-write a durable journal for a (possibly pending) operation.
    fn write_pending_journal(
        cfg: &Path,
        operation_id: &str,
        source_root: &Path,
        target_root: &Path,
        phase: MigrationJournalPhase,
    ) -> PathBuf {
        let dir = op_dir_of(cfg, operation_id);
        fs::create_dir_all(&dir).unwrap();
        let journal = MigrationOperationJournal {
            operation_id: operation_id.to_string(),
            source_data_root: source_root.to_path_buf(),
            target_data_root: target_root.to_path_buf(),
            safety_backup_id: uid(),
            phase,
            created_at_ms: 1_700_000_000_000,
            updated_at_ms: 1_700_000_000_000,
        };
        write_journal(&dir, &journal).unwrap();
        dir
    }

    /// The staging directory an operation would have created beside the target.
    fn staging_of(target: &Path, operation_id: &str) -> PathBuf {
        target
            .parent()
            .unwrap()
            .join(format!("{STAGING_PREFIX}{operation_id}"))
    }

    /// The database inside the single Safety Backup bundle of a Data Root's
    /// `backup/` directory.
    fn only_bundle_db(data_root: &Path) -> PathBuf {
        let mut bundles: Vec<PathBuf> = fs::read_dir(data_root.join("backup"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .collect();
        bundles.sort();
        assert_eq!(bundles.len(), 1, "exactly one safety backup bundle");
        bundles.remove(0).join(DB_RELATIVE_PATH)
    }

    // -------- injectable space probe (a plain `fn`, so a thread-local hook) --------

    thread_local! {
        /// A ONE-SHOT hook the free-space probe fires. It exists because the
        /// probe is reached at a very specific point in the FROZEN order —
        /// AFTER the Safety Backup and the source enumeration, BEFORE a single
        /// target byte is written — which is the only way a test can change
        /// something under the source at exactly that moment.
        static PROBE_HOOK: RefCell<Option<Box<dyn FnOnce(&Path)>>> = RefCell::new(None);
    }

    fn arm_probe_hook(hook: impl FnOnce(&Path) + 'static) {
        PROBE_HOOK.with(|slot| *slot.borrow_mut() = Some(Box::new(hook)));
    }

    fn probe_ok(path: &Path) -> Result<u64, String> {
        let hook = PROBE_HOOK.with(|slot| slot.borrow_mut().take());
        if let Some(hook) = hook {
            hook(path);
        }
        Ok(u64::MAX)
    }

    fn probe_no_space(_path: &Path) -> Result<u64, String> {
        Ok(0)
    }

    fn probe_unavailable(_path: &Path) -> Result<u64, String> {
        Err("probe exploded".into())
    }

    /// Run one apply through the injectable-probe entry point.
    fn apply(
        cfg: &Path,
        operation_id: &str,
        target: &Path,
    ) -> Result<MigrationApplyResultDto, DataRootMigrationError> {
        apply_data_root_migration_with_probe(cfg, operation_id, target, probe_ok)
    }

    fn reconcile(
        cfg: &Path,
        operation_id: &str,
        target: &Path,
    ) -> Result<MigrationReconcileResultDto, DataRootMigrationError> {
        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).expect("permit");
        reconcile_data_root_migration(cfg, operation_id, target, permit)
    }

    fn recover(cfg: &Path) -> Result<MigrationRecoveryOutcome, MigrationRecoveryBlocker> {
        recover_or_classify_pending_migrations(cfg)
    }

    /// A completely migrated sandbox: (cfg, source, target, operation id).
    fn migrated(tmp: &Path) -> (PathBuf, PathBuf, PathBuf, String) {
        let (cfg, source) = make_root(tmp);
        seed_live(&source, &["alpha", "beta"]);
        let target = tmp.join("moved");
        let operation_id = uid();
        let result = apply(&cfg, &operation_id, &target).expect("migration");
        assert_eq!(result.outcome, MigrationApplyOutcome::Migrated);
        (cfg, source, target, result.operation_id)
    }

    // ============================================================
    // target request validation (§4, §5)
    // ============================================================

    #[test]
    fn a_target_that_is_not_absolute_is_refused_before_anything_is_created() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);

        let error = apply(&cfg, &uid(), Path::new("relative/folder")).unwrap_err();

        assert_eq!(error.code(), "TARGET_INVALID");
        assert_eq!(error.disposition(), MigrationDisposition::Recoverable);
        assert!(!migration_root(&cfg).exists());
    }

    #[test]
    fn a_target_inside_the_current_data_folder_is_refused() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);

        // A path that does not exist yet, so the containment rule is what
        // rejects it rather than the "already exists" rule.
        let error = apply(&cfg, &uid(), &source.join("nested")).unwrap_err();

        assert_eq!(error.code(), "TARGET_INVALID");
        assert!(!source.join("nested").exists());
        assert!(!migration_root(&cfg).exists());
    }

    #[test]
    fn an_existing_target_is_refused_whatever_its_relation_to_the_source() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);

        // The source itself.
        assert_eq!(
            apply(&cfg, &uid(), &source).unwrap_err().code(),
            "TARGET_INVALID"
        );
        // The source's own parent.
        assert_eq!(
            apply(&cfg, &uid(), source.parent().unwrap())
                .unwrap_err()
                .code(),
            "TARGET_INVALID"
        );

        // NOTE: the explicit `target_canon == source_canon` /
        // `source_canon.starts_with(&target_canon)` branches are DEFENSIVE. They
        // cannot fire while the "the target must not exist" rule above runs
        // first: any path that equals or contains an EXISTING directory also
        // exists. Keeping them is deliberate defence in depth for §4/§5, and
        // this test pins the invariant that matters — no existing directory is
        // ever accepted, whatever its relation to the source.
        assert!(source.exists());
        assert!(!migration_root(&cfg).exists());
    }

    #[test]
    fn a_target_whose_parent_is_missing_is_refused() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);

        let error = apply(&cfg, &uid(), &tmp.path().join("nope").join("moved")).unwrap_err();

        assert_eq!(error.code(), "TARGET_INVALID");
    }

    #[test]
    fn a_network_target_is_refused() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);

        let error = apply(&cfg, &uid(), Path::new(r"\\server\share\zhixing")).unwrap_err();

        assert_eq!(error.code(), "TARGET_INVALID");
        assert!(!migration_root(&cfg).exists());
    }

    // ============================================================
    // source layout (§7–§9)
    // ============================================================

    #[test]
    fn an_unknown_top_level_entry_fails_closed() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        fs::create_dir_all(source.join("mystery")).unwrap();
        fs::write(source.join("mystery").join("payload.dat"), b"x").unwrap();

        let error = apply(&cfg, &uid(), &tmp.path().join("moved")).unwrap_err();

        assert_eq!(error.code(), "UNSUPPORTED_SOURCE_LAYOUT");
        assert!(!tmp.path().join("moved").exists());
    }

    #[test]
    fn a_missing_fixed_subdirectory_fails_closed() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        fs::remove_dir_all(source.join("thumbnails")).unwrap();

        let error = apply(&cfg, &uid(), &tmp.path().join("moved")).unwrap_err();

        assert_eq!(error.code(), "UNSUPPORTED_SOURCE_LAYOUT");
    }

    #[test]
    fn an_unknown_entry_inside_database_fails_closed() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        fs::write(source.join(DATABASE_DIR_NAME).join("notes.txt"), b"x").unwrap();

        let error = apply(&cfg, &uid(), &tmp.path().join("moved")).unwrap_err();

        assert_eq!(error.code(), "UNSUPPORTED_SOURCE_LAYOUT");
    }

    #[test]
    fn a_missing_manifest_fails_closed_at_source_resolution() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        fs::remove_file(source.join(MANIFEST_FILENAME)).unwrap();

        let error = apply(&cfg, &uid(), &tmp.path().join("moved")).unwrap_err();

        // A Data Root with no `manifest.json` is not a Data Root at all, so this
        // is caught one step EARLIER than the layout scan — while resolving the
        // authoritative source — and nothing has been created at that point.
        assert_eq!(error.code(), "UNAVAILABLE");
        assert!(!migration_root(&cfg).exists());
    }

    // ============================================================
    // pre-copy gates
    // ============================================================

    #[test]
    fn a_non_uuid_operation_id_is_refused_before_anything_is_touched() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");

        let error = apply(&cfg, "not-a-uuid", &target).unwrap_err();

        assert_eq!(error.code(), "REQUEST_INVALID");
        assert!(!target.exists());
        assert!(!migration_root(&cfg).exists());
    }

    #[test]
    fn an_operation_id_can_never_be_reused() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let operation_id = uid();

        // A pre-existing record for this id, whatever its phase.
        write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &tmp.path().join("elsewhere"),
            MigrationJournalPhase::Committed,
        );

        let error = apply(&cfg, &operation_id, &tmp.path().join("moved")).unwrap_err();

        assert_eq!(error.code(), "REQUEST_INVALID");
        assert!(!tmp.path().join("moved").exists());
    }

    #[test]
    fn an_unavailable_bootstrap_fails_closed_and_creates_nothing() {
        let tmp = tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        fs::create_dir_all(&cfg).unwrap();

        let error = apply(&cfg, &uid(), &tmp.path().join("moved")).unwrap_err();

        assert_eq!(error.code(), "UNAVAILABLE");
        assert_eq!(error.disposition(), MigrationDisposition::Recoverable);
        assert!(!migration_root(&cfg).exists());
    }

    #[test]
    fn insufficient_space_is_detected_before_a_single_target_byte_is_written() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();

        let error =
            apply_data_root_migration_with_probe(&cfg, &operation_id, &target, probe_no_space)
                .unwrap_err();

        assert_eq!(error.code(), "INSUFFICIENT_SPACE");
        assert_eq!(error.disposition(), MigrationDisposition::Recoverable);
        // The operation record exists (it must, so a restart can reconcile), but
        // no target and no staging survived.
        assert!(!target.exists());
        assert!(!staging_of(&target, &operation_id).exists());
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::SafetyBackupCreated)
        );
    }

    #[test]
    fn an_unusable_target_volume_is_reported_as_a_target_problem() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);

        let error = apply_data_root_migration_with_probe(
            &cfg,
            &uid(),
            &tmp.path().join("moved"),
            probe_unavailable,
        )
        .unwrap_err();

        assert_eq!(error.code(), "TARGET_INVALID");
    }

    // ============================================================
    // happy path
    // ============================================================

    #[test]
    fn a_happy_migration_publishes_a_byte_verified_target_and_repoints_the_bootstrap() {
        let tmp = tempdir().unwrap();
        let (cfg, source, target, operation_id) = migrated(tmp.path());

        // 1. The bootstrap points at the target, and only the root changed.
        assert_eq!(bootstrap_root(&cfg), target);

        // 2. The target is a well-formed Simple Data Root.
        let (_root, manifest) =
            DataRootService::get_and_ensure(&target, InitMode::Existing).expect("Existing target");
        for sub in FIXED_SUBDIRS {
            assert!(target.join(sub).is_dir(), "{sub}/ missing from the target");
        }
        assert!(target.join(MANIFEST_FILENAME).is_file());

        // 3. The target database is valid at the CURRENT schema.
        let target_db = DataRootService::resolve_database_path(&target, &manifest);
        assert!(database_is_valid(&target_db));

        // 4. The WHOLE tree matches the copy manifest, with no extra file.
        let op_dir = op_dir_of(&cfg, &operation_id);
        let copy_manifest = read_copy_manifest(&op_dir).expect("copy manifest");
        assert!(verify_target_against_copy_manifest(&target, &copy_manifest).is_ok());

        // 5. The source is still there, still valid, and was never switched away
        //    from silently — it simply is no longer the authoritative root.
        assert!(source.exists());
        assert!(source_is_valid(&source).is_ok());

        // 6. The record is terminal and claims the commit.
        assert_eq!(
            phase_of(&op_dir),
            Some(MigrationJournalPhase::Committed)
        );
    }

    #[test]
    fn the_permits_gated_entry_point_performs_the_same_migration() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();

        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).expect("owner permit");

        let result = apply_data_root_migration(&cfg, &operation_id, &target, permit)
            .expect("gated migration");

        assert_eq!(result.outcome, MigrationApplyOutcome::Migrated);
        assert_eq!(bootstrap_root(&cfg), target);
    }

    #[test]
    fn a_permit_is_only_issued_to_the_active_owner() {
        let (state, owner_id) = owner();
        assert!(state.acquire_owner_permit(&owner_id).is_ok());
        // A stale / foreign id is refused: the migration command can only ever
        // act as the CURRENT barrier owner.
        assert!(state.acquire_owner_permit("native-maint-someone-else").is_err());
    }

    #[test]
    fn the_target_database_is_the_safety_backup_snapshot_not_the_live_file() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["original"]);
        let live_before = sha256_file_hex(&live_path(&source)).unwrap();
        let target = tmp.path().join("moved");
        let operation_id = uid();

        // Mutate the LIVE database at the exact point between the Safety Backup
        // and the staging build. If the target were copied from the live file,
        // it would now carry this row.
        let source_for_hook = source.clone();
        arm_probe_hook(move |_| {
            let conn =
                crate::db::policy::open_configured_connection(live_path(&source_for_hook)).unwrap();
            conn.execute("INSERT INTO t(v) VALUES ('inserted-after-backup')", [])
                .unwrap();
            drop(conn);
        });

        apply(&cfg, &operation_id, &target).expect("migration");

        let live_after = sha256_file_hex(&live_path(&source)).unwrap();
        assert_ne!(live_before, live_after, "the hook must have changed the live DB");

        let op_dir = op_dir_of(&cfg, &operation_id);
        let copy_manifest = read_copy_manifest(&op_dir).unwrap();
        let entry = copy_manifest
            .entries
            .iter()
            .find(|e| e.relative_path == DB_RELATIVE_PATH)
            .expect("database entry");

        // The manifest's database entry is the SAFETY BACKUP's identity...
        assert_ne!(entry.sha256, live_after);

        // ...and the target really holds the backup's bytes. The Safety Backup is
        // produced with the SQLite Online Backup API and normalized to
        // `journal_mode=DELETE`, so it is a self-contained snapshot rather than a
        // byte copy of the (WAL-mode) live file — which is why the comparison is
        // against the bundle on disk, not against `live_before`.
        let safety_db = only_bundle_db(&source);
        let target_db = target.join(DB_RELATIVE_PATH);
        assert_eq!(sha256_file_hex(&safety_db).unwrap(), entry.sha256);
        assert_eq!(fs::metadata(&safety_db).unwrap().len(), entry.size_bytes);
        assert_eq!(
            sha256_file_hex(&target_db).unwrap(),
            sha256_file_hex(&safety_db).unwrap()
        );
        // And it is NOT the later live file.
        assert_ne!(sha256_file_hex(&target_db).unwrap(), live_after);
    }

    #[test]
    fn the_target_contains_this_migrations_own_safety_backup() {
        let tmp = tempdir().unwrap();
        let (cfg, source, target, operation_id) = migrated(tmp.path());

        let op_dir = op_dir_of(&cfg, &operation_id);
        let journal = match read_journal(&op_dir) {
            JournalRead::Present(journal) => *journal,
            _ => panic!("journal must be present"),
        };
        assert!(!journal.safety_backup_id.is_empty());

        // The safety backup was published into the SOURCE `backup/` before the
        // enumeration ran, so the target carries it too.
        let safety_root = source.join("backup");
        let bundles: Vec<String> = fs::read_dir(&safety_root)
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(bundles.len(), 1, "exactly one safety backup bundle");
        let bundle = safety_root.join(&bundles[0]);
        assert!(bundle.join(MANIFEST_FILENAME).is_file());
        assert!(bundle.join(DB_RELATIVE_PATH).is_file());

        let mirrored = target.join("backup").join(&bundles[0]);
        assert!(
            mirrored.join(DB_RELATIVE_PATH).is_file(),
            "the target's backup/ must contain this migration's own safety backup"
        );
        assert_eq!(
            sha256_file_hex(&bundle.join(DB_RELATIVE_PATH)).unwrap(),
            sha256_file_hex(&mirrored.join(DB_RELATIVE_PATH)).unwrap()
        );
    }

    #[test]
    fn the_source_tree_is_never_deleted_and_every_payload_file_survives() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        fs::write(source.join("attachments").join("note.txt"), b"payload").unwrap();
        let target = tmp.path().join("moved");
        let operation_id = uid();

        apply(&cfg, &operation_id, &target).expect("migration");

        // Source intact.
        assert_eq!(
            fs::read(source.join("attachments").join("note.txt")).unwrap(),
            b"payload"
        );
        // And the payload travelled.
        assert_eq!(
            fs::read(target.join("attachments").join("note.txt")).unwrap(),
            b"payload"
        );
    }

    #[test]
    fn no_sidecar_is_left_beside_the_target_database() {
        let tmp = tempdir().unwrap();
        let (_cfg, _source, target, _operation_id) = migrated(tmp.path());

        let db = target.join(DB_RELATIVE_PATH);
        // A read-only validation that materialises `-wal` / `-shm` would make the
        // strict "no unexpected file" verification fail and roll every migration
        // back; this pins the fix.
        assert!(!sidecar_path(&db, "-wal").exists());
        assert!(!sidecar_path(&db, "-shm").exists());
        assert!(!sidecar_path(&db, "-journal").exists());
    }

    #[test]
    fn the_copy_manifest_is_consistent_and_counts_every_byte_once() {
        let tmp = tempdir().unwrap();
        let (cfg, _source, _target, operation_id) = migrated(tmp.path());

        let manifest = read_copy_manifest(&op_dir_of(&cfg, &operation_id)).unwrap();
        assert_eq!(manifest.manifest_kind, COPY_MANIFEST_KIND);
        assert_eq!(manifest.operation_id, operation_id);
        assert!(manifest.source_data_root.is_absolute());
        assert!(manifest.target_data_root.is_absolute());

        let mut paths: Vec<&str> = manifest
            .entries
            .iter()
            .map(|e| e.relative_path.as_str())
            .collect();
        paths.sort_unstable();
        let mut deduped = paths.clone();
        deduped.dedup();
        assert_eq!(paths, deduped, "an entry must appear exactly once");
        assert!(paths.contains(&DB_RELATIVE_PATH));
        assert!(paths.contains(&MANIFEST_FILENAME));

        assert_eq!(
            manifest.required_bytes,
            manifest.entries.iter().map(|e| e.size_bytes).sum::<u64>()
        );
    }

    #[test]
    fn the_journal_is_device_local_and_carries_no_secret() {
        let tmp = tempdir().unwrap();
        let (cfg, source, target, operation_id) = migrated(tmp.path());

        let raw = fs::read_to_string(journal_path(&op_dir_of(&cfg, &operation_id))).unwrap();

        // It DOES carry both roots: that is how a later reconcile or a process
        // restart can tell which one is authoritative. They are read back
        // through the parsed document, because JSON escapes the separators.
        let source_str = source.display().to_string();
        let target_str = target.display().to_string();
        let value: serde_json::Value = serde_json::from_str(&raw).unwrap();
        assert_eq!(
            value["source_data_root"].as_str(),
            Some(source_str.as_str())
        );
        assert_eq!(
            value["target_data_root"].as_str(),
            Some(target_str.as_str())
        );

        // It does NOT carry a token, a trust credential or an owner lease: the
        // roots are device-local evidence, not a portable secret.
        for forbidden in ["token", "secret", "owner", "lease", "credential"] {
            assert!(
                !raw.to_ascii_lowercase().contains(forbidden),
                "the journal must not mention `{forbidden}`"
            );
        }
    }

    #[test]
    fn the_apply_result_never_exposes_the_source_path() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");

        let result = apply(&cfg, &uid(), &target).unwrap();
        let json = serde_json::to_string(&result).unwrap();

        assert!(!json.contains(&source.display().to_string()));
        assert!(!json.contains("cfg"));
        assert!(json.contains("targetDataRoot"));
        assert!(is_uuid_like(&result.safety_backup_id));
    }

    fn is_uuid_like(value: &str) -> bool {
        Uuid::parse_str(value).is_ok()
    }

    // ============================================================
    // failures after the point of no return
    // ============================================================

    #[test]
    fn a_publish_failure_leaves_the_source_authoritative_and_the_bootstrap_unchanged() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        injection::arm(&operation_id, injection::InjectKind::PublishFailure);

        let error = apply(&cfg, &operation_id, &target).unwrap_err();

        assert_eq!(error.code(), "TARGET_PUBLISH_FAILED");
        assert_eq!(error.disposition(), MigrationDisposition::Recoverable);
        assert_eq!(bootstrap_root(&cfg), source);
        assert!(source_is_valid(&source).is_ok());
        // Nothing was published, and the operation-owned staging directory is
        // retained rather than silently cleaned up.
        assert!(!target.exists());
        assert!(staging_of(&target, &operation_id).exists());
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::TargetStaged)
        );
    }

    #[test]
    fn a_bootstrap_switch_failure_retains_the_target_and_keeps_the_source_authoritative() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        injection::arm(
            &operation_id,
            injection::InjectKind::BootstrapSwitchFailure,
        );

        let error = apply(&cfg, &operation_id, &target).unwrap_err();

        assert_eq!(error.code(), "BOOTSTRAP_SWITCH_FAILED");
        assert_eq!(error.disposition(), MigrationDisposition::Recoverable);
        assert_eq!(bootstrap_root(&cfg), source);
        // §94: the published target is RETAINED (never deleted) while the source
        // stays authoritative.
        assert!(target.exists());
        assert!(target.join(DB_RELATIVE_PATH).is_file());
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::NotCommitted)
        );
    }

    #[test]
    fn a_bootstrap_that_moved_underneath_is_blocked_and_never_overwritten() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();

        // A THIRD, valid Data Root that the bootstrap will be re-pointed at
        // while the migration is in flight.
        let third = tmp.path().join("third-party-root");
        DataRootService::get_and_ensure(&third, InitMode::FirstBoot).unwrap();
        let third_for_hook = third.clone();
        let cfg_for_hook = cfg.clone();
        arm_probe_hook(move |_| {
            let payload = json!({
                "bootstrap_version": 1,
                "device_id": Uuid::new_v4().to_string(),
                "data_root": third_for_hook,
            });
            fs::write(
                BootstrapService::bootstrap_path(&cfg_for_hook),
                serde_json::to_string_pretty(&payload).unwrap(),
            )
            .unwrap();
        });

        let error = apply(&cfg, &operation_id, &target).unwrap_err();

        assert_eq!(error.code(), "BOOTSTRAP_CHANGED");
        // The barrier MUST stay held: which root is authoritative is exactly what
        // can no longer be proven.
        assert_eq!(error.disposition(), MigrationDisposition::Blocked);
        // The foreign root was respected, not clobbered.
        assert_eq!(bootstrap_root(&cfg), third);
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::Blocked)
        );
    }

    #[test]
    fn a_failed_post_switch_validation_is_rolled_back_and_proven() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        injection::arm(&operation_id, injection::InjectKind::PostSwitchFailure);

        let error = apply(&cfg, &operation_id, &target).unwrap_err();

        assert_eq!(error.code(), "ROLLED_BACK");
        assert_eq!(error.disposition(), MigrationDisposition::Recoverable);
        assert_eq!(bootstrap_root(&cfg), source);
        assert!(source_is_valid(&source).is_ok());
        // The target is never rescinded destructively.
        assert!(target.exists());
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::RolledBack)
        );
    }

    #[test]
    fn an_unprovable_rollback_is_switch_indeterminate_and_keeps_the_barrier() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        injection::arm(&operation_id, injection::InjectKind::PostSwitchFailure);
        injection::arm(&operation_id, injection::InjectKind::RollbackFailure);

        let error = apply(&cfg, &operation_id, &target).unwrap_err();

        assert_eq!(error.code(), "SWITCH_INDETERMINATE");
        assert_eq!(error.disposition(), MigrationDisposition::Blocked);
        // The rollback never happened, so the bootstrap still points at the
        // target — which is precisely why the outcome is unprovable.
        assert_eq!(bootstrap_root(&cfg), target);
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::Blocked)
        );
        let _ = source;
    }

    #[test]
    fn only_an_unprovable_outcome_keeps_the_barrier() {
        let blocked = [
            DataRootMigrationError::BootstrapChanged("x".into()),
            DataRootMigrationError::SwitchIndeterminate("x".into()),
            DataRootMigrationError::Internal("x".into()),
        ];
        for error in blocked {
            assert_eq!(
                error.disposition(),
                MigrationDisposition::Blocked,
                "{} must be BLOCKED",
                error.code()
            );
        }

        let recoverable = [
            DataRootMigrationError::Unavailable("x".into()),
            DataRootMigrationError::RequestInvalid("x".into()),
            DataRootMigrationError::TargetInvalid("x".into()),
            DataRootMigrationError::UnsupportedSourceLayout("x".into()),
            DataRootMigrationError::InsufficientSpace("x".into()),
            DataRootMigrationError::SafetyBackupFailed("x".into()),
            DataRootMigrationError::CopyFailed("x".into()),
            DataRootMigrationError::VerifyFailed("x".into()),
            DataRootMigrationError::TargetPublishFailed("x".into()),
            DataRootMigrationError::BootstrapSwitchFailed("x".into()),
            DataRootMigrationError::RolledBack("x".into()),
            DataRootMigrationError::UnsupportedPlatform,
        ];
        for error in recoverable {
            assert_eq!(
                error.disposition(),
                MigrationDisposition::Recoverable,
                "{} must be RECOVERABLE",
                error.code()
            );
        }
    }

    #[test]
    fn every_failure_code_is_stable_unique_and_has_a_safe_message() {
        let errors = [
            DataRootMigrationError::Unavailable("x".into()),
            DataRootMigrationError::RequestInvalid("x".into()),
            DataRootMigrationError::TargetInvalid("x".into()),
            DataRootMigrationError::UnsupportedSourceLayout("x".into()),
            DataRootMigrationError::InsufficientSpace("x".into()),
            DataRootMigrationError::SafetyBackupFailed("x".into()),
            DataRootMigrationError::CopyFailed("x".into()),
            DataRootMigrationError::VerifyFailed("x".into()),
            DataRootMigrationError::TargetPublishFailed("x".into()),
            DataRootMigrationError::BootstrapSwitchFailed("x".into()),
            DataRootMigrationError::BootstrapChanged("x".into()),
            DataRootMigrationError::RolledBack("x".into()),
            DataRootMigrationError::SwitchIndeterminate("x".into()),
            DataRootMigrationError::UnsupportedPlatform,
            DataRootMigrationError::Internal("x".into()),
        ];

        let mut codes: Vec<&str> = Vec::new();
        for error in &errors {
            let code = error.code();
            assert!(!code.is_empty());
            assert!(code.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
            assert!(!error.safe_message().is_empty());
            // No raw detail ever crosses the boundary.
            assert!(!error.safe_message().contains('x'));
            codes.push(code);
        }
        let unique: BTreeSet<&str> = codes.iter().copied().collect();
        assert_eq!(unique.len(), codes.len(), "codes must be unique");
    }

    #[test]
    fn the_transport_dto_exposes_exactly_the_coarse_safe_triple() {
        let dto = MigrationCommandErrorDto::from(DataRootMigrationError::VerifyFailed(
            "C:\\secret\\zhixing.db exploded".into(),
        ));

        assert_eq!(dto.code, "VERIFY_FAILED");
        assert_eq!(dto.disposition, "RECOVERABLE");
        assert!(!dto.message.contains("secret"));
        assert!(!dto.message.contains("zhixing.db"));
        assert_eq!(
            dto.message,
            DataRootMigrationError::VerifyFailed(String::new()).safe_message()
        );
    }

    // ============================================================
    // same-process reconcile (§49–§53)
    // ============================================================

    #[test]
    fn reconcile_proves_committed_from_the_migrated_bytes() {
        let tmp = tempdir().unwrap();
        let (cfg, _source, target, operation_id) = migrated(tmp.path());

        let result = reconcile(&cfg, &operation_id, &target).unwrap();

        assert_eq!(result.outcome, MigrationReconcileOutcome::Committed);
        assert!(result.reason_code.is_none());
        assert!(result.safety_backup_id.is_some());
    }

    #[test]
    fn reconcile_proves_not_committed_when_the_source_is_still_authoritative() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        // A pending record that never reached the switch.
        write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &target,
            MigrationJournalPhase::TargetStaged,
        );

        let result = reconcile(&cfg, &operation_id, &target).unwrap();

        assert_eq!(result.outcome, MigrationReconcileOutcome::NotCommitted);
        assert_eq!(
            phase_of(&op_dir_of(&cfg, &operation_id)),
            Some(MigrationJournalPhase::NotCommitted)
        );
    }

    #[test]
    fn reconcile_reports_rolled_back_when_the_source_is_live_again_after_a_switch() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &target,
            MigrationJournalPhase::BootstrapSwitched,
        );

        let result = reconcile(&cfg, &operation_id, &target).unwrap();

        // The journal DID reach the switch, so the source being authoritative
        // again means the switch was undone.
        assert_eq!(result.outcome, MigrationReconcileOutcome::RolledBack);
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_target_no_longer_verifies() {
        let tmp = tempdir().unwrap();
        let (cfg, _source, target, operation_id) = migrated(tmp.path());
        // Break the target after the fact.
        fs::remove_file(target.join(DB_RELATIVE_PATH)).unwrap();

        let result = reconcile(&cfg, &operation_id, &target).unwrap();

        assert_eq!(result.outcome, MigrationReconcileOutcome::Indeterminate);
        assert_eq!(result.reason_code, Some(MigrationReconcileReason::TargetInvalid));
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_journal_is_absent_or_unreadable() {
        let tmp = tempdir().unwrap();
        let (cfg, _source) = make_root(tmp.path());
        let target = tmp.path().join("moved");

        // Absent.
        let absent = reconcile(&cfg, &uid(), &target).unwrap();
        assert_eq!(absent.outcome, MigrationReconcileOutcome::Indeterminate);
        assert_eq!(
            absent.reason_code,
            Some(MigrationReconcileReason::JournalMissing)
        );

        // Present but unreadable.
        let operation_id = uid();
        let dir = op_dir_of(&cfg, &operation_id);
        fs::create_dir_all(&dir).unwrap();
        fs::write(journal_path(&dir), b"{ not json").unwrap();
        let unreadable = reconcile(&cfg, &operation_id, &target).unwrap();
        assert_eq!(
            unreadable.reason_code,
            Some(MigrationReconcileReason::JournalUnreadable)
        );
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_bootstrap_points_at_neither_root() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &target,
            MigrationJournalPhase::TargetPublished,
        );

        // Re-point the bootstrap at a third root.
        let third = tmp.path().join("third");
        DataRootService::get_and_ensure(&third, InitMode::FirstBoot).unwrap();
        let payload = json!({
            "bootstrap_version": 1,
            "device_id": Uuid::new_v4().to_string(),
            "data_root": third,
        });
        fs::write(
            BootstrapService::bootstrap_path(&cfg),
            serde_json::to_string_pretty(&payload).unwrap(),
        )
        .unwrap();

        let result = reconcile(&cfg, &operation_id, &target).unwrap();

        assert_eq!(result.outcome, MigrationReconcileOutcome::Indeterminate);
        assert_eq!(
            result.reason_code,
            Some(MigrationReconcileReason::BootstrapPointsNeither)
        );
    }

    #[test]
    fn reconcile_is_indeterminate_when_the_source_no_longer_verifies() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        let operation_id = uid();
        write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &target,
            MigrationJournalPhase::TargetPublished,
        );
        // The bootstrap still points at the source, but the source is broken.
        fs::remove_file(live_path(&source)).unwrap();

        let result = reconcile(&cfg, &operation_id, &target).unwrap();

        assert_eq!(result.outcome, MigrationReconcileOutcome::Indeterminate);
        assert_eq!(result.reason_code, Some(MigrationReconcileReason::SourceInvalid));
    }

    // ============================================================
    // startup recovery gate (§58–§65)
    // ============================================================

    #[test]
    fn startup_is_a_no_op_without_a_migration_tree() {
        let tmp = tempdir().unwrap();
        let (cfg, _source) = make_root(tmp.path());

        assert_eq!(recover(&cfg).unwrap(), MigrationRecoveryOutcome::Clear);
        assert!(!migration_root(&cfg).exists());
    }

    #[test]
    fn startup_ignores_terminal_history_and_never_deletes_it() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let operation_id = uid();
        let dir = write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &tmp.path().join("moved"),
            MigrationJournalPhase::Committed,
        );

        assert_eq!(recover(&cfg).unwrap(), MigrationRecoveryOutcome::Clear);
        // The history is evidence, not garbage.
        assert!(dir.exists());
        assert_eq!(
            phase_of(&dir),
            Some(MigrationJournalPhase::Committed)
        );
    }

    #[test]
    fn startup_terminalizes_a_pending_operation_from_disk_truth() {
        let tmp = tempdir().unwrap();
        let (cfg, _source, target, operation_id) = migrated(tmp.path());

        // Make the record look like a crash left it behind.
        write_pending_journal(
            &cfg,
            &operation_id,
            &target,
            &target,
            MigrationJournalPhase::TargetPublished,
        );

        let outcome = recover(&cfg).unwrap();
        assert_eq!(
            outcome,
            MigrationRecoveryOutcome::Reconciled {
                operation_id: operation_id.clone(),
                phase: MigrationJournalPhase::Committed,
            }
        );
    }

    #[test]
    fn startup_proves_rolled_back_when_a_switched_operation_was_undone() {
        let tmp = tempdir().unwrap();
        let (cfg, source, target, operation_id) = migrated(tmp.path());
        // Point the bootstrap back at the source, as a rollback would.
        let payload = json!({
            "bootstrap_version": 1,
            "device_id": Uuid::new_v4().to_string(),
            "data_root": source,
        });
        fs::write(
            BootstrapService::bootstrap_path(&cfg),
            serde_json::to_string_pretty(&payload).unwrap(),
        )
        .unwrap();
        write_pending_journal(
            &cfg,
            &operation_id,
            &source,
            &target,
            MigrationJournalPhase::BootstrapSwitched,
        );

        assert_eq!(
            recover(&cfg).unwrap(),
            MigrationRecoveryOutcome::Reconciled {
                operation_id,
                phase: MigrationJournalPhase::RolledBack,
            }
        );
    }

    #[test]
    fn startup_disk_truth_outranks_a_blocked_journal() {
        let tmp = tempdir().unwrap();
        let (cfg, _source, target, operation_id) = migrated(tmp.path());
        // A journal that admits defeat, over a target that provably holds the data.
        write_pending_journal(
            &cfg,
            &operation_id,
            &target,
            &target,
            MigrationJournalPhase::Blocked,
        );

        assert_eq!(
            recover(&cfg).unwrap(),
            MigrationRecoveryOutcome::Reconciled {
                operation_id,
                phase: MigrationJournalPhase::Committed,
            }
        );
    }

    #[test]
    fn startup_fails_closed_when_a_pending_operation_has_no_readable_journal() {
        let tmp = tempdir().unwrap();
        let (cfg, _source) = make_root(tmp.path());

        // An operation directory with no journal at all.
        let missing = op_dir_of(&cfg, &uid());
        fs::create_dir_all(&missing).unwrap();
        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::JournalMalformed
        );

        // ...and one whose journal is present but unreadable.
        fs::write(journal_path(&missing), b"{ nope").unwrap();
        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::JournalMalformed
        );
    }

    #[test]
    fn startup_fails_closed_on_multiple_pending_operations() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        write_pending_journal(
            &cfg,
            &uid(),
            &source,
            &target,
            MigrationJournalPhase::TargetStaged,
        );
        write_pending_journal(
            &cfg,
            &uid(),
            &source,
            &target,
            MigrationJournalPhase::Preparing,
        );

        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::MultiplePendingOperations
        );
    }

    #[test]
    fn startup_fails_closed_when_bootstrap_is_missing_while_a_migration_is_pending() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        write_pending_journal(
            &cfg,
            &uid(),
            &source,
            &target,
            MigrationJournalPhase::TargetPublished,
        );
        fs::remove_file(BootstrapService::bootstrap_path(&cfg)).unwrap();

        // 🔒 A pending migration must NEVER fall through into FirstBoot.
        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::BootstrapMissing
        );
    }

    #[test]
    fn startup_fails_closed_when_the_bootstrap_points_at_neither_root() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        write_pending_journal(
            &cfg,
            &uid(),
            &source,
            &target,
            MigrationJournalPhase::TargetPublished,
        );
        let third = tmp.path().join("third");
        DataRootService::get_and_ensure(&third, InitMode::FirstBoot).unwrap();
        let payload = json!({
            "bootstrap_version": 1,
            "device_id": Uuid::new_v4().to_string(),
            "data_root": third,
        });
        fs::write(
            BootstrapService::bootstrap_path(&cfg),
            serde_json::to_string_pretty(&payload).unwrap(),
        )
        .unwrap();

        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::BootstrapPointsNeither
        );
    }

    #[test]
    fn startup_fails_closed_when_the_target_does_not_verify() {
        let tmp = tempdir().unwrap();
        let (cfg, _source, target, operation_id) = migrated(tmp.path());
        write_pending_journal(
            &cfg,
            &operation_id,
            &target,
            &target,
            MigrationJournalPhase::TargetPublished,
        );
        // The bootstrap still points at the target, but the target is damaged.
        fs::remove_file(target.join(MANIFEST_FILENAME)).unwrap();

        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::TargetInvalid
        );
    }

    #[test]
    fn startup_fails_closed_when_the_source_does_not_verify() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        let target = tmp.path().join("moved");
        // A NON-TERMINAL phase is required, or the startup gate would correctly
        // ignore the record as settled history.
        write_pending_journal(
            &cfg,
            &uid(),
            &source,
            &target,
            MigrationJournalPhase::TargetPublished,
        );
        fs::remove_file(live_path(&source)).unwrap();

        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::SourceInvalid
        );
    }

    #[test]
    fn startup_fails_closed_on_a_malformed_migration_tree() {
        let tmp = tempdir().unwrap();
        let (cfg, _source) = make_root(tmp.path());

        // A directory name that is not a canonical operation id.
        fs::create_dir_all(migration_root(&cfg).join("not-an-operation-id")).unwrap();
        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::RootMalformed
        );

        // A plain FILE among the operation directories.
        fs::remove_dir_all(migration_root(&cfg)).unwrap();
        fs::create_dir_all(migration_root(&cfg)).unwrap();
        fs::write(migration_root(&cfg).join("stray.txt"), b"x").unwrap();
        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::RootMalformed
        );
    }

    #[test]
    fn startup_fails_closed_on_incomplete_evidence() {
        let tmp = tempdir().unwrap();
        let (cfg, _source) = make_root(tmp.path());

        // A pending journal whose roots are not absolute cannot be reasoned about.
        let operation_id = uid();
        let dir = op_dir_of(&cfg, &operation_id);
        fs::create_dir_all(&dir).unwrap();
        let journal = MigrationOperationJournal {
            operation_id: operation_id.clone(),
            source_data_root: PathBuf::from("relative/source"),
            target_data_root: PathBuf::from("relative/target"),
            safety_backup_id: uid(),
            phase: MigrationJournalPhase::TargetPublished,
            created_at_ms: 1,
            updated_at_ms: 1,
        };
        write_journal(&dir, &journal).unwrap();

        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::EvidenceContradictory
        );
    }

    #[test]
    fn startup_fails_closed_when_the_bootstrap_is_unreadable() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["a"]);
        write_pending_journal(
            &cfg,
            &uid(),
            &source,
            &tmp.path().join("moved"),
            MigrationJournalPhase::TargetStaged,
        );
        fs::write(BootstrapService::bootstrap_path(&cfg), b"{ broken").unwrap();

        assert_eq!(
            recover(&cfg).unwrap_err().code,
            MigrationRecoveryBlockerCode::BootstrapUnreadable
        );
    }

    #[test]
    fn every_recovery_blocker_kind_is_prefixed_and_machine_readable() {
        use MigrationRecoveryBlockerCode as Code;

        let all = [
            Code::RootUnreadable,
            Code::RootMalformed,
            Code::MultiplePendingOperations,
            Code::JournalMalformed,
            Code::BootstrapMissing,
            Code::BootstrapUnreadable,
            Code::BootstrapPointsNeither,
            Code::TargetInvalid,
            Code::SourceInvalid,
            Code::EvidenceContradictory,
        ];

        let mut kinds: Vec<&str> = Vec::new();
        for code in all {
            let kind = code.kind();
            assert!(
                kind.starts_with("DATA_ROOT_MIGRATION_RECOVERY_"),
                "{kind} must carry the frozen prefix"
            );
            assert!(kind.chars().all(|c| c.is_ascii_uppercase() || c == '_'));
            kinds.push(kind);
        }
        let unique: BTreeSet<&str> = kinds.iter().copied().collect();
        assert_eq!(unique.len(), kinds.len(), "kinds must be unique");
    }

    #[test]
    fn a_recovery_blocker_becomes_a_distinguishable_degraded_issue() {
        let blocker = recovery_blocker(
            MigrationRecoveryBlockerCode::BootstrapPointsNeither,
            Some(Path::new("C:/cfg/bootstrap.json")),
            "points at neither",
        );

        // The subsystem tag is what lets the UI tell this apart from a schema
        // migration failure or a missing Data Root.
        let issue = crate::Issue::from(blocker);
        assert_eq!(issue.subsystem, "data_root_migration");
        assert_eq!(
            issue.kind,
            "DATA_ROOT_MIGRATION_RECOVERY_POINTS_NEITHER"
        );
    }

    // ============================================================
    // the atomic bootstrap re-point (§37–§40)
    // ============================================================

    #[test]
    fn the_atomic_rewrite_changes_only_the_root() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        let target = tmp.path().join("moved");
        DataRootService::get_and_ensure(&target, InitMode::FirstBoot).unwrap();

        let bootstrap_path = BootstrapService::bootstrap_path(&cfg);
        let before = match BootstrapService::load(&bootstrap_path) {
            BootstrapState::Valid(loaded) => loaded,
            _ => panic!("valid bootstrap"),
        };

        let after =
            rewrite_data_root_atomically(&bootstrap_path, &source, &target).expect("rewrite");

        assert_eq!(after.data_root, target);
        // The device identity and the bootstrap schema version are PRESERVED: a
        // migration must never regenerate an identity and never doubles as a
        // bootstrap upgrade.
        assert_eq!(after.device_id, before.device_id);
        assert_eq!(after.bootstrap_version, before.bootstrap_version);
        // No temp file survives.
        assert!(!bootstrap_path.with_extension("json.migrating").exists());
    }

    #[test]
    fn the_atomic_rewrite_refuses_when_the_current_root_is_not_the_expected_one() {
        let tmp = tempdir().unwrap();
        let (cfg, _source) = make_root(tmp.path());
        let real = tmp.path().join("real");
        let other = tmp.path().join("other");
        DataRootService::get_and_ensure(&real, InitMode::FirstBoot).unwrap();
        DataRootService::get_and_ensure(&other, InitMode::FirstBoot).unwrap();

        let bootstrap_path = BootstrapService::bootstrap_path(&cfg);
        let before = fs::read(&bootstrap_path).unwrap();

        // The caller expects `real` but the bootstrap points elsewhere: this must
        // NOT be overwritten, because another state already moved it.
        let error = rewrite_data_root_atomically(&bootstrap_path, &real, &other).unwrap_err();
        assert!(matches!(error, BootstrapRewriteError::Changed));
        assert_eq!(fs::read(&bootstrap_path).unwrap(), before);
    }

    #[test]
    fn the_atomic_rewrite_fails_closed_on_a_missing_bootstrap() {
        let tmp = tempdir().unwrap();
        let cfg = tmp.path().join("cfg");
        fs::create_dir_all(&cfg).unwrap();
        let bootstrap_path = BootstrapService::bootstrap_path(&cfg);

        let error =
            rewrite_data_root_atomically(&bootstrap_path, tmp.path(), &tmp.path().join("t"))
                .unwrap_err();
        assert!(matches!(error, BootstrapRewriteError::Unavailable(_)));
        assert!(!bootstrap_path.exists());
    }

    // ============================================================
    // P6-S9R2 / R1 — the runtime handoff to the production resolver
    // ============================================================
    //
    // Everything above proves the migration did its job. None of it proves the
    // thing that actually matters afterwards: that the NEXT ordinary command
    // reads the TARGET. The bootstrap string being the target is necessary, not
    // sufficient — the resolver has to re-derive the database path from it.

    /// Build the REAL production schema (every frozen migration) in a root's
    /// live database, plus one ordinary task row.
    ///
    /// The S9 fixtures deliberately write a hand-rolled `schema_migrations`
    /// table instead, because Data Root Migration V1 must never migrate a
    /// schema. This one has to: the handoff can only be observed through a real
    /// production API, and there is none for a table called `t`.
    fn seed_production_schema(data_root: &Path) {
        let database_path = live_path(data_root);
        let mut connection =
            crate::db::policy::open_configured_connection(&database_path).unwrap();
        crate::db::migration::MigrationRunner::new(
            crate::db::definitions::MIGRATIONS,
            crate::db::snapshot::SqliteBackupSnapshot,
        )
        .run(&mut connection, &data_root.join("backup"))
        .expect("apply the production schema");
        connection
            .execute(
                "INSERT INTO tasks(id, title, status, created_at_ms, updated_at_ms) \
                 VALUES('task-1', 'before-migration', 'todo', 1, 1)",
                [],
            )
            .unwrap();
        drop(connection);
    }

    /// Rename the fixture task inside ONE database.
    ///
    /// TEST-ONLY divergence (P6-S9R2/§5): it is not part of the migration, it
    /// just makes the two roots distinguishable so the assertion below cannot
    /// be satisfied by accident.
    fn rename_fixture_task(database_path: &Path, title: &str) {
        let connection =
            crate::db::policy::open_configured_connection(database_path).unwrap();
        connection
            .execute(
                "UPDATE tasks SET title = ?1 WHERE id = 'task-1'",
                [title],
            )
            .unwrap();
        connection.close().unwrap();
    }

    #[test]
    fn committed_migration_makes_the_next_production_open_use_the_target_data_root() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_production_schema(&source);

        let target = tmp.path().join("moved");
        let operation_id = uid();
        let (state, owner_id) = owner();
        let permit = state.acquire_owner_permit(&owner_id).expect("permit");
        let result =
            apply_data_root_migration(&cfg, &operation_id, &target, permit).expect("migration");
        assert_eq!(result.outcome, MigrationApplyOutcome::Migrated);

        // The handoff happens AFTER the barrier is gone: ordinary Task commands
        // carry no maintenance lease at all.
        state.end_maintenance(&owner_id).expect("release");
        assert!(state.active_owner_id().is_none());

        assert_eq!(bootstrap_root(&cfg), target);
        assert!(source.exists(), "the old root must be retained");

        // Divergence. Right now BOTH roots are byte-identical for this task, so
        // "the row is readable" would prove nothing at all about which root was
        // opened.
        rename_fixture_task(&live_path(&source), "SOURCE_ONLY");
        rename_fixture_task(&live_path(&target), "TARGET_ONLY");

        // THE handoff. `TaskDbService::open_existing` is the exact entry point
        // every Task command uses: app_config_dir → bootstrap → Existing root →
        // <root>/database/zhixing.db. Nothing here mentions either root.
        let connection = crate::task::TaskDbService::open_existing(&cfg).expect("production open");
        let titles: Vec<String> = crate::task::TaskDbService::list(&connection)
            .expect("production list")
            .into_iter()
            .map(|task| task.title)
            .collect();

        assert!(
            titles.contains(&"TARGET_ONLY".to_string()),
            "the resolver must read the TARGET root, got {titles:?}"
        );
        assert!(
            !titles.contains(&"SOURCE_ONLY".to_string()),
            "the resolver must not read the old SOURCE root, got {titles:?}"
        );
        assert_eq!(titles, vec!["TARGET_ONLY".to_string()]);
    }

    // ============================================================
    // P6-S9R2 / R2 — symlink / junction / reparse fails closed
    // ============================================================

    /// Windows file-attribute bits the reparse test reasons about.
    #[cfg(windows)]
    const WIN_ATTR_READONLY: u32 = 0x0001;
    #[cfg(windows)]
    const WIN_ATTR_HIDDEN: u32 = 0x0002;
    #[cfg(windows)]
    const WIN_ATTR_SYSTEM: u32 = 0x0004;
    #[cfg(windows)]
    const WIN_ATTR_DIRECTORY: u32 = 0x0010;
    #[cfg(windows)]
    const WIN_ATTR_ARCHIVE: u32 = 0x0020;
    #[cfg(windows)]
    const WIN_ATTR_NORMAL: u32 = 0x0080;

    /// The reparse policy, proven WITHOUT creating any link: no junction, no
    /// symlink, no elevation, no Developer Mode — so this evidence holds on any
    /// Windows runner (P6-S9R2/§11).
    #[test]
    #[cfg(windows)]
    fn the_reparse_bit_is_classified_without_creating_any_link() {
        // Anything carrying the bit is refused, whatever else it claims to be.
        // The `REPARSE | DIRECTORY` case is precisely what
        // `FileType::is_symlink` misses: a junction looks like an ordinary
        // directory to Rust's standard file-type query.
        assert!(is_reparse_attribute(FILE_ATTRIBUTE_REPARSE_POINT));
        assert!(is_reparse_attribute(
            FILE_ATTRIBUTE_REPARSE_POINT | WIN_ATTR_DIRECTORY
        ));
        assert!(is_reparse_attribute(
            FILE_ATTRIBUTE_REPARSE_POINT | WIN_ATTR_ARCHIVE | WIN_ATTR_READONLY
        ));
        // ...and no innocent entry is mistaken for one.
        assert!(!is_reparse_attribute(0));
        assert!(!is_reparse_attribute(WIN_ATTR_NORMAL));
        assert!(!is_reparse_attribute(WIN_ATTR_DIRECTORY));
        assert!(!is_reparse_attribute(
            WIN_ATTR_DIRECTORY
                | WIN_ATTR_ARCHIVE
                | WIN_ATTR_READONLY
                | WIN_ATTR_HIDDEN
                | WIN_ATTR_SYSTEM
        ));
    }

    /// Create a real Windows directory redirection. Junctions need no
    /// elevation; symbolic links do on a hardened box, so they are only a
    /// fallback here. Returns false when neither is possible on this machine.
    #[cfg(windows)]
    fn try_create_reparse_directory(target: &Path, link: &Path) -> bool {
        let junction = std::process::Command::new("cmd")
            .args(["/c", "mklink", "/J"])
            .arg(link)
            .arg(target)
            .output();
        if matches!(&junction, Ok(out) if out.status.success()) {
            return true;
        }
        std::os::windows::fs::symlink_dir(target, link).is_ok()
    }

    /// SUPPLEMENTARY (P6-S9R2/§14): the policy is already proven privilege-free
    /// above; this proves the scanner really consults it, end to end, with a
    /// redirection the OS can actually create here.
    #[test]
    #[cfg(windows)]
    fn a_reparse_entry_inside_an_approved_subtree_fails_closed() {
        let tmp = tempdir().unwrap();
        let (cfg, source) = make_root(tmp.path());
        seed_live(&source, &["alpha"]);

        // Payload OUTSIDE the Data Root: if the copy ever followed the entry,
        // these bytes would be pulled into the target.
        let outside = tmp.path().join("outside");
        fs::create_dir_all(&outside).unwrap();
        let secret = outside.join("secret.txt");
        fs::write(&secret, b"OUTSIDE").unwrap();

        // A plain top-level name would already be refused as an unknown entry;
        // placing it INSIDE an approved subtree targets the reparse rule itself.
        let link = source.join("attachments").join("mirror");
        if !try_create_reparse_directory(&outside, &link) {
            // Neither junction nor symlink is creatable here. The detection
            // policy is still proven by the attribute test above.
            return;
        }
        let meta = fs::symlink_metadata(&link).unwrap();
        assert!(
            is_reparse_point(&meta),
            "the fixture really must be a reparse point"
        );

        let target = tmp.path().join("moved");
        let error = apply(&cfg, &uid(), &target).unwrap_err();

        assert_eq!(error.code(), "UNSUPPORTED_SOURCE_LAYOUT");
        // Nothing followed it, was published, or was switched.
        assert_eq!(bootstrap_root(&cfg), source);
        assert!(!target.exists(), "no target may be published");
        assert_eq!(fs::read(&secret).unwrap(), b"OUTSIDE");
        assert!(source.join("attachments").is_dir());
        // No operation-owned staging directory survived either.
        let siblings = dir_entries(tmp.path()).unwrap();
        assert!(
            siblings.iter().all(|(name, _)| !name.starts_with(STAGING_PREFIX)),
            "no staging directory may be left beside the target"
        );
    }
}
