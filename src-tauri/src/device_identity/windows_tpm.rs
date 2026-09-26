//! Gate B — Windows TPM capability probe and Software-KSP fallback selection (P7-S2).
//!
//! The question this module answers: **how is TPM capability reliably detected on
//! Windows, and how does the code reach the Software KSP path when there is no TPM?**
//!
//! # Why the probe uses TBS, not "try to open the TPM provider" (§19)
//!
//! `Tbsi_GetDeviceInfo` has documented, distinguishable results — `TBS_SUCCESS` and
//! `TBS_E_TPM_NOT_FOUND` — so "there is no TPM" can be told apart from "the probe
//! failed". The failure code of `NCryptOpenStorageProvider(MS_PLATFORM_CRYPTO_PROVIDER)`
//! has no such documented guarantee, so it is NOT used as the TPM detector here. It is
//! only used *after* a positive TBS result, as a read-only capability check.
//!
//! # Three outcomes that must stay distinguishable (§20 / §23)
//!
//! | observation | outcome | selection |
//! |---|---|---|
//! | `TBS_SUCCESS` | `Available` | `PlatformCng` candidate |
//! | `TBS_E_TPM_NOT_FOUND` | `NotFound` (a condition, not an error) | `SoftwareCng` |
//! | anything else | `ProbeFailed` (raw status preserved) | `Error` — never a silent fallback |
//!
//! # Read-only by construction (§27)
//!
//! Nothing in this file creates, finalizes, persists or deletes a key. The Platform
//! Crypto Provider is only *opened and inspected*.

use super::windows_cng::{open_provider, CNG_SUCCESS};
use super::{TpmProbeOutcome, TpmVersionReport};

use windows_sys::Win32::Foundation::TBS_E_TPM_NOT_FOUND;
use windows_sys::Win32::Security::Cryptography::{
    NCryptGetProperty, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_IMPL_HARDWARE_FLAG,
    NCRYPT_IMPL_TYPE_PROPERTY, NCRYPT_PROV_HANDLE,
};
use windows_sys::Win32::System::TpmBaseServices::{
    Tbsi_GetDeviceInfo, TPM_DEVICE_INFO, TPM_VERSION_12, TPM_VERSION_20,
};

/// Label for the TPM-backed provider, used for reporting only.
pub(crate) const PLATFORM_PROVIDER_LABEL: &str = "Microsoft Platform Crypto Provider";

/// `TBS_SUCCESS`, the documented "a device was found" result.
const TBS_RESULT_SUCCESS: u32 = 0;

/// Maps the raw `tpmVersion` field to the documented generations. Kept total on purpose:
/// an unrecognised value is reported as [`TpmVersionReport::Unknown`] rather than being
/// guessed or dropped.
fn map_tpm_version(raw: u32) -> TpmVersionReport {
    match raw {
        TPM_VERSION_12 => TpmVersionReport::V1_2,
        TPM_VERSION_20 => TpmVersionReport::V2_0,
        _ => TpmVersionReport::Unknown,
    }
}

/// Classifies a raw `TBS_RESULT` into one of the three distinguishable outcomes (§20).
///
/// Deliberately separated from the FFI call so the classification is testable without a
/// TPM, and without ever touching the machine's real TPM state (§26).
///
/// `device_info` is the filled-in structure, and is only consulted on success.
pub(crate) fn classify_tbs_result(
    status: u32,
    device_info: Option<&TPM_DEVICE_INFO>,
) -> TpmProbeOutcome {
    if status == TBS_RESULT_SUCCESS {
        let info = match device_info {
            Some(info) => info,
            // Success without a structure cannot happen through `probe_tpm`; treating it
            // as a probe failure keeps the function total and honest instead of inventing
            // a version.
            None => return TpmProbeOutcome::ProbeFailed { status },
        };
        return TpmProbeOutcome::Available {
            tpm_version: map_tpm_version(info.tpmVersion),
            interface_type: info.tpmInterfaceType,
        };
    }
    if status == TBS_E_TPM_NOT_FOUND as u32 {
        // §22 — "no TPM" is a CONDITION, not a fatal application error: the architecture
        // already allows the Software KSP fallback, and this is precisely the observable
        // that selects it. The raw error is deliberately NOT reinterpreted as anything
        // broader, and no other status is allowed to land here (§23).
        return TpmProbeOutcome::NotFound;
    }
    TpmProbeOutcome::ProbeFailed { status }
}

/// The real platform TPM probe.
pub(crate) fn probe_tpm() -> TpmProbeOutcome {
    let mut info = TPM_DEVICE_INFO::default();
    // SAFETY: `info` is a live, correctly aligned `TPM_DEVICE_INFO`, and the size passed
    // in matches its type exactly. `Tbsi_GetDeviceInfo` requires no TBS context, and the
    // call only writes into `info`.
    let status = unsafe {
        Tbsi_GetDeviceInfo(
            std::mem::size_of::<TPM_DEVICE_INFO>() as u32,
            &mut info as *mut TPM_DEVICE_INFO as *mut std::ffi::c_void,
        )
    };
    classify_tbs_result(status, Some(&info))
}

/// Read-only inspection of the TPM-backed provider.
///
/// §27 — this opens the provider and reads a property. It never creates, finalizes or
/// persists a key, so nothing is left behind in the key store.
#[derive(Debug, Clone, Copy)]
pub(crate) struct PlatformProviderProbe {
    pub opened: bool,
    pub open_status: u32,
    /// `NCRYPT_IMPL_TYPE_PROPERTY` flags, when the query succeeded.
    pub impl_type: Option<u32>,
    pub impl_type_status: u32,
}

impl PlatformProviderProbe {
    /// True when the provider reports hardware-backed implementation
    /// (`NCRYPT_IMPL_HARDWARE_FLAG`). This is the Windows counterpart of Android's
    /// `getSecurityLevel()` and is reported as evidence, never as a decision the frozen
    /// architecture would let this slice make on its own.
    pub(crate) fn hardware_backed(&self) -> bool {
        matches!(self.impl_type, Some(value) if value & NCRYPT_IMPL_HARDWARE_FLAG != 0)
    }
}

/// Opens the Platform Crypto Provider read-only and reports what it says about itself.
pub(crate) fn inspect_platform_crypto_provider() -> PlatformProviderProbe {
    let provider = match open_provider(MS_PLATFORM_CRYPTO_PROVIDER, PLATFORM_PROVIDER_LABEL) {
        Ok(provider) => provider,
        Err(error) => {
            // A failed open is reported as a status, never as a decision: §19 forbids
            // using this failure as the TPM detector.
            return PlatformProviderProbe {
                opened: false,
                open_status: error.status().unwrap_or(0),
                impl_type: None,
                impl_type_status: 0,
            };
        }
    };

    let mut value: u32 = 0;
    let mut written: u32 = 0;
    let handle: NCRYPT_PROV_HANDLE = provider.raw();
    // SAFETY: the provider handle is live (owned by `provider` for the rest of this
    // function), `value` is a live 4-byte buffer whose exact size is passed in, and the
    // property is documented as a DWORD.
    let status = unsafe {
        NCryptGetProperty(
            handle,
            NCRYPT_IMPL_TYPE_PROPERTY,
            &mut value as *mut u32 as *mut u8,
            std::mem::size_of::<u32>() as u32,
            &mut written,
            0,
        )
    };
    let query_ok = status == CNG_SUCCESS && written == std::mem::size_of::<u32>() as u32;
    PlatformProviderProbe {
        opened: true,
        open_status: CNG_SUCCESS as u32,
        impl_type: if query_ok { Some(value) } else { None },
        impl_type_status: if query_ok { 0 } else { status as u32 },
    }
}

#[cfg(test)]
mod tests {
    use super::super::{select_identity_backend, IdentityBackendSelection};
    use super::*;

    /// §20 / §22 / §23 — the classification keeps the three answers apart, and preserves
    /// the raw status of an unexpected failure.
    #[test]
    fn tbs_result_classification_is_total_and_preserves_raw_status() {
        let available = classify_tbs_result(
            TBS_RESULT_SUCCESS,
            Some(&TPM_DEVICE_INFO {
                structVersion: 1,
                tpmVersion: TPM_VERSION_20,
                tpmInterfaceType: 3, // TPM_IFTYPE_HW
                tpmImpRevision: 0,
            }),
        );
        assert_eq!(
            available,
            TpmProbeOutcome::Available {
                tpm_version: TpmVersionReport::V2_0,
                interface_type: 3,
            }
        );

        assert_eq!(
            classify_tbs_result(TBS_E_TPM_NOT_FOUND as u32, None),
            TpmProbeOutcome::NotFound
        );

        // 0x80284001 == TBS_E_INTERNAL_ERROR: an unexpected failure must keep its code.
        let failed = classify_tbs_result(0x8028_4001, None);
        assert_eq!(
            failed,
            TpmProbeOutcome::ProbeFailed {
                status: 0x8028_4001
            }
        );

        // A success with no structure must not invent a TPM version.
        assert_eq!(
            classify_tbs_result(TBS_RESULT_SUCCESS, None),
            TpmProbeOutcome::ProbeFailed {
                status: TBS_RESULT_SUCCESS
            }
        );
    }

    /// §26 — the no-TPM path is exercised WITHOUT touching the machine's real TPM state:
    /// the documented `TBS_E_TPM_NOT_FOUND` value is fed through the same classification
    /// the real probe uses, and the resulting selection must be the Software KSP path —
    /// not an error, and not "TPM present".
    #[test]
    fn constructed_tpm_not_found_selects_the_software_path() {
        let outcome = classify_tbs_result(TBS_E_TPM_NOT_FOUND as u32, None);
        assert_eq!(outcome, TpmProbeOutcome::NotFound);

        let selection = select_identity_backend(&outcome);
        assert_eq!(selection, IdentityBackendSelection::SoftwareCng);
        assert!(
            !matches!(selection, IdentityBackendSelection::Error(_)),
            "a missing TPM is a condition, not a failure (§22)"
        );
    }

    /// §25 — run a REAL probe on this machine and report it as environment evidence.
    ///
    /// The assertion is deliberately about the probe being *observable and classified*,
    /// not about this machine having a TPM: a machine with no TPM is a perfectly valid
    /// environment for Gate B, and reporting `NotFound` here would then be a pass, not a
    /// failure.
    /// §25 / §14-§17 — run a REAL probe on this machine and HARDEN the assertions.
    ///
    /// - `Available` ⇒ the TPM-backed Platform Crypto Provider MUST open, its impl-type
    ///   query MUST succeed, and it MUST report hardware backing (§15). A bare `eprintln`
    ///   is not enough: a missing hardware flag is a capability failure, not a pass.
    /// - `NotFound` ⇒ a valid environment; the selection must be `SoftwareCng` (§16).
    /// - `ProbeFailed` ⇒ capability validation could NOT be measured. This MUST NOT count
    ///   as a pass (§17): "could not measure" is not "no TPM". Fail loudly, preserving the
    ///   raw status.
    #[test]
    fn real_machine_probe_is_classified_and_reported() {
        let outcome = probe_tpm();
        let selection = select_identity_backend(&outcome);
        match outcome {
            TpmProbeOutcome::Available { .. } => {
                eprintln!("GATE_B tbs_result=TBS_SUCCESS — verifying platform provider");
                let probe = inspect_platform_crypto_provider();
                // §15 — when a TPM is reported, the TPM-backed provider MUST be openable and
                // MUST report hardware backing; otherwise capability validation fails.
                assert!(
                    probe.opened,
                    "TPM available but Platform Crypto Provider did not open: {probe:?}"
                );
                assert_eq!(
                    probe.open_status, 0,
                    "platform provider open status must be success: {probe:?}"
                );
                assert!(
                    probe.impl_type.is_some(),
                    "impl_type query must succeed once the provider opened: {probe:?}"
                );
                assert!(
                    probe.hardware_backed(),
                    "the platform provider must report hardware backing: {probe:?}"
                );
                eprintln!("GATE_B provider={PLATFORM_PROVIDER_LABEL} {:?}", probe);
                assert_eq!(selection, IdentityBackendSelection::PlatformCng);
            }
            TpmProbeOutcome::NotFound => {
                eprintln!(
                    "GATE_B tbs_result=TBS_E_TPM_NOT_FOUND (0x{:08X}) — software fallback path",
                    TBS_E_TPM_NOT_FOUND as u32
                );
                assert_eq!(selection, IdentityBackendSelection::SoftwareCng);
            }
            TpmProbeOutcome::ProbeFailed { status } => {
                // §17 — capability validation could not be measured. This is NOT a pass:
                // the raw status is preserved and the test fails loudly.
                panic!(
                    "GATE_B capability validation could NOT be measured (probe failed 0x{status:08X}). \
                     This is not a pass — 'could not measure' != 'no TPM'."
                );
            }
        }
    }

    /// §27 — inspecting the TPM-backed provider must be read-only. The observable
    /// invariant available to a test is that the probe is internally consistent: the
    /// provider either opened (and then the implementation-type query has a defined
    /// answer) or it did not (and then no property was read).
    #[test]
    fn platform_provider_inspection_is_read_only_and_consistent() {
        let probe = inspect_platform_crypto_provider();
        if probe.opened {
            assert_eq!(probe.open_status, 0);
            assert_eq!(probe.impl_type.is_some(), probe.impl_type_status == 0);
        } else {
            assert_ne!(probe.open_status, 0, "a failed open must carry its status");
            assert!(probe.impl_type.is_none());
        }
    }
}
