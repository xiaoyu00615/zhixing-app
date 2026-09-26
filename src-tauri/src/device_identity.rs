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
//! There is **no** `DeviceIdentityProvider`, no Trust Store, no pairing, no sync
//! tables, no networking, and **no IPC** (§8): nothing here is a `#[tauri::command]`
//! and no React/TS caller exists. A passing Gate A / Gate B proves ONLY that the
//! Windows CNG *foundation* is validated — never that "Device Identity is complete".
//!
//! # Platform boundary (§5)
//!
//! Every Win32 / CNG / TBS call lives behind `#[cfg(windows)]` in the two
//! submodules. The types in THIS file are the shared vocabulary and contain no
//! Win32 type, so neither the shared domain nor a future Android build gains a
//! Windows dependency from this module. On non-Windows the submodules simply do
//! not exist: nothing is emulated and nothing fails open.
//!
//! # Frozen architecture inherited by this slice (must not be changed here)
//!
//! - Preferred Windows backend: **Microsoft Platform Crypto Provider** (TPM-backed);
//!   fallback: **Microsoft Software Key Storage Provider**; if both are unavailable
//!   the answer is `UNAVAILABLE` / fail closed — never a silent raw-byte downgrade.
//! - The shared contract stays **operation-oriented**; `getPrivateKeyBytes()` (or any
//!   equivalent raw-private-key export entry point) must never appear in it.
//! - The identity **algorithm is NOT FROZEN**. `ECDSA P-256` appears in this slice
//!   strictly as a **TEST / CAPABILITY PROBE ONLY** value and must not be promoted to
//!   the final identity algorithm by anything written here.

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

/// Internal, structured error model for this slice.
///
/// Raw OS status codes are retained as `u32` (structured) and are never replaced by
/// a localized Windows error string (§31). Nothing here carries secret material.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IdentityBackendError {
    /// A CNG key-storage provider could not be opened.
    ProviderOpenFailed { provider: &'static str, status: u32 },
    /// `NCryptCreatePersistedKey` failed.
    KeyCreateFailed { status: u32 },
    /// A key property could not be written.
    PropertySetFailed { property: &'static str, status: u32 },
    /// The written export policy did not read back as written.
    ExportPolicyReadBackMismatch { expected: u32, actual: u32 },
    /// `NCryptFinalizeKey` failed.
    KeyFinalizeFailed { status: u32 },
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
}

impl IdentityBackendError {
    /// Stable, machine-readable token (same convention as `Issue.kind` in the startup
    /// pipeline: the variant name, never localized prose).
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::ProviderOpenFailed { .. } => "ProviderOpenFailed",
            Self::KeyCreateFailed { .. } => "KeyCreateFailed",
            Self::PropertySetFailed { .. } => "PropertySetFailed",
            Self::ExportPolicyReadBackMismatch { .. } => "ExportPolicyReadBackMismatch",
            Self::KeyFinalizeFailed { .. } => "KeyFinalizeFailed",
            Self::PublicExportFailed { .. } => "PublicExportFailed",
            Self::UnexpectedPrivateExportSuccess => "UnexpectedPrivateExportSuccess",
            Self::TpmNotFound => "TpmNotFound",
            Self::TpmProbeFailed { .. } => "TpmProbeFailed",
            Self::CleanupFailed { .. } => "CleanupFailed",
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
            | Self::PropertySetFailed { status, .. }
            | Self::KeyFinalizeFailed { status }
            | Self::PublicExportFailed { status }
            | Self::TpmProbeFailed { status }
            | Self::CleanupFailed { status, .. } => Some(*status),
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
// Windows-only implementation
// ---------------------------------------------------------------------------

#[cfg(windows)]
pub(crate) mod windows_cng;

#[cfg(windows)]
pub(crate) mod windows_tpm;

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
}
