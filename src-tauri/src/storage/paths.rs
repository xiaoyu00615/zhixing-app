//! 路径工具函数：默认 Data Root、SQLite 路径、网络共享检测、空目录探测。
//!
//! 冻结规则：
//! - 所有路径必须通过调用方传入 PathResolver 或显式根路径推导；绝不硬编码 %APPDATA%/..。
//! - 默认 Data Root = <app_local_data_dir>/data。
//! - DB 父目录只做 validate（不存在 → 报错），不 create_dir_all。

use std::io;
use std::path::{Path, PathBuf};

use super::error::DataRootError;

/// 默认 Data Root：<app_local_data_dir>/data
pub fn default_data_root(app_local_data_dir: &Path) -> PathBuf {
    assert!(
        app_local_data_dir.is_absolute(),
        "app_local_data_dir 必须是绝对路径: {}",
        app_local_data_dir.display()
    );
    app_local_data_dir.join("data")
}

/// 检测是否为网络共享路径（Windows UNC）。冻结规则严禁作为实时主库。
///
/// 当前实现：
/// - 前缀 `\\server\share` 风格 → true。
/// - Linux/macOS 下不会命中，返回 false；此时由上层在 Windows 上做实际检测。
pub fn is_network_share(path: &Path) -> bool {
    // PathBuf::to_string_lossy 前缀以 \\ 开头（Windows UNC）。
    // 同时覆盖 // 前缀（某些 POSIX 工具模拟 UNC）。
    let s = path.to_string_lossy();
    if let Some(rest) = s.strip_prefix(r"\\") {
        // server\share 至少存在一个 \
        return rest.contains(['\\', '/']);
    }
    if let Some(rest) = s.strip_prefix("//") {
        return rest.contains('/');
    }
    false
}

/// 检测目录是否为空（即没有任何子条目；允许 "."/".." 不计入）。
///
/// 如果目录不存在 → io::Error(NotFound)；调用方决定含义。
pub fn is_dir_empty(dir: &Path) -> Result<bool, io::Error> {
    Ok(dir.read_dir()?.next().is_none())
}

/// Data Root 基本路径合法性（绝对 + 非 UNC）。
pub fn validate_basic(data_root: &Path) -> Result<(), DataRootError> {
    if !data_root.is_absolute() {
        return Err(DataRootError::NotAbsolute(
            data_root.display().to_string(),
        ));
    }
    if is_network_share(data_root) {
        return Err(DataRootError::NetworkShareUnsupported(
            data_root.display().to_string(),
        ));
    }
    Ok(())
}
