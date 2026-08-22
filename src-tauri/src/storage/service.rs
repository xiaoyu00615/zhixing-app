//! DataRootService：get / resolve / validate / detect_need_init / initialize。
//!
//! 🔒 冻结红线（Step 8）：
//! - 仅当 FirstBoot（由调用方显式传入 mode=FirstBoot）且 目标 不存在/为空 → 允许 initialize。
//! - 其余任何情况（Valid bootstrap 指向 Missing/Invalid/NonEmpty）→ Degraded。
//! - initialize 创建 5 个固定子目录 + 最小 manifest.json。
//! - Data Root / database 目录创建只能发生在 initialize。
//! - Existing Valid bootstrap 目录缺失 → Degraded，不自动修复。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use super::{
    error::DataRootError,
    manifest::DataRootManifest,
    paths::*,
    FIXED_SUBDIRS, MANIFEST_FILENAME,
};

/// Data Root 初始化触发时机：严格控制只有 FirstBoot 可创建。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InitMode {
    /// FirstBoot：bootstrap.json 尚未提交，允许创建 Data Root + manifest + 子目录。
    FirstBoot,
    /// Valid 已存在 bootstrap 指向该路径，不允许初始化（只能 load/reopen）。
    Existing,
}

/// DataRootService 工具集合。无状态。
pub struct DataRootService;

impl DataRootService {
    /// 入口：
    ///
    /// 根据 mode 决定行为：
    /// - FirstBoot：空/不存在 → initialize；非空但缺 manifest → Degraded。
    /// - Existing：按 V2 状态机，缺目录不修复。
    ///
    /// 返回：
    /// - Ok((data_root_path, manifest))：成功加载 / 初始化
    /// - Err(DataRootError)：调用方应转入 Degraded。
    pub fn get_and_ensure(
        data_root: &Path,
        mode: InitMode,
    ) -> Result<(PathBuf, DataRootManifest), DataRootError> {
        validate_basic(data_root)?;

        match (mode, entry_kind(data_root)?) {
            // --- FirstBoot 分支 ---
            (InitMode::FirstBoot, EntryKind::Missing) => {
                let manifest = Self::initialize(data_root)?;
                Ok((data_root.to_path_buf(), manifest))
            }
            (InitMode::FirstBoot, EntryKind::DirEmpty) => {
                let manifest = Self::initialize(data_root)?;
                Ok((data_root.to_path_buf(), manifest))
            }
            (InitMode::FirstBoot, EntryKind::DirWithManifest) => {
                // 不允许：FirstBoot 阶段不应出现 manifest。防止覆盖已有数据。
                Err(DataRootError::InitializeOnlyAllowedOnFirstBoot(
                    data_root.display().to_string(),
                ))
            }
            (InitMode::FirstBoot, EntryKind::DirNonEmptyNoManifest) => Err(
                DataRootError::NonEmptyWithoutManifest(data_root.display().to_string()),
            ),
            (InitMode::FirstBoot, EntryKind::File) => Err(DataRootError::EntryIsFile(
                data_root.display().to_string(),
            )),

            // --- Existing 分支（Valid bootstrap） ---
            (InitMode::Existing, EntryKind::Missing) => Err(DataRootError::NotFound(
                data_root.display().to_string(),
            )),
            (InitMode::Existing, EntryKind::DirEmpty) => Err(DataRootError::NotFound(
                data_root.display().to_string(),
            )),
            (InitMode::Existing, EntryKind::DirWithManifest) => {
                let manifest = Self::load_manifest(data_root)?;
                manifest.validate(&data_root.join(MANIFEST_FILENAME))?;
                Ok((data_root.to_path_buf(), manifest))
            }
            (InitMode::Existing, EntryKind::DirNonEmptyNoManifest) => Err(
                DataRootError::NonEmptyWithoutManifest(data_root.display().to_string()),
            ),
            (InitMode::Existing, EntryKind::File) => {
                Err(DataRootError::EntryIsFile(data_root.display().to_string()))
            }
        }
    }

    /// 初始化 Data Root（创建 5 子目录 + 写最小 manifest）。
    ///
    /// 🔒 仅应在 FirstBoot + Missing/DirEmpty 时由 get_and_ensure 内部调用。
    fn initialize(data_root: &Path) -> Result<DataRootManifest, DataRootError> {
        // 1. create data_root
        fs::create_dir_all(data_root).map_err(|source| {
            DataRootError::InitializeCreateDir {
                path: data_root.display().to_string(),
                source,
            }
        })?;
        // 2. 创建固定子目录
        for sub in FIXED_SUBDIRS {
            let sub_path = data_root.join(sub);
            fs::create_dir_all(&sub_path).map_err(|source| {
                DataRootError::InitializeCreateDir {
                    path: sub_path.display().to_string(),
                    source,
                }
            })?;
        }
        // 3. 写最小 manifest.json
        let manifest = DataRootManifest::simple();
        let manifest_path = data_root.join(MANIFEST_FILENAME);
        let json = serde_json::to_string_pretty(&manifest)
            .expect("DataRootManifest simple 序列化不会失败");
        let mut f = fs::File::create(&manifest_path).map_err(|source| {
            DataRootError::InitializeWriteManifest {
                path: manifest_path.display().to_string(),
                source,
            }
        })?;
        f.write_all(json.as_bytes())
            .map_err(|source| DataRootError::InitializeWriteManifest {
                path: manifest_path.display().to_string(),
                source,
            })?;
        f.sync_all().map_err(|source| DataRootError::InitializeWriteManifest {
            path: manifest_path.display().to_string(),
            source,
        })?;
        Ok(manifest)
    }

    /// 从 data_root 加载 manifest.json 并反序列化（不做 validate）。
    pub fn load_manifest(data_root: &Path) -> Result<DataRootManifest, DataRootError> {
        let manifest_path = data_root.join(MANIFEST_FILENAME);
        if !manifest_path.exists() {
            return Err(DataRootError::ManifestMissing(
                manifest_path.display().to_string(),
            ));
        }
        let s = fs::read_to_string(&manifest_path).map_err(|source| {
            DataRootError::ManifestRead {
                path: manifest_path.display().to_string(),
                source,
            }
        })?;
        let m: DataRootManifest = serde_json::from_str(&s).map_err(|source| {
            DataRootError::ManifestParse {
                path: manifest_path.display().to_string(),
                source,
            }
        })?;
        Ok(m)
    }

    /// 解析 SQLite 数据库绝对路径（不校验文件存在）。
    pub fn resolve_database_path(data_root: &Path, manifest: &DataRootManifest) -> PathBuf {
        manifest.resolve_database_path(data_root)
    }
}

// -------- 内部辅助：条目的种类分类 --------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum EntryKind {
    Missing,
    File,
    DirEmpty,
    DirNonEmptyNoManifest,
    DirWithManifest,
}

fn entry_kind(path: &Path) -> Result<EntryKind, DataRootError> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(EntryKind::Missing),
        Err(e) => {
            return Err(DataRootError::PermissionDenied {
                path: path.display().to_string(),
                source: e,
            })
        }
    };
    if !meta.is_dir() {
        return Ok(EntryKind::File);
    }
    // dir → 探测 manifest.json 是否存在
    let manifest_path = path.join(MANIFEST_FILENAME);
    if manifest_path.exists() && manifest_path.is_file() {
        return Ok(EntryKind::DirWithManifest);
    }
    // 是否为空
    match is_dir_empty(path) {
        Ok(true) => Ok(EntryKind::DirEmpty),
        Ok(false) => Ok(EntryKind::DirNonEmptyNoManifest),
        Err(e) => Err(DataRootError::PermissionDenied {
            path: path.display().to_string(),
            source: e,
        }),
    }
}
