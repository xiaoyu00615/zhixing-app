//! Bootstrap 模块：负责 %APPDATA% (app_config_dir) 下 bootstrap.json 的生命周期。
//!
//! 冻结边界（Step 8）：
//! - 设备本地配置文件 bootstrap.json，最小三字段：bootstrap_version、device_id、data_root。
//! - device_id = UUID v4 canonical lowercase（36 字符），一旦写入永不自动重新生成。
//! - bootstrap 损坏/不支持时：不删除、不覆盖、不自动重建、不重新生成 device_id → Degraded。
//! - FirstBoot 采用延迟提交：BootstrapCandidate（内存）→ 完成 Data Root 初始化 + DB Bootstrap
//!   全部成功后，才原子写入 bootstrap.json。

pub mod device_id;
pub mod error;
pub mod service;

pub use error::BootstrapState;
pub use service::BootstrapService;
#[cfg(test)]
pub(crate) use error::LoadedBootstrap;

/// bootstrap.json 文件常量。
pub const BOOTSTRAP_VERSION: u32 = 1;
pub const BOOTSTRAP_FILENAME: &str = "bootstrap.json";
