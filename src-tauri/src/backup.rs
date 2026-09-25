//! Native User Backup (P6-S5 · Backup V1).
//!
//! Backup is a WEAK-quiescence operation: it does NOT take the exclusive
//! maintenance barrier. Ordinary database reads/writes continue while a backup
//! runs; SQLite's Online Backup API is what makes the snapshot consistent.
//!
//! Pipeline (frozen by spec):
//!   resolve authoritative Data Root (bootstrap → DataRootService::Existing)
//!   → operation permit (interlocks with the Native strong maintenance barrier)
//!   → open source with the existing-only policy (never CREATE)
//!   → staging dir (`backup/.creating_<uuid>/database/zhixing.db`)
//!   → SQLite Online Backup API (rusqlite::backup::Backup)
//!   → integrity_check
//!   → streaming SHA-256
//!   → manifest.json.part → sync → rename → manifest.json
//!   → atomic rename of the staging dir → `backup/backup_<createdAtMs>_<uuid>/`
//!
//! Hard rules (frozen):
//! - NEVER `std::fs::copy` the live `zhixing.db` (WAL/SHM are part of the state).
//! - NEVER create the Data Root, the `backup/` root, or a missing source DB.
//! - The final bundle is only visible once EVERY verification step has passed.
//! - On failure, only THIS operation's staging dir is best-effort removed.
//! - No auto-retention, no orphan cleanup (later Backup maintenance slice).
//! - `Migration Snapshot != User Backup`: this module shares only the SQLite
//!   Backup API pattern and `sha256_file_hex`; it does NOT reuse
//!   `MigrationDefinition` / `SnapshotReport` / `SqliteBackupSnapshot` as a
//!   Backup domain.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::Manager;
use thiserror::Error;
use uuid::Uuid;

use crate::bootstrap::{BootstrapService, BootstrapState};
use crate::db::checksum::sha256_file_hex;
use crate::db::definitions::MIGRATIONS;
use crate::db::policy::open_existing_configured_connection;
use crate::maintenance::{NativeDbOperationPermit, NativeMaintenanceState};
use crate::storage::manifest::DataRootManifest;
use crate::storage::{DataRootService, InitMode};

/// First argument to `Backup::run_to_completion` is a count of PAGES, never
/// bytes (256 pages × 4 KiB = ~1 MiB per step).
const BACKUP_PAGES_PER_STEP: i32 = 256;
/// Short pause between backup steps (0 is also legal).
const BACKUP_STEP_PAUSE: Duration = Duration::from_millis(1);

/// Backup manifest kind discriminator (never confused with the Data Root
/// manifest, which uses `"data_root"`).
const MANIFEST_KIND: &str = "backup";
/// Backup manifest format version for this slice.
const FORMAT_VERSION: u32 = 1;
/// Subdirectory inside a bundle that holds the database file.
const DATABASE_SUBDIR: &str = "database";
/// Staging directory prefix inside the `backup/` root.
const STAGING_PREFIX: &str = ".creating_";
/// Final bundle directory prefix inside the `backup/` root.
const BUNDLE_PREFIX: &str = "backup_";

/// Structured backup failure. The concrete `String` detail is for Rust tracing
/// only and is never sent to the UI; the UI sees a coarse `code` + safe message.
#[derive(Debug, Error)]
pub(crate) enum BackupError {
    /// Bootstrap missing/degraded, Data Root unavailable, or the Native strong
    /// maintenance barrier is active (no operation permit).
    #[error("backup unavailable: {0}")]
    Unavailable(String),
    /// Source database missing / not openable under the existing-only policy.
    #[error("source database invalid: {0}")]
    SourceInvalid(String),
    /// `backup/` root missing/not a dir, or the operation-owned staging dir
    /// could not be created / published.
    #[error("backup destination invalid: {0}")]
    DestinationInvalid(String),
    /// SQLite Online Backup API failure.
    #[error("backup failed: {0}")]
    BackupFailed(String),
    /// Verification failure (integrity_check or streaming checksum).
    #[error("backup verification failed: {0}")]
    VerifyFailed(String),
    /// Manifest serialization / write / atomic rename failure.
    #[error("backup manifest failed: {0}")]
    ManifestFailed(String),
}

impl BackupError {
    /// Coarse, UI-safe machine code.
    pub(crate) fn code(&self) -> &'static str {
        match self {
            BackupError::Unavailable(_) => "UNAVAILABLE",
            BackupError::SourceInvalid(_) => "SOURCE_INVALID",
            BackupError::DestinationInvalid(_) => "DESTINATION_INVALID",
            BackupError::BackupFailed(_) => "BACKUP_FAILED",
            BackupError::VerifyFailed(_) => "VERIFY_FAILED",
            BackupError::ManifestFailed(_) => "MANIFEST_FAILED",
        }
    }

    /// Fixed, UI-safe human message (no path / SQLite internals).
    pub(crate) fn safe_message(&self) -> &'static str {
        match self {
            BackupError::Unavailable(_) => "Backup is currently unavailable.",
            BackupError::SourceInvalid(_) => {
                "The source database is not available for backup."
            }
            BackupError::DestinationInvalid(_) => {
                "The backup destination is not available."
            }
            BackupError::BackupFailed(_) => "The backup could not be completed.",
            BackupError::VerifyFailed(_) => {
                "The backup failed verification and was discarded."
            }
            BackupError::ManifestFailed(_) => {
                "The backup manifest could not be written."
            }
        }
    }
}

/// Transport error DTO. The detail of `BackupError` is deliberately NOT
/// included: only a coarse `code` and a safe message cross the boundary.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupCommandErrorDto {
    pub(crate) code: &'static str,
    pub(crate) message: &'static str,
}

impl From<BackupError> for BackupCommandErrorDto {
    fn from(error: BackupError) -> Self {
        // Detailed (possibly path-bearing) error goes to Rust tracing only.
        tracing::warn!(target: "zhixing::backup", error = %error, "native backup failed");
        Self {
            code: error.code(),
            message: error.safe_message(),
        }
    }
}

/// V1 backup scope declaration. `device-local settings` (device_id, Trust Token,
/// Pairing Credential, permission state) is NEVER portable and is not modeled
/// here; the three booleans describe exactly what the bundle contains.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub(crate) struct BackupScope {
    pub(crate) database: bool,
    pub(crate) attachments: bool,
    pub(crate) portable_settings: bool,
}

impl BackupScope {
    /// Frozen V1 scope: database only.
    pub(crate) fn v1() -> Self {
        Self {
            database: true,
            attachments: false,
            portable_settings: false,
        }
    }
}

/// The database entry of a Backup Manifest. `relative_path` is ALWAYS relative
/// to the bundle root so the bundle stays portable across devices.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct BackupDatabaseEntry {
    pub(crate) relative_path: String,
    pub(crate) size_bytes: u64,
    pub(crate) sha256: String,
    pub(crate) integrity_check_ok: bool,
}

/// Backup Manifest (permanently separate from the Data Root manifest).
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) struct BackupManifest {
    pub(crate) manifest_kind: String,
    pub(crate) format_version: u32,
    pub(crate) backup_id: String,
    pub(crate) created_at_ms: i64,
    pub(crate) app_version: String,
    pub(crate) schema_version: u32,
    pub(crate) scope: BackupScope,
    pub(crate) database: BackupDatabaseEntry,
}

/// TS-facing scope DTO (camelCase booleans, explicit V1 declaration).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupScopeDto {
    pub(crate) database_included: bool,
    pub(crate) attachments_included: bool,
    pub(crate) portable_settings_included: bool,
}

/// Result DTO returned to the TS boundary. Carries no absolute path: only the
/// bundle path RELATIVE to the Data Root.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BackupResultDto {
    pub(crate) backup_id: String,
    pub(crate) created_at_ms: i64,
    pub(crate) size_bytes: u64,
    pub(crate) checksum_sha256: String,
    pub(crate) bundle_relative_path: String,
    pub(crate) scope: BackupScopeDto,
}

/// The authoritative current schema version, derived from the production
/// migration list (never hardcoded; an empty list is handled without panic).
fn current_schema_version() -> u32 {
    MIGRATIONS.last().map(|m| m.version).unwrap_or(0)
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Acquire the Native operation permit for a backup command.
///
/// MUST be called BEFORE the source database is opened. While strong
/// maintenance admission is closed this returns `Unavailable`, so a backup can
/// never race past the strong barrier. Conversely, while a backup permit is
/// alive the strong-maintenance drain waits for it to drop.
pub(crate) fn acquire_backup_permit(
    state: &NativeMaintenanceState,
) -> Result<NativeDbOperationPermit, BackupError> {
    state.acquire_operation_permit().ok_or_else(|| {
        BackupError::Unavailable("strong maintenance admission is closed".into())
    })
}

/// Resolve the authoritative Data Root: Valid bootstrap only, Existing mode
/// only. Never guesses, never falls back, never creates.
fn resolve_data_root(app_config_dir: &Path) -> Result<(PathBuf, DataRootManifest), BackupError> {
    let bootstrap_path = BootstrapService::bootstrap_path(app_config_dir);
    let loaded = match BootstrapService::load(&bootstrap_path) {
        BootstrapState::Valid(loaded) => loaded,
        BootstrapState::Missing { .. } => {
            return Err(BackupError::Unavailable("bootstrap.json missing".into()))
        }
        BootstrapState::Degraded(e) => {
            return Err(BackupError::Unavailable(format!(
                "bootstrap degraded: {e}"
            )))
        }
    };
    DataRootService::get_and_ensure(&loaded.data_root, InitMode::Existing)
        .map_err(|e| BackupError::Unavailable(format!("data root unavailable: {e}")))
}

/// Create a full backup bundle. `_permit` is held for the whole operation so the
/// strong-maintenance drain can observe the backup as in-flight.
pub(crate) fn create_backup(
    app_config_dir: &Path,
    _permit: NativeDbOperationPermit,
) -> Result<BackupResultDto, BackupError> {
    // 1. Authoritative Data Root (Valid bootstrap + Existing mode).
    let (data_root, data_manifest) = resolve_data_root(app_config_dir)?;

    // 2. `backup/` is a FirstBoot-created fixed subdir. Under an existing Data
    //    Root a missing backup root FAILS CLOSED — never auto-create it.
    let backup_root = data_root.join("backup");
    match fs::metadata(&backup_root) {
        Ok(meta) if meta.is_dir() => {}
        Ok(_) => {
            return Err(BackupError::DestinationInvalid(
                "backup root exists but is not a directory".into(),
            ))
        }
        Err(e) => {
            return Err(BackupError::DestinationInvalid(format!(
                "backup root missing: {e}"
            )))
        }
    }

    // 3. Operation-owned staging directory. One backup == one self-contained
    //    directory; nothing is written into the final location until every
    //    check has passed.
    let backup_id = Uuid::new_v4().to_string();
    let created_at_ms = now_ms();
    let staging = backup_root.join(format!("{STAGING_PREFIX}{backup_id}"));
    fs::create_dir(&staging).map_err(|e| {
        BackupError::DestinationInvalid(format!("cannot create staging dir: {e}"))
    })?;

    // From here on, any failure must only remove THIS operation's staging dir.
    let built = build_bundle(&staging, &data_root, &data_manifest, &backup_id, created_at_ms)
        .and_then(|entry| {
            publish_bundle(&staging, &backup_root, created_at_ms, &backup_id).map(
                |bundle_name| BackupResultDto {
                    backup_id: backup_id.clone(),
                    created_at_ms,
                    size_bytes: entry.size_bytes,
                    checksum_sha256: entry.sha256.clone(),
                    bundle_relative_path: format!("backup/{bundle_name}"),
                    scope: BackupScopeDto {
                        database_included: true,
                        attachments_included: false,
                        portable_settings_included: false,
                    },
                },
            )
        });

    if built.is_err() {
        // Best-effort cleanup of THIS operation's staging dir only. Never touch
        // existing bundles, the source Data Root, the source DB, WAL/SHM,
        // attachments, or other staging dirs.
        best_effort_remove_dir(&staging);
    }
    built
}

/// Build the bundle contents inside `staging`, returning the database entry.
fn build_bundle(
    staging: &Path,
    data_root: &Path,
    data_manifest: &DataRootManifest,
    backup_id: &str,
    created_at_ms: i64,
) -> Result<BackupDatabaseEntry, BackupError> {
    // Portable relative path, taken verbatim from the Data Root manifest
    // (e.g. `database/zhixing.db`). Never an absolute path.
    let db_relative_path = data_manifest.database.relative_path.clone();

    let staging_db_dir = staging.join(DATABASE_SUBDIR);
    fs::create_dir(&staging_db_dir).map_err(|e| {
        BackupError::DestinationInvalid(format!("cannot create staging database dir: {e}"))
    })?;
    let dest_db = staging.join(&db_relative_path);

    let source_db = DataRootService::resolve_database_path(data_root, data_manifest);

    // === 1. SQLite Online Backup API: source (existing-only) → staging DB ===
    {
        // P6-F0 permanent rule: the source is opened existing-only. A missing
        // source must fail closed, never create a replacement database.
        let source = open_existing_configured_connection(&source_db)
            .map_err(|e| BackupError::SourceInvalid(format!("open source: {e}")))?;
        let mut dest = Connection::open(&dest_db)
            .map_err(|e| BackupError::BackupFailed(format!("open staging db: {e}")))?;
        let backup = rusqlite::backup::Backup::new(&source, &mut dest)
            .map_err(|e| BackupError::BackupFailed(format!("init backup: {e}")))?;
        backup
            .run_to_completion(BACKUP_PAGES_PER_STEP, BACKUP_STEP_PAUSE, None)
            .map_err(|e| BackupError::BackupFailed(format!("run backup: {e}")))?;
        // `dest` and `source` drop here (Connection closed) — the source
        // Connection is dropped before the operation permit (held by the caller).
    }

    // === 2. Normalize + verify the staging DB ===
    // The online backup copies the source journal-mode flag, so the staging DB
    // may be WAL. Force rollback-journal mode (a checkpoint that merges any WAL
    // into the main file) so the bundle is ONE self-contained file, then verify.
    {
        let verifier = Connection::open(&dest_db)
            .map_err(|e| BackupError::VerifyFailed(format!("open for verify: {e}")))?;
        let mode: String = verifier
            .query_row("PRAGMA journal_mode=DELETE", [], |r| r.get(0))
            .map_err(|e| BackupError::VerifyFailed(format!("normalize journal mode: {e}")))?;
        if mode.to_lowercase() != "delete" {
            return Err(BackupError::VerifyFailed(format!(
                "could not normalize backup journal mode (got {mode})"
            )));
        }
        let integrity: String = verifier
            .query_row("PRAGMA integrity_check", [], |r| r.get(0))
            .map_err(|e| BackupError::VerifyFailed(format!("integrity_check query: {e}")))?;
        if integrity.to_lowercase() != "ok" {
            return Err(BackupError::VerifyFailed(format!(
                "integrity_check != ok: {integrity}"
            )));
        }
        // `verifier` drops here → any `-wal`/`-shm` are removed.
    }

    // === 3. Size + streaming SHA-256 (never load the DB into RAM) ===
    let size_bytes = fs::metadata(&dest_db)
        .map(|m| m.len())
        .map_err(|e| BackupError::VerifyFailed(format!("metadata.len: {e}")))?;
    let sha256 = sha256_file_hex(&dest_db)
        .map_err(|e| BackupError::VerifyFailed(format!("sha256: {e}")))?;

    let database = BackupDatabaseEntry {
        relative_path: db_relative_path,
        size_bytes,
        sha256,
        integrity_check_ok: true,
    };

    // === 4. Manifest (portable: relative paths only) ===
    let manifest = BackupManifest {
        manifest_kind: MANIFEST_KIND.to_string(),
        format_version: FORMAT_VERSION,
        backup_id: backup_id.to_string(),
        created_at_ms,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        schema_version: current_schema_version(),
        scope: BackupScope::v1(),
        database: database.clone(),
    };
    write_manifest(staging, &manifest)?;

    Ok(database)
}

/// Write `manifest.json` atomically: `manifest.json.part` + sync + rename.
fn write_manifest(staging: &Path, manifest: &BackupManifest) -> Result<(), BackupError> {
    let json = serde_json::to_string_pretty(manifest)
        .map_err(|e| BackupError::ManifestFailed(format!("serialize: {e}")))?;
    let part_path = staging.join("manifest.json.part");
    let final_path = staging.join("manifest.json");
    {
        let mut file = fs::File::create(&part_path)
            .map_err(|e| BackupError::ManifestFailed(format!("create part: {e}")))?;
        file.write_all(json.as_bytes())
            .map_err(|e| BackupError::ManifestFailed(format!("write part: {e}")))?;
        file.sync_all()
            .map_err(|e| BackupError::ManifestFailed(format!("sync part: {e}")))?;
    }
    fs::rename(&part_path, &final_path)
        .map_err(|e| BackupError::ManifestFailed(format!("rename part: {e}")))?;
    Ok(())
}

/// Atomically publish the staging directory as the final bundle directory.
fn publish_bundle(
    staging: &Path,
    backup_root: &Path,
    created_at_ms: i64,
    backup_id: &str,
) -> Result<String, BackupError> {
    let bundle_name = format!("{BUNDLE_PREFIX}{created_at_ms}_{backup_id}");
    let final_dir = backup_root.join(&bundle_name);
    fs::rename(staging, &final_dir).map_err(|e| {
        BackupError::DestinationInvalid(format!("publish rename failed: {e}"))
    })?;
    Ok(bundle_name)
}

/// Best-effort removal of a single directory tree (our own staging dir).
fn best_effort_remove_dir(path: &Path) {
    if let Err(e) = fs::remove_dir_all(path) {
        tracing::debug!(target: "zhixing::backup", error = %e, path = %path.display(), "staging cleanup skipped");
    }
}

// ============================================================
// Tauri backup command
// ============================================================

/// Create a Native user backup (Backup V1: database only).
///
/// The operation permit is acquired BEFORE the source DB is opened and is held
/// across open + backup + verification, so:
///   - strong maintenance active → backup cannot start (no permit), and
///   - backup in flight → strong maintenance drain waits for it.
///
/// The heavy work (SQLite backup + integrity_check + hash) runs off the sync
/// command thread via `spawn_blocking`.
#[tauri::command]
pub(crate) async fn native_backup_create(
    app: tauri::AppHandle,
) -> Result<BackupResultDto, BackupCommandErrorDto> {
    // Must acquire the permit before touching any database.
    let permit = acquire_backup_permit(app.state::<NativeMaintenanceState>().inner())
        .map_err(BackupCommandErrorDto::from)?;

    let app_config_dir = app
        .path()
        .app_config_dir()
        .map_err(|_| BackupCommandErrorDto::from(BackupError::Unavailable(
            "app_config_dir unavailable".into(),
        )))?;

    let joined = tauri::async_runtime::spawn_blocking(move || {
        create_backup(&app_config_dir, permit).map_err(BackupCommandErrorDto::from)
    })
    .await;

    match joined {
        Ok(result) => result,
        Err(_) => Err(BackupCommandErrorDto::from(BackupError::BackupFailed(
            "backup task failed to complete".into(),
        ))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::maintenance::NativeMaintenanceState;
    use std::sync::{mpsc, Arc};
    use std::thread;
    use tempfile::tempdir;

    /// Build a Valid bootstrap + FirstBoot-initialized Data Root in a tempdir.
    /// Only test sandbox paths are ever touched.
    fn make_root(tmp: &Path) -> (PathBuf, PathBuf) {
        let cfg = tmp.join("cfg");
        fs::create_dir_all(&cfg).unwrap();
        let data_root = tmp.join("data");
        DataRootService::get_and_ensure(&data_root, InitMode::FirstBoot)
            .expect("FirstBoot initialize");
        let device_id = Uuid::new_v4().to_string();
        let json = serde_json::json!({
            "bootstrap_version": 1,
            "device_id": device_id,
            "data_root": data_root,
        });
        fs::write(
            cfg.join("bootstrap.json"),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
        (cfg, data_root)
    }

    /// Create a source database (FirstBoot-style CREATE is allowed in the
    /// sandbox only) with a tiny table. Returns the still-open writer
    /// connection so a WAL test can keep data uncheckpointed.
    fn create_source_db(path: &Path) -> Connection {
        let conn = crate::db::policy::open_configured_connection(path).unwrap();
        conn.execute_batch("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL);")
            .unwrap();
        conn
    }

    fn db_path(data_root: &Path) -> PathBuf {
        data_root.join("database/zhixing.db")
    }

    fn bundle_dir(data_root: &Path, dto: &BackupResultDto) -> PathBuf {
        data_root
            .join("backup")
            .join(dto.bundle_relative_path.trim_start_matches("backup/"))
    }

    fn backup_root_entries(data_root: &Path) -> Vec<String> {
        fs::read_dir(data_root.join("backup"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect()
    }

    fn permit() -> NativeDbOperationPermit {
        acquire_backup_permit(&NativeMaintenanceState::new()).expect("permit")
    }

    /// §39 — happy path: bundle published, manifest + DB present, source intact
    /// and unchanged, backup rows correct, and the bundle database dir holds
    /// exactly the single `zhixing.db` file.
    #[test]
    fn happy_path_creates_self_contained_bundle() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let src = db_path(&data_root);
        {
            let conn = create_source_db(&src);
            conn.execute("INSERT INTO t(v) VALUES ('a'),('b'),('c')", [])
                .unwrap();
        }

        let dto = create_backup(&cfg, permit()).expect("backup");

        let bundle = bundle_dir(&data_root, &dto);
        assert!(bundle.is_dir(), "final bundle must exist");
        assert!(bundle.join("manifest.json").is_file(), "manifest must exist");
        assert!(
            bundle.join("database/zhixing.db").is_file(),
            "backup database must exist"
        );
        // Source still exists and is unchanged.
        assert!(src.is_file(), "source must be untouched");
        let src_conn = Connection::open(&src).unwrap();
        let src_rows: i64 = src_conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(src_rows, 3, "source rows unchanged");
        // Backup rows correct.
        let bak = Connection::open(bundle.join("database/zhixing.db")).unwrap();
        let bak_rows: i64 = bak
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(bak_rows, 3, "backup rows correct");
        // Self-contained: only `zhixing.db` inside the bundle's database dir.
        let db_entries: Vec<String> = fs::read_dir(bundle.join("database"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert_eq!(db_entries, vec!["zhixing.db".to_string()]);
    }

    /// §18/§40 — WAL correctness: committed data that is still in the WAL (not
    /// yet checkpointed into the main DB file) MUST appear in the backup. A
    /// plain `fs::copy(zhixing.db)` would miss it.
    #[test]
    fn wal_committed_data_is_included_in_backup() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let src = db_path(&data_root);
        // Keep the writer connection OPEN so the WAL is not checkpointed on close.
        let writer = create_source_db(&src);
        writer
            .execute("INSERT INTO t(v) VALUES ('wal-1'),('wal-2')", [])
            .unwrap();

        let wal_file = PathBuf::from(format!("{}-wal", src.display()));
        assert!(
            wal_file.exists(),
            "WAL file must exist while the writer connection is open"
        );

        let dto = create_backup(&cfg, permit()).expect("backup");
        let bundle_db = bundle_dir(&data_root, &dto).join("database/zhixing.db");
        let bak = Connection::open(&bundle_db).unwrap();
        let rows: i64 = bak
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(
            rows, 2,
            "backup must include WAL-committed rows (proves Online Backup API, not fs::copy)"
        );
        drop(writer);
    }

    /// §41 — manifest completeness + portability (no absolute path, no device_id).
    #[test]
    fn manifest_is_complete_and_portable() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let src = db_path(&data_root);
        {
            let conn = create_source_db(&src);
            conn.execute("INSERT INTO t(v) VALUES ('x')", []).unwrap();
        }

        let dto = create_backup(&cfg, permit()).expect("backup");
        let bundle = bundle_dir(&data_root, &dto);
        let raw = fs::read_to_string(bundle.join("manifest.json")).unwrap();
        let m: BackupManifest = serde_json::from_str(&raw).unwrap();

        assert_eq!(m.manifest_kind, "backup");
        assert_eq!(m.format_version, 1);
        assert_eq!(m.backup_id, dto.backup_id);
        assert!(Uuid::parse_str(&m.backup_id).is_ok(), "backup_id must be a UUID");
        assert!(m.created_at_ms > 0);
        assert_eq!(m.app_version, env!("CARGO_PKG_VERSION"));
        assert_eq!(m.schema_version, current_schema_version());
        assert_eq!(m.schema_version, 15);
        assert!(m.scope.database);
        assert!(!m.scope.attachments);
        assert!(!m.scope.portable_settings);
        assert_eq!(m.database.relative_path, "database/zhixing.db");
        assert!(m.database.integrity_check_ok);
        let actual_size = fs::metadata(bundle.join("database/zhixing.db"))
            .unwrap()
            .len();
        assert_eq!(m.database.size_bytes, actual_size);
        assert_eq!(m.database.sha256.len(), 64);

        // Portable: no absolute path, no device_id anywhere in the manifest.
        assert!(
            !raw.contains(&data_root.display().to_string()),
            "manifest must not contain the absolute Data Root path"
        );
        assert!(!raw.contains("device_id"), "manifest must not contain device_id");
        assert!(!raw.contains("C:\\"), "manifest must not contain a Windows absolute path");
        assert!(!raw.contains("/home/"), "manifest must not contain a POSIX absolute path");
    }

    /// §42 — the manifest SHA-256 equals an independent streaming recomputation.
    #[test]
    fn manifest_hash_matches_recomputed_streaming_hash() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let src = db_path(&data_root);
        {
            let conn = create_source_db(&src);
            conn.execute("INSERT INTO t(v) VALUES ('y')", []).unwrap();
        }

        let dto = create_backup(&cfg, permit()).expect("backup");
        let bundle = bundle_dir(&data_root, &dto);
        let raw = fs::read_to_string(bundle.join("manifest.json")).unwrap();
        let m: BackupManifest = serde_json::from_str(&raw).unwrap();
        let recomputed = sha256_file_hex(&bundle.join("database/zhixing.db")).unwrap();
        assert_eq!(m.database.sha256, recomputed);
        assert_eq!(m.database.sha256, dto.checksum_sha256);
    }

    /// §43 — missing source fails closed: no empty replacement DB, no bundle.
    #[test]
    fn missing_source_fails_closed_without_creating_db_or_bundle() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let src = db_path(&data_root);
        assert!(!src.exists());

        let err = create_backup(&cfg, permit()).unwrap_err();
        assert!(matches!(err, BackupError::SourceInvalid(_)), "got {err:?}");
        assert!(!src.exists(), "no empty replacement database may be created");
        assert!(
            backup_root_entries(&data_root).is_empty(),
            "no bundle or staging dir may remain"
        );
    }

    /// §44 — missing `backup/` root fails closed and is NOT auto-created.
    #[test]
    fn missing_backup_root_fails_closed_without_creating_it() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        let src = db_path(&data_root);
        {
            let conn = create_source_db(&src);
            conn.execute("INSERT INTO t(v) VALUES ('z')", []).unwrap();
        }
        fs::remove_dir_all(data_root.join("backup")).unwrap();
        assert!(!data_root.join("backup").exists());

        let err = create_backup(&cfg, permit()).unwrap_err();
        assert!(
            matches!(err, BackupError::DestinationInvalid(_)),
            "got {err:?}"
        );
        assert!(
            !data_root.join("backup").exists(),
            "backup root must not be auto-created"
        );
    }

    /// §45 — failure publication: a failure after staging is created leaves no
    /// final bundle and no staging residue (best-effort cleanup).
    #[test]
    fn failure_publication_leaves_no_bundle_and_cleans_staging() {
        let tmp = tempdir().unwrap();
        let (cfg, data_root) = make_root(tmp.path());
        // Source is missing → the failure happens AFTER the staging dir exists.
        let err = create_backup(&cfg, permit()).unwrap_err();
        assert!(matches!(err, BackupError::SourceInvalid(_)));

        let entries = backup_root_entries(&data_root);
        assert!(
            entries.is_empty(),
            "no staging/final residue may remain, got {entries:?}"
        );
        assert!(!entries.iter().any(|n| n.starts_with(BUNDLE_PREFIX)));
        assert!(!entries.iter().any(|n| n.starts_with(STAGING_PREFIX)));
    }

    /// §46 (direction 1) — while strong maintenance is active a backup cannot
    /// acquire the operation permit (so it can never open the source DB).
    #[test]
    fn backup_cannot_start_while_strong_maintenance_active() {
        let state = NativeMaintenanceState::new();
        let owner = state.begin_maintenance().expect("strong maintenance");
        assert!(
            matches!(
                acquire_backup_permit(&state),
                Err(BackupError::Unavailable(_))
            ),
            "backup must fail closed while strong maintenance is active"
        );
        assert!(state.acquire_operation_permit().is_none());
        state.end_maintenance(&owner).unwrap();
        assert!(state.acquire_operation_permit().is_some());
    }

    /// §46 (direction 2) — while a backup permit is alive, the strong
    /// maintenance drain waits for the backup to complete (no second lock).
    #[test]
    fn strong_maintenance_drain_waits_for_backup_permit() {
        let state = Arc::new(NativeMaintenanceState::new());
        // A backup operation is in flight.
        let in_flight = acquire_backup_permit(&state).expect("backup permit");

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

        // Drain is blocked while the backup permit is alive.
        assert!(
            done_rx.recv_timeout(Duration::from_millis(300)).is_err(),
            "drain must wait for the in-flight backup"
        );
        // A second backup cannot start while strong maintenance holds admission.
        assert!(acquire_backup_permit(&state).is_err());

        // Completing the backup releases the permit → drain completes.
        drop(in_flight);
        assert!(
            done_rx.recv_timeout(Duration::from_secs(2)).is_ok(),
            "drain must complete after the backup permit drops"
        );
        drain.join().unwrap();
    }

    /// §15 — schema version derivation is panic-free even for an empty list.
    #[test]
    fn schema_version_never_panics_on_empty() {
        assert_eq!(current_schema_version(), 15);
        let empty: &[crate::db::migration::MigrationDefinition] = &[];
        assert_eq!(empty.last().map(|m| m.version).unwrap_or(0), 0);
    }
}
