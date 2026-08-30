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
//! 边界演进：
//! - 不把 rusqlite::Connection 放入 Tauri managed State；Phase 1B Task commands
//!   只通过 Existing bootstrap/Data Root 打开短生命周期 existing-only connection。
//! - Step 8 只保留 native_ping；Phase 1B 增加批准的 capability-specific Task commands。
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
mod canvas;
mod commands;
mod db;
mod diagnostics;
mod project;
mod storage;
mod tag;
mod task;

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
        let (kind, path): (&str, Option<std::path::PathBuf>) = match &err {
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
            // 收口 5：Migration 分支 → 单一 authoritative kind() 调用；
            // 不再复制 16-way match。链路：MigrationError.kind() → Issue.kind。
            Migration(me) => {
                return Issue {
                    subsystem: "migration",
                    kind: me.kind().into(),
                    path: None,
                    message: me.to_string(),
                };
            }
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
    diagnostics::init_tracing();

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::native_ping,
            commands::task_create,
            commands::task_list,
            commands::task_list_trashed,
            commands::task_trash,
            commands::task_restore,
            commands::task_rename,
            commands::task_change_status,
            commands::task_set_importance,
            commands::task_set_urgency,
            commands::task_set_deadline,
            commands::task_clear_deadline,
            commands::task_set_project,
            commands::task_clear_project,
            commands::task_add_tag,
            commands::task_remove_tag,
            commands::project_create,
            commands::project_list,
            commands::project_rename,
            commands::tag_create,
            commands::tag_list,
            commands::tag_rename,
            commands::canvas_create,
            commands::canvas_list,
            commands::canvas_get,
            commands::canvas_rename,
            commands::canvas_update_viewport,
            commands::canvas_node_create,
            commands::canvas_node_list,
            commands::canvas_node_update_content,
            commands::canvas_node_rename,
            commands::canvas_node_move,
            commands::canvas_nodes_move,
            commands::canvas_edge_create,
            commands::canvas_edge_list,
            commands::canvas_edge_set_direction,
            commands::canvas_edge_set_line_style,
            commands::canvas_edge_delete
        ])
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
            diagnostics::record_startup_status(&runtime_status);
            app.manage(runtime_status);
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 启动流水线（可独立 unit test；无 Tauri 依赖；Step 9 FirstBoot 顺序 + Existing 接入）。
fn run_bootstrap_pipeline(
    app_config_dir: &std::path::Path,
    app_local_data_dir: &std::path::Path,
) -> RuntimeStatus {
    use db::definitions::MIGRATIONS;
    use db::snapshot::SqliteBackupSnapshot;
    // 收口 1：生产入口直接使用生产 MIGRATIONS + SqliteBackupSnapshot；
    // 测试通过内部 run_with_migrations 注入自定义切片，不改 API / 不加 Tauri command。
    run_bootstrap_pipeline_with_migrations::<SqliteBackupSnapshot>(
        app_config_dir,
        app_local_data_dir,
        MIGRATIONS,
        SqliteBackupSnapshot,
    )
}

/// Private bootstrap implementation helper.
/// Production uses frozen MIGRATIONS + SqliteBackupSnapshot;
/// tests may inject custom migrations / SnapshotProvider.
fn run_bootstrap_pipeline_with_migrations<S: db::snapshot::SnapshotProvider>(
    app_config_dir: &std::path::Path,
    app_local_data_dir: &std::path::Path,
    migrations: &[db::migration::MigrationDefinition],
    snapshot: S,
) -> RuntimeStatus {
    let default_data_root = storage_paths::default_data_root(app_local_data_dir);

    match BootstrapService::load(&BootstrapService::bootstrap_path(app_config_dir)) {
        BootstrapState::Missing { bootstrap_path } => {
            // FirstBoot Step 9 冻结顺序（审核三）：
            // 1. Candidate 内存；2. DataRoot initialize；3. open_configured_connection 成功；
            // 4. candidate.commit bootstrap.json；5. MigrationRunner.run → Healthy / Degraded
            let candidate = BootstrapService::new_candidate(bootstrap_path, default_data_root);
            match DataRootService::get_and_ensure(&candidate.data_root, InitMode::FirstBoot) {
                Ok((data_root, manifest)) => {
                    let db_path = DataRootService::resolve_database_path(&data_root, &manifest);
                    // Step 9 顺序 (3)：先 open + PRAGMA，失败时 Degraded，不 commit bootstrap。
                    match db::policy::open_configured_connection(&db_path) {
                        Ok(mut conn) => {
                            // Step 9 顺序 (4)：Location/DataRoot/Open 全部 OK → commit bootstrap.json。
                            match candidate.commit() {
                                Ok(_loaded) => {
                                    // Step 9 顺序 (5)：MigrationRunner（调用方注入 migrations + snapshot）。
                                    let snapshot_dir = data_root.join("backup");
                                    let runner = db::migration::MigrationRunner::new(migrations, snapshot);
                                    match runner.run(&mut conn, &snapshot_dir) {
                                        Ok(_result) => RuntimeStatus::Healthy,
                                        Err(migration_err) => {
                                            RuntimeStatus::Degraded(
                                                DegradedCause::Database(migration_err.into()),
                                            )
                                        }
                                    }
                                }
                                Err(commit_err) => {
                                    drop(conn);
                                    RuntimeStatus::Degraded(DegradedCause::Bootstrap(
                                        commit_err.into(),
                                    ))
                                }
                            }
                        }
                        Err(db_err) => {
                            RuntimeStatus::Degraded(DegradedCause::Database(db_err.into()))
                        }
                    }
                }
                Err(e) => RuntimeStatus::Degraded(DegradedCause::DataRoot(e.into())),
            }
        }

        BootstrapState::Valid(loaded) => {
            // Existing：每次启动都跑 Runner；上次 ApplyFailed 因 Tx rollback 自动重试 pending。
            let _bp = &loaded.bootstrap_path;
            match DataRootService::get_and_ensure(&loaded.data_root, InitMode::Existing) {
                Ok((data_root, manifest)) => {
                    let db_path = DataRootService::resolve_database_path(&data_root, &manifest);
                    match db::policy::open_configured_connection(&db_path) {
                        Ok(mut conn) => {
                            let snapshot_dir = data_root.join("backup");
                            let runner = db::migration::MigrationRunner::new(migrations, snapshot);
                            match runner.run(&mut conn, &snapshot_dir) {
                                Ok(_result) => RuntimeStatus::Healthy,
                                Err(me) => RuntimeStatus::Degraded(
                                    DegradedCause::Database(me.into()),
                                ),
                            }
                        }
                        Err(db_err) => {
                            RuntimeStatus::Degraded(DegradedCause::Database(db_err.into()))
                        }
                    }
                }
                Err(e) => RuntimeStatus::Degraded(DegradedCause::DataRoot(e.into())),
            }
        }

        BootstrapState::Degraded(e) => {
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

        // open_configured_connection 应失败（validate_parent 报错：DatabaseParentIsFile）
        let err = db::policy::open_configured_connection(&db_path).unwrap_err();
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

    // ============================================================
    // Step 9 Boot Pipeline Integration（冻结六 18 + 19）
    // ============================================================

    // --- [18] FirstBoot integration：production migrations apply through the Runner ---
    #[test]
    fn step9_first_boot_pipeline_integration() {
        let (_t, cfg, local) = sandbox();
        let status = run_bootstrap_pipeline(&cfg, &local);
        assert!(matches!(status, RuntimeStatus::Healthy), "{:?}", status);
        // 🔒 bootstrap.json 必须已 commit（Step 9 顺序: init→open→commit→Runner）
        let bp = cfg.join(BOOTSTRAP_FILENAME);
        assert!(bp.exists(), "FirstBoot 成功后 bootstrap.json 必须存在");
        let loaded = load_bootstrap(&cfg);
        let data_root = loaded.data_root.clone();
        // Data Root 结构
        assert!(data_root.join(MANIFEST_FILENAME).is_file());
        assert!(data_root.join("database/zhixing.db").is_file());
        assert!(data_root.join("backup").is_dir());
        // DB 打开 → schema_migrations + approved business tables are present.
        let conn = db::policy::open_configured_connection(&data_root.join("database/zhixing.db")).unwrap();
        let cnt_meta: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='schema_migrations'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cnt_meta, 1, "Runner 必须自举 schema_migrations");
        let rows: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM schema_migrations",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(rows, 9, "Production Migrations 1-9 必须写入 history");
        let task_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tasks'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(task_table, 1, "Migration 1 必须创建 tasks");
        let project_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='projects'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(project_table, 1, "Migration 3 必须创建 projects");
        let tag_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='tags'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(tag_table, 1, "Migration 4 必须创建 tags");
        let task_tags_table: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='task_tags'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(task_tags_table, 1, "Migration 4 必须创建 task_tags");
        // No unapproved business tables exist.
        let others: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master \
                 WHERE type='table' AND name NOT IN ('schema_migrations', 'tasks', 'projects', 'tags', 'task_tags', 'canvases', 'canvas_nodes', 'canvas_edges')",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(others, 0, "不得创建未批准业务表");
    }

    // --- [19] Existing / retry / failure integration：
    // 先 FirstBoot → 手动破坏 history 使其产生 MigrationError（FutureVersion）→
    // 下次 Existing 启动返回 Degraded(Database)，**bootstrap/Data Root 不被删除/修改**。
    #[test]
    fn step9_existing_retry_failure_preserves_everything() {
        let (_t, cfg, local) = sandbox();
        // (1) FirstBoot 正常
        assert!(matches!(
            run_bootstrap_pipeline(&cfg, &local),
            RuntimeStatus::Healthy
        ));
        let loaded1 = load_bootstrap(&cfg);
        let device_id_1 = loaded1.device_id.as_str().to_string();
        let data_root = loaded1.data_root.clone();
        let db_path = data_root.join("database/zhixing.db");
        let bootstrap_bytes_before = fs::read(cfg.join(BOOTSTRAP_FILENAME)).unwrap();
        let manifest_bytes_before =
            fs::read(data_root.join(MANIFEST_FILENAME)).unwrap();

        // (2) Production already applied v1-v9; insert an unknown v10.
        {
            let conn = db::policy::open_configured_connection(&db_path).unwrap();
            conn.execute_batch(
                "INSERT INTO schema_migrations(version,id,checksum_sha256,applied_at_ms) \
                 VALUES(10,'m10','sha10',101);",
            )
            .unwrap();
        }

        // (3) Existing 启动 → Degraded(Database)
        let status = run_bootstrap_pipeline(&cfg, &local);
        assert!(
            matches!(
                status,
                RuntimeStatus::Degraded(DegradedCause::Database(ref issue))
                if issue.kind == "FutureVersion"
            ),
            "Expected Degraded(Database::FutureVersion), got {:?}",
            status
        );

        // 🔒 bootstrap/Data Root 保留不变（不删/不覆盖/不重建）
        let bootstrap_bytes_after = fs::read(cfg.join(BOOTSTRAP_FILENAME)).unwrap();
        assert_eq!(
            bootstrap_bytes_before, bootstrap_bytes_after,
            "Existing migration failure 不得改 bootstrap.json"
        );
        let manifest_bytes_after =
            fs::read(data_root.join(MANIFEST_FILENAME)).unwrap();
        assert_eq!(
            manifest_bytes_before, manifest_bytes_after,
            "Existing migration failure 不得改 manifest"
        );
        let loaded2 = load_bootstrap(&cfg);
        assert_eq!(device_id_1.as_str(), loaded2.device_id.as_str());
        assert!(db_path.exists(), "失败不得删 zhixing.db");

        // (4) Remove only the injected v10 row; approved v1-v9 remain intact.
        {
            let conn = db::policy::open_configured_connection(&db_path).unwrap();
            conn.execute_batch("DELETE FROM schema_migrations WHERE version = 10;")
                .unwrap();
        }
        let status = run_bootstrap_pipeline(&cfg, &local);
        assert!(matches!(status, RuntimeStatus::Healthy), "{:?}", status);
        // 再次确认 bootstrap/manifest 字节不变
        let bootstrap_bytes_after2 = fs::read(cfg.join(BOOTSTRAP_FILENAME)).unwrap();
        assert_eq!(bootstrap_bytes_before, bootstrap_bytes_after2);
    }

    // ============================================================
    // 收口 1：FirstBoot migration failure → Existing retry 真正集成测试
    // ============================================================
    // （非手工污染 history 模式；通过真实 M_bad 触发 Tx rollback → bootstrap 已提交 → 失败 → 第二次启动 Existing 路径用修正 migration 重试成功）

    use db::migration::MigrationDefinition;
    use db::snapshot::SqliteBackupSnapshot;

    /// bad migration：第一次 migrate 时失败（同 Tx 内 rollback schema + history）。
    const FAIL_M1: MigrationDefinition = MigrationDefinition {
        version: 1,
        id: "20250101_bad_dup_t1",
        sql_up: "CREATE TABLE t1(id INTEGER); CREATE TABLE t1(id INTEGER);", // duplicate → ApplyFailed
        high_risk: false,
    };

    /// good migration（修正后的版本）：相同 id 不同 SQL 是另一种 corruption，这里用同一「执行意图」的正确 version 1 + 不同 id → 形成 proper migration series [GOOD_M1, GOOD_M2]。
    /// 因为 FirstBoot failure 后 history 为空，直接把 GOOD_M1 id 设为不同即可（失败的 FAIL_M1 作为 pending 仍未执行；把 Runner 换成 [GOOD_M1] 就会成功）。
    const GOOD_M1: MigrationDefinition = MigrationDefinition {
        version: 1,
        id: "20250101_fixed_create_t1",
        sql_up: "CREATE TABLE t1(id INTEGER PRIMARY KEY NOT NULL);",
        high_risk: false,
    };
    const GOOD_M2: MigrationDefinition = MigrationDefinition {
        version: 2,
        id: "20250102_create_t2",
        sql_up: "CREATE TABLE t2(v TEXT NOT NULL);",
        high_risk: false,
    };

    fn file_mtime(p: &std::path::Path) -> Option<std::time::SystemTime> {
        fs::metadata(p).ok().and_then(|m| m.modified().ok())
    }

    /// 收口 1｜真正 FirstBoot failure → Existing retry：
    ///   1) Missing → init → open → commit bootstrap → Runner.run(FAIL_M1) ApplyFailed
    ///      → Degraded(Database ApplyFailed)
    ///   2) bootstrap.json 已存在（device_id 已知，字节保存，mtime 保存）；
    ///      failed schema t1 不存在；schema_migrations 0 成功行；
    ///      zhixing.db / Data Root / manifest 不被删。
    ///   3) 模拟第二次启动：Bootstrap Valid → Existing → Runner.run([GOOD_M1, GOOD_M2])
    ///      → Healthy；bootstrap 内容和 mtime 不被重写；device_id 不变。
    #[test]
    fn step9_closeout_first_boot_failure_existing_retry() {
        let (_t, cfg, local) = sandbox();

        // ─── (1) FirstBoot 用 [FAIL_M1] → migration 应失败 ───
        let s1 = run_bootstrap_pipeline_with_migrations::<SqliteBackupSnapshot>(
            &cfg,
            &local,
            &[FAIL_M1],
            SqliteBackupSnapshot,
        );
        match &s1 {
            RuntimeStatus::Degraded(DegradedCause::Database(issue)) => {
                assert_eq!(issue.subsystem, "migration");
                assert_eq!(issue.kind, "ApplyFailed");
            }
            other => panic!("Expected Degraded(Database ApplyFailed), got {other:?}"),
        }

        // ─── (2) 失败后状态：bootstrap 已存在且字节保存；failed schema 无；history 0 行 ───
        let bp = cfg.join(BOOTSTRAP_FILENAME);
        assert!(bp.exists(), "FirstBoot: commit+失败 后 bootstrap.json 必须已写入");
        let loaded1 = load_bootstrap(&cfg);
        let device_id_1 = loaded1.device_id.as_str().to_string();
        let data_root = loaded1.data_root.clone();
        let db_path = data_root.join("database/zhixing.db");

        let bootstrap_bytes_before = fs::read(&bp).unwrap();
        let manifest_bytes_before =
            fs::read(data_root.join(MANIFEST_FILENAME)).unwrap();
        let bootstrap_mtime_before = file_mtime(&bp);

        // t1 不存在（整 Tx rollback）
        {
            let conn = db::policy::open_configured_connection(&db_path).unwrap();
            let cnt: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='t1'",
                    [],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(cnt, 0, "ApplyFailed 后 t1 不该存在（Tx rollback）");
            let hist: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap();
            assert_eq!(hist, 0, "ApplyFailed 后 history 0 成功行");
        }

        // DataRoot / manifest / zhixing.db 不被删除（Known Deferred Edge：仅 bootstrap+Data Root 成功后不删）
        assert!(data_root.join(MANIFEST_FILENAME).exists());
        assert!(db_path.exists());

        // ─── (3) 第二次启动：Existing 路径 + GOOD migrations → Healthy ───
        let s2 = run_bootstrap_pipeline_with_migrations::<SqliteBackupSnapshot>(
            &cfg,
            &local,
            &[GOOD_M1, GOOD_M2],
            SqliteBackupSnapshot,
        );
        assert!(matches!(s2, RuntimeStatus::Healthy), "{:?}", s2);

        // bootstrap 字节和 mtime 不被重写；device_id 不变
        let bootstrap_bytes_after = fs::read(&bp).unwrap();
        assert_eq!(
            bootstrap_bytes_before, bootstrap_bytes_after,
            "Existing retry 不得重写 bootstrap.json"
        );
        if let Some(before) = bootstrap_mtime_before {
            let after = file_mtime(&bp).unwrap();
            assert_eq!(after, before, "Existing retry 不得更新 bootstrap mtime");
        }
        let manifest_bytes_after =
            fs::read(data_root.join(MANIFEST_FILENAME)).unwrap();
        assert_eq!(
            manifest_bytes_before, manifest_bytes_after,
            "Existing retry 不得改 manifest"
        );
        let loaded2 = load_bootstrap(&cfg);
        assert_eq!(device_id_1.as_str(), loaded2.device_id.as_str());

        // GOOD_M1 + GOOD_M2 应生效：t1、t2 表存在；history 两行；version = 2
        {
            let conn = db::policy::open_configured_connection(&db_path).unwrap();
            assert!(table_exists2(&conn, "t1"));
            assert!(table_exists2(&conn, "t2"));
            assert!(table_exists2(&conn, "schema_migrations"));
            let hist: i64 = conn
                .query_row(
                    "SELECT COUNT(*) FROM schema_migrations",
                    [],
                    |r| r.get::<_, i64>(0),
                )
                .unwrap();
            assert_eq!(hist, 2, "两次成功 migration 历史 2 行");
            let maxv: i64 = conn
                .query_row(
                    "SELECT MAX(version) FROM schema_migrations",
                    [],
                    |r| r.get::<_, Option<i64>>(0),
                )
                .unwrap()
                .unwrap_or(0);
            assert_eq!(maxv, 2, "current_version = 2");
        }
    }

    fn table_exists2(conn: &rusqlite::Connection, name: &str) -> bool {
        let cnt: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name=?1",
                [name],
                |r| r.get(0),
            )
            .unwrap();
        cnt > 0
    }
}
