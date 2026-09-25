//! Native Backup Inventory / Verification (P6-S6).
//!
//! P6-S5 can CREATE one verified backup bundle. This module adds the read-only
//! counterpart: discover the bundles that already exist, describe them honestly,
//! and verify one of them on explicit request.
//!
//! Two operations with deliberately different costs (never conflated):
//!
//! * **Inventory** (`native_backup_list`) — cheap. Scan `backup/` (top level
//!   only), read each manifest, validate its structure + path safety, check the
//!   required files and their SIZE metadata, and classify. It does NOT
//!   recompute SHA-256 and does NOT open any database. A `STRUCTURALLY_VALID`
//!   result is explicitly NOT a claim that the bundle is intact.
//! * **Full verification** (`native_backup_verify`) — expensive and explicit.
//!   Re-resolve the bundle by id, re-run the structural validation, then stream
//!   SHA-256 and run a READ-ONLY `PRAGMA integrity_check`. A future Restore MUST
//!   go through this path.
//!
//! Frozen classification rule (status axis):
//!   * `INCOMPLETE`  — a required part is ABSENT (staging dir, missing manifest,
//!     missing database file). Nothing is contradictory; the bundle is not whole.
//!   * `INVALID`     — every required part is present but a hard rule is
//!     violated (unreadable/incoherent manifest, unsafe database path, unsafe
//!     symlink, non-regular database, size mismatch, duplicated identity).
//!   * `UNSUPPORTED` — well-formed under a format/scope this build cannot
//!     consume. NEVER reported as corrupt: a newer bundle may be perfectly valid.
//!   * `STRUCTURALLY_VALID` — manifest + structure + metadata checks all passed.
//!
//! Frozen verification rule (second, independent axis):
//!   `NOT_VERIFIED` (list never verifies) / `VERIFIED` / `FAILED`.
//!   Only an explicit `native_backup_verify` can produce `VERIFIED`.
//!
//! Hard rules (frozen):
//! - NEVER claim a bundle is verified, safe, or restorable from a list call.
//! - NEVER follow a symlink (bundle, manifest, or database) — `INVALID`.
//! - NEVER read outside the bundle: the database path must be exactly the V1
//!   canonical `database/zhixing.db`, so a hostile manifest cannot redirect us.
//! - NEVER create the `backup/` root; a missing root fails closed.
//! - NEVER delete / repair / resume / publish anything (Cleanup and Management
//!   are later slices). `Migration Snapshot != User Backup`: migration snapshot
//!   files and unknown entries are ignored, never deleted and never reported.
//! - NEVER touch the live source database, and NEVER take the strong
//!   maintenance barrier: inventory and verification only read backup copies.
//! - `verifyBackup(backupId)` NEVER picks arbitrarily: an ambiguous id (two
//!   bundles claiming it) fails closed.

use std::cmp::Ordering;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use tauri::Manager;
use thiserror::Error;
use uuid::Uuid;

use crate::backup::{
    resolve_existing_backup_root, resolve_existing_data_root, BackupManifest, BackupScope,
    BackupScopeDto, BACKUP_DIR_NAME, BUNDLE_PREFIX, FORMAT_VERSION, MANIFEST_FILENAME,
    MANIFEST_KIND, STAGING_PREFIX,
};
use crate::db::checksum::sha256_file_hex;
use crate::storage::manifest::DB_RELATIVE_PATH;

// ============================================================
// Error model (independent from the creation subsystem)
// ============================================================

/// Structured inventory / verification failure.
///
/// A *damaged backup* is NEVER an error: it is a data result
/// (`verificationStatus = FAILED` + a reason code). Command-level errors are
/// reserved for "this request cannot be served at all": unavailable Data Root
/// or `backup/` root, unknown / ambiguous id, or an internal failure.
///
/// The concrete `String` detail is for Rust tracing only and never crosses the
/// UI boundary.
#[derive(Debug, Error)]
pub(crate) enum BackupInventoryError {
    /// Bootstrap missing/degraded, Data Root unavailable, or `backup/` missing.
    #[error("backup inventory unavailable: {0}")]
    Unavailable(String),
    /// No bundle in the authoritative backup root claims the requested id.
    #[error("backup not found: {0}")]
    NotFound(String),
    /// More than one bundle claims the requested id, so identity-based
    /// operations on it are unsafe.
    #[error("backup id ambiguous: {0}")]
    Ambiguous(String),
    /// The request itself is unusable (e.g. the id is not a UUID).
    #[error("invalid backup request: {0}")]
    RequestInvalid(String),
    /// The located bundle is a format/scope this build cannot verify.
    #[error("unsupported backup: {0}")]
    Unsupported(String),
    /// Scanning, parsing, or the blocking task failed.
    #[error("backup inventory internal failure: {0}")]
    Internal(String),
}

impl BackupInventoryError {
    /// Coarse, UI-safe machine code.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            BackupInventoryError::Unavailable(_) => "UNAVAILABLE",
            BackupInventoryError::NotFound(_) => "NOT_FOUND",
            BackupInventoryError::Ambiguous(_) => "AMBIGUOUS",
            BackupInventoryError::RequestInvalid(_) => "REQUEST_INVALID",
            BackupInventoryError::Unsupported(_) => "UNSUPPORTED",
            BackupInventoryError::Internal(_) => "INTERNAL",
        }
    }

    /// Fixed, UI-safe human message (no path / SQLite / filesystem internals).
    pub(crate) fn safe_message(&self) -> &'static str {
        match self {
            BackupInventoryError::Unavailable(_) => {
                "The backup list is currently unavailable."
            }
            BackupInventoryError::NotFound(_) => "The requested backup was not found.",
            BackupInventoryError::Ambiguous(_) => {
                "The requested backup id is ambiguous and cannot be used."
            }
            BackupInventoryError::RequestInvalid(_) => "The backup request was invalid.",
            BackupInventoryError::Unsupported(_) => {
                "This backup format is not supported by this version."
            }
            BackupInventoryError::Internal(_) => "The backup list could not be read.",
        }
    }
}

/// Transport error DTO. Only a coarse `code` and a safe message cross the
/// boundary; the `BackupInventoryError` detail goes to tracing.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupInventoryCommandErrorDto {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl From<BackupInventoryError> for BackupInventoryCommandErrorDto {
    fn from(error: BackupInventoryError) -> Self {
        tracing::warn!(
            target: "zhixing::backup_inventory",
            error = %error,
            "native backup inventory failure"
        );
        Self {
            code: error.code(),
            message: error.safe_message(),
        }
    }
}

// ============================================================
// Status axes
// ============================================================

/// Structural classification. `StructurallyValid` is NOT "verified".
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum BackupInventoryStatus {
    StructurallyValid,
    Incomplete,
    Invalid,
    Unsupported,
}

/// Independent verification axis. Only an explicit verify can leave
/// `NotVerified`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum BackupVerificationStatus {
    NotVerified,
    Verified,
    Failed,
}

/// Safe, UI-exposable reason codes. Never a raw filesystem or SQLite message.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum BackupReasonCode {
    // --- structural (inventory) ---
    StagingIncomplete,
    ManifestMissing,
    ManifestInvalid,
    UnsupportedFormat,
    UnsafeDatabasePath,
    DatabaseMissing,
    DatabaseNotRegular,
    SizeMismatch,
    InvalidChecksumMetadata,
    UnsupportedScope,
    DuplicateBackupId,
    SymlinkNotAllowed,
    // --- verification only ---
    ChecksumMismatch,
    IntegrityFailed,
    DatabaseUnreadable,
}

// ============================================================
// Transport DTOs
// ============================================================

/// One entry of the backup inventory. Carries no absolute path.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupInventoryItemDto {
    /// Present iff the manifest was readable and claimed a valid identity.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) backup_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) created_at_ms: Option<i64>,
    pub(crate) bundle_name: String,
    /// Bundle path RELATIVE to the Data Root, e.g. `backup/backup_<ms>_<uuid>`.
    pub(crate) bundle_relative_path: String,
    pub(crate) inventory_status: BackupInventoryStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<BackupReasonCode>,
    pub(crate) verification_status: BackupVerificationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) schema_version: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) checksum_sha256: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) scope: Option<BackupScopeDto>,
}

/// Result of an explicit full verification.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupVerifyResultDto {
    pub(crate) backup_id: String,
    pub(crate) verification_status: BackupVerificationStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) reason_code: Option<BackupReasonCode>,
    /// Measured size, present only once the file could actually be measured.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) size_bytes: Option<u64>,
    /// Re-computed checksum, present only once it could actually be computed.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) checksum_sha256: Option<String>,
}

// ============================================================
// Discovery
// ============================================================

/// A candidate backed by a readable manifest that claims an identity.
///
/// Identity is a *claim*, independent of whether this build can consume the
/// bundle: it requires the manifest to parse, `manifest_kind == "backup"`, and
/// a syntactically valid UUID `backup_id`.
#[derive(Debug, Clone)]
struct Claimed {
    backup_id: String,
    manifest: BackupManifest,
}

/// One entry discovered in the `backup/` root.
#[derive(Debug, Clone)]
struct Scanned {
    item: BackupInventoryItemDto,
    claim: Option<Claimed>,
    /// Where the candidate lives. Never crosses the UI boundary.
    bundle_dir: PathBuf,
}

fn scope_dto(scope: &BackupScope) -> BackupScopeDto {
    BackupScopeDto {
        database_included: scope.database,
        attachments_included: scope.attachments,
        portable_settings_included: scope.portable_settings,
    }
}

/// Lowercase hex SHA-256 metadata check. Shared with the Restore subsystem,
/// which must validate a recorded checksum before trusting it.
pub(crate) fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// Build a classified entry. `reason` is `None` only for `StructurallyValid`.
fn classify(
    bundle_dir: &Path,
    bundle_name: String,
    bundle_relative_path: String,
    status: BackupInventoryStatus,
    reason: Option<BackupReasonCode>,
    claim: Option<Claimed>,
) -> Scanned {
    let item = BackupInventoryItemDto {
        backup_id: claim.as_ref().map(|c| c.backup_id.clone()),
        // A non-positive timestamp is omitted rather than reported as `0`, so
        // ordering never treats "unknown" as "the epoch".
        created_at_ms: claim
            .as_ref()
            .map(|c| c.manifest.created_at_ms)
            .filter(|ms| *ms > 0),
        bundle_name,
        bundle_relative_path,
        inventory_status: status,
        reason_code: reason,
        // Inventory NEVER verifies.
        verification_status: BackupVerificationStatus::NotVerified,
        app_version: claim.as_ref().map(|c| c.manifest.app_version.clone()),
        schema_version: claim.as_ref().map(|c| c.manifest.schema_version),
        size_bytes: claim.as_ref().map(|c| c.manifest.database.size_bytes),
        checksum_sha256: claim
            .as_ref()
            .map(|c| c.manifest.database.sha256.clone()),
        scope: claim.as_ref().map(|c| scope_dto(&c.manifest.scope)),
    };
    Scanned {
        item,
        claim,
        bundle_dir: bundle_dir.to_path_buf(),
    }
}

/// Names that the inventory is allowed to REPORT on. Everything else in the
/// `backup/` root (migration snapshots, `readme.txt`, `foo/`, `random.json`, …)
/// is ignored — and never deleted.
fn is_candidate_name(name: &str) -> bool {
    name.starts_with(BUNDLE_PREFIX) || name.starts_with(STAGING_PREFIX)
}

/// Inspect one `backup_*` candidate directory.
fn inspect_bundle(bundle_dir: &Path, bundle_name: String, relative: String) -> Scanned {
    // Required: the candidate is a real directory.
    match fs::symlink_metadata(bundle_dir) {
        Ok(meta) if meta.is_dir() => {}
        _ => {
            return classify(
                bundle_dir,
                bundle_name,
                relative,
                BackupInventoryStatus::Incomplete,
                Some(BackupReasonCode::ManifestMissing),
                None,
            )
        }
    }

    // Required: `manifest.json`, a regular file (never a symlink target).
    let manifest_path = bundle_dir.join(MANIFEST_FILENAME);
    let manifest_meta = match fs::symlink_metadata(&manifest_path) {
        Ok(meta) => meta,
        Err(_) => {
            return classify(
                bundle_dir,
                bundle_name,
                relative,
                BackupInventoryStatus::Incomplete,
                Some(BackupReasonCode::ManifestMissing),
                None,
            )
        }
    };
    if manifest_meta.file_type().is_symlink() || !manifest_meta.is_file() {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::ManifestInvalid),
            None,
        );
    }

    // Required: the manifest parses and claims a Backup identity.
    let manifest: BackupManifest = match fs::read(&manifest_path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    {
        Some(manifest) => manifest,
        None => {
            return classify(
                bundle_dir,
                bundle_name,
                relative,
                BackupInventoryStatus::Invalid,
                Some(BackupReasonCode::ManifestInvalid),
                None,
            )
        }
    };
    let claimed = if manifest.manifest_kind == MANIFEST_KIND {
        Uuid::parse_str(manifest.backup_id.trim()).ok().map(|id| Claimed {
            backup_id: id.to_string(),
            manifest: manifest.clone(),
        })
    } else {
        None
    };
    let Some(claimed) = claimed else {
        // Not a Backup manifest at all (foreign kind or unusable identity).
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::ManifestInvalid),
            None,
        );
    };

    // A NEWER format is not corrupt — it is simply unreadable to this build.
    if manifest.format_version > FORMAT_VERSION {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Unsupported,
            Some(BackupReasonCode::UnsupportedFormat),
            Some(claimed),
        );
    }
    if manifest.format_version != FORMAT_VERSION {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::ManifestInvalid),
            Some(claimed),
        );
    }

    // Manifest scalar coherence.
    if manifest.created_at_ms <= 0 || manifest.app_version.trim().is_empty() {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::ManifestInvalid),
            Some(claimed),
        );
    }
    if !is_sha256_hex(&manifest.database.sha256) {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::InvalidChecksumMetadata),
            Some(claimed),
        );
    }
    // A manifest admitting its own database failed integrity is not a valid
    // bundle manifest.
    if !manifest.database.integrity_check_ok {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::ManifestInvalid),
            Some(claimed),
        );
    }

    // §10 path safety — the hard gate. Requiring the V1 canonical relative path
    // means a hostile manifest can never point the read outside the bundle.
    if manifest.database.relative_path != DB_RELATIVE_PATH {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::UnsafeDatabasePath),
            Some(claimed),
        );
    }

    // Scope must be exactly V1; anything else is a capability we cannot consume.
    if manifest.scope != BackupScope::v1() {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Unsupported,
            Some(BackupReasonCode::UnsupportedScope),
            Some(claimed),
        );
    }

    // Required: the database file exists, as a regular non-symlink file.
    let db_path = bundle_dir.join(DB_RELATIVE_PATH);
    let db_meta = match fs::symlink_metadata(&db_path) {
        Ok(meta) => meta,
        Err(_) => {
            return classify(
                bundle_dir,
                bundle_name,
                relative,
                BackupInventoryStatus::Incomplete,
                Some(BackupReasonCode::DatabaseMissing),
                Some(claimed),
            )
        }
    };
    if db_meta.file_type().is_symlink() || !db_meta.is_file() {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::DatabaseNotRegular),
            Some(claimed),
        );
    }

    // Size metadata must agree with the actual file (cheap; no hashing here).
    if db_meta.len() != manifest.database.size_bytes {
        return classify(
            bundle_dir,
            bundle_name,
            relative,
            BackupInventoryStatus::Invalid,
            Some(BackupReasonCode::SizeMismatch),
            Some(claimed),
        );
    }

    // Structurally whole. Explicitly NOT verified.
    classify(
        bundle_dir,
        bundle_name,
        relative,
        BackupInventoryStatus::StructurallyValid,
        None,
        Some(claimed),
    )
}

/// Scan the `backup/` root TOP LEVEL only, classifying every candidate.
fn scan_backup_root(backup_root: &Path) -> Result<Vec<Scanned>, BackupInventoryError> {
    let entries = fs::read_dir(backup_root)
        .map_err(|e| BackupInventoryError::Unavailable(format!("read backup root: {e}")))?;

    let mut scanned: Vec<Scanned> = Vec::new();
    for entry in entries {
        let entry = entry
            .map_err(|e| BackupInventoryError::Internal(format!("read backup entry: {e}")))?;
        let bundle_name = entry.file_name().to_string_lossy().into_owned();

        // Migration snapshots and unknown entries are other subsystems'
        // business: never reported, never deleted. Rejected before any stat so
        // an unreadable irrelevant entry can never fail the whole scan.
        if !is_candidate_name(&bundle_name) {
            continue;
        }

        let relative = format!("{BACKUP_DIR_NAME}/{bundle_name}");
        let bundle_dir = entry.path();
        let meta = fs::symlink_metadata(&bundle_dir)
            .map_err(|e| BackupInventoryError::Internal(format!("stat backup entry: {e}")))?;

        // §11 symlink safety: never trust a redirection, even to a legal file.
        if meta.file_type().is_symlink() {
            scanned.push(classify(
                &bundle_dir,
                bundle_name,
                relative,
                BackupInventoryStatus::Invalid,
                Some(BackupReasonCode::SymlinkNotAllowed),
                None,
            ));
            continue;
        }

        // §8 operation staging is INCOMPLETE — never deleted / resumed / published.
        if bundle_name.starts_with(STAGING_PREFIX) {
            scanned.push(classify(
                &bundle_dir,
                bundle_name,
                relative,
                BackupInventoryStatus::Incomplete,
                Some(BackupReasonCode::StagingIncomplete),
                None,
            ));
            continue;
        }

        scanned.push(inspect_bundle(&bundle_dir, bundle_name, relative));
    }

    Ok(scanned)
}

/// Apply cross-entry rules and produce a deterministic order.
fn finalize(scanned: Vec<Scanned>) -> Vec<BackupInventoryItemDto> {
    // §14 duplicated identity → fail closed. Two bundles claiming one id are
    // BOTH unsafe for identity-based operations; we never pick one.
    let mut counts: HashMap<String, usize> = HashMap::new();
    for entry in &scanned {
        if let Some(claim) = entry.claim.as_ref() {
            *counts.entry(claim.backup_id.clone()).or_insert(0) += 1;
        }
    }

    let mut items: Vec<BackupInventoryItemDto> = scanned
        .into_iter()
        .map(|entry| {
            let Scanned { mut item, claim, .. } = entry;
            if let Some(claim) = claim.as_ref() {
                if counts.get(&claim.backup_id).copied().unwrap_or(0) > 1
                    && item.inventory_status != BackupInventoryStatus::Invalid
                {
                    item.inventory_status = BackupInventoryStatus::Invalid;
                    item.reason_code = Some(BackupReasonCode::DuplicateBackupId);
                }
            }
            item
        })
        .collect();

    // Deterministic (frozen): newest first; ties by id then name. Entries with
    // no recorded time come last, ordered by name. Never filesystem order.
    items.sort_by(|a, b| match (a.created_at_ms, b.created_at_ms) {
        (Some(left), Some(right)) => right
            .cmp(&left)
            .then_with(|| a.backup_id.cmp(&b.backup_id))
            .then_with(|| a.bundle_name.cmp(&b.bundle_name)),
        (Some(_), None) => Ordering::Less,
        (None, Some(_)) => Ordering::Greater,
        (None, None) => a.bundle_name.cmp(&b.bundle_name),
    });

    items
}

/// Resolve the authoritative `backup/` root (Valid bootstrap → Existing Data
/// Root → `backup/`). Never creates anything.
fn resolve_backup_root(app_config_dir: &Path) -> Result<PathBuf, BackupInventoryError> {
    let (data_root, _manifest) =
        resolve_existing_data_root(app_config_dir).map_err(BackupInventoryError::Unavailable)?;
    resolve_existing_backup_root(&data_root).map_err(BackupInventoryError::Unavailable)
}

/// List every user backup bundle under the authoritative backup root.
///
/// Cheap by contract: no SHA-256 recomputation, no database opened.
pub(crate) fn list_backups(
    app_config_dir: &Path,
) -> Result<Vec<BackupInventoryItemDto>, BackupInventoryError> {
    let backup_root = resolve_backup_root(app_config_dir)?;
    let scanned = scan_backup_root(&backup_root)?;
    Ok(finalize(scanned))
}

// ============================================================
// Full verification
// ============================================================

/// Read-only integrity check. §18: explicit READ ONLY flags, so verification
/// can never mutate the bundle (no journal-mode change, no write, no checkpoint).
///
/// Shared with the P6-S8 Restore subsystem, which uses the SAME read-only rule
/// for the restore staging database and for the post-switch live database — the
/// "is this SQLite file sound?" test exists exactly once in the codebase.
pub(crate) fn read_only_integrity_check(db_path: &Path) -> rusqlite::Result<bool> {
    let conn = Connection::open_with_flags(db_path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    let result: String = conn.query_row("PRAGMA integrity_check", [], |row| row.get(0))?;
    Ok(result.eq_ignore_ascii_case("ok"))
}

fn failed_verification(
    backup_id: &str,
    reason: BackupReasonCode,
    size_bytes: Option<u64>,
    checksum_sha256: Option<String>,
) -> BackupVerifyResultDto {
    BackupVerifyResultDto {
        backup_id: backup_id.to_string(),
        verification_status: BackupVerificationStatus::Failed,
        reason_code: Some(reason),
        size_bytes,
        checksum_sha256,
    }
}

/// Outcome of locating + fully verifying one bundle by id.
///
/// Shared by the explicit verification command AND the P6-S8 Restore
/// pre-flight, so "what counts as a trustworthy bundle" is defined once.
pub(crate) enum LocatedVerification {
    /// Unique bundle; structure, size, streaming SHA-256 and a real read-only
    /// `integrity_check` all passed. A legitimate V1 bundle.
    Verified {
        /// Where the bundle lives. Never crosses the UI boundary.
        bundle_dir: PathBuf,
        manifest: BackupManifest,
        size_bytes: u64,
        checksum_sha256: String,
    },
    /// Unique bundle that cannot serve as a source. A DATA result, never a
    /// subsystem crash.
    Damaged {
        reason: BackupReasonCode,
        size_bytes: Option<u64>,
        checksum_sha256: Option<String>,
    },
}

/// Locate one bundle by id from a FRESH scan and fully verify it.
///
/// §17 TOCTOU: the id is re-located from a fresh scan of the authoritative
/// backup root — a previous list is never trusted. §19: size, then streaming
/// SHA-256, then a real `PRAGMA integrity_check`. All three must pass.
///
/// Error / data model (unchanged from P6-S6):
///   * unique, `STRUCTURALLY_VALID` → `Ok(Verified | Damaged)`;
///   * unique but `INCOMPLETE` / `INVALID` → `Ok(Damaged)`;
///   * unique but `UNSUPPORTED` → `Err(Unsupported)`: never reported as corrupt;
///   * absent → `Err(NotFound)`; several claimants → `Err(Ambiguous)`;
///   * unusable id → `Err(RequestInvalid)`; no root → `Err(Unavailable)`.
pub(crate) fn locate_and_verify(
    app_config_dir: &Path,
    backup_id: &str,
) -> Result<LocatedVerification, BackupInventoryError> {
    let requested = Uuid::parse_str(backup_id.trim())
        .map_err(|e| BackupInventoryError::RequestInvalid(format!("backup id is not a UUID: {e}")))?
        .to_string();

    let backup_root = resolve_backup_root(app_config_dir)?;
    let scanned = scan_backup_root(&backup_root)?;

    let matches: Vec<&Scanned> = scanned
        .iter()
        .filter(|entry| entry.claim.as_ref().map(|c| &c.backup_id) == Some(&requested))
        .collect();
    if matches.is_empty() {
        return Err(BackupInventoryError::NotFound(requested));
    }
    if matches.len() > 1 {
        // §14: never arbitrarily choose one of several bundles claiming one id.
        return Err(BackupInventoryError::Ambiguous(format!(
            "{} bundles claim this id",
            matches.len()
        )));
    }
    let target = matches[0];

    // A bundle we cannot even consume is not a verification failure — it is a
    // request this build cannot serve. Never reported as corrupt.
    if target.item.inventory_status == BackupInventoryStatus::Unsupported {
        return Err(BackupInventoryError::Unsupported(
            target
                .item
                .reason_code
                .map(|c| format!("{c:?}"))
                .unwrap_or_else(|| "unsupported".into()),
        ));
    }
    // Any other unusable bundle is a DATA result with its structural reason.
    if target.item.inventory_status != BackupInventoryStatus::StructurallyValid {
        return Ok(LocatedVerification::Damaged {
            reason: target
                .item
                .reason_code
                .unwrap_or(BackupReasonCode::ManifestInvalid),
            size_bytes: None,
            checksum_sha256: None,
        });
    }

    let manifest = target
        .claim
        .as_ref()
        .expect("structurally valid implies a claimed manifest")
        .manifest
        .clone();
    let db_path = target.bundle_dir.join(DB_RELATIVE_PATH);

    // 1. Actual size must equal the manifest size.
    let size = match fs::symlink_metadata(&db_path) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta.len(),
        _ => {
            return Ok(LocatedVerification::Damaged {
                reason: BackupReasonCode::DatabaseUnreadable,
                size_bytes: None,
                checksum_sha256: None,
            })
        }
    };
    if size != manifest.database.size_bytes {
        return Ok(LocatedVerification::Damaged {
            reason: BackupReasonCode::SizeMismatch,
            size_bytes: Some(size),
            checksum_sha256: None,
        });
    }

    // 2. Streaming SHA-256 must equal the manifest checksum (never a whole-file
    //    read into RAM).
    let checksum = match sha256_file_hex(&db_path) {
        Ok(checksum) => checksum,
        Err(_) => {
            return Ok(LocatedVerification::Damaged {
                reason: BackupReasonCode::DatabaseUnreadable,
                size_bytes: Some(size),
                checksum_sha256: None,
            })
        }
    };
    if checksum != manifest.database.sha256 {
        return Ok(LocatedVerification::Damaged {
            reason: BackupReasonCode::ChecksumMismatch,
            size_bytes: Some(size),
            checksum_sha256: Some(checksum),
        });
    }

    // 3. A REAL read-only integrity check — never the manifest's own claim.
    match read_only_integrity_check(&db_path) {
        Ok(true) => Ok(LocatedVerification::Verified {
            bundle_dir: target.bundle_dir.clone(),
            manifest,
            size_bytes: size,
            checksum_sha256: checksum,
        }),
        Ok(false) => Ok(LocatedVerification::Damaged {
            reason: BackupReasonCode::IntegrityFailed,
            size_bytes: Some(size),
            checksum_sha256: Some(checksum),
        }),
        Err(_) => Ok(LocatedVerification::Damaged {
            reason: BackupReasonCode::DatabaseUnreadable,
            size_bytes: Some(size),
            checksum_sha256: Some(checksum),
        }),
    }
}

/// Verify one backup bundle by id.
///
/// Thin projection of `locate_and_verify` onto the P6-S6 verification result
/// contract; the rules themselves live in `locate_and_verify` so the Restore
/// pre-flight cannot drift from the explicit verification path.
pub(crate) fn verify_backup(
    app_config_dir: &Path,
    backup_id: &str,
) -> Result<BackupVerifyResultDto, BackupInventoryError> {
    // Normalize (and reject a non-UUID id) BEFORE touching the filesystem so the
    // error precedence of P6-S6 is preserved exactly.
    let requested = Uuid::parse_str(backup_id.trim())
        .map_err(|e| BackupInventoryError::RequestInvalid(format!("backup id is not a UUID: {e}")))?
        .to_string();

    match locate_and_verify(app_config_dir, backup_id)? {
        LocatedVerification::Verified {
            size_bytes,
            checksum_sha256,
            ..
        } => Ok(BackupVerifyResultDto {
            backup_id: requested,
            verification_status: BackupVerificationStatus::Verified,
            reason_code: None,
            size_bytes: Some(size_bytes),
            checksum_sha256: Some(checksum_sha256),
        }),
        LocatedVerification::Damaged {
            reason,
            size_bytes,
            checksum_sha256,
        } => Ok(failed_verification(
            &requested,
            reason,
            size_bytes,
            checksum_sha256,
        )),
    }
}

// ============================================================
// Tauri commands
// ============================================================

/// List the user backup bundles (cheap: no hashing, no database opened).
///
/// The filesystem scan + manifest parsing run off the async executor via
/// `spawn_blocking`.
#[tauri::command]
pub(crate) async fn native_backup_list(
    app: tauri::AppHandle,
) -> Result<Vec<BackupInventoryItemDto>, BackupInventoryCommandErrorDto> {
    let app_config_dir = app.path().app_config_dir().map_err(|_| {
        BackupInventoryCommandErrorDto::from(BackupInventoryError::Unavailable(
            "app_config_dir unavailable".into(),
        ))
    })?;

    let joined = tauri::async_runtime::spawn_blocking(move || {
        list_backups(&app_config_dir).map_err(BackupInventoryCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        Err(_) => Err(BackupInventoryCommandErrorDto::from(
            BackupInventoryError::Internal("list task failed to complete".into()),
        )),
    }
}

/// Fully verify one backup bundle by id (streaming SHA-256 + read-only
/// `integrity_check`), off the async executor.
#[tauri::command]
pub(crate) async fn native_backup_verify(
    app: tauri::AppHandle,
    backup_id: String,
) -> Result<BackupVerifyResultDto, BackupInventoryCommandErrorDto> {
    let app_config_dir = app.path().app_config_dir().map_err(|_| {
        BackupInventoryCommandErrorDto::from(BackupInventoryError::Unavailable(
            "app_config_dir unavailable".into(),
        ))
    })?;

    let joined = tauri::async_runtime::spawn_blocking(move || {
        verify_backup(&app_config_dir, &backup_id).map_err(BackupInventoryCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        Err(_) => Err(BackupInventoryCommandErrorDto::from(
            BackupInventoryError::Internal("verify task failed to complete".into()),
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::backup::{acquire_backup_permit, create_backup, BackupResultDto};
    use crate::db::definitions::MIGRATIONS;
    use crate::maintenance::NativeMaintenanceState;
    use serde_json::json;
    use tempfile::tempdir;

    // ---------- sandbox helpers (tempdir only — never real user data) ----------

    /// Build a Valid bootstrap + FirstBoot-initialized Data Root in a tempdir.
    fn make_root(tmp: &Path) -> (PathBuf, PathBuf) {
        let cfg = tmp.join("cfg");
        fs::create_dir_all(&cfg).unwrap();
        let data_root = tmp.join("data");
        crate::storage::DataRootService::get_and_ensure(
            &data_root,
            crate::storage::InitMode::FirstBoot,
        )
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

    fn backup_root_of(data_root: &Path) -> PathBuf {
        data_root.join(BACKUP_DIR_NAME)
    }

    /// Create a real P6-S5 bundle through the production path.
    fn make_real_backup(cfg: &Path, data_root: &Path) -> BackupResultDto {
        let source = data_root.join(DB_RELATIVE_PATH);
        {
            let conn = crate::db::policy::open_configured_connection(&source).unwrap();
            conn.execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);
                 INSERT INTO t(v) VALUES ('a'),('b'),('c');",
            )
            .unwrap();
        }
        let permit = acquire_backup_permit(&NativeMaintenanceState::new()).expect("permit");
        create_backup(cfg, permit).expect("backup")
    }

    fn bundle_dir_of(data_root: &Path, dto: &BackupResultDto) -> PathBuf {
        data_root.join(BACKUP_DIR_NAME).join(
            dto.bundle_relative_path
                .trim_start_matches(&format!("{BACKUP_DIR_NAME}/")),
        )
    }

    fn names(items: &[BackupInventoryItemDto]) -> Vec<String> {
        items.iter().map(|i| i.bundle_name.clone()).collect()
    }

    fn only(items: &[BackupInventoryItemDto]) -> &BackupInventoryItemDto {
        assert_eq!(items.len(), 1, "expected exactly one entry, got {items:?}");
        &items[0]
    }

    // ---------- hand-built candidate helpers ----------

    fn make_candidate(backup_root: &Path, name: &str) -> PathBuf {
        let dir = backup_root.join(name);
        fs::create_dir_all(dir.join("database")).unwrap();
        dir
    }

    /// Write a real, valid SQLite database at the canonical bundle path.
    /// Returns `(size, sha256)`.
    fn make_valid_db(dir: &Path) -> (u64, String) {
        let path = dir.join(DB_RELATIVE_PATH);
        let conn = Connection::open(&path).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);
             INSERT INTO t(v) VALUES ('alpha'),('beta'),('gamma');",
        )
        .unwrap();
        drop(conn);
        let size = fs::metadata(&path).unwrap().len();
        let sha = sha256_file_hex(&path).unwrap();
        (size, sha)
    }

    fn manifest_json(backup_id: &str, created_at_ms: i64, size: u64, sha: &str) -> serde_json::Value {
        json!({
            "manifest_kind": MANIFEST_KIND,
            "format_version": FORMAT_VERSION,
            "backup_id": backup_id,
            "created_at_ms": created_at_ms,
            "app_version": "0.0.0-test",
            "schema_version": 15,
            "scope": {"database": true, "attachments": false, "portable_settings": false},
            "database": {
                "relative_path": DB_RELATIVE_PATH,
                "size_bytes": size,
                "sha256": sha,
                "integrity_check_ok": true,
            },
        })
    }

    fn write_manifest_value(dir: &Path, value: &serde_json::Value) {
        fs::write(
            dir.join(MANIFEST_FILENAME),
            serde_json::to_string_pretty(value).unwrap(),
        )
        .unwrap();
    }

    fn read_manifest_value(dir: &Path) -> serde_json::Value {
        serde_json::from_str(&fs::read_to_string(dir.join(MANIFEST_FILENAME)).unwrap()).unwrap()
    }

    /// A complete, structurally valid hand-built bundle.
    fn make_valid_bundle(backup_root: &Path, name: &str, backup_id: &str, created_at_ms: i64) -> PathBuf {
        let dir = make_candidate(backup_root, name);
        let (size, sha) = make_valid_db(&dir);
        write_manifest_value(&dir, &manifest_json(backup_id, created_at_ms, size, &sha));
        dir
    }

    fn uid() -> String {
        Uuid::new_v4().to_string()
    }

    // ============================================================
    // §35 · a real P6-S5 bundle is structurally valid but NOT verified
    // ============================================================
    #[test]
    fn real_backup_is_structurally_valid_but_not_verified() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_real_backup(&cfg, &data_root);

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);

        assert_eq!(item.inventory_status, BackupInventoryStatus::StructurallyValid);
        assert_eq!(item.reason_code, None);
        assert_eq!(
            item.verification_status,
            BackupVerificationStatus::NotVerified,
            "list must never claim verification"
        );
        assert_eq!(item.backup_id.as_deref(), Some(dto.backup_id.as_str()));
        assert_eq!(item.created_at_ms, Some(dto.created_at_ms));
        assert_eq!(item.size_bytes, Some(dto.size_bytes));
        assert_eq!(
            item.checksum_sha256.as_deref(),
            Some(dto.checksum_sha256.as_str())
        );
        assert_eq!(
            item.bundle_relative_path,
            format!("{BACKUP_DIR_NAME}/{}", item.bundle_name)
        );
        let scope = item.scope.as_ref().unwrap();
        assert!(scope.database_included);
        assert!(!scope.attachments_included);
        assert!(!scope.portable_settings_included);

        // Metadata agrees with the manifest actually on disk.
        let bundle = bundle_dir_of(&data_root, &dto);
        let manifest = read_manifest_value(&bundle);
        assert_eq!(
            item.app_version.as_deref(),
            manifest["app_version"].as_str()
        );
        assert_eq!(
            item.schema_version,
            Some(MIGRATIONS.last().unwrap().version)
        );
        // The V1 canonical path this module validates against is exactly what
        // the creation subsystem writes.
        assert_eq!(manifest["database"]["relative_path"], DB_RELATIVE_PATH);
    }

    // ============================================================
    // §36 · operation staging is INCOMPLETE and left untouched
    // ============================================================
    #[test]
    fn staging_directory_is_incomplete_and_preserved() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let staging = backup_root_of(&data_root).join(format!("{STAGING_PREFIX}test"));
        fs::create_dir_all(&staging).unwrap();

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Incomplete);
        assert_eq!(item.reason_code, Some(BackupReasonCode::StagingIncomplete));
        assert_eq!(item.backup_id, None);
        assert_eq!(item.created_at_ms, None);
        assert_eq!(item.verification_status, BackupVerificationStatus::NotVerified);

        assert!(staging.is_dir(), "staging must never be deleted or resumed");
    }

    // ============================================================
    // §37 · missing manifest / missing database are INCOMPLETE
    // ============================================================
    #[test]
    fn missing_manifest_is_incomplete() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dir = make_candidate(&backup_root_of(&data_root), "backup_1_missing_manifest");
        let _ = make_valid_db(&dir); // database present, manifest absent

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Incomplete);
        assert_eq!(item.reason_code, Some(BackupReasonCode::ManifestMissing));
        assert_eq!(item.backup_id, None);
    }

    #[test]
    fn missing_database_is_incomplete() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dir = make_candidate(&backup_root_of(&data_root), "backup_2_missing_db");
        write_manifest_value(&dir, &manifest_json(&uid(), 1_700_000_000_000, 4096, &"a".repeat(64)));

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Incomplete);
        assert_eq!(item.reason_code, Some(BackupReasonCode::DatabaseMissing));
        // The identity was readable, so it is still reported (never silently hidden).
        assert!(item.backup_id.is_some());
    }

    // ============================================================
    // §38 · malformed / foreign / unsupported manifests
    // ============================================================
    #[test]
    fn malformed_manifest_is_invalid() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);
        let dir = make_candidate(&root, "backup_3_malformed");
        fs::write(dir.join(MANIFEST_FILENAME), "{ not json at all").unwrap();

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Invalid);
        assert_eq!(item.reason_code, Some(BackupReasonCode::ManifestInvalid));
    }

    #[test]
    fn foreign_manifest_kind_is_invalid() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dir = make_candidate(&backup_root_of(&data_root), "backup_4_foreign_kind");
        let (size, sha) = make_valid_db(&dir);
        let mut value = manifest_json(&uid(), 1_700_000_000_000, size, &sha);
        value["manifest_kind"] = json!("data_root");
        write_manifest_value(&dir, &value);

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Invalid);
        assert_eq!(item.reason_code, Some(BackupReasonCode::ManifestInvalid));
        assert_eq!(item.backup_id, None, "a non-backup manifest claims no id");
    }

    #[test]
    fn future_format_version_is_unsupported_not_corrupt() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let id = uid();
        let dir = make_candidate(&backup_root_of(&data_root), "backup_5_future");
        let (size, sha) = make_valid_db(&dir);
        let mut value = manifest_json(&id, 1_700_000_000_000, size, &sha);
        value["format_version"] = json!(FORMAT_VERSION + 1);
        write_manifest_value(&dir, &value);

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Unsupported);
        assert_eq!(item.reason_code, Some(BackupReasonCode::UnsupportedFormat));
        assert_ne!(item.inventory_status, BackupInventoryStatus::Invalid);
        // The identity is still reported so a future UI can distinguish it.
        assert_eq!(item.backup_id.as_deref(), Some(id.as_str()));

        // Verifying it is a request this build cannot serve — not a corruption.
        let err = verify_backup(&cfg, &id).unwrap_err();
        assert!(matches!(err, BackupInventoryError::Unsupported(_)), "got {err:?}");
    }

    #[test]
    fn unsupported_scope_is_unsupported_not_corrupt() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dir = make_candidate(&backup_root_of(&data_root), "backup_6_scope");
        let (size, sha) = make_valid_db(&dir);
        let mut value = manifest_json(&uid(), 1_700_000_000_000, size, &sha);
        value["scope"]["attachments"] = json!(true);
        write_manifest_value(&dir, &value);

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Unsupported);
        assert_eq!(item.reason_code, Some(BackupReasonCode::UnsupportedScope));
    }

    #[test]
    fn incoherent_manifest_metadata_is_invalid() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);

        // (name, mutate) — every case must be INVALID with the frozen reason.
        let cases: [(&str, fn(&mut serde_json::Value), BackupReasonCode); 5] = [
            ("backup_7_bad_sha", |v| v["database"]["sha256"] = json!("not-a-hash"), BackupReasonCode::InvalidChecksumMetadata),
            ("backup_8_sha_short", |v| v["database"]["sha256"] = json!("abc"), BackupReasonCode::InvalidChecksumMetadata),
            ("backup_9_integrity", |v| v["database"]["integrity_check_ok"] = json!(false), BackupReasonCode::ManifestInvalid),
            ("backup_10_time", |v| v["created_at_ms"] = json!(0), BackupReasonCode::ManifestInvalid),
            ("backup_11_version", |v| v["app_version"] = json!(""), BackupReasonCode::ManifestInvalid),
        ];

        for (name, mutate, reason) in cases {
            let dir = make_candidate(&root, name);
            let (size, sha) = make_valid_db(&dir);
            let mut value = manifest_json(&uid(), 1_700_000_000_000, size, &sha);
            mutate(&mut value);
            write_manifest_value(&dir, &value);

            let items = list_backups(&cfg).unwrap();
            let item = items.iter().find(|i| i.bundle_name == name).unwrap();
            assert_eq!(
                (item.inventory_status, item.reason_code),
                (BackupInventoryStatus::Invalid, Some(reason)),
                "case {name}"
            );
        }
    }

    // ============================================================
    // §38 / §10 · path safety is a hard gate and never escapes the bundle
    // ============================================================
    #[test]
    fn unsafe_database_relative_path_is_rejected_without_reading_outside() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);

        // A perfectly good database OUTSIDE the bundle. If the inventory
        // honoured the manifest's path it would read this file.
        let outside = tmp.path().join("outside.db");
        {
            let conn = Connection::open(&outside).unwrap();
            conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY);").unwrap();
        }
        let outside_size = fs::metadata(&outside).unwrap().len();
        let outside_sha = sha256_file_hex(&outside).unwrap();

        let hostile = [
            "../../outside.db",
            "..\\..\\outside.db",
            "/etc/passwd",
            "C:\\Windows\\System32\\config\\SAM",
            "database/../database/zhixing.db",
            "",
        ];

        for (index, path) in hostile.iter().enumerate() {
            let name = format!("backup_1{index}_escape");
            let dir = make_candidate(&root, &name);
            let mut value = manifest_json(&uid(), 1_700_000_000_000, outside_size, &outside_sha);
            value["database"]["relative_path"] = json!(path);
            write_manifest_value(&dir, &value);

            let items = list_backups(&cfg).unwrap();
            let item = items.iter().find(|i| i.bundle_name == name).unwrap();
            assert_eq!(
                (item.inventory_status, item.reason_code),
                (
                    BackupInventoryStatus::Invalid,
                    Some(BackupReasonCode::UnsafeDatabasePath)
                ),
                "hostile path {path:?} must be rejected"
            );
        }
    }

    // ============================================================
    // §39 · size metadata mismatch is detected without hashing
    // ============================================================
    #[test]
    fn size_mismatch_is_invalid() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dir = make_candidate(&backup_root_of(&data_root), "backup_12_size");
        let (size, sha) = make_valid_db(&dir);
        write_manifest_value(
            &dir,
            &manifest_json(&uid(), 1_700_000_000_000, size + 1, &sha),
        );

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(item.inventory_status, BackupInventoryStatus::Invalid);
        assert_eq!(item.reason_code, Some(BackupReasonCode::SizeMismatch));
    }

    // ============================================================
    // §14 / §40 · duplicate identity fails closed on both axes
    // ============================================================
    #[test]
    fn duplicate_backup_id_fails_closed_and_verify_is_ambiguous() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);
        let shared = uid();
        make_valid_bundle(&root, "backup_13_dup_a", &shared, 1_700_000_000_000);
        make_valid_bundle(&root, "backup_13_dup_b", &shared, 1_700_000_001_000);

        let items = list_backups(&cfg).unwrap();
        assert_eq!(items.len(), 2);
        for item in &items {
            assert_eq!(
                (item.inventory_status, item.reason_code),
                (
                    BackupInventoryStatus::Invalid,
                    Some(BackupReasonCode::DuplicateBackupId)
                ),
                "both claimants must be unsafe: {item:?}"
            );
        }

        // Identity-based operations must never pick one of them.
        let err = verify_backup(&cfg, &shared).unwrap_err();
        assert!(
            matches!(err, BackupInventoryError::Ambiguous(_)),
            "duplicate id must be ambiguous, got {err:?}"
        );
    }

    // ============================================================
    // §23 / §41 · list is cheap; verify is explicit (the two must not be one)
    // ============================================================
    #[test]
    fn list_is_structural_only_while_verify_detects_content_tamper() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_real_backup(&cfg, &data_root);
        let db = bundle_dir_of(&data_root, &dto).join(DB_RELATIVE_PATH);

        // Tamper in place, keeping the exact file length so the manifest's size
        // stays truthful. Only a checksum can catch this.
        tamper_in_place(&db);

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(
            item.inventory_status,
            BackupInventoryStatus::StructurallyValid,
            "a stale hash is invisible to a structural inventory"
        );
        assert_eq!(item.verification_status, BackupVerificationStatus::NotVerified);

        let result = verify_backup(&cfg, &dto.backup_id).unwrap();
        assert_eq!(result.verification_status, BackupVerificationStatus::Failed);
        assert_eq!(result.reason_code, Some(BackupReasonCode::ChecksumMismatch));
        assert_eq!(result.backup_id, dto.backup_id);
    }

    /// Flip bytes in the middle of a file without changing its length.
    fn tamper_in_place(path: &Path) {
        use std::io::{Read, Seek, SeekFrom, Write};
        let len = fs::metadata(path).unwrap().len();
        assert!(len >= 64, "tamper probe needs a non-trivial file");
        let offset = len / 2;
        let mut file = fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(path)
            .unwrap();
        let mut buf = [0u8; 16];
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.read_exact(&mut buf).unwrap();
        for byte in &mut buf {
            *byte = !*byte;
        }
        file.seek(SeekFrom::Start(offset)).unwrap();
        file.write_all(&buf).unwrap();
        file.sync_all().unwrap();
        assert_eq!(fs::metadata(path).unwrap().len(), len, "length must not change");
    }

    // ============================================================
    // §41 · a clean bundle verifies; §42 · integrity_check really runs
    // ============================================================
    #[test]
    fn real_backup_verifies_cleanly() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_real_backup(&cfg, &data_root);

        let result = verify_backup(&cfg, &dto.backup_id).unwrap();
        assert_eq!(result.verification_status, BackupVerificationStatus::Verified);
        assert_eq!(result.reason_code, None);
        assert_eq!(result.size_bytes, Some(dto.size_bytes));
        assert_eq!(
            result.checksum_sha256.as_deref(),
            Some(dto.checksum_sha256.as_str())
        );
    }

    /// §42 — a bundle whose manifest is *internally consistent* (size and
    /// checksum both agree with the file) but whose database is genuinely
    /// corrupt must fail on a REAL `PRAGMA integrity_check`, not on the
    /// manifest's `integrity_check_ok` claim.
    #[test]
    fn integrity_failure_is_detected_by_a_real_integrity_check() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);
        let id = uid();
        let dir = make_candidate(&root, "backup_14_corrupt");
        let _ = make_valid_db(&dir);

        // An index whose declared key columns no longer match the b-tree that
        // actually backs it is a LOGICAL corruption: the schema still parses, so
        // the database OPENS, and only a genuine integrity check can catch it.
        let db = dir.join(DB_RELATIVE_PATH);
        {
            let conn = Connection::open(&db).unwrap();
            conn.execute_batch("CREATE INDEX i1 ON t(v);").unwrap();
            conn.execute_batch(
                "PRAGMA writable_schema=ON;
                 UPDATE sqlite_master SET sql = 'CREATE INDEX i1 ON t(id)' WHERE name='i1';
                 PRAGMA writable_schema=OFF;",
            )
            .unwrap();
        }

        // Make the manifest truthful about the corrupted file so that ONLY the
        // integrity check can fail.
        let size = fs::metadata(&db).unwrap().len();
        let sha = sha256_file_hex(&db).unwrap();
        write_manifest_value(&dir, &manifest_json(&id, 1_700_000_000_000, size, &sha));

        // Probe (independent of the production helper): the fixture must still
        // OPEN, and SQLite itself must judge it corrupt. Otherwise this test
        // would only be proving "unreadable", not "integrity_check ran".
        let verdict = {
            let conn = Connection::open_with_flags(&db, OpenFlags::SQLITE_OPEN_READ_ONLY)
                .expect("probe: the corrupted fixture must still open");
            conn.query_row("PRAGMA integrity_check", [], |row| row.get::<_, String>(0))
        };
        println!("integrity probe = {verdict:?}");
        let verdict = verdict.expect("probe: integrity_check must not error out");
        assert_ne!(
            verdict.to_lowercase(),
            "ok",
            "probe: the fixture must be genuinely corrupt (got {verdict:?})"
        );

        let items = list_backups(&cfg).unwrap();
        let item = only(&items);
        assert_eq!(
            item.inventory_status,
            BackupInventoryStatus::StructurallyValid,
            "the corruption is invisible to a structural inventory"
        );

        let result = verify_backup(&cfg, &id).unwrap();
        assert_eq!(result.verification_status, BackupVerificationStatus::Failed);
        assert_eq!(result.reason_code, Some(BackupReasonCode::IntegrityFailed));
    }

    // ============================================================
    // §43 / §24 · verification never mutates the bundle
    // ============================================================
    #[test]
    fn verification_does_not_mutate_the_bundle() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_real_backup(&cfg, &data_root);
        let bundle = bundle_dir_of(&data_root, &dto);
        let db = bundle.join(DB_RELATIVE_PATH);
        let manifest = bundle.join(MANIFEST_FILENAME);

        let db_before = sha256_file_hex(&db).unwrap();
        let manifest_before = fs::read(&manifest).unwrap();
        let len_before = fs::metadata(&db).unwrap().len();

        let result = verify_backup(&cfg, &dto.backup_id).unwrap();
        assert_eq!(result.verification_status, BackupVerificationStatus::Verified);

        assert_eq!(
            sha256_file_hex(&db).unwrap(),
            db_before,
            "verification must not change the backup database"
        );
        assert_eq!(fs::metadata(&db).unwrap().len(), len_before);
        assert_eq!(
            fs::read(&manifest).unwrap(),
            manifest_before,
            "verification must not rewrite the manifest"
        );
        // No journal / WAL residue may be created by a read-only verification.
        assert!(!bundle.join("database/zhixing.db-wal").exists());
        assert!(!bundle.join("database/zhixing.db-shm").exists());
        assert!(!bundle.join("database/zhixing.db-journal").exists());
    }

    // ============================================================
    // §25 / §44 · migration snapshots are another subsystem's business
    // ============================================================
    #[test]
    fn migration_snapshots_and_unknown_entries_are_ignored_and_preserved() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);

        for noise in [
            "migration_snapshot_0001.db",
            "migration_snapshot_0001.json",
            "readme.txt",
            "random.json",
        ] {
            fs::write(root.join(noise), "not a backup").unwrap();
        }
        fs::create_dir_all(root.join("foo")).unwrap();

        let items = list_backups(&cfg).unwrap();
        assert!(
            items.is_empty(),
            "only approved User Backup conventions may be reported, got {items:?}"
        );

        // Nothing may be deleted, and nothing may be re-classified.
        for noise in [
            "migration_snapshot_0001.db",
            "migration_snapshot_0001.json",
            "readme.txt",
            "random.json",
        ] {
            assert!(root.join(noise).is_file(), "{noise} must be preserved");
        }
        assert!(root.join("foo").is_dir());
    }

    // ============================================================
    // §45 · a missing backup root fails closed and is NOT re-created
    // ============================================================
    #[test]
    fn missing_backup_root_fails_closed_without_creating_it() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        fs::remove_dir_all(backup_root_of(&data_root)).unwrap();

        let err = list_backups(&cfg).unwrap_err();
        assert!(matches!(err, BackupInventoryError::Unavailable(_)), "got {err:?}");
        assert_eq!(err.code(), "UNAVAILABLE");
        assert!(
            !backup_root_of(&data_root).exists(),
            "the backup root must never be auto-created"
        );

        // Verification fails closed the same way.
        let err = verify_backup(&cfg, &uid()).unwrap_err();
        assert!(matches!(err, BackupInventoryError::Unavailable(_)), "got {err:?}");
        assert!(!backup_root_of(&data_root).exists());
    }

    // ============================================================
    // §16 · verify rejects unusable / unknown ids
    // ============================================================
    #[test]
    fn verify_rejects_non_uuid_and_unknown_ids() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        make_real_backup(&cfg, &data_root);

        for bad in ["", "   ", "not-a-uuid", "../../etc/passwd", "backup_1"] {
            let err = verify_backup(&cfg, bad).unwrap_err();
            assert!(
                matches!(err, BackupInventoryError::RequestInvalid(_)),
                "{bad:?} → {err:?}"
            );
            assert_eq!(err.code(), "REQUEST_INVALID");
        }

        let err = verify_backup(&cfg, &uid()).unwrap_err();
        assert!(matches!(err, BackupInventoryError::NotFound(_)), "got {err:?}");
        assert_eq!(err.code(), "NOT_FOUND");
    }

    #[test]
    fn verify_accepts_a_manifest_id_that_is_not_canonical_text() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);
        let id = uid();
        let dir = make_candidate(&root, "backup_15_uppercase_id");
        let (size, sha) = make_valid_db(&dir);
        let mut value = manifest_json(&id, 1_700_000_000_000, size, &sha);
        value["backup_id"] = json!(id.to_uppercase());
        write_manifest_value(&dir, &value);

        // The identity is normalised, so the canonical form locates it.
        let result = verify_backup(&cfg, &id).unwrap();
        assert_eq!(result.backup_id, id);
        assert_eq!(result.verification_status, BackupVerificationStatus::Verified);
    }

    // ============================================================
    // §22 · ordering is deterministic and stable across runs
    // ============================================================
    #[test]
    fn list_order_is_deterministic() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);

        make_valid_bundle(&root, "backup_a", &uid(), 300);
        make_valid_bundle(&root, "backup_b", &uid(), 100);
        make_valid_bundle(&root, "backup_c", &uid(), 200);
        fs::create_dir_all(root.join(format!("{STAGING_PREFIX}x"))).unwrap();
        make_candidate(&root, "backup_d_missing_manifest");

        let expected = vec![
            "backup_a".to_string(),
            "backup_c".to_string(),
            "backup_b".to_string(),
            format!("{STAGING_PREFIX}x"),
            "backup_d_missing_manifest".to_string(),
        ];

        let first = list_backups(&cfg).unwrap();
        assert_eq!(names(&first), expected);
        // Stable across repeated runs (never filesystem order).
        let second = list_backups(&cfg).unwrap();
        assert_eq!(names(&second), expected);
    }

    #[test]
    fn equal_timestamps_are_ordered_by_id() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);

        let low = "00000000-0000-4000-8000-000000000001".to_string();
        let high = "ffffffff-ffff-4fff-bfff-ffffffffffff".to_string();
        make_valid_bundle(&root, "backup_z", &high, 500);
        make_valid_bundle(&root, "backup_y", &low, 500);

        let items = list_backups(&cfg).unwrap();
        assert_eq!(
            items.iter().filter_map(|i| i.backup_id.clone()).collect::<Vec<_>>(),
            vec![low, high]
        );
    }

    // ============================================================
    // §11 · symlinked candidates are never followed
    // ============================================================

    /// Best-effort symlink creation. Returns `false` when the platform refuses
    /// (e.g. Windows without developer mode), so the test can skip rather than
    /// fail on a capability the runner lacks. The production guard itself is
    /// unconditional: it always uses `symlink_metadata`.
    #[cfg(unix)]
    fn try_symlink(target: &Path, link: &Path, _target_is_dir: bool) -> bool {
        std::os::unix::fs::symlink(target, link).is_ok()
    }

    #[cfg(windows)]
    fn try_symlink(target: &Path, link: &Path, target_is_dir: bool) -> bool {
        if target_is_dir {
            std::os::windows::fs::symlink_dir(target, link).is_ok()
        } else {
            std::os::windows::fs::symlink_file(target, link).is_ok()
        }
    }

    #[cfg(not(any(unix, windows)))]
    fn try_symlink(_target: &Path, _link: &Path, _target_is_dir: bool) -> bool {
        false
    }

    #[test]
    fn symlinked_bundle_and_database_are_invalid() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let root = backup_root_of(&data_root);

        // A legitimate bundle that the malicious entries will point at.
        let real = make_valid_bundle(&root, "backup_16_real", &uid(), 1_700_000_000_000);
        let link = root.join("backup_17_link");
        if !try_symlink(&real, &link, true) {
            return; // symlinks unavailable on this runner — skip, never fail.
        }
        // A bundle whose database file is a symlink to a legitimate database.
        let db_link_dir = make_candidate(&root, "backup_18_db_link");
        let (size, sha) = make_valid_db(&db_link_dir);
        let db_link = db_link_dir.join(DB_RELATIVE_PATH);
        fs::remove_file(&db_link).unwrap();
        let db_linked = try_symlink(&real.join(DB_RELATIVE_PATH), &db_link, false);
        write_manifest_value(
            &db_link_dir,
            &manifest_json(&uid(), 1_700_000_000_000, size, &sha),
        );

        let items = list_backups(&cfg).unwrap();
        let linked = items.iter().find(|i| i.bundle_name == "backup_17_link").unwrap();
        assert_eq!(
            (linked.inventory_status, linked.reason_code),
            (
                BackupInventoryStatus::Invalid,
                Some(BackupReasonCode::SymlinkNotAllowed)
            ),
            "a symlinked bundle must never be trusted"
        );

        if db_linked {
            let db_linked_item = items
                .iter()
                .find(|i| i.bundle_name == "backup_18_db_link")
                .unwrap();
            assert_eq!(
                (db_linked_item.inventory_status, db_linked_item.reason_code),
                (
                    BackupInventoryStatus::Invalid,
                    Some(BackupReasonCode::DatabaseNotRegular)
                ),
                "a symlinked database must never be trusted"
            );
        }

        // The legitimate bundle is unaffected.
        let real_item = items.iter().find(|i| i.bundle_name == "backup_16_real").unwrap();
        assert_eq!(
            real_item.inventory_status,
            BackupInventoryStatus::StructurallyValid
        );
    }

    // ============================================================
    // Cross-checks
    // ============================================================
    #[test]
    fn error_codes_and_messages_are_stable() {
        let cases = [
            (BackupInventoryError::Unavailable(String::new()), "UNAVAILABLE"),
            (BackupInventoryError::NotFound(String::new()), "NOT_FOUND"),
            (BackupInventoryError::Ambiguous(String::new()), "AMBIGUOUS"),
            (BackupInventoryError::RequestInvalid(String::new()), "REQUEST_INVALID"),
            (BackupInventoryError::Unsupported(String::new()), "UNSUPPORTED"),
            (BackupInventoryError::Internal(String::new()), "INTERNAL"),
        ];
        for (error, code) in cases {
            assert_eq!(error.code(), code);
            // No absolute path or SQLite detail may reach the UI message.
            let message = error.safe_message();
            assert!(!message.contains('/'), "{message}");
            assert!(!message.contains('\\'), "{message}");
        }
    }

    #[test]
    fn verify_result_never_leaks_an_absolute_path() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let dto = make_real_backup(&cfg, &data_root);

        // The needle exactly as it would appear inside a JSON string.
        let escaped = serde_json::to_string(data_root.to_str().unwrap()).unwrap();
        let needle = escaped.trim_matches('"').to_string();
        assert!(!needle.is_empty());

        let listed = serde_json::to_string(&list_backups(&cfg).unwrap()).unwrap();
        let verified =
            serde_json::to_string(&verify_backup(&cfg, &dto.backup_id).unwrap()).unwrap();
        for payload in [listed, verified] {
            assert!(!payload.contains(&needle), "absolute path leaked: {payload}");
            assert!(!payload.contains("device_id"), "device_id leaked: {payload}");
        }
    }
}
