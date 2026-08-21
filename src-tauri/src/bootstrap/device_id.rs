//! device_id：Device-local identity，UUID v4 canonical lowercase（36 字符，带连字符）。
//!
//! 冻结规则：
//! - 不使用自定义前缀（如 zhx_dev_）。
//! - 不直接引入 rand crate；通过 uuid/v4 feature 使用内部熵源。
//! - 生成一次后持久化于 bootstrap.json；永不随 Backup Restore 覆盖；损坏时不重生成。

use serde::{Deserialize, Serialize};
use std::fmt;
use std::str::FromStr;
use thiserror::Error;
use uuid::Uuid;

/// Device-local stable identity.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(try_from = "String", into = "String")]
pub struct DeviceId(String);

#[derive(Debug, Clone, Error)]
pub enum DeviceIdError {
    #[error("device_id length must be 36 bytes (UUID v4 canonical), got {0}")]
    Length(usize),
    #[error("device_id is not a valid UUID v4 canonical lowercase: {0}")]
    Invalid(String),
}

impl DeviceId {
    /// 生成一个新的 UUID v4 canonical lowercase device_id。
    ///
    /// 仅允许在 FirstBoot 候选阶段调用。
    pub fn generate() -> Self {
        Self(Uuid::new_v4().to_string())
    }

    /// 返回内部字符串（借用）。
    pub fn as_str(&self) -> &str {
        &self.0
    }

    fn validate(s: &str) -> Result<(), DeviceIdError> {
        if s.len() != 36 {
            return Err(DeviceIdError::Length(s.len()));
        }
        // 必须是全小写
        if s != s.to_lowercase() {
            return Err(DeviceIdError::Invalid(s.to_string()));
        }
        let uuid = Uuid::from_str(s).map_err(|_| DeviceIdError::Invalid(s.to_string()))?;
        if uuid.get_version() != Some(uuid::Version::Random) {
            return Err(DeviceIdError::Invalid(s.to_string()));
        }
        // 变体必须是 RFC 4122 (uuid crate 判 variant == Variant::RFC4122)
        if uuid.get_variant() != uuid::Variant::RFC4122 {
            return Err(DeviceIdError::Invalid(s.to_string()));
        }
        Ok(())
    }
}

impl fmt::Display for DeviceId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl From<DeviceId> for String {
    fn from(value: DeviceId) -> Self {
        value.0
    }
}

impl TryFrom<String> for DeviceId {
    type Error = DeviceIdError;
    fn try_from(value: String) -> Result<Self, Self::Error> {
        Self::validate(&value)?;
        Ok(Self(value))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generate_uuid_v4_canonical_lowercase() {
        let id = DeviceId::generate();
        assert_eq!(id.as_str().len(), 36);
        assert_eq!(id.as_str(), id.as_str().to_lowercase());
        // 含 4 个连字符
        assert_eq!(id.as_str().chars().filter(|c| *c == '-').count(), 4);
    }

    #[test]
    fn two_generations_are_unique() {
        let a = DeviceId::generate();
        let b = DeviceId::generate();
        assert_ne!(a, b);
    }

    #[test]
    fn reject_invalid_cases() {
        // 长度错
        assert!(DeviceId::try_from("short".to_string()).is_err());
        // 非 UUID v4 段（非 128 bit 位要求）
        assert!(DeviceId::try_from("zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz".to_string()).is_err());
        // 大写字符（不接受）
        assert!(DeviceId::try_from(
            "550E8400-E29B-41D4-A716-446655440000".to_string()
        )
        .is_err());
        // 合法 v4 lowercase 通过
        let s = Uuid::new_v4().to_string();
        assert!(DeviceId::try_from(s).is_ok());
    }
}
