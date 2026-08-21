//! Data Root Manifest 最小 schema（V2 冻结）。
//!
//! {
//!   "manifest_kind": "data_root",
//!   "format_version": 1,
//!   "layout": "simple",
//!   "database": {
//!     "relative_path": "database/zhixing.db"
//!   }
//! }
//!
//! 严格不包含：created_at / updated_at / PRAGMA / Backup Manifest 字段。

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::error::DataRootError;

pub const MANIFEST_KIND: &str = "data_root";
pub const LAYOUT_SIMPLE: &str = "simple";
pub const FORMAT_VERSION: u32 = 1;
pub const DB_RELATIVE_PATH: &str = "database/zhixing.db";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DatabaseLayout {
    pub relative_path: String,
}

impl Default for DatabaseLayout {
    fn default() -> Self {
        Self {
            relative_path: DB_RELATIVE_PATH.to_string(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DataRootManifest {
    pub manifest_kind: String,
    pub format_version: u32,
    pub layout: String,
    pub database: DatabaseLayout,
}

impl Default for DataRootManifest {
    fn default() -> Self {
        Self::simple()
    }
}

impl DataRootManifest {
    pub fn simple() -> Self {
        Self {
            manifest_kind: MANIFEST_KIND.to_string(),
            format_version: FORMAT_VERSION,
            layout: LAYOUT_SIMPLE.to_string(),
            database: DatabaseLayout::default(),
        }
    }

    /// 按冻结规则逐项 validate；失败返回 DataRootError。
    pub fn validate(&self, manifest_path: &Path) -> Result<(), DataRootError> {
        if self.manifest_kind != MANIFEST_KIND {
            return Err(DataRootError::ManifestKindMismatch {
                actual: self.manifest_kind.clone(),
            });
        }
        if self.format_version != FORMAT_VERSION {
            return Err(DataRootError::ManifestUnsupportedVersion {
                actual: self.format_version,
            });
        }
        if self.layout != LAYOUT_SIMPLE {
            return Err(DataRootError::ManifestUnsupportedLayout {
                actual: self.layout.clone(),
            });
        }
        if self.database.relative_path != DB_RELATIVE_PATH {
            return Err(DataRootError::ManifestDatabaseRelativePathInvalid {
                actual: self.database.relative_path.clone(),
            });
        }
        // 相对路径安全：不允许绝对 / 不允许 .. 穿透
        let rel = Path::new(&self.database.relative_path);
        if rel.is_absolute()
            || rel
                .components()
                .any(|c| matches!(c, std::path::Component::ParentDir))
        {
            return Err(DataRootError::ManifestDatabaseRelativePathInvalid {
                actual: self.database.relative_path.clone(),
            });
        }
        let _ = manifest_path;
        Ok(())
    }

    /// 解析 Data Root → SQLite 绝对路径（不校验文件存在）。
    pub fn resolve_database_path(&self, data_root: &Path) -> PathBuf {
        data_root.join(&self.database.relative_path)
    }
}
