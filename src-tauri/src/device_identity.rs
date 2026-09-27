//! Device Identity capability validation — Phase 7 / P7-S2 (Windows CNG).
//!
//! This module answers exactly TWO high-risk questions, and nothing else:
//!
//! - **Gate A** — when a CNG key's private export is disabled by policy, can the
//!   PUBLIC key blob still be exported? If not, the whole "operation-oriented,
//!   non-exportable identity key" direction is not implementable on Windows CNG.
//! - **Gate B** — how is TPM capability reliably detected on Windows, and how does
//!   the code reach the Software KSP path when there is no TPM?
//!
//! # What this module deliberately is NOT (§0 / §46)
//!
//! Since P7-S2B the shared [`DeviceIdentityProvider`] *contract* exists here —
//! platform-neutral and `resolve`-only, with deliberately no fake `sign` /
//! `public_identity` methods (§3 / §19). What still does NOT exist: no Trust Store, no
//! pairing, no sync tables, no networking, and **no IPC** (§8) — nothing here is a
//! `#[tauri::command]` and no React/TS caller exists. A passing Gate A / Gate B proves ONLY
//! that the Windows CNG *foundation* is validated — never that "Device Identity is complete".
//!
//! # Platform boundary (§5)
//!
//! Every Win32 / CNG / TBS call lives behind `#[cfg(windows)]` in the Windows submodules
//! (`windows_cng`, `windows_tpm`, `windows_capability`). This file holds the shared,
//! platform-neutral contract plus the Windows adapter's *raw vocabulary* (TPM probe
//! outcomes, backend error codes) — none of which is a Win32 type and none of which is part
//! of the cross-platform contract, so a future Android build gains no Windows dependency
//! from this module. On non-Windows the submodules simply do not exist: nothing is emulated
//! and nothing fails open.
//!
//! # Frozen architecture inherited by this slice (must not be changed here)
//!
//! - Preferred Windows backend: **Microsoft Platform Crypto Provider** (TPM-backed);
//!   fallback: **Microsoft Software Key Storage Provider**; if both are unavailable
//!   the answer is `UNAVAILABLE` / fail closed — never a silent raw-byte downgrade.
//! - The shared contract stays **operation-oriented**; `getPrivateKeyBytes()` (or any
//!   equivalent raw-private-key export entry point) must never appear in it (§7).

// ---------------------------------------------------------------------------
// P7-S4 — V1 Device Identity algorithm freeze (§3)
// ---------------------------------------------------------------------------
//
// The identity algorithm IS frozen for V1 as **ECDSA P-256 / SHA-256**:
//
// - Windows TPM / CNG runtime validated (P7-S2 / P7-T2V);
// - Android Keystore runtime validated on the P7-S3 emulator probe;
// - Windows ↔ Android signature interoperability PASS (P7-S3 §28);
// - P-256 is officially supported by both platform key stores.
//
// This is a **V1 freeze only** — it is NOT a statement that P-256 is permanent for all
// future versions. Nothing outside this module may introduce a second V1 algorithm, and
// no platform adapter may negotiate one at runtime.
//
// What remains platform-neutral and unchanged: the security classification
// [`IdentitySecurityLevel`] (§4) names a security PROPERTY, never a platform
// implementation (no TPM / TEE / StrongBox / provider name may enter the shared domain).

// SHA-256 is used for the canonical identity fingerprint (§9): `SHA-256(SPKI DER)`. The
// crate is already a project dependency — no new dependency is introduced (§37).
use sha2::Digest;

// ---------------------------------------------------------------------------
// TPM probe vocabulary (no Win32 type — see §5)
// ---------------------------------------------------------------------------

/// Documented TPM generation reported by the platform probe.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TpmVersionReport {
    /// `TPM_VERSION_12`
    V1_2,
    /// `TPM_VERSION_20`
    V2_0,
    /// `TPM_VERSION_UNKNOWN`
    Unknown,
}

/// Structured outcome of the platform TPM probe (Gate B, §20).
///
/// The three variants are semantically distinct on purpose (§23): an unexpected
/// probe error is NEVER quietly reinterpreted as "no TPM".
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum TpmProbeOutcome {
    /// The platform reported a usable TPM. `interface_type` is the raw structured
    /// `tpmInterfaceType` value (hardware / emulator / trustzone / …), kept as a
    /// number so no localized string ever drives logic (§31).
    Available {
        tpm_version: TpmVersionReport,
        interface_type: u32,
    },
    /// The platform positively reported that no TPM exists
    /// (`TBS_E_TPM_NOT_FOUND`). This is a **condition, not a failure** (§22).
    NotFound,
    /// The probe failed for any other reason. The raw status travels with it so the
    /// real error is preserved instead of being flattened into "no TPM" (§23).
    ProbeFailed { status: u32 },
}

// ---------------------------------------------------------------------------
// Error model (§30 / §31)
// ---------------------------------------------------------------------------

/// Windows adapter error model (NOT part of the cross-platform contract).
///
/// This is the RICH, Windows-specific error vocabulary (TPM probe statuses, provider open
/// failures, raw `SECURITY_STATUS` codes). It is deliberately NOT referenced by the shared
/// [`DeviceIdentityProvider`] / [`DeviceIdentityReadiness`] contract (§10): the Windows
/// adapter maps it onto the platform-neutral [`IdentityAvailabilityError`] before returning
/// readiness, so a future Android provider is never forced to name a Windows failure.
///
/// Raw OS status codes are retained as `u32` (structured) and are never replaced by
/// a localized Windows error string (§31). Nothing here carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdentityBackendError {
    /// A CNG key-storage provider could not be opened.
    ProviderOpenFailed { provider: &'static str, status: u32 },
    /// `NCryptCreatePersistedKey` failed.
    KeyCreateFailed { status: u32 },
    /// P7-S4R — `NCryptCreatePersistedKey` returned `NTE_EXISTS`: a FINALIZED key with
    /// this name already lives in the store.
    ///
    /// Distinct from [`Self::KeyCreateFailed`] because the required answer is not "fail
    /// and stop": an existing production-name key must never be overwritten, so the caller
    /// re-enters state reconciliation (§12). Collapsing the two would make a two-instance
    /// race indistinguishable from a broken provider.
    KeyAlreadyExists { status: u32 },
    /// A key property could not be written.
    PropertySetFailed { property: &'static str, status: u32 },
    /// The written export policy did not read back as written.
    ExportPolicyReadBackMismatch { expected: u32, actual: u32 },
    /// `NCryptFinalizeKey` failed.
    KeyFinalizeFailed { status: u32 },
    /// `NCryptSignHash` failed (P7-S4 §28). The identity is then unusable: a signing error
    /// is never substituted with another key or another answer.
    SignFailed { status: u32 },
    /// The PUBLIC key blob could not be exported (Gate A's positive case failed).
    PublicExportFailed { status: u32 },
    /// A PRIVATE blob export was permitted. This is the failure Gate A exists to
    /// detect: the key is not non-exportable and must never be accepted.
    UnexpectedPrivateExportSuccess,
    /// No TPM is present. Retained as a *condition* token: [`select_identity_backend`]
    /// maps [`TpmProbeOutcome::NotFound`] to [`IdentityBackendSelection::SoftwareCng`]
    /// and never to an error, but a future caller that *requires* TPM-backed identity
    /// can fail closed with this stable token instead of inventing prose.
    TpmNotFound,
    /// The TPM probe failed for a reason other than "not found".
    TpmProbeFailed { status: u32 },
    /// The dedicated test key could not be deleted. Carries the key identifier so a
    /// human can remove it by hand (§17).
    CleanupFailed { key_name: String, status: u32 },
    /// The cleanup verification re-open could not determine presence: the key is NOT
    /// proven absent. Deliberately distinct from [`Self::CleanupFailed`] (which means the
    /// deletion itself failed) — "could not prove absence" must never be reported as
    /// "deleted" (§8 / §9, fail-closed).
    KeyPresenceProbeFailed { key_name: String, status: u32 },
    /// The TPM-reported Platform Crypto Provider could not be opened even though the TPM
    /// probe reported one present. This is NOT silently downgraded to the Software KSP
    /// (§12): a measured TPM whose expected secure backend fails is an anomaly → fail
    /// closed, never a quiet software fallback.
    PlatformProviderUnavailable { status: u32 },
    /// The Microsoft Software Key Storage Provider could not be opened on the no-TPM path.
    /// With neither backend available the device-identity capability is Unavailable (§13).
    SoftwareProviderUnavailable { status: u32 },
    /// A backend provider opened but a required self-inspection (e.g. the hardware-backed
    /// implementation-type query) failed, so its claimed security level cannot be trusted
    /// and the capability is Unavailable rather than mis-reported.
    ProviderInspectionFailed { provider: &'static str, status: u32 },
}

impl IdentityBackendError {
    /// Stable, machine-readable token (same convention as `Issue.kind` in the startup
    /// pipeline: the variant name, never localized prose).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::ProviderOpenFailed { .. } => "ProviderOpenFailed",
            Self::KeyCreateFailed { .. } => "KeyCreateFailed",
            Self::KeyAlreadyExists { .. } => "KeyAlreadyExists",
            Self::PropertySetFailed { .. } => "PropertySetFailed",
            Self::ExportPolicyReadBackMismatch { .. } => "ExportPolicyReadBackMismatch",
            Self::KeyFinalizeFailed { .. } => "KeyFinalizeFailed",
            Self::SignFailed { .. } => "SignFailed",
            Self::PublicExportFailed { .. } => "PublicExportFailed",
            Self::UnexpectedPrivateExportSuccess => "UnexpectedPrivateExportSuccess",
            Self::TpmNotFound => "TpmNotFound",
            Self::TpmProbeFailed { .. } => "TpmProbeFailed",
            Self::CleanupFailed { .. } => "CleanupFailed",
            Self::KeyPresenceProbeFailed { .. } => "KeyPresenceProbeFailed",
            Self::PlatformProviderUnavailable { .. } => "PlatformProviderUnavailable",
            Self::SoftwareProviderUnavailable { .. } => "SoftwareProviderUnavailable",
            Self::ProviderInspectionFailed { .. } => "ProviderInspectionFailed",
        }
    }

    /// The raw structured OS status carried by this error, when it has one (§31).
    ///
    /// Statuses stay numbers all the way through: no localized Windows error string is
    /// ever stored, and none is ever used to make a decision.
    pub(crate) fn status(&self) -> Option<u32> {
        match self {
            Self::ProviderOpenFailed { status, .. }
            | Self::KeyCreateFailed { status }
            | Self::KeyAlreadyExists { status }
            | Self::PropertySetFailed { status, .. }
            | Self::KeyFinalizeFailed { status }
            | Self::SignFailed { status }
            | Self::PublicExportFailed { status }
            | Self::TpmProbeFailed { status }
            | Self::CleanupFailed { status, .. }
            | Self::KeyPresenceProbeFailed { status, .. }
            | Self::PlatformProviderUnavailable { status }
            | Self::SoftwareProviderUnavailable { status }
            | Self::ProviderInspectionFailed { status, .. } => Some(*status),
            Self::ExportPolicyReadBackMismatch { actual, .. } => Some(*actual),
            // Neither of these is an OS status: one is a verdict about an export that
            // must never have succeeded, the other is a condition, not a failure.
            Self::UnexpectedPrivateExportSuccess | Self::TpmNotFound => None,
        }
    }
}

// ---------------------------------------------------------------------------
// Backend selection (pure logic — deterministic and testable without a TPM, §24 / §26)
// ---------------------------------------------------------------------------

/// Which Windows identity backend the probe result selects.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdentityBackendSelection {
    /// TPM available ⇒ the Microsoft Platform Crypto Provider is the candidate.
    PlatformCng,
    /// No TPM ⇒ the Microsoft Software Key Storage Provider is the candidate
    /// (documented fallback, NOT an error).
    SoftwareCng,
    /// The probe failed unexpectedly ⇒ the answer is an error. There is deliberately
    /// no silent fallback to `SoftwareCng` here (§23 / §24): "could not measure" is
    /// not the same observation as "measured, and there is no TPM".
    Error(IdentityBackendError),
}

impl IdentityBackendSelection {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::PlatformCng => "PLATFORM_CNG",
            Self::SoftwareCng => "SOFTWARE_CNG",
            Self::Error(_) => "ERROR",
        }
    }
}

/// Pure backend-selection function (§24).
///
/// Deliberately takes an already-measured [`TpmProbeOutcome`] rather than performing
/// the probe itself, so the decision logic is deterministic and testable on any
/// machine — including one that HAS a TPM and must not have it disabled (§26).
pub(crate) fn select_identity_backend(probe: &TpmProbeOutcome) -> IdentityBackendSelection {
    match probe {
        TpmProbeOutcome::Available { .. } => IdentityBackendSelection::PlatformCng,
        TpmProbeOutcome::NotFound => IdentityBackendSelection::SoftwareCng,
        TpmProbeOutcome::ProbeFailed { status } => {
            IdentityBackendSelection::Error(IdentityBackendError::TpmProbeFailed {
                status: *status,
            })
        }
    }
}

// ---------------------------------------------------------------------------
// P7-S2B / P7-S2BR — Device Identity capability foundation (shared vocabulary, NO Win32)
// ---------------------------------------------------------------------------
//
// PLATFORM BOUNDARY (§3–§7): everything below is the SEMANTIC contract a future
// `AndroidDeviceIdentityProvider` (or a test provider) must also be able to implement, so
// it contains NO Win32 handle, NO windows-sys type, NO secret bytes and NO Windows provider
// name. The Windows-specific diagnostics that used to leak here — `PlatformCng` /
// `SoftwareCng`, the provider labels and raw `SECURITY_STATUS` codes — now live in the
// Windows adapter (`windows_capability`) and are reached only through a Windows-specific
// API (§18).

/// How strongly the selected backend protects the identity material.
///
/// Platform-neutral: the variants describe a SECURITY PROPERTY, never a platform
/// implementation name, so a future Android Keystore / TEE / StrongBox backend maps onto
/// the same two levels without modifying this enum (§8).
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum IdentitySecurityLevel {
    /// Backed by a discrete/measured hardware root of trust (e.g. TPM, TEE, StrongBox).
    HardwareBacked,
    /// Isolated in software key storage; not hardware-protected.
    SoftwareIsolated,
}

/// Platform-neutral reason a device-identity capability is unavailable.
///
/// This is the ONLY unavailability vocabulary the shared contract exposes (§9 / §10): it
/// deliberately does NOT contain Windows/TPM tokens such as `TpmProbeFailed`,
/// `PlatformProviderUnavailable` or `SoftwareProviderUnavailable`. Each platform adapter
/// maps its own richer error (on Windows: [`IdentityBackendError`]) onto one of these
/// generic reasons, so a future Android provider is never forced to name a Windows failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum IdentityAvailabilityError {
    /// The capability could not be measured at all (a probe/inspection failed). This is
    /// NOT the same observation as "measured, and nothing is available" (§9, fail closed).
    ProbeFailed,
    /// No secure backend could be opened on this device.
    NoBackendAvailable,
    /// A backend opened but its claimed security level could not be verified.
    SecurityLevelUnverified,
}

impl IdentityAvailabilityError {
    /// Stable, machine-readable token (same convention as [`IdentityBackendError::kind`]).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::ProbeFailed => "PROBE_FAILED",
            Self::NoBackendAvailable => "NO_BACKEND_AVAILABLE",
            Self::SecurityLevelUnverified => "SECURITY_LEVEL_UNVERIFIED",
        }
    }
}

/// The device-identity capability, resolved from the platform.
///
/// Platform-neutral by construction (§6): `Ready` carries ONLY the shared
/// [`IdentitySecurityLevel`] — it does NOT carry a Windows backend type or any other
/// platform-specific detail, so an Android provider can construct it verbatim. Windows
/// backend diagnostics (`PlatformCng` / `SoftwareCng`) are returned separately by the
/// Windows adapter, never through this contract (§7 / §18).
///
/// The resolution NEVER creates a key, writes a file or touches the credential store
/// (§14 / §26).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeviceIdentityReadiness {
    /// A backend is confirmed available, with the security level it provides.
    Ready {
        security_level: IdentitySecurityLevel,
    },
    /// No backend is confirmed available; the generic reason is carried for diagnosis.
    Unavailable { reason: IdentityAvailabilityError },
}

impl DeviceIdentityReadiness {
    /// `true` iff a backend is confirmed available.
    pub(crate) fn is_ready(&self) -> bool {
        matches!(self, Self::Ready { .. })
    }

    /// The security level, when ready.
    pub(crate) fn security_level(&self) -> Option<IdentitySecurityLevel> {
        match self {
            Self::Ready { security_level } => Some(*security_level),
            Self::Unavailable { .. } => None,
        }
    }
}

/// The operation-oriented device-identity capability contract (§7 / §11).
///
/// Only methods that can be TRULY delivered today are present — there is deliberately no
/// `sign`, no `public_identity`, no `ensure_identity`, no `reset_identity`: those require a
/// frozen identity algorithm and a real (long-lived) key, neither of which exists yet
/// (§3 / §8 / §19).
///
/// PLATFORM NEUTRALITY (§3 / §17): neither this trait nor its [`DeviceIdentityReadiness`]
/// return type references any Windows type. A `WindowsDeviceIdentityProvider` (the Windows
/// adapter), a future `AndroidDeviceIdentityProvider`, and a `FakeDeviceIdentityProvider`
/// (test) all implement it identically; the test module below proves this at compile time.
pub(crate) trait DeviceIdentityProvider {
    /// Resolve the current device-identity backend readiness. Side-effect free: no key is
    /// created, no file is written, no transport is opened (§14 / §26).
    fn resolve(&self) -> DeviceIdentityReadiness;
}

// ---------------------------------------------------------------------------
// P7-S4 — production identity capability (§6–§27), platform-neutral
// ---------------------------------------------------------------------------
//
// Everything below is the SEMANTIC contract a future `AndroidDeviceIdentityProvider` must
// also implement: NO Win32 type, NO provider name, NO secret bytes, NO private-key entry
// point (§7). The only platform-shaped value that crosses this boundary is a raw OS status
// carried as a `u32` inside a stable error token — a structured number, never prose.

/// The frozen V1 Device Identity algorithm (§3 / §11).
///
/// Only the algorithm that actually has callers exists: adding `Ed25519`, `P384`, `RSA` or
/// a placeholder "future" variant would be a hierarchy without a use case.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub(crate) enum DeviceIdentityAlgorithm {
    /// `ECDSA P-256` with `SHA-256`, signatures encoded as DER `ECDSA-Sig-Value`.
    #[serde(rename = "ecdsa-p256-sha256")]
    EcdsaP256Sha256,
}

impl DeviceIdentityAlgorithm {
    /// Stable machine-readable token (§11).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::EcdsaP256Sha256 => "ecdsa-p256-sha256",
        }
    }
}

/// The signature scheme a signed authentication message was produced with (§12).
///
/// Deliberately NOT `rustls::SignatureScheme`: Device Identity must stay
/// transport-independent, so the transport adapter maps this onto whatever its TLS stack
/// wants when (and only when) transport is implemented (§38 / §43).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DeviceSignatureScheme {
    /// `ECDSA P-256` over `SHA-256` of the UNHASHED message, DER `ECDSA-Sig-Value`.
    EcdsaP256Sha256,
}

impl DeviceSignatureScheme {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::EcdsaP256Sha256 => "ecdsa-p256-sha256",
        }
    }
}

/// A produced signature in the shared, platform-neutral output format (§14).
///
/// Windows converts its native P-1363 output to DER; Android already emits DER. Callers
/// therefore never see — and never branch on — a platform difference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DeviceSignature {
    /// The scheme the signature was produced with.
    pub scheme: DeviceSignatureScheme,
    /// DER `ECDSA-Sig-Value` bytes.
    pub der: Vec<u8>,
}

/// The canonical V1 public Device Identity (§10).
///
/// - `spki_der` is the canonical DER `SubjectPublicKeyInfo` (§8) — platform-neutral bytes,
///   never a provider-native blob, handle or platform object.
/// - `fingerprint` is `SHA-256(spki_der)` (§9): the stable trust identifier used for
///   pairing display / reference and for the future Trust Store key. It is never derived
///   from a provider blob, a display name, a `device_id` or an IP address.
///
/// Immutable value semantics: the fields are private and there is no mutation path — the
/// only constructor validates the canonical encoding, so a `DevicePublicIdentity` can only
/// ever hold a well-formed V1 identity.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct DevicePublicIdentity {
    algorithm: DeviceIdentityAlgorithm,
    spki_der: Vec<u8>,
    fingerprint: [u8; 32],
}

impl DevicePublicIdentity {
    /// Builds the canonical identity from a DER `SubjectPublicKeyInfo` (§8 / §9).
    ///
    /// Rejects anything that is not a canonical P-256 SPKI: this is the single place where
    /// a provider-native blob is stopped from ever becoming the wire identity.
    pub(crate) fn from_spki(spki_der: Vec<u8>) -> Result<Self, IdentityError> {
        if !der::is_canonical_p256_spki(&spki_der) {
            return Err(IdentityError::PublicIdentityUnavailable {
                kind: "NonCanonicalSpki",
                status: None,
            });
        }
        let digest = sha2::Sha256::digest(&spki_der);
        let mut fingerprint = [0u8; 32];
        fingerprint.copy_from_slice(digest.as_slice());
        Ok(Self {
            algorithm: DeviceIdentityAlgorithm::EcdsaP256Sha256,
            spki_der,
            fingerprint,
        })
    }

    pub(crate) fn algorithm(&self) -> DeviceIdentityAlgorithm {
        self.algorithm
    }

    /// Canonical DER `SubjectPublicKeyInfo` (§8).
    pub(crate) fn spki_der(&self) -> &[u8] {
        &self.spki_der
    }

    /// `SHA-256(canonical SPKI DER)` (§9).
    pub(crate) fn fingerprint(&self) -> [u8; 32] {
        self.fingerprint
    }

    /// Lowercase hex fingerprint — the canonical comparison/display form (§9).
    pub(crate) fn fingerprint_hex(&self) -> String {
        der::hex(&self.fingerprint)
    }

    /// Constant-shape fingerprint comparison against the recorded hex value (§23).
    pub(crate) fn matches_fingerprint_hex(&self, fingerprint_hex: &str) -> bool {
        self.fingerprint_hex() == fingerprint_hex
    }
}

/// Platform-neutral identity failure model (§21–§24, §30).
///
/// Every variant is a distinct, stable answer; the fail-closed cases
/// ([`Self::IdentityMaterialMissing`], [`Self::IdentityMetadataMissing`],
/// [`Self::FingerprintMismatch`], [`Self::SecurityLevelMismatch`],
/// [`Self::UnexpectedPrivateExportSuccess`], [`Self::Unavailable`]) exist so a caller can
/// never mistake "identity is gone" for "identity was never here" or for success.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdentityError {
    /// No usable backend on this device (§15 / §5 on Android: provider unavailable ⇒
    /// identity unavailable).
    Unavailable { reason: IdentityAvailabilityError },
    /// P7-S4R2 §15 — FROZEN meaning:
    ///
    /// ```text
    /// NOT_PROVISIONED  iff  metadata absent AND provider key absent
    /// ```
    ///
    /// It is NEVER used for an incomplete established state (key present without a record,
    /// record present without a key, damaged record, drift): those are all fail-closed
    /// errors, so "nothing was here" and "something here cannot be trusted" stay different
    /// answers forever.
    NotProvisioned,
    /// Metadata says an identity was established, but its key material is gone (§22).
    /// NEVER silently regenerated.
    IdentityMaterialMissing,
    /// P7-S4R — the provider key EXISTS but no trusted metadata record does.
    ///
    /// Without trusted metadata, an existing production-name key cannot be distinguished
    /// from interrupted provisioning, deleted state, or an unexpected/pre-seeded key.
    /// Therefore it is not silently adopted: fail closed, and never reconstruct a record
    /// from the key alone. This is the mirror of [`Self::IdentityMaterialMissing`] (key
    /// gone / record present) and is NEVER reported as [`Self::NotProvisioned`] — by ANY
    /// entry point (`ensure_identity`, `public_identity`, `sign`), because all of them run
    /// the same state reconciliation (P7-S4R2 §14).
    IdentityMetadataMissing,
    /// The provider key's canonical public identity does not match the recorded
    /// fingerprint (§23 / §24) — including a same-named key found in a different provider.
    FingerprintMismatch,
    /// P7-S4R — the recorded [`IdentitySecurityLevel`] differs from the security level
    /// currently observed from the platform.
    ///
    /// V1 does NOT distinguish an upgrade from a downgrade: `HardwareBacked →
    /// SoftwareIsolated` fails and `SoftwareIsolated → HardwareBacked` fails too. The
    /// record is never silently rewritten; an explicit, reviewed security migration would
    /// need its own real use case.
    SecurityLevelMismatch,
    /// The device-local metadata record is damaged or unreadable-as-valid (§19).
    MetadataCorrupt { detail: &'static str },
    /// The metadata file could not be read or written (§19).
    MetadataIo { detail: &'static str },
    /// The platform provider failed: key creation, policy, presence probe, or export.
    ProviderFailure {
        kind: &'static str,
        status: Option<u32>,
    },
    /// The signing operation failed (§28). Fail closed — a missing or invalid signature is
    /// never substituted.
    SignFailed {
        kind: &'static str,
        status: Option<u32>,
    },
    /// The public identity could not be derived from the provider key (§8 / §30).
    PublicIdentityUnavailable {
        kind: &'static str,
        status: Option<u32>,
    },
    /// P7-S4R — provisioning created a key, the metadata record could NOT be written, and
    /// the just-created key could not be PROVEN removed.
    ///
    /// "Provisioning failed" must never be reported as "the environment is back as it
    /// was": a key left behind without a record is exactly the orphan state that later
    /// fails closed, so the caller has to be told the cleanup did not complete.
    ProvisionCleanupIncomplete {
        kind: &'static str,
        status: Option<u32>,
    },
    /// A private-key export SUCCEEDED. The production key must be non-exportable (§30), so
    /// success here is a failure — and it is never reported as a usable identity.
    UnexpectedPrivateExportSuccess,
}

impl IdentityError {
    /// Stable, machine-readable token (same convention as the rest of the module family).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::Unavailable { .. } => "UNAVAILABLE",
            Self::NotProvisioned => "NOT_PROVISIONED",
            Self::IdentityMaterialMissing => "IDENTITY_MATERIAL_MISSING",
            Self::IdentityMetadataMissing => "IDENTITY_METADATA_MISSING",
            Self::FingerprintMismatch => "FINGERPRINT_MISMATCH",
            Self::SecurityLevelMismatch => "SECURITY_LEVEL_MISMATCH",
            Self::MetadataCorrupt { .. } => "METADATA_CORRUPT",
            Self::MetadataIo { .. } => "METADATA_IO",
            Self::ProviderFailure { .. } => "PROVIDER_FAILURE",
            Self::SignFailed { .. } => "SIGN_FAILED",
            Self::PublicIdentityUnavailable { .. } => "PUBLIC_IDENTITY_UNAVAILABLE",
            Self::ProvisionCleanupIncomplete { .. } => "PROVISION_CLEANUP_INCOMPLETE",
            Self::UnexpectedPrivateExportSuccess => "UNEXPECTED_PRIVATE_EXPORT_SUCCESS",
        }
    }

    /// The stable sub-token that distinguishes failures sharing a class (§30 / §38).
    pub(crate) fn detail(&self) -> Option<&'static str> {
        match self {
            Self::MetadataCorrupt { detail } | Self::MetadataIo { detail } => Some(detail),
            Self::ProviderFailure { kind, .. }
            | Self::SignFailed { kind, .. }
            | Self::PublicIdentityUnavailable { kind, .. }
            | Self::ProvisionCleanupIncomplete { kind, .. } => Some(kind),
            _ => None,
        }
    }

    /// The raw structured OS status, when one was captured. Statuses stay numbers all the
    /// way through (§31 of the Windows slice): no localized error string ever travels here.
    pub(crate) fn status(&self) -> Option<u32> {
        match self {
            Self::ProviderFailure { status, .. }
            | Self::SignFailed { status, .. }
            | Self::PublicIdentityUnavailable { status, .. }
            | Self::ProvisionCleanupIncomplete { status, .. } => *status,
            _ => None,
        }
    }
}

impl From<metadata::MetadataError> for IdentityError {
    fn from(error: metadata::MetadataError) -> Self {
        match error {
            metadata::MetadataError::Corrupt { detail } => Self::MetadataCorrupt { detail },
            metadata::MetadataError::Io { detail } => Self::MetadataIo { detail },
        }
    }
}

/// The production device-identity capability (§6).
///
/// `resolve` remains the side-effect-free readiness read; the three methods below are the
/// production capability every platform adapter (Windows today, Android next) must
/// provide:
///
/// - [`Self::ensure_identity`] — provisioning, idempotent (§25);
/// - [`Self::public_identity`] — read-only, no side-effect creation (§26);
/// - [`Self::sign`] — sign an UNHASHED authentication message (§12 / §28).
///
/// P7-S4R — there is deliberately NO `reset_identity` / `rotate_identity` method: a
/// method whose only implementation is "not permitted" is a fake API, not a boundary.
/// Rotation and reset remain frozen ARCHITECTURE semantics; their API is DEFERRED UNTIL
/// A REAL CALLER EXISTs (§27).
///
/// NO private-key entry point exists and none may be added (§7). This is an internal
/// native capability: it is never exposed as a frontend "sign arbitrary bytes" command
/// (§13), and no Trust Store / pairing / transport behaviour lives here (§42 / §43).
pub(crate) trait DeviceIdentityCapability: DeviceIdentityProvider {
    /// Ensures a V1 identity exists and returns its canonical public identity.
    ///
    /// Idempotent: repeated calls return the SAME identity and never generate a second key
    /// (§25). `metadata_dir` is the app config dir (§17); the provider applies every
    /// fail-closed rule (§20–§24) before touching anything.
    fn ensure_identity(&self, metadata_dir: &std::path::Path)
        -> Result<DevicePublicIdentity, IdentityError>;

    /// Reads the already-established identity. NEVER provisions (§26).
    fn public_identity(
        &self,
        metadata_dir: &std::path::Path,
    ) -> Result<DevicePublicIdentity, IdentityError>;

    /// Signs an UNHASHED authentication message with the device identity.
    ///
    /// The provider performs `SHA-256` exactly once and returns DER (§12 / §14 / §28).
    /// The recorded identity must still match the provider key or the call fails closed
    /// (§23) — signing with an unattested key is never allowed.
    fn sign(
        &self,
        metadata_dir: &std::path::Path,
        message: &[u8],
    ) -> Result<DeviceSignature, IdentityError>;
}

// ---------------------------------------------------------------------------
// Windows-only implementation
// ---------------------------------------------------------------------------

// Platform-neutral building blocks: canonical encodings (§8 / §14) and the device-local
// identity record (§17–§19). Both compile on every target, so a future Android adapter
// reuses them instead of growing a second encoding path.
pub(crate) mod der;
pub(crate) mod metadata;

#[cfg(windows)]
pub(crate) mod windows_cng;

#[cfg(windows)]
pub(crate) mod windows_tpm;

#[cfg(windows)]
pub(crate) mod windows_capability;

/// P7-S4 — Windows production identity provider (§15 / §28).
#[cfg(windows)]
pub(crate) mod windows_identity;

#[cfg(test)]
mod tests {
    use super::*;

    // --- Gate B selection logic (§33) -------------------------------------

    /// `TBS_SUCCESS` ⇒ the Platform Crypto Provider is the candidate.
    #[test]
    fn tbs_success_selects_the_platform_candidate() {
        let probe = TpmProbeOutcome::Available {
            tpm_version: TpmVersionReport::V2_0,
            interface_type: 3, // TPM_IFTYPE_HW
        };
        let selection = select_identity_backend(&probe);
        assert_eq!(selection, IdentityBackendSelection::PlatformCng);
        assert_eq!(selection.kind(), "PLATFORM_CNG");
    }

    /// `TBS_E_TPM_NOT_FOUND` ⇒ the Software KSP candidate, and explicitly NOT an
    /// error: the architecture already allows the software fallback (§22).
    #[test]
    fn tbs_tpm_not_found_selects_the_software_candidate() {
        let selection = select_identity_backend(&TpmProbeOutcome::NotFound);
        assert_eq!(selection, IdentityBackendSelection::SoftwareCng);
        assert_eq!(selection.kind(), "SOFTWARE_CNG");
    }

    /// Any other probe result ⇒ error, and NEVER a silent software fallback (§23).
    #[test]
    fn unexpected_probe_failure_never_silently_falls_back() {
        let selection = select_identity_backend(&TpmProbeOutcome::ProbeFailed {
            status: 0x8028_4001, // TBS_E_INTERNAL_ERROR
        });
        match selection {
            IdentityBackendSelection::Error(error) => {
                assert_eq!(error.kind(), "TpmProbeFailed");
                assert_eq!(
                    error,
                    IdentityBackendError::TpmProbeFailed {
                        status: 0x8028_4001
                    }
                );
            }
            other => panic!("unexpected probe failure must not select a backend: {other:?}"),
        }
    }

    /// The "no TPM" condition and the "probe broke" condition must stay
    /// distinguishable — this is the whole point of §20 / §23.
    #[test]
    fn not_found_and_probe_failure_are_different_answers() {
        assert_ne!(
            select_identity_backend(&TpmProbeOutcome::NotFound),
            select_identity_backend(&TpmProbeOutcome::ProbeFailed { status: 1 })
        );
        // …and the "no TPM" answer is never an error.
        assert!(!matches!(
            select_identity_backend(&TpmProbeOutcome::NotFound),
            IdentityBackendSelection::Error(_)
        ));
    }

    /// §30 — every variant has a stable machine-readable token, and no token is
    /// localized prose.
    #[test]
    fn error_kinds_are_stable_tokens() {
        let samples = [
            IdentityBackendError::ProviderOpenFailed {
                provider: "p",
                status: 1,
            },
            IdentityBackendError::KeyCreateFailed { status: 1 },
            IdentityBackendError::KeyAlreadyExists { status: 1 },
            IdentityBackendError::PropertySetFailed {
                property: "Export Policy",
                status: 1,
            },
            IdentityBackendError::ExportPolicyReadBackMismatch {
                expected: 0,
                actual: 1,
            },
            IdentityBackendError::KeyFinalizeFailed { status: 1 },
            IdentityBackendError::PublicExportFailed { status: 1 },
            IdentityBackendError::UnexpectedPrivateExportSuccess,
            IdentityBackendError::TpmNotFound,
            IdentityBackendError::TpmProbeFailed { status: 1 },
            IdentityBackendError::CleanupFailed {
                key_name: "k".into(),
                status: 1,
            },
            IdentityBackendError::KeyPresenceProbeFailed {
                key_name: "k".into(),
                status: 1,
            },
            IdentityBackendError::PlatformProviderUnavailable { status: 1 },
            IdentityBackendError::SoftwareProviderUnavailable { status: 1 },
            IdentityBackendError::ProviderInspectionFailed {
                provider: "p",
                status: 1,
            },
        ];
        for error in &samples {
            let kind = error.kind();
            assert!(!kind.is_empty());
            assert!(
                kind.chars().all(|c| c.is_ascii_alphanumeric()),
                "kind tokens must be ASCII machine tokens, got {kind:?}"
            );
        }
    }

    // --- P7-S2BR — shared contract platform-neutrality (§3 / §17) ------------

    /// A stand-in for a future `AndroidDeviceIdentityProvider` (and for any test provider).
    ///
    /// It implements the shared contract using ONLY platform-neutral types: NO
    /// `WindowsIdentityBackend`, NO `PlatformCng` / `SoftwareCng`, NO windows-sys, NO raw OS
    /// status. If this compiles, the contract is genuinely platform-neutral (§3 / §17).
    struct FakeDeviceIdentityProvider {
        readiness: DeviceIdentityReadiness,
    }

    impl DeviceIdentityProvider for FakeDeviceIdentityProvider {
        fn resolve(&self) -> DeviceIdentityReadiness {
            self.readiness
        }
    }

    /// §17 — compile-level proof: a fake provider satisfies `DeviceIdentityProvider` without
    /// referencing a single Windows type, for BOTH readiness states.
    #[test]
    fn fake_provider_implements_shared_contract_without_windows_types() {
        let ready = FakeDeviceIdentityProvider {
            readiness: DeviceIdentityReadiness::Ready {
                security_level: IdentitySecurityLevel::HardwareBacked,
            },
        };
        let readiness = ready.resolve();
        assert!(readiness.is_ready());
        assert_eq!(
            readiness.security_level(),
            Some(IdentitySecurityLevel::HardwareBacked)
        );

        let unavailable = FakeDeviceIdentityProvider {
            readiness: DeviceIdentityReadiness::Unavailable {
                reason: IdentityAvailabilityError::NoBackendAvailable,
            },
        };
        let readiness = unavailable.resolve();
        assert!(!readiness.is_ready());
        assert_eq!(readiness.security_level(), None);
    }

    /// The shared unavailability vocabulary stays platform-neutral and stable (§9 / §10) —
    /// no Windows/TPM token may appear here, and the three causes never collapse.
    #[test]
    fn availability_error_kinds_are_neutral_stable_tokens() {
        let samples = [
            IdentityAvailabilityError::ProbeFailed,
            IdentityAvailabilityError::NoBackendAvailable,
            IdentityAvailabilityError::SecurityLevelUnverified,
        ];
        for reason in &samples {
            let kind = reason.kind();
            assert!(!kind.is_empty());
            assert!(
                kind.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "availability tokens must be ASCII machine tokens, got {kind:?}"
            );
        }
        assert_ne!(
            IdentityAvailabilityError::ProbeFailed.kind(),
            IdentityAvailabilityError::NoBackendAvailable.kind()
        );
        assert_ne!(
            IdentityAvailabilityError::NoBackendAvailable.kind(),
            IdentityAvailabilityError::SecurityLevelUnverified.kind()
        );
    }

    // --- P7-S4 — canonical public identity (§8 / §9 / §10) -------------------

    /// A canonical P-256 SPKI: fixed prefix + SEC1 uncompressed point (91 bytes).
    fn canonical_spki(fill: u8) -> Vec<u8> {
        let mut spki = der::P256_SPKI_PREFIX.to_vec();
        spki.push(0x04);
        spki.extend(std::iter::repeat(fill).take(der::P256_POINT_LEN - 1));
        spki
    }

    /// §9 — the fingerprint is `SHA-256(canonical SPKI DER)`, deterministic and hex-stable.
    #[test]
    fn fingerprint_is_sha256_of_the_canonical_spki() {
        let spki = canonical_spki(0x11);
        let identity = DevicePublicIdentity::from_spki(spki.clone()).expect("canonical spki");
        assert_eq!(identity.algorithm(), DeviceIdentityAlgorithm::EcdsaP256Sha256);
        assert_eq!(identity.spki_der(), &spki[..]);
        assert_eq!(identity.spki_der().len(), der::P256_SPKI_LEN);

        let expected = sha2::Sha256::digest(&spki);
        assert_eq!(identity.fingerprint(), expected.as_slice());
        assert_eq!(identity.fingerprint_hex().len(), 64);
        assert!(identity.matches_fingerprint_hex(&der::hex(&identity.fingerprint())));

        // Deterministic: the same bytes always yield the same identity reference.
        let again = DevicePublicIdentity::from_spki(spki).expect("canonical spki");
        assert_eq!(again.fingerprint(), identity.fingerprint());
        // A different key is a different identity — the fingerprint is never constant.
        let other = DevicePublicIdentity::from_spki(canonical_spki(0x22)).expect("canonical spki");
        assert_ne!(other.fingerprint(), identity.fingerprint());
    }

    /// §8 — a provider-native blob must never become the canonical public identity.
    #[test]
    fn non_canonical_spki_is_rejected() {
        let mut blob = vec![0u8; 8 + 2 * der::P256_SCALAR_LEN];
        blob[0..4].copy_from_slice(&der::BCRYPT_ECDSA_PUBLIC_P256_MAGIC.to_le_bytes());
        blob[4..8].copy_from_slice(&(der::P256_SCALAR_LEN as u32).to_le_bytes());
        let error = DevicePublicIdentity::from_spki(blob).expect_err("blob must be rejected");
        assert_eq!(error.kind(), "PUBLIC_IDENTITY_UNAVAILABLE");
        assert_eq!(error.detail(), Some("NonCanonicalSpki"));

        // Wrong length, and a well-formed length with the wrong algorithm identifier.
        assert!(DevicePublicIdentity::from_spki(vec![0u8; 90]).is_err());
        let mut wrong_alg = canonical_spki(0x11);
        wrong_alg[4] = 0x00;
        assert!(DevicePublicIdentity::from_spki(wrong_alg).is_err());
    }

    /// §11 / §12 — only the algorithms that exist have tokens, and they are stable.
    #[test]
    fn algorithm_and_signature_scheme_tokens_are_stable() {
        assert_eq!(
            DeviceIdentityAlgorithm::EcdsaP256Sha256.kind(),
            "ecdsa-p256-sha256"
        );
        assert_eq!(
            DeviceSignatureScheme::EcdsaP256Sha256.kind(),
            "ecdsa-p256-sha256"
        );
        // The frozen algorithm survives a metadata round-trip unchanged (§3 / §19).
        let json = serde_json::to_string(&DeviceIdentityAlgorithm::EcdsaP256Sha256)
            .expect("serialize algorithm");
        assert_eq!(json, "\"ecdsa-p256-sha256\"");
        let back: DeviceIdentityAlgorithm = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, DeviceIdentityAlgorithm::EcdsaP256Sha256);
    }

    /// §21–§24 — every failure has a stable token, and the fail-closed answers never
    /// collapse into "not provisioned" or into success.
    #[test]
    fn identity_error_kinds_are_stable_machine_tokens() {
        let samples = [
            IdentityError::Unavailable {
                reason: IdentityAvailabilityError::NoBackendAvailable,
            },
            IdentityError::NotProvisioned,
            IdentityError::IdentityMaterialMissing,
            IdentityError::IdentityMetadataMissing,
            IdentityError::FingerprintMismatch,
            IdentityError::SecurityLevelMismatch,
            IdentityError::MetadataCorrupt {
                detail: "invalid_json",
            },
            IdentityError::MetadataIo {
                detail: "read_failed",
            },
            IdentityError::ProviderFailure {
                kind: "KeyCreateFailed",
                status: Some(0x8009_0000),
            },
            IdentityError::SignFailed {
                kind: "CngSign",
                status: None,
            },
            IdentityError::PublicIdentityUnavailable {
                kind: "PublicExportFailed",
                status: Some(1),
            },
            IdentityError::ProvisionCleanupIncomplete {
                kind: "KeyDeleteFailed",
                status: Some(1),
            },
            IdentityError::UnexpectedPrivateExportSuccess,
        ];
        for error in &samples {
            let kind = error.kind();
            assert!(!kind.is_empty());
            assert!(
                kind.chars().all(|c| c.is_ascii_uppercase() || c == '_'),
                "identity error tokens must be ASCII machine tokens, got {kind:?}"
            );
        }
        // The two "identity is not usable" answers are distinct on purpose (§20–§22).
        assert_ne!(
            IdentityError::NotProvisioned.kind(),
            IdentityError::IdentityMaterialMissing.kind()
        );
        // P7-S4R — the four "state is not what it should be" answers never collapse:
        // an orphaned key (key present, no record) is neither "never provisioned" nor
        // "key material lost", and drift is neither of the mismatch answers.
        assert_ne!(
            IdentityError::IdentityMetadataMissing.kind(),
            IdentityError::IdentityMaterialMissing.kind()
        );
        assert_ne!(
            IdentityError::IdentityMetadataMissing.kind(),
            IdentityError::NotProvisioned.kind()
        );
        assert_ne!(
            IdentityError::SecurityLevelMismatch.kind(),
            IdentityError::FingerprintMismatch.kind()
        );
        // Raw OS statuses stay structured numbers (never prose).
        assert_eq!(
            IdentityError::ProviderFailure {
                kind: "k",
                status: Some(42)
            }
            .status(),
            Some(42)
        );
    }

    // --- §35 — platform-neutrality of the FULL capability --------------------

    /// A stand-in for a future `AndroidDeviceIdentityProvider`.
    ///
    /// It implements the whole production capability — `resolve`, `ensure_identity`,
    /// `public_identity`, `sign` — using ONLY platform-neutral types:
    /// no Windows backend, no provider name, no raw OS status, no Win32 handle. If this
    /// compiles, the shared contract genuinely carries no Windows dependency (§6 / §35).
    struct FakeProductionIdentityProvider {
        readiness: DeviceIdentityReadiness,
    }

    impl DeviceIdentityProvider for FakeProductionIdentityProvider {
        fn resolve(&self) -> DeviceIdentityReadiness {
            self.readiness
        }
    }

    impl DeviceIdentityCapability for FakeProductionIdentityProvider {
        fn ensure_identity(
            &self,
            _metadata_dir: &std::path::Path,
        ) -> Result<DevicePublicIdentity, IdentityError> {
            // Without a platform provider an identity simply cannot be established.
            Err(IdentityError::Unavailable {
                reason: IdentityAvailabilityError::NoBackendAvailable,
            })
        }

        fn public_identity(
            &self,
            _metadata_dir: &std::path::Path,
        ) -> Result<DevicePublicIdentity, IdentityError> {
            Err(IdentityError::NotProvisioned)
        }

        fn sign(
            &self,
            _metadata_dir: &std::path::Path,
            _message: &[u8],
        ) -> Result<DeviceSignature, IdentityError> {
            Err(IdentityError::NotProvisioned)
        }
    }

    /// §35 — compile-level proof that a non-Windows provider can implement the full
    /// capability, and that its answers are the shared, platform-neutral ones.
    #[test]
    fn future_non_windows_provider_implements_the_full_capability() {
        let provider = FakeProductionIdentityProvider {
            readiness: DeviceIdentityReadiness::Ready {
                security_level: IdentitySecurityLevel::HardwareBacked,
            },
        };
        assert!(provider.resolve().is_ready());

        let dir = std::path::Path::new("/tmp/never-used");
        match provider.ensure_identity(dir) {
            Err(IdentityError::Unavailable { reason }) => {
                assert_eq!(reason.kind(), "NO_BACKEND_AVAILABLE");
            }
            other => panic!("expected Unavailable, got {other:?}"),
        }
        assert_eq!(
            provider.public_identity(dir).expect_err("not provisioned").kind(),
            "NOT_PROVISIONED"
        );
        assert_eq!(
            provider.sign(dir, b"message").expect_err("not provisioned").kind(),
            "NOT_PROVISIONED"
        );
        // P7-S4R — no reset/rotate method exists on the V1 shared capability: the
        // destructive boundary is a frozen architecture semantic, not a fake API.
    }

    /// §4 — the shared security classification names a PROPERTY, never a platform: the
    /// two levels are the whole vocabulary an Android TEE / StrongBox backend needs.
    #[test]
    fn security_level_vocabulary_stays_property_based() {
        // The shared classification names a SECURITY PROPERTY, so its vocabulary is
        // exactly two property-shaped variants — an Android TEE / StrongBox backend maps
        // onto the same two without the shared layer ever learning a platform name (§4).
        assert_ne!(
            IdentitySecurityLevel::HardwareBacked,
            IdentitySecurityLevel::SoftwareIsolated
        );
        assert_eq!(
            format!("{:?}", IdentitySecurityLevel::HardwareBacked),
            "HardwareBacked"
        );
        assert_eq!(
            format!("{:?}", IdentitySecurityLevel::SoftwareIsolated),
            "SoftwareIsolated"
        );
        // The persisted (metadata) form is property-based as well.
        assert_eq!(
            serde_json::to_string(&IdentitySecurityLevel::HardwareBacked).expect("serialize"),
            "\"hardware_backed\""
        );
        assert_eq!(
            serde_json::to_string(&IdentitySecurityLevel::SoftwareIsolated).expect("serialize"),
            "\"software_isolated\""
        );
    }
}
