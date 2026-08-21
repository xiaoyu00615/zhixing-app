//! Bootstrap 错误与状态枚举（严格三态 + Degraded）。
//!
//! 冻结红线：
//! - Corrupt / Unsupported 状态下不删除、不覆盖、不自动重建、不重新生成 device_id。

use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use thiserror::Error;

use super::device_id::DeviceId;

/// Bootstrap 加载后三态结果。
#[derive(Debug)]
pub enum BootstrapState {
    /// 文件不存在：需要 FirstBoot 流程创建（延迟提交 Candidate）。
    ///
    /// 注意：此状态不直接写入磁盘；需要 service 完成 initialize → boot_db 成功后 commit。
    Missing { bootstrap_path: PathBuf },

    /// 文件有效且通过校验。
    Valid(LoadedBootstrap),

    /// 文件存在但损坏 / 不支持 / 字段非法。
    ///
    /// 🔒 不删除、不覆盖、不自动重建、不重新生成 device_id。
    Degraded(BootstrapError),
}

/// 成功加载的 bootstrap（Valid 状态）。
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LoadedBootstrap {
    /// 始终为 1。
    pub bootstrap_version: u32,
    /// Device-local stable identity.
    pub device_id: DeviceId,
    /// 当前 Data Root 绝对路径。
    pub data_root: PathBuf,
    /// 磁盘上 bootstrap.json 的绝对路径。
    #[serde(skip)]
    pub bootstrap_path: PathBuf,
}

/// bootstrap 错误（Corrupt / Unsupported / Io / Invalid 字段）。
#[derive(Debug, Error)]
pub enum BootstrapError {
    #[error("bootstrap.json 读失败: {path}: {source}")]
    Read {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("bootstrap.json 解析失败: {path}: {source}")]
    Parse {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
    #[error("bootstrap.json 字段缺失/非法: {path}: {reason}")]
    Invalid { path: PathBuf, reason: String },
    #[error("bootstrap_version = {actual}; 仅支持 1")]
    UnsupportedVersion { path: PathBuf, actual: u32 },
    #[error("bootstrap 写失败: {path}: {source}")]
    Write {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("创建 app_config_dir 父目录失败: {path}: {source}")]
    ConfigDirCreate {
        path: PathBuf,
        #[source]
        source: std::io::Error,
    },
}
