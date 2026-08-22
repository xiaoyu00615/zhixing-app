//! Migration Safety Snapshot（Step 9 Closeout 版）。
//!
//! 规则（冻结二 九）：
//! - high_risk=false：不生成 snapshot。
//! - high_risk=true：before_high_risk_migration 在 migration Tx 之前调用。
//!   Snapshot 失败 → migration Tx 不开。
//! - Snapshot 实现：rusqlite Backup API（冻结二 九 推荐方案）。
//! - 禁止 std::fs::copy(source zhixing.db)（冻结二 九）。
//!
//! 原子性（Implementation Ready 二 注意 C/D）：
//!   *.db.tmp → Backup API → open tmp integrity_check → drop snapshot conn
//!           → streaming SHA256 → atomic rename → *.db
//!   *.json.part → 完整序列化 + write + sync_all → rename → *.json
//!
//! ═══════════════════════════════════════════════════════════════════
//! 收口 7｜Snapshot 完整性与 Orphan 读取规则（跨文件原子性说明）
//! ───────────────────────────────────────────────────────────────────
//! 由于 .db 与 .json 是两次独立 rename，不存在跨两文件的真正原子提交；
//! 因此未来任何恢复/校验逻辑必须遵守以下读取规则：
//!
//!   有效 Snapshot ⇔ 同时满足：
//!     1) snapshot.db 存在
//!     2) snapshot.json 存在（与 .db 同 UUID v4 前缀）
//!     3) JSON 中 path / checksum_sha256 / size_bytes 等元数据
//!        与 snapshot.db 实际文件 + 独立流式 SHA256 校验一致
//!
//!   孤立（orphan/incomplete）处理：
//!     - 仅存在 .db，无匹配 .json → orphan，未来恢复系统不得使用
//!     - 仅存在 .json，无匹配 .db → orphan，未来恢复系统不得使用
//!     - JSON 元数据与实际 DB 不一致 → orphan/invalid，不得使用
//!
//!   本 Step 不实现 orphan 自动清理（留作后续 Backup 子系统职责）。
//!
//! 不在 Step 9：restore / Backup Manifest / Backup UI / 自动 snapshot 清理。

use super::checksum::sha256_file_hex;
use super::migration::MigrationDefinition;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;
use thiserror::Error;
use uuid::Uuid;

/// 收口 4：Backup::run_to_completion(pages_per_step, pause, progress_cb)
/// 第一个参数是「每页数量（pages）」，绝非 bytes。禁止 1MiB / 1024*1024 这种字节语义命名。
/// SQLite 默认页大小 = 4096 B；256 pages × 4KiB = 1 MiB 每步；符合原意图且参数语义正确。
const BACKUP_PAGES_PER_STEP: i32 = 256;

/// 每步之间的短暂 pause（给底层 writer 时间；0 也是合法值）。
const BACKUP_STEP_PAUSE: Duration = Duration::from_millis(1);

#[derive(Debug, Error)]
pub enum SnapshotError {
    #[error("snapshot output directory is not accessible / missing: {path}: {io}")]
    OutputDir { path: String, io: String },

    #[error("cannot create snapshot tmp file: {path}: {io}")]
    CreateTmp { path: String, io: String },

    #[error("SQLite Backup API failed: {0}")]
    BackupApi(String),

    #[error("cannot open snapshot tmp for verification: {path}: {io}")]
    OpenTmp { path: String, io: String },

    #[error("snapshot integrity_check != ok, got: {0}")]
    IntegrityCheckNotOk(String),

    #[error("cannot compute streaming SHA256 on snapshot: {path}: {io}")]
    Checksum { path: String, io: String },

    #[error("cannot rename tmp snapshot to final .db: {from} → {to}: {io}")]
    RenameDb { from: String, to: String, io: String },

    #[error("cannot write snapshot report json.part: {path}: {io}")]
    ReportWritePart { path: String, io: String },

    #[error("cannot rename .json.part to .json: {from} → {to}: {io}")]
    RenameJson { from: String, to: String, io: String },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SnapshotReport {
    pub id: String,              // 完整 UUID v4（不人为缩短，冻结二 九 + 补充 3）
    pub for_version: u32,
    pub for_id: String,
    pub snapshot_db_path: PathBuf,
    pub report_json_path: PathBuf,
    pub size_bytes: u64,
    pub checksum_sha256: String,
    pub integrity_check_ok: bool,
    pub taken_at_ms: i64,
}

pub trait SnapshotProvider {
    fn before_high_risk_migration(
        &self,
        conn: &Connection,
        output_dir: &Path,
        m: &MigrationDefinition,
    ) -> Result<SnapshotReport, SnapshotError>;
}

/// 默认实现：SQLite Backup API（冻结二 九；rusqlite feature="backup" 启用）。
pub struct SqliteBackupSnapshot;

impl SnapshotProvider for SqliteBackupSnapshot {
    fn before_high_risk_migration(
        &self,
        conn: &Connection,
        output_dir: &Path,
        m: &MigrationDefinition,
    ) -> Result<SnapshotReport, SnapshotError> {
        // 1. output_dir 必须存在（Step 9 推荐 A：backup/ 属于 FirstBoot 5 FIXED_SUBDIRS）
        match fs::metadata(output_dir) {
            Ok(meta) if meta.is_dir() => {}
            Ok(meta) => {
                return Err(SnapshotError::OutputDir {
                    path: output_dir.display().to_string(),
                    io: format!("entry exists but is_dir=false, is_file={}", meta.is_file()),
                });
            }
            Err(io) => {
                return Err(SnapshotError::OutputDir {
                    path: output_dir.display().to_string(),
                    io: io.to_string(),
                });
            }
        }

        // 2. 生成完整 UUID v4 + 命名
        let id_full = Uuid::new_v4().to_string();
        let safe_id = sanitize_for_filename(m.id);
        let db_final = output_dir.join(format!(
            "migration_snapshot_v{}_{}_{}.db",
            m.version, safe_id, id_full
        ));
        let db_tmp = output_dir.join(format!(
            "migration_snapshot_v{}_{}_{}.db.tmp",
            m.version, safe_id, id_full
        ));
        let json_final = output_dir.join(format!(
            "migration_snapshot_v{}_{}_{}.json",
            m.version, safe_id, id_full
        ));
        let json_part = output_dir.join(format!(
            "migration_snapshot_v{}_{}_{}.json.part",
            m.version, safe_id, id_full
        ));

        // ===== 原子流程 =====
        // (a) Backup API → *.db.tmp
        {
            let tmp_conn = Connection::open(&db_tmp).map_err(|e| SnapshotError::CreateTmp {
                path: db_tmp.display().to_string(),
                io: e.to_string(),
            })?;
            // rusqlite backup：source → destination；backup_to 需要 feature backup
            // 对于 rusqlite 0.40 + backup feature：Backup::new(conn, &tmp_conn).step(...)
            // 或更简单：conn.backup(...) 方法（根据 rusqlite docs）
            // 这里使用 rusqlite::Backup::new
            let mut tmp_conn = tmp_conn;
            let backup = rusqlite::backup::Backup::new(conn, &mut tmp_conn).map_err(|e| {
                let _ = fs::remove_file(&db_tmp); // best-effort
                SnapshotError::BackupApi(e.to_string())
            })?;
            backup
                .run_to_completion(BACKUP_PAGES_PER_STEP, BACKUP_STEP_PAUSE, None)
                .map_err(|e| {
                    let _ = fs::remove_file(&db_tmp);
                    SnapshotError::BackupApi(e.to_string())
                })?;
            // Drop tmp_conn（闭包结束自动）；避免 Windows 文件句柄阻止 rename（冻结二 注意 C）
        }

        // (b) open tmp → integrity_check
        let integrity: String;
        {
            let verifier =
                Connection::open(&db_tmp).map_err(|e| SnapshotError::OpenTmp {
                    path: db_tmp.display().to_string(),
                    io: e.to_string(),
                })?;
            integrity = verifier
                .query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))
                .map_err(|e| {
                    let _ = fs::remove_file(&db_tmp);
                    SnapshotError::OpenTmp {
                        path: db_tmp.display().to_string(),
                        io: format!("integrity_check query: {e}"),
                    }
                })?;
            if integrity.to_lowercase() != "ok" {
                let _ = fs::remove_file(&db_tmp);
                return Err(SnapshotError::IntegrityCheckNotOk(integrity));
            }
            // Drop verifier conn（闭包结束）→ Windows 句柄释放 ✔
        }

        // (c) size_bytes + streaming SHA256（冻结二 D：不 fs::read 整库入内存）
        let size_bytes = fs::metadata(&db_tmp)
            .map(|m| m.len())
            .map_err(|e| {
                let _ = fs::remove_file(&db_tmp);
                SnapshotError::Checksum {
                    path: db_tmp.display().to_string(),
                    io: format!("metadata.len: {e}"),
                }
            })?;
        let checksum_sha256 = sha256_file_hex(&db_tmp).map_err(|e| {
            let _ = fs::remove_file(&db_tmp);
            SnapshotError::Checksum {
                path: db_tmp.display().to_string(),
                io: e.to_string(),
            }
        })?;

        // (d) atomic rename .db.tmp → .db（同目录 NTFS / ext4 原子）
        fs::rename(&db_tmp, &db_final).map_err(|e| {
            let _ = fs::remove_file(&db_tmp);
            SnapshotError::RenameDb {
                from: db_tmp.display().to_string(),
                to: db_final.display().to_string(),
                io: e.to_string(),
            }
        })?;

        // (e) write report → .json.part → rename → .json（冻结二 D 原子）
        let taken_at_ms = now_ms();
        let report = SnapshotReport {
            id: id_full.clone(),
            for_version: m.version,
            for_id: m.id.to_string(),
            snapshot_db_path: db_final.clone(),
            report_json_path: json_final.clone(),
            size_bytes,
            checksum_sha256,
            integrity_check_ok: true,
            taken_at_ms,
        };
        let json_str = serde_json::to_string_pretty(&report)
            .expect("SnapshotReport serialize never fails");
        {
            let mut f = fs::File::create(&json_part).map_err(|e| {
                let _ = fs::remove_file(&db_final);
                SnapshotError::ReportWritePart {
                    path: json_part.display().to_string(),
                    io: e.to_string(),
                }
            })?;
            if let Err(e) = f.write_all(json_str.as_bytes()) {
                let _ = fs::remove_file(&json_part);
                let _ = fs::remove_file(&db_final);
                return Err(SnapshotError::ReportWritePart {
                    path: json_part.display().to_string(),
                    io: e.to_string(),
                });
            }
            f.sync_all().map_err(|e| {
                let _ = fs::remove_file(&json_part);
                let _ = fs::remove_file(&db_final);
                SnapshotError::ReportWritePart {
                    path: json_part.display().to_string(),
                    io: format!("sync_all: {e}"),
                }
            })?;
        }
        fs::rename(&json_part, &json_final).map_err(|e| {
            let _ = fs::remove_file(&json_part);
            let _ = fs::remove_file(&db_final);
            SnapshotError::RenameJson {
                from: json_part.display().to_string(),
                to: json_final.display().to_string(),
                io: e.to_string(),
            }
        })?;

        Ok(report)
    }
}

fn sanitize_for_filename(s: &str) -> String {
    // migration id 只使用 [-_a-zA-Z0-9]，但做 conservative sanitize
    s.chars()
        .map(|c| match c {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '-' | '_' => c,
            _ => '_',
        })
        .collect()
}

fn now_ms() -> i64 {
    use std::time::{SystemTime, UNIX_EPOCH};
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// 测试可访问 SnapshotReport
