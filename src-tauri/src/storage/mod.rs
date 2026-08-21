//! Storage 模块：Data Root 生命周期管理。
//!
//! 冻结边界（Step 8）：
//! - 只实现 get / resolve / validate / detect / initialize。
//! - 不实现 migrateDataLocation / 数据目录迁移 / live copy / backup restore。
//! - 只有 FirstBoot 且目标 不存在 / 为空目录 → 允许 initialize。
//! - 已存在 Valid bootstrap 指向 Data Root Missing / Invalid / NonEmptyWithoutManifest → Degraded，禁止创建。
//! - 目录结构：
//!   <data_root>/{manifest.json,database/,attachments/,thumbnails/,backup/,metadata/}

pub mod error;
pub mod manifest;
pub mod paths;
pub mod service;

pub use service::{DataRootService, InitMode};

/// Data Root Manifest 文件名。
pub const MANIFEST_FILENAME: &str = "manifest.json";

/// 固定子目录集合（简单模式）。
pub const FIXED_SUBDIRS: &[&str] = &[
    "database",
    "attachments",
    "thumbnails",
    "backup",
    "metadata",
];
