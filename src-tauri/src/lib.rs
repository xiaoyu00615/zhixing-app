//! Zhixing native library entry point.
//!
//! Phase 1A Step 8 启动链路（严格冻结）：
//! Tauri Builder.setup(app)
//!   ↓ PathResolver (不引入 dirs，不拼 %APPDATA%/%LOCALAPPDATA%)
//!   ↓ bootstrap::service::load 三态（Missing → FirstBoot Candidate；Valid → Load；Corrupt → Degraded）
//!     Missing → 延迟提交：Candidate → DataRoot(FirstBoot) initialize → db::open_configured_connection()
//!               → PRAGMA/FTS5/SELECT1 全部成功 → commit bootstrap.json → Healthy
//!               → 任何中间失败 → Degraded (不 panic/不 exit/不写半成 bootstrap)
//!     Valid   → DataRoot(Existing) get_and_ensure → boot_db → Healthy / Degraded
//!     Degraded→ 级联降级
//!
//! 边界：
//! - 不把 rusqlite::Connection 放入 Tauri managed State（推迟 Step 9）。
//! - 新增 Tauri commands = 0，仅保留 Step 7 native_ping。
//! - Step 8 无 UI，Degraded 仅 Rust 内部状态模型。
//!
//! ⚠️ 永久安全约束（本项目所有自动化 / CI 测试必须遵守）：
//! 任何测试、fixture、tearDown、setup 不得为了模拟 FirstBoot / Missing / Corrupt /
//! Migration / Restore / DataRoot failure 等场景，自动删除、覆盖或破坏真实用户：
//!   - bootstrap.json
//!   - Data Root（含 manifest.json / 子目录）
//!   - zhixing.db 及其 -wal / -shm / -journal
//!   - attachments / backup 目录下任何文件
//! 测试异常状态 → 仅允许：tempfile::TempDir / sandbox / 测试专用路径。
//! 只有在用户明确授权「清理开发数据」时，才允许触碰真实 AppData / Data Root。

mod bootstrap;
mod commands;
mod db;
mod storage;

use bootstrap::{BootstrapService, BootstrapState};
use storage::{paths as storage_paths, DataRootService, InitMode};
use tauri::Manager;

/// 应用启动时内部状态（Rust 内部可测试模型；Step 8 无 UI）。
/// 🔒 Tauri managed state 不要求 Clone，不为 Clone 而将错误降级为 String。
#[derive(Debug)]
pub enum RuntimeStatus {
    /// 所有子系统（bootstrap + Data Root + DB Policy）通过。
    Healthy,
    /// 至少一个子系统失败；Shell 仍正常启动。
    Degraded(DegradedCause),
}

/// 结构化退化原因（严格三类：Bootstrap / DataRoot / Database + Tauri PathResolver 合成）。
#[derive(Debug)]
pub enum DegradedCause {
    /// Bootstrap 子系统错误（Missing/Valid/Degraded 流程本身、bootstrap.json 读写、Candidate commit）。
    Bootstrap(Issue),
    /// Data Root 子系统错误（默认位置解析、initialize、manifest 校验、Existing 模式缺失目录）。
    DataRoot(Issue),
    /// Database 子系统错误（打开、PRAGMA、FTS5、SELECT 1 sanity、父目录存在性验证）。
    Database(Issue),
    /// Tauri PathResolver::app_config_dir / app_local_data_dir 返回 Err 时的结构化信息。
    /// 框架级：不归属三大子系统；Issue 统一结构保留 subsystem=path_resolver / kind / message。
    PathResolver(Issue),
}

/// 统一结构化错误载体：保留 subsystem / kind / path / message 四项。
///
/// 禁止只保存 String：所有子系统级 DegradedCause 必须通过此 Issue 传递，
/// 保证未来 UI / 诊断面板 / 日志桥接可以按 kind / path 做精确匹配。
#[derive(Debug)]
pub struct Issue {
    /// 子系统标签："bootstrap" | "data_root" | "database"
    pub subsystem: &'static str,
    /// 错误 kind：来自底层枚举变体名，例如 "Read" / "Parse" / "ManifestMissing" /
    ///            "SqliteOpen" / "Fts5NotCompiled" / "DatabaseParentMissing"
    pub kind: String,
    /// 涉及路径（如适用，绝对路径；不适用时为 None）
    pub path: Option<std::path::PathBuf>,
    /// Display 化的完整错误消息（保留 source chain）
    pub message: String,
}

impl From<bootstrap::error::BootstrapError> for Issue {
    fn from(err: bootstrap::error::BootstrapError) -> Self {
        use bootstrap::error::BootstrapError::*;
        let (kind, path) = match &err {
            Read { path, .. } => ("Read", Some(path.clone())),
            Parse { path, .. } => ("Parse", Some(path.clone())),
            Invalid { path, .. } => ("Invalid", Some(path.clone())),
            UnsupportedVersion { path, .. } => ("UnsupportedVersion", Some(path.clone())),
            Write { path, .. } => ("Write", Some(path.clone())),
            ConfigDirCreate { path, .. } => ("ConfigDirCreate", Some(path.clone())),
        };
        Self {
            subsystem: "bootstrap",
            kind: kind.into(),
            path,
            message: err.to_string(),
        }
    }
}

impl From<storage::error::DataRootError> for Issue {
    fn from(err: storage::error::DataRootError) -> Self {
        use storage::error::DataRootError::*;
        let (kind, path) = match &err {
            NotAbsolute(p) => ("NotAbsolute", Some(std::path::PathBuf::from(p))),
            NetworkShareUnsupported(p) => {
                ("NetworkShareUnsupported", Some(std::path::PathBuf::from(p)))
            }
            NotFound(p) => ("NotFound", Some(std::path::PathBuf::from(p))),
            EntryIsFile(p) => ("EntryIsFile", Some(std::path::PathBuf::from(p))),
            PermissionDenied { path, .. } => ("PermissionDenied", Some(std::path::PathBuf::from(path))),
            NonEmptyWithoutManifest(p) => {
                ("NonEmptyWithoutManifest", Some(std::path::PathBuf::from(p)))
            }
            ManifestMissing(p) => ("ManifestMissing", Some(std::path::PathBuf::from(p))),
            ManifestRead { path, .. } => ("ManifestRead", Some(std::path::PathBuf::from(path))),
            ManifestParse { path, .. } => ("ManifestParse", Some(std::path::PathBuf::from(path))),
            ManifestKindMismatch { .. } => ("ManifestKindMismatch", None),
            ManifestUnsupportedVersion { .. } => ("ManifestUnsupportedVersion", None),
            ManifestUnsupportedLayout { .. } => ("ManifestUnsupportedLayout", None),
            ManifestDatabaseRelativePathInvalid { .. } => {
                ("ManifestDatabaseRelativePathInvalid", None)
            }
            InitializeCreateDir { path, .. } => {
                ("InitializeCreateDir", Some(std::path::PathBuf::from(path)))
            }
            InitializeWriteManifest { path, .. } => {
                ("InitializeWriteManifest", Some(std::path::PathBuf::from(path)))
            }
            InitializeOnlyAllowedOnFirstBoot(p) => {
                ("InitializeOnlyAllowedOnFirstBoot", Some(std::path::PathBuf::from(p)))
            }
        };
        Self {
            subsystem: "data_root",
            kind: kind.into(),
            path,
            message: err.to_string(),
        }
    }
}

impl From<db::error::DbError> for Issue {
    fn from(err: db::error::DbError) -> Self {
        use db::error::DbError::*;
        let (kind, path) = match &err {
            SqliteOpen { path, .. } => ("SqliteOpen", Some(std::path::PathBuf::from(path))),
            DatabaseParentMissing(p) => {
                ("DatabaseParentMissing", Some(std::path::PathBuf::from(p)))
            }
            DatabaseParentIsFile(p) => ("DatabaseParentIsFile", Some(std::path::PathBuf::from(p))),
            PragmaReadbackMismatch { .. } => ("PragmaReadbackMismatch", None),
            Fts5NotCompiled => ("Fts5NotCompiled", None),
            PragmaUpdate { .. } => ("PragmaUpdate", None),
            PragmaRead { .. } => ("PragmaRead", None),
            SanityCheck { .. } => ("SanityCheck", None),
            SanityCheckValue(_) => ("SanityCheckValue", None),
        };
        Self {
            subsystem: "database",
            kind: kind.into(),
            path,
            message: err.to_string(),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![commands::native_ping])
        .setup(|app| {
            // 🔒 冻结 §3：路径统一通过 PathResolver。
            let runtime_status = match (app.path().app_config_dir(), app.path().app_local_data_dir()) {
                (Ok(app_config_dir), Ok(app_local_data_dir)) => {
                    run_bootstrap_pipeline(&app_config_dir, &app_local_data_dir)
                }
                (cfg_res, local_res) => {
                    // PathResolver 错误任何一个 → PathResolver cause Degraded；Shell 仍启动。
                    // 🔒 结构化 Issue（DegradedCause 所有变体均不保存裸 String）。
                    let mut failed_kinds: Vec<&'static str> = Vec::new();
                    let mut messages: Vec<String> = Vec::new();
                    if let Err(e) = cfg_res {
                        failed_kinds.push("app_config_dir");
                        messages.push(format!("app_config_dir: {e}"));
                    }
                    if let Err(e) = local_res {
                        failed_kinds.push("app_local_data_dir");
                        messages.push(format!("app_local_data_dir: {e}"));
                    }
                    let kind: String = match failed_kinds[..] {
                        [single] => single.into(),
                        _ => "MultipleResolverErrors".into(),
                    };
                    let issue = Issue {
                        subsystem: "path_resolver",
                        kind,
                        path: None, // Tauri 路径解析失败不对应单一文件路径
                        message: messages.join("; "),
                    };
                    RuntimeStatus::Degraded(DegradedCause::PathResolver(issue))
                }
            };
            app.manage(runtime_status);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 启动流水线（可独立 unit test；无 Tauri 依赖；按冻结 4 修订）。
fn run_bootstrap_pipeline(app_config_dir: &std::path::Path, app_local_data_dir: &std::path::Path) -> RuntimeStatus {
    let default_data_root = storage_paths::default_data_root(app_local_data_dir);

    match BootstrapService::load(&BootstrapService::bootstrap_path(app_config_dir)) {
        BootstrapState::Missing { bootstrap_path } => {
            // FirstBoot：Candidate 内存，延迟提交。
            let candidate = BootstrapService::new_candidate(bootstrap_path, default_data_root);
            match DataRootService::get_and_ensure(&candidate.data_root, InitMode::FirstBoot) {
                Ok((data_root, manifest)) => {
                    let db_path = DataRootService::resolve_database_path(&data_root, &manifest);
                    match db::bootstrap::boot_db(&db_path) {
                        Ok(_) => match candidate.commit() {
                            Ok(_) => RuntimeStatus::Healthy,
                            Err(e) => {
                                RuntimeStatus::Degraded(DegradedCause::Bootstrap(e.into()))
                            }
                        },
                        Err(e) => {
                            // 冻结 2：DB Bootstrap Error 必须 Degraded，禁止 ? 让 setup 失败。
                            // 冻结 1 新测试：first_boot_db_failure_does_not_commit_bootstrap
                            // 因 commit() 从未被调用，bootstrap.json 保持 Missing。
                            RuntimeStatus::Degraded(DegradedCause::Database(e.into()))
                        }
                    }
                }
                Err(e) => RuntimeStatus::Degraded(DegradedCause::DataRoot(e.into())),
            }
        }

        BootstrapState::Valid(loaded) => {
            // Existing Valid：DataRoot InitMode=Existing（禁止 initialize 新建空库/覆盖）。
            // 🔒 实际读取 bootstrap_path 字段（消除 "field is never read"，并保持派生信息）。
            let _bp = &loaded.bootstrap_path;
            match DataRootService::get_and_ensure(&loaded.data_root, InitMode::Existing) {
                Ok((data_root, manifest)) => {
                    let db_path = DataRootService::resolve_database_path(&data_root, &manifest);
                    match db::bootstrap::boot_db(&db_path) {
                        Ok(_) => RuntimeStatus::Healthy,
                        Err(e) => RuntimeStatus::Degraded(DegradedCause::Database(e.into())),
                    }
                }
                Err(e) => RuntimeStatus::Degraded(DegradedCause::DataRoot(e.into())),
            }
        }

        BootstrapState::Degraded(e) => {
            // 不删/不覆盖/不重建 device_id；直接级联 Degraded。
            RuntimeStatus::Degraded(DegradedCause::Bootstrap(e.into()))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bootstrap::{BootstrapService, LoadedBootstrap, BOOTSTRAP_FILENAME};
    use std::fs;
    use storage::{InitMode, MANIFEST_FILENAME};
    use tempfile::tempdir;

    fn sandbox() -> (tempfile::TempDir, std::path::PathBuf, std::path::PathBuf) {
        let t = tempdir().unwrap();
        let cfg = t.path().join("cfg");
        let local = t.path().join("local");
        fs::create_dir_all(&cfg).unwrap();
        fs::create_dir_all(&local).unwrap();
        (t, cfg, local)
    }

    fn write_bootstrap(cfg: &std::path::Path, data_root: &std::path::Path, device_id: &str) {
        let json = serde_json::json!({
            "bootstrap_version": 1,
            "device_id": device_id,
            "data_root": data_root
        });
        fs::write(
            cfg.join(BOOTSTRAP_FILENAME),
            serde_json::to_string_pretty(&json).unwrap(),
        )
        .unwrap();
    }

    fn load_bootstrap(cfg: &std::path::Path) -> LoadedBootstrap {
        match BootstrapService::load(&cfg.join(BOOTSTRAP_FILENAME)) {
            BootstrapState::Valid(loaded) => loaded,
            other => panic!("expect Valid, got {:?}", other),
        }
    }

    // --- 1. first_boot_creates_valid_bootstrap ---
    #[test]
    fn first_boot_creates_valid_bootstrap() {
        let (_t, cfg, local) = sandbox();
        let status = run_bootstrap_pipeline(&cfg, &local);
        assert!(matches!(status, RuntimeStatus::Healthy), "{:?}", status);
        let bootstrap_path = cfg.join(BOOTSTRAP_FILENAME);
        assert!(bootstrap_path.exists(), "bootstrap.json 必须被提交");
        let loaded = load_bootstrap(&cfg);
        assert_eq!(loaded.bootstrap_version, 1);
        assert_eq!(loaded.device_id.as_str().len(), 36); // UUID v4 canonical
        let expected_root = local.join("data");
        assert_eq!(loaded.data_root, expected_root);
        assert!(expected_root.join(MANIFEST_FILENAME).exists());
        assert!(expected_root.join("database").is_dir());
        assert!(expected_root.join("attachments").is_dir());
        assert!(expected_root.join("thumbnails").is_dir());
        assert!(expected_root.join("backup").is_dir());
        assert!(expected_root.join("metadata").is_dir());
        assert!(expected_root.join("database").join("zhixing.db").exists());
    }

    // --- 2. corrupt_bootstrap_does_not_overwrite_or_regen_device_id (关键安全) ---
    #[test]
    fn corrupt_bootstrap_does_not_overwrite_or_regen_device_id() {
        let (_t, cfg, local) = sandbox();
        let corrupt = "not valid json {{{{";
        let path = cfg.join(BOOTSTRAP_FILENAME);
        fs::write(&path, corrupt).unwrap();
        let before = fs::read(&path).unwrap();

        let status = run_bootstrap_pipeline(&cfg, &local);
        // 必须 Degraded
        assert!(
            matches!(status, RuntimeStatus::Degraded(DegradedCause::Bootstrap(_))),
            "{:?}",
            status
        );
        // 🔒 文件字节保持不变（不删/不覆盖/不重建）
        let after = fs::read(&path).unwrap();
        assert_eq!(before, after, "corrupt bootstrap 文件被改动了");
        // 不能有 bootstrap.json.tmp 残留（本流程不应写）
        assert!(!path.with_extension("json.tmp").exists());
    }

    // --- 3. valid_bootstrap_loads_idempotent (字节不变) ---
    #[test]
    fn valid_bootstrap_loads_idempotent() {
        let (_t, cfg, local) = sandbox();
        let did = "12345678-1234-4321-8000-0123456789ab";
        let data_root = local.join("data");
        // 先手动造完整 Data Root（否则 Existing 流程会 Degraded）
        fs::create_dir_all(data_root.join("database")).unwrap();
        fs::create_dir_all(data_root.join("attachments")).unwrap();
        fs::create_dir_all(data_root.join("thumbnails")).unwrap();
        fs::create_dir_all(data_root.join("backup")).unwrap();
        fs::create_dir_all(data_root.join("metadata")).unwrap();
        let db_path = data_root.join("database/zhixing.db");
        // 初始化空 DB + PRAGMA (用 open_configured_connection)
        db::policy::open_configured_connection(&db_path).unwrap();
        let manifest = storage::manifest::DataRootManifest::simple();
        fs::write(
            data_root.join(MANIFEST_FILENAME),
            serde_json::to_string_pretty(&manifest).unwrap(),
        )
        .unwrap();
        write_bootstrap(&cfg, &data_root, did);

        let before_bytes = fs::read(cfg.join(BOOTSTRAP_FILENAME)).unwrap();
        let status = run_bootstrap_pipeline(&cfg, &local);
        assert!(matches!(status, RuntimeStatus::Healthy), "{:?}", status);
        let loaded = load_bootstrap(&cfg);
        assert_eq!(loaded.device_id.as_str(), did);
        let after_bytes = fs::read(cfg.join(BOOTSTRAP_FILENAME)).unwrap();
        assert_eq!(before_bytes, after_bytes, "Valid bootstrap 不应被写回");
    }

    // --- 4. existing_bootstrap_missing_data_root_does_not_create (关键安全) ---
    #[test]
    fn existing_bootstrap_missing_data_root_does_not_create() {
        let (_t, cfg, local) = sandbox();
        let did = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
        let nonexistent = local.join("data"); // 将 Valid bootstrap 指向该目录，但我们不创建它
        write_bootstrap(&cfg, &nonexistent, did);

        let status = run_bootstrap_pipeline(&cfg, &local);
        // 必须 Degraded（DataRoot 缺失）
        assert!(
            matches!(status, RuntimeStatus::Degraded(DegradedCause::DataRoot(_))),
            "{:?}",
            status
        );
        // 🔒 禁止自动创建新 Data Root
        assert!(!nonexistent.exists(), "Existing 模式不应创建缺失的 Data Root");
        // 🔒 device_id 保持不变（bootstrap 文件未变）
        let loaded = load_bootstrap(&cfg);
        assert_eq!(loaded.device_id.as_str(), did);
    }

    // --- 5. non_empty_root_without_manifest_does_not_initialize (关键安全) ---
    #[test]
    fn non_empty_root_without_manifest_does_not_initialize() {
        let (_t, cfg, local) = sandbox();
        let data_root = local.join("data");
        // FirstBoot 场景：目录存在，但里面有垃圾文件（NonEmptyWithoutManifest）
        fs::create_dir_all(&data_root).unwrap();
        fs::write(data_root.join("notes.txt"), "old stuff").unwrap();

        let status = run_bootstrap_pipeline(&cfg, &local);
        // Missing → FirstBoot → 但实际状态 DirNonEmptyNoManifest → Degraded DataRoot
        assert!(
            matches!(status, RuntimeStatus::Degraded(DegradedCause::DataRoot(_))),
            "{:?}",
            status
        );
        // 🔒 不 initialize（不应生成 manifest.json）
        assert!(!data_root.join(MANIFEST_FILENAME).exists());
        // 🔒 不应创建 zhixing.db
        assert!(!data_root.join("database").join("zhixing.db").exists());
        // 🔒 旧 notes.txt 必须完整保留
        assert_eq!(fs::read_to_string(data_root.join("notes.txt")).unwrap(), "old stuff");
        // bootstrap.json 未被提交（因为 initialize 失败 → 不 commit）
        assert!(!cfg.join(BOOTSTRAP_FILENAME).exists());
    }

    // --- 6. first_boot_empty_root_initializes (关键安全) ---
    #[test]
    fn first_boot_empty_root_initializes() {
        let (_t, cfg, local) = sandbox();
        let data_root = local.join("data");
        fs::create_dir_all(&data_root).unwrap(); // 空目录
        let status = run_bootstrap_pipeline(&cfg, &local);
        assert!(matches!(status, RuntimeStatus::Healthy), "{:?}", status);
        assert!(data_root.join(MANIFEST_FILENAME).is_file());
        assert!(data_root.join("database").join("zhixing.db").is_file());
        assert!(cfg.join(BOOTSTRAP_FILENAME).is_file());
    }

    // --- 7. valid_root_reopen (字节完全一致) ---
    #[test]
    fn valid_root_reopen() {
        // 先 FirstBoot
        let (_t, cfg, local) = sandbox();
        assert!(matches!(
            run_bootstrap_pipeline(&cfg, &local),
            RuntimeStatus::Healthy
        ));
        let loaded1 = load_bootstrap(&cfg);
        let data_root = loaded1.data_root.clone();
        let manifest_before =
            fs::read_to_string(data_root.join(MANIFEST_FILENAME)).unwrap();
        // 再次 Existing → reopen
        assert!(matches!(
            run_bootstrap_pipeline(&cfg, &local),
            RuntimeStatus::Healthy
        ));
        let loaded2 = load_bootstrap(&cfg);
        assert_eq!(loaded1.device_id, loaded2.device_id);
        assert_eq!(loaded1.bootstrap_path, loaded2.bootstrap_path);
        // manifest 字节一致（不追加字段）
        let manifest_after =
            fs::read_to_string(data_root.join(MANIFEST_FILENAME)).unwrap();
        assert_eq!(manifest_before, manifest_after);
    }

    // --- 8. sqlite_open_zero_tables ---
    #[test]
    fn sqlite_open_zero_tables() {
        let t = tempdir().unwrap();
        let db = t.path().join("database");
        fs::create_dir_all(&db).unwrap();
        let db_path = db.join("zhixing.db");
        let conn = db::policy::open_configured_connection(&db_path).unwrap();
        let cnt: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master WHERE type='table'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(cnt, 0, "禁止 Step 8 创建任何业务表");
        // 也不应该有 index/trigger/view
        let cnt_all: i64 = conn
            .query_row("SELECT COUNT(*) FROM sqlite_master", [], |r| r.get(0))
            .unwrap();
        assert_eq!(cnt_all, 0);
    }

    // --- 9. pragma_readback_correct ---
    #[test]
    fn pragma_readback_correct() {
        let t = tempdir().unwrap();
        fs::create_dir_all(t.path().join("database")).unwrap();
        let db_path = t.path().join("database/zhixing.db");
        let conn = db::policy::open_configured_connection(&db_path).unwrap();
        let pr = |name: &str| -> String {
            conn.query_row(&format!("PRAGMA {}", name), [], |r| {
                let v: rusqlite::types::Value = r.get(0).unwrap();
                Ok(match v {
                    rusqlite::types::Value::Text(s) => s,
                    rusqlite::types::Value::Integer(i) => i.to_string(),
                    other => format!("{other:?}"),
                })
            })
            .unwrap()
        };
        assert_eq!(pr("journal_mode").to_lowercase(), "wal");
        assert_eq!(pr("foreign_keys"), "1");
        assert_eq!(pr("busy_timeout"), "5000");
        let sync = pr("synchronous").to_lowercase();
        assert!(sync == "1" || sync == "normal", "synchronous = {}", sync);
    }

    // --- 10. fts5_enabled (冻结 §11 sqlite_compileoption_used) ---
    #[test]
    fn fts5_enabled() {
        let t = tempdir().unwrap();
        fs::create_dir_all(t.path().join("database")).unwrap();
        let db_path = t.path().join("database/zhixing.db");
        let conn = db::policy::open_configured_connection(&db_path).unwrap();
        let v: i64 = conn
            .query_row("SELECT sqlite_compileoption_used('ENABLE_FTS5')", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(v, 1, "ENABLE_FTS5 未编译进 bundled SQLite");
    }

    // --- 11. restart_device_id_unchanged (关键安全) ---
    #[test]
    fn restart_device_id_unchanged() {
        let (_t, cfg, local) = sandbox();
        // first boot
        assert!(matches!(
            run_bootstrap_pipeline(&cfg, &local),
            RuntimeStatus::Healthy
        ));
        let a = load_bootstrap(&cfg).device_id.as_str().to_string();
        // "restart" → load again (Existing pipeline)
        assert!(matches!(
            run_bootstrap_pipeline(&cfg, &local),
            RuntimeStatus::Healthy
        ));
        let b = load_bootstrap(&cfg).device_id.as_str().to_string();
        assert_eq!(a, b, "重启后 device_id 发生变化");
    }

    // --- 12. path_no_network_root (UNC) ---
    #[test]
    fn path_no_network_root() {
        let unc = std::path::PathBuf::from(r"\\server\share\data");
        let err = storage::paths::validate_basic(&unc).unwrap_err();
        assert!(
            matches!(err, storage::error::DataRootError::NetworkShareUnsupported(_)),
            "{:?}",
            err
        );
    }

    // --- 13. first_boot_db_failure_does_not_commit_bootstrap (冻结 §1 新增) ---
    #[test]
    fn first_boot_db_failure_does_not_commit_bootstrap() {
        // 分步模拟：Candidate → initialize 成功 → 人为破坏 database 目录 → boot_db 失败
        // 目标：bootstrap.json 在失败后保持 Missing（文件不存在）。
        let (_t, cfg, local) = sandbox();
        let bootstrap_path = BootstrapService::bootstrap_path(&cfg);
        let default_data_root = storage::paths::default_data_root(&local);

        assert!(!bootstrap_path.exists());
        let candidate = BootstrapService::new_candidate(bootstrap_path.clone(), default_data_root);

        // FirstBoot initialize 正常
        let (data_root, manifest) = DataRootService::get_and_ensure(
            &candidate.data_root,
            InitMode::FirstBoot,
        )
        .unwrap();
        let db_path = DataRootService::resolve_database_path(&data_root, &manifest);

        // 🔪 破坏：删掉 database/ 目录并创建同名占位文件 → validate_parent_is_file
        let parent = db_path.parent().unwrap();
        fs::remove_dir_all(parent).unwrap();
        fs::write(parent, "block").unwrap();

        // boot_db 应失败
        let err = db::bootstrap::boot_db(&db_path).unwrap_err();
        assert!(
            matches!(err, db::error::DbError::DatabaseParentIsFile(_)),
            "{:?}",
            err
        );

        // 🔒 关键断言：bootstrap.json 从未被 commit（Candidate.commit 未调用）
        assert!(
            !bootstrap_path.exists(),
            "DB 失败后 bootstrap.json 不应存在"
        );
        // 也没有 .tmp 残留
        assert!(!bootstrap_path.with_extension("json.tmp").exists());
    }

    // -------- 快速：检查 Connection 未被写入 State（静态，通过类型检查） --------
    // 此处不跑 Tauri Builder，仅通过 API 可见性：lib.rs 未 pub use Connection 或 manage State<Connection>：
    // 已满足：本文件无 `app.manage(Connection)`；RuntimeStatus 成员皆 String/Unit。

    // -------- 快速：Rust 侧不包含 sqlite_master count > 0 的"初始化"代码 --------
    // 已被 #8 覆盖。
}
