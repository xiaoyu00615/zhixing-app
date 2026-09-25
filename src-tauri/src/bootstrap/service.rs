//! BootstrapService：bootstrap.json 的加载、验证、以及 FirstBoot 延迟提交。
//!
//! 延迟提交流程：
//! 1. 构造 BootstrapCandidate（内存，不写盘）。
//! 2. 调用方完成 DataRootService::initialize + db::bootstrap::boot_db。
//! 3. 调用 BootstrapCandidate::commit 原子写入 bootstrap.json。
//!
//! 任何中间失败都必须导致 Degraded（而不是写半成的 bootstrap）。

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::platform_atomic_file::{atomic_replace_file, write_file_durable};

use super::{device_id::DeviceId, error::*, BOOTSTRAP_FILENAME, BOOTSTRAP_VERSION};

/// Bootstrap 服务句柄。不持有状态；接受路径入参以便可测试。
pub struct BootstrapService;

/// 磁盘上 JSON 结构（用于 serde）。与 LoadedBootstrap 对应，不含 bootstrap_path 派生字段。
#[derive(Debug, Serialize, Deserialize)]
struct BootstrapJson {
    pub bootstrap_version: u32,
    pub device_id: DeviceId,
    pub data_root: PathBuf,
}

/// 延迟提交候选：FirstBoot 初始化成功后写入。
#[derive(Debug, Clone)]
pub struct BootstrapCandidate {
    /// 最终写入的绝对路径。
    pub path: PathBuf,
    /// 生成的 device_id（FirstBoot 时新生成一份）。
    pub device_id: DeviceId,
    /// 默认 Data Root 绝对路径。
    pub data_root: PathBuf,
}

impl BootstrapService {
    /// 计算 bootstrap.json 的绝对路径。app_config_dir 必须为 OS 可写 App Config 根目录。
    pub fn bootstrap_path(app_config_dir: &Path) -> PathBuf {
        app_config_dir.join(BOOTSTRAP_FILENAME)
    }

    /// 按严格三态加载 bootstrap。
    ///
    /// - Missing → 返回 BootstrapState::Missing，调用方应走 FirstBoot。
    /// - Valid → 返回 LoadedBootstrap。
    /// - Corrupt / Unsupported → BootstrapState::Degraded，不删除、不覆盖、不重建 device_id。
    pub fn load(bootstrap_path: &Path) -> BootstrapState {
        if !bootstrap_path.exists() {
            return BootstrapState::Missing {
                bootstrap_path: bootstrap_path.to_path_buf(),
            };
        }

        match fs::read_to_string(bootstrap_path) {
            Ok(s) => match serde_json::from_str::<BootstrapJson>(&s) {
                Ok(v) => {
                    if v.bootstrap_version != BOOTSTRAP_VERSION {
                        return BootstrapState::Degraded(BootstrapError::UnsupportedVersion {
                            path: bootstrap_path.to_path_buf(),
                            actual: v.bootstrap_version,
                        });
                    }
                    if !v.data_root.is_absolute() {
                        return BootstrapState::Degraded(BootstrapError::Invalid {
                            path: bootstrap_path.to_path_buf(),
                            reason: format!(
                                "data_root 必须是绝对路径，得到: {}",
                                v.data_root.display()
                            ),
                        });
                    }
                    BootstrapState::Valid(LoadedBootstrap {
                        bootstrap_version: v.bootstrap_version,
                        device_id: v.device_id,
                        data_root: v.data_root,
                        bootstrap_path: bootstrap_path.to_path_buf(),
                    })
                }
                Err(e) => BootstrapState::Degraded(BootstrapError::Parse {
                    path: bootstrap_path.to_path_buf(),
                    source: e,
                }),
            },
            Err(e) => BootstrapState::Degraded(BootstrapError::Read {
                path: bootstrap_path.to_path_buf(),
                source: e,
            }),
        }
    }

    /// 构造 FirstBoot Candidate（内存），包含新 UUID v4 device_id + 默认 data_root。
    ///
    /// 注意：不创建文件、不写入磁盘。
    pub fn new_candidate(bootstrap_path: PathBuf, default_data_root: PathBuf) -> BootstrapCandidate {
        assert!(
            default_data_root.is_absolute(),
            "default_data_root 必须是绝对路径: {}",
            default_data_root.display()
        );
        BootstrapCandidate {
            path: bootstrap_path,
            device_id: DeviceId::generate(),
            data_root: default_data_root,
        }
    }
}

impl BootstrapCandidate {
    /// 全部初始化完成后，原子提交 bootstrap.json。
    ///
    /// 原子写策略：
    /// 1. mkdir -p bootstrap_path.parent
    /// 2. write bootstrap.json.tmp
    /// 3. fsync
    /// 4. rename → bootstrap.json
    ///
    /// 任何中间失败都返回 BootstrapError，不写正式文件。
    pub fn commit(&self) -> Result<LoadedBootstrap, BootstrapError> {
        let parent = self
            .path
            .parent()
            .expect("bootstrap_path 必须是文件路径，应有父目录")
            .to_path_buf();
        if !parent.exists() {
            fs::create_dir_all(&parent).map_err(|source| BootstrapError::ConfigDirCreate {
                path: parent.clone(),
                source,
            })?;
        }

        let payload = BootstrapJson {
            bootstrap_version: BOOTSTRAP_VERSION,
            device_id: self.device_id.clone(),
            data_root: self.data_root.clone(),
        };
        let s = serde_json::to_string_pretty(&payload)
            .expect("序列化 BootstrapJson 不会失败");

        // 临时文件位于同一目录以保证 atomic rename 跨卷不失败。
        let tmp_path = self.path.with_extension("json.tmp");
        let mut f = fs::File::create(&tmp_path).map_err(|source| BootstrapError::Write {
            path: tmp_path.clone(),
            source,
        })?;
        f.write_all(s.as_bytes())
            .map_err(|source| BootstrapError::Write {
                path: tmp_path.clone(),
                source,
            })?;
        f.sync_all().map_err(|source| BootstrapError::Write {
            path: tmp_path.clone(),
            source,
        })?;
        drop(f);

        fs::rename(&tmp_path, &self.path).map_err(|source| BootstrapError::Write {
            path: self.path.clone(),
            source,
        })?;

        Ok(LoadedBootstrap {
            bootstrap_version: BOOTSTRAP_VERSION,
            device_id: self.device_id.clone(),
            data_root: self.data_root.clone(),
            bootstrap_path: self.path.clone(),
        })
    }
}

/// Why an atomic `data_root` re-point did not happen.
///
/// Deliberately NARROW and non-leaking: the detail is Rust-side diagnosis only
/// and never crosses the Tauri boundary (the migration maps it into its own
/// stable machine codes).
#[derive(Debug, thiserror::Error)]
pub enum BootstrapRewriteError {
    /// `bootstrap.json` is missing / unreadable / unsupported. Nothing written.
    #[error("bootstrap.json is not loadable: {0}")]
    Unavailable(String),
    /// The current `data_root` is NOT the expected one. Another state already
    /// changed the bootstrap, so this operation must NOT overwrite it.
    #[error("bootstrap.json data_root has changed since the migration started")]
    Changed,
    /// The new bootstrap could not be written / atomically installed.
    #[error("bootstrap.json rewrite failed: {0}")]
    Write(String),
}

/// P6-S9 §37–§40 — narrow, purpose-built atomic re-point of `data_root`.
///
/// This is deliberately NOT a general "rewrite bootstrap" API:
///
/// - it preserves `bootstrap_version` and `device_id` (a migration must never
///   regenerate a device identity, §68, and never doubles as a bootstrap schema
///   upgrade, §69);
/// - it changes ONLY `data_root`;
/// - it RE-READS `bootstrap.json` immediately before switching and requires the
///   current `data_root` to equal `expected_current_data_root`, so it can never
///   clobber a bootstrap that some other state already moved (§38);
/// - it installs the new content with the OS atomic-replace primitive rather
///   than `fs::rename` over an existing file, which on Windows is not a
///   write-through replace (§40).
///
/// On success the file at `bootstrap_path` describes `new_data_root`; on ANY
/// failure the previous bootstrap is left exactly as it was.
pub fn rewrite_data_root_atomically(
    bootstrap_path: &Path,
    expected_current_data_root: &Path,
    new_data_root: &Path,
) -> Result<LoadedBootstrap, BootstrapRewriteError> {
    if !new_data_root.is_absolute() {
        return Err(BootstrapRewriteError::Write(
            "the new data root must be an absolute path".into(),
        ));
    }

    // Expected-old check FIRST: the switch is authorized only against the exact
    // root this operation started from.
    let current = match BootstrapService::load(bootstrap_path) {
        BootstrapState::Valid(loaded) => loaded,
        BootstrapState::Missing { .. } => {
            return Err(BootstrapRewriteError::Unavailable(
                "bootstrap.json is missing".into(),
            ))
        }
        BootstrapState::Degraded(e) => {
            return Err(BootstrapRewriteError::Unavailable(format!(
                "bootstrap.json degraded: {e}"
            )))
        }
    };
    if current.data_root != expected_current_data_root {
        return Err(BootstrapRewriteError::Changed);
    }

    // Preserve version + device identity; change ONLY the root.
    let payload = BootstrapJson {
        bootstrap_version: current.bootstrap_version,
        device_id: current.device_id.clone(),
        data_root: new_data_root.to_path_buf(),
    };
    let json = serde_json::to_string_pretty(&payload).expect("序列化 BootstrapJson 不会失败");

    let parent = bootstrap_path
        .parent()
        .expect("bootstrap_path 必须是文件路径，应有父目录")
        .to_path_buf();
    if !parent.exists() {
        fs::create_dir_all(&parent).map_err(|source| {
            BootstrapRewriteError::Write(format!("create config dir: {source}"))
        })?;
    }

    // Durable temp file in the SAME directory (same volume) → sync_all → ONE OS
    // atomic replace of the existing bootstrap.json.
    let tmp_path = bootstrap_path.with_extension("json.migrating");
    write_file_durable(&tmp_path, json.as_bytes())
        .map_err(|source| BootstrapRewriteError::Write(format!("write temp bootstrap: {source}")))?;

    if let Err(failure) = atomic_replace_file(bootstrap_path, &tmp_path, None) {
        // The old bootstrap is untouched; drop our temp file best-effort.
        let _ = fs::remove_file(&tmp_path);
        return Err(BootstrapRewriteError::Write(failure.detail()));
    }

    Ok(LoadedBootstrap {
        bootstrap_version: current.bootstrap_version,
        device_id: current.device_id.clone(),
        data_root: new_data_root.to_path_buf(),
        bootstrap_path: bootstrap_path.to_path_buf(),
    })
}
