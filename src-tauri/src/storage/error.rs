//! DataRoot 结构化错误枚举（非字符串，可测试）。

use std::io;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum DataRootError {
    #[error("data_root 必须是绝对路径，得到: {0}")]
    NotAbsolute(String),

    #[error("检测到不允许的网络卷路径: {0}")]
    NetworkShareUnsupported(String),

    #[error("data_root 不存在: {0}")]
    NotFound(String),

    #[error("data_root 存在但是文件，不是目录: {0}")]
    EntryIsFile(String),

    #[error("无权限: {path}: {source}")]
    PermissionDenied {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("Data Root 非空且缺少 manifest.json（禁止 initialize）: {0}")]
    NonEmptyWithoutManifest(String),

    #[error("manifest.json 缺失: {0}")]
    ManifestMissing(String),

    #[error("manifest.json 读失败: {path}: {source}")]
    ManifestRead {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("manifest.json 解析失败: {path}: {source}")]
    ManifestParse {
        path: String,
        #[source]
        source: serde_json::Error,
    },

    #[error("manifest_kind 期望 \"data_root\"，实际: {actual}")]
    ManifestKindMismatch { actual: String },

    #[error("manifest format_version = {actual}，仅支持 1")]
    ManifestUnsupportedVersion { actual: u32 },

    #[error("manifest layout 期望 \"simple\"，实际: {actual}")]
    ManifestUnsupportedLayout { actual: String },

    #[error(
        "manifest database.relative_path 期望 \"database/zhixing.db\"，实际: {actual}"
    )]
    ManifestDatabaseRelativePathInvalid { actual: String },

    #[error("initialize 时创建目录失败: {path}: {source}")]
    InitializeCreateDir {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("initialize 时写入 manifest.json 失败: {path}: {source}")]
    InitializeWriteManifest {
        path: String,
        #[source]
        source: io::Error,
    },

    #[error("initialize 只能在 FirstBoot 状态触发，当前已存在 bootstrap 指向该 Data Root: {0}")]
    InitializeOnlyAllowedOnFirstBoot(String),
}
