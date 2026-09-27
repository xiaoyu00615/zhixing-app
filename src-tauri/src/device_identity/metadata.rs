//! Device-local identity metadata (§17–§19).
//!
//! # What problem this solves
//!
//! The identity SECRET lives in the platform key store (CNG / AndroidKeyStore) and can
//! never be read out of it. What the app therefore needs locally is a small, non-secret
//! record of **what identity is supposed to be here**, so the difference between
//!
//! - "this device has never provisioned an identity" (legal first run, §20), and
//! - "an identity was established and its key material is gone" (§22 — fail closed, never
//!   silently regenerate a new identity)
//!
//! is observable instead of guessed.
//!
//! # What this module deliberately is NOT
//!
//! - It is **not** a settings system, **not** a second database and **not** a business
//!   table: one small versioned JSON document, written atomically through the already
//!   approved [`crate::platform_atomic_file::write_file_atomic`] (§19).
//! - It never stores a private key, a key handle, or any secret byte (§18). The fields
//!   below are the whole record.
//! - It does not decide policy: the provider owns every fail-closed rule (§21–§24).
//!
//! # Location
//!
//! The directory is supplied by the caller and is the app config dir (§17). Tests always
//! pass a temporary directory (§33).
//!
//! # Platform neutrality (P7-S4R §9)
//!
//! The durable record carries ONLY platform-neutral security facts: schema version,
//! algorithm, fingerprint, security level, generation and the established marker. It
//! never serializes a Windows backend name (`PlatformCng` / `SoftwareCng`), a Microsoft
//! provider name, a Win32 / `SECURITY_STATUS` value or any other platform enum — those
//! belong to backend diagnostics, not to a durable shared artifact.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

use super::{DeviceIdentityAlgorithm, IdentitySecurityLevel};

/// File name of the identity metadata document inside the app config dir.
pub(crate) const IDENTITY_METADATA_FILE_NAME: &str = "device-identity.json";

/// The only schema version this build understands (§19: small, versioned).
pub(crate) const IDENTITY_METADATA_SCHEMA_VERSION: u32 = 1;

/// Generation counter of the V1 identity record. Bumped only by an explicit, reviewed
/// identity-generation change — never silently (§27).
pub(crate) const IDENTITY_GENERATION_V1: u32 = 1;

/// The device-local identity record. Non-secret by construction (§18).
///
/// `established` is what separates "never provisioned" from "provisioned and lost";
/// `fingerprint_hex` is the canonical identity reference (§9), so a provider key that no
/// longer matches it is detected instead of trusted.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct IdentityMetadata {
    /// Schema version; anything else is rejected as corrupt rather than migrated silently.
    pub schema_version: u32,
    /// `true` once an identity has been established on this device.
    pub established: bool,
    /// The frozen V1 identity algorithm (§3).
    pub algorithm: DeviceIdentityAlgorithm,
    /// SHA-256 of the canonical SPKI DER, lowercase hex (§9).
    pub fingerprint_hex: String,
    /// Security level the identity was established at — the platform-neutral
    /// classification only, never a platform provider name (§4).
    pub security_level: IdentitySecurityLevel,
    /// Identity generation (§18).
    pub generation: u32,
}

impl IdentityMetadata {
    /// Builds the record for a freshly established identity.
    pub(crate) fn established(
        algorithm: DeviceIdentityAlgorithm,
        fingerprint_hex: String,
        security_level: IdentitySecurityLevel,
    ) -> Self {
        Self {
            schema_version: IDENTITY_METADATA_SCHEMA_VERSION,
            established: true,
            algorithm,
            fingerprint_hex,
            security_level,
            generation: IDENTITY_GENERATION_V1,
        }
    }

    /// `true` iff the record is internally consistent enough to be trusted.
    ///
    /// A record that is not `established`, or whose fingerprint is not a 64-character
    /// lowercase hex SHA-256 digest, is treated as corrupt: "identity established with no
    /// fingerprint" is not a state this build may act on (fail closed, §9 / §23).
    pub(crate) fn is_trustworthy(&self) -> bool {
        self.validate().is_ok()
    }

    /// P7-S4R — every field this build must be able to trust, checked individually.
    ///
    /// A durable identity record is either fully valid or CORRUPT: there is no
    /// "partially usable" state, because a half-trusted record is exactly how a damaged
    /// identity gets silently re-provisioned. The returned token is a stable machine
    /// value, never prose built from the document.
    pub(crate) fn validate(&self) -> Result<(), &'static str> {
        if self.schema_version != IDENTITY_METADATA_SCHEMA_VERSION {
            return Err("unsupported_schema_version");
        }
        if !self.established {
            return Err("record_not_established");
        }
        if !is_sha256_hex(&self.fingerprint_hex) {
            return Err("invalid_fingerprint");
        }
        if self.generation != IDENTITY_GENERATION_V1 {
            // A generation this build does not understand is never adopted: an unknown
            // identity generation is a future/foreign record, not a V1 identity.
            return Err("unsupported_generation");
        }
        Ok(())
    }
}

/// Metadata access outcome (§19).
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MetadataError {
    /// The document could not be read or written. `detail` is a stable token, never prose
    /// built from user data.
    Io { detail: &'static str },
    /// The document exists but is not a valid identity record for this build.
    Corrupt { detail: &'static str },
}

impl MetadataError {
    /// Stable, machine-readable token (same convention as the rest of the module family).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Io { .. } => "METADATA_IO",
            Self::Corrupt { .. } => "METADATA_CORRUPT",
        }
    }

    /// The stable detail token.
    pub(crate) fn detail(&self) -> &'static str {
        match self {
            Self::Io { detail } | Self::Corrupt { detail } => detail,
        }
    }
}

/// Path of the identity metadata document inside `dir` (§17).
pub(crate) fn metadata_path(dir: &Path) -> PathBuf {
    dir.join(IDENTITY_METADATA_FILE_NAME)
}

/// Loads the identity metadata, if any.
///
/// - No file ⇒ `Ok(None)` — "never provisioned" is a legal answer (§20), not an error.
/// - Unreadable / invalid / wrong schema / untrustworthy ⇒ `Corrupt`, which the caller
///   must treat as fail-closed: a damaged record must never be silently replaced.
pub(crate) fn load_identity_metadata(dir: &Path) -> Result<Option<IdentityMetadata>, MetadataError> {
    let path = metadata_path(dir);
    let bytes = match std::fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(MetadataError::Io {
                detail: "read_failed",
            })
        }
    };
    // P7-S4R — `NotFound` and `ExistsButInvalid` are strictly different answers: only a
    // missing FILE is `Ok(None)`. Anything that exists but is not a valid V1 record is
    // `Corrupt`, which every caller treats as fail closed (never deleted, never
    // regenerated, never read as "first boot").
    let metadata: IdentityMetadata = serde_json::from_slice(&bytes).map_err(|_| {
        MetadataError::Corrupt {
            detail: "invalid_json",
        }
    })?;
    metadata.validate().map_err(|detail| MetadataError::Corrupt { detail })?;
    Ok(Some(metadata))
}

/// Stores the identity metadata atomically (§19).
///
/// The write goes through the shared atomic-file helper, so a crash mid-write can never
/// leave a half-written record that would later be read as "established".
pub(crate) fn store_identity_metadata(
    dir: &Path,
    metadata: &IdentityMetadata,
) -> Result<(), MetadataError> {
    let bytes = serde_json::to_vec_pretty(metadata).map_err(|_| MetadataError::Io {
        detail: "serialize_failed",
    })?;
    std::fs::create_dir_all(dir).map_err(|_| MetadataError::Io {
        detail: "create_dir_failed",
    })?;
    crate::platform_atomic_file::write_file_atomic(&metadata_path(dir), &bytes).map_err(|_| {
        MetadataError::Io {
            detail: "atomic_write_failed",
        }
    })
}

/// Removes the identity metadata document. Used only by tests and by a future reviewed
/// explicit reset path (§27) — never by the normal read path.
pub(crate) fn delete_identity_metadata(dir: &Path) -> Result<(), MetadataError> {
    match std::fs::remove_file(metadata_path(dir)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(MetadataError::Io {
            detail: "delete_failed",
        }),
    }
}

/// `true` iff `value` is a 64-character lowercase hex SHA-256 digest (§9).
fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample(fingerprint_hex: &str) -> IdentityMetadata {
        IdentityMetadata::established(
            DeviceIdentityAlgorithm::EcdsaP256Sha256,
            fingerprint_hex.to_string(),
            IdentitySecurityLevel::HardwareBacked,
        )
    }

    const FINGERPRINT: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    /// No document ⇒ `None`, and that is the legal "never provisioned" answer (§20).
    #[test]
    fn missing_metadata_is_none_not_an_error() {
        let dir = tempfile::tempdir().expect("temp dir");
        assert_eq!(
            load_identity_metadata(dir.path()).expect("load"),
            None,
            "a missing record must not be treated as corruption"
        );
    }

    /// Round-trip through the atomic writer (§19).
    #[test]
    fn metadata_round_trips() {
        let dir = tempfile::tempdir().expect("temp dir");
        let metadata = sample(FINGERPRINT);
        store_identity_metadata(dir.path(), &metadata).expect("store");
        let loaded = load_identity_metadata(dir.path())
            .expect("load")
            .expect("record present");
        assert_eq!(loaded, metadata);
        assert_eq!(loaded.algorithm, DeviceIdentityAlgorithm::EcdsaP256Sha256);
        assert_eq!(loaded.security_level, IdentitySecurityLevel::HardwareBacked);
        assert_eq!(loaded.schema_version, IDENTITY_METADATA_SCHEMA_VERSION);
        assert!(loaded.is_trustworthy());
    }

    /// §18 — the record carries no secret: only the documented fields, and the
    /// fingerprint is the only key-derived value.
    #[test]
    fn metadata_contains_no_secret_material() {
        let dir = tempfile::tempdir().expect("temp dir");
        store_identity_metadata(dir.path(), &sample(FINGERPRINT)).expect("store");
        let text = std::fs::read_to_string(metadata_path(dir.path())).expect("read");
        let value: serde_json::Value = serde_json::from_str(&text).expect("json");
        let keys: Vec<&str> = value.as_object().expect("object").keys().map(|k| k.as_str()).collect();
        for expected in [
            "schema_version",
            "established",
            "algorithm",
            "fingerprint_hex",
            "security_level",
            "generation",
        ] {
            assert!(keys.contains(&expected), "missing field {expected}");
        }
        assert_eq!(keys.len(), 6, "unexpected extra field in {keys:?}");
        for forbidden in ["private", "secret", "pkcs8", "scalar", "pkcs8_der"] {
            assert!(
                !text.to_ascii_lowercase().contains(forbidden),
                "metadata must never carry secret material ({forbidden})"
            );
        }
    }

    /// A damaged record is `Corrupt`, never overwritten and never read as "absent".
    #[test]
    fn invalid_metadata_is_corrupt_not_absent() {
        let dir = tempfile::tempdir().expect("temp dir");
        std::fs::create_dir_all(dir.path()).expect("dir");
        std::fs::write(metadata_path(dir.path()), b"not json at all").expect("write");
        let error = load_identity_metadata(dir.path()).expect_err("must fail");
        assert_eq!(error.kind(), "METADATA_CORRUPT");
        assert_eq!(error.detail(), "invalid_json");
    }

    /// A future schema version is not silently migrated (§19).
    #[test]
    fn unsupported_schema_version_is_corrupt() {
        let dir = tempfile::tempdir().expect("temp dir");
        let mut metadata = sample(FINGERPRINT);
        metadata.schema_version = IDENTITY_METADATA_SCHEMA_VERSION + 1;
        store_identity_metadata(dir.path(), &metadata).expect("store");
        let error = load_identity_metadata(dir.path()).expect_err("must fail");
        assert_eq!(error.detail(), "unsupported_schema_version");
    }

    /// A record without a usable fingerprint cannot be acted on (§9 / §23).
    #[test]
    fn record_without_a_valid_fingerprint_is_not_trustworthy() {
        let mut ok = sample(FINGERPRINT);
        assert!(ok.is_trustworthy());
        ok.fingerprint_hex = "short".to_string();
        assert!(!ok.is_trustworthy());
        ok.fingerprint_hex = FINGERPRINT.to_uppercase();
        assert!(!ok.is_trustworthy(), "fingerprint comparison must be canonical");
        ok.fingerprint_hex = FINGERPRINT.to_string();
        ok.established = false;
        assert!(!ok.is_trustworthy());
    }

    /// P7-S4R §9 — the durable record is platform-neutral: no Windows backend name, no
    /// Microsoft provider name, no Win32 status and no platform enum is serialized.
    #[test]
    fn metadata_serializes_no_platform_specific_detail() {
        let dir = tempfile::tempdir().expect("temp dir");
        for level in [
            IdentitySecurityLevel::HardwareBacked,
            IdentitySecurityLevel::SoftwareIsolated,
        ] {
            store_identity_metadata(
                dir.path(),
                &IdentityMetadata::established(
                    DeviceIdentityAlgorithm::EcdsaP256Sha256,
                    FINGERPRINT.to_string(),
                    level,
                ),
            )
            .expect("store");
            let text = std::fs::read_to_string(metadata_path(dir.path())).expect("read");
            let lower = text.to_ascii_lowercase();
            for forbidden in [
                "platform_cng",
                "software_cng",
                "platformcng",
                "softwarecng",
                "microsoft",
                "ncrypt",
                "bcrypt",
                "windows",
                "tpm",
                "strongbox",
                "tee",
                "0x",
            ] {
                assert!(
                    !lower.contains(forbidden),
                    "durable metadata must never carry platform detail ({forbidden}): {text}"
                );
            }
        }
    }

    /// P7-S4R §5 — `NotFound` and `ExistsButInvalid` are different answers, and every
    /// damaged shape fails closed with its own stable token.
    #[test]
    fn every_damaged_shape_is_corrupt_not_absent() {
        let cases: [(&str, &str); 6] = [
            // Invalid JSON at all.
            ("{ not json", "invalid_json"),
            // Missing a required field.
            (
                "{\"schema_version\":1,\"established\":true,\"algorithm\":\"ecdsa-p256-sha256\"}",
                "invalid_json",
            ),
            // Unsupported metadata version.
            (
                "{\"schema_version\":99,\"established\":true,\"algorithm\":\"ecdsa-p256-sha256\",\
                 \"fingerprint_hex\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\
                 \"security_level\":\"hardware_backed\",\"generation\":1}",
                "unsupported_schema_version",
            ),
            // Invalid algorithm (not a V1 identity algorithm).
            (
                "{\"schema_version\":1,\"established\":true,\"algorithm\":\"rsa-4096\",\
                 \"fingerprint_hex\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\
                 \"security_level\":\"hardware_backed\",\"generation\":1}",
                "invalid_json",
            ),
            // Invalid security level (a platform name is not a security property).
            (
                "{\"schema_version\":1,\"established\":true,\"algorithm\":\"ecdsa-p256-sha256\",\
                 \"fingerprint_hex\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\
                 \"security_level\":\"platform_cng\",\"generation\":1}",
                "invalid_json",
            ),
            // Invalid generation: a foreign/future generation is never adopted.
            (
                "{\"schema_version\":1,\"established\":true,\"algorithm\":\"ecdsa-p256-sha256\",\
                 \"fingerprint_hex\":\"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\",\
                 \"security_level\":\"hardware_backed\",\"generation\":99}",
                "unsupported_generation",
            ),
        ];
        for (document, expected_detail) in cases {
            let dir = tempfile::tempdir().expect("temp dir");
            std::fs::write(metadata_path(dir.path()), document).expect("write");
            let error = load_identity_metadata(dir.path())
                .expect_err("a damaged record must fail closed, never load as absent");
            assert_eq!(error.kind(), "METADATA_CORRUPT", "document: {document}");
            assert_eq!(error.detail(), expected_detail, "document: {document}");
            // …and the damaged record is left in place: nothing deletes or rewrites it.
            assert_eq!(
                std::fs::read_to_string(metadata_path(dir.path())).expect("read"),
                document,
                "a corrupt record must never be deleted or regenerated"
            );
        }
    }

    /// Deletion is idempotent and leaves "never provisioned" behind.
    #[test]
    fn delete_is_idempotent() {
        let dir = tempfile::tempdir().expect("temp dir");
        store_identity_metadata(dir.path(), &sample(FINGERPRINT)).expect("store");
        delete_identity_metadata(dir.path()).expect("delete");
        delete_identity_metadata(dir.path()).expect("delete again");
        assert_eq!(load_identity_metadata(dir.path()).expect("load"), None);
    }

    /// The document lives directly in the supplied directory, under a fixed name (§17).
    #[test]
    fn metadata_path_is_inside_the_supplied_directory() {
        let path = metadata_path(Path::new("/tmp/config"));
        assert_eq!(path, PathBuf::from("/tmp/config/device-identity.json"));
    }
}
