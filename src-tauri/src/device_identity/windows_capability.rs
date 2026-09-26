//! P7-S2B / P7-S2BR — Windows Device Identity capability resolution (production adapter).
//!
//! This module is the **Windows adapter** for the shared, platform-neutral
//! [`DeviceIdentityProvider`] contract. It turns the already-validated P7-S2 probes into a
//! usable capability and performs ONLY read-only OS observation:
//!
//! - `probe_tpm()` (TBS) — is a TPM present?
//! - `inspect_platform_crypto_provider()` — does the TPM-backed provider open and report
//!   hardware backing?
//! - a Software KSP open probe — does the no-TPM fallback exist?
//!
//! It NEVER creates, finalizes, persists or deletes a key, and never touches a
//! `zhixing-test-cng-*` test key (those stay in `windows_cng.rs`, §17). The selection
//! rules below are the frozen architecture from P7-S2 — they are only *applied* here, not
//! changed (§38, DOC CHANGE REQUIRED: NO).
//!
//! # Platform boundary (§4–§7 / §18)
//!
//! The Windows-specific types ([`WindowsIdentityBackend`], [`WindowsIdentityCapability`])
//! live HERE, not in the shared file: they are diagnostics, reachable by Windows callers
//! through [`resolve_windows_identity_capability`], and are NEVER part of the shared
//! [`DeviceIdentityReadiness`]. The shared readiness carries only the platform-neutral
//! [`IdentitySecurityLevel`] / [`IdentityAvailabilityError`].
//!
//! # Fail-closed selection (§11–§13)
//!
//! - `ProbeFailed` ⇒ `Unavailable` — never a silent fallback.
//! - `NotFound` ⇒ `SoftwareCng` **only if** the Software KSP actually opens; else
//!   `Unavailable` (a no-TPM machine with no software KSP is genuinely unavailable).
//! - `Available` ⇒ `PlatformCng` **only if** the provider opens AND reports hardware
//!   backing; a measured TPM whose expected secure backend fails is `Unavailable`, never a
//!   quiet software downgrade (§12).

use super::windows_cng::open_provider;
use super::windows_tpm::{inspect_platform_crypto_provider, probe_tpm, PlatformProviderProbe};
use super::{
    DeviceIdentityProvider, DeviceIdentityReadiness, IdentityAvailabilityError,
    IdentitySecurityLevel, TpmProbeOutcome,
};
use windows_sys::Win32::Security::Cryptography::MS_KEY_STORAGE_PROVIDER;

/// Label for the Software KSP, used for reporting only.
pub(crate) const SOFTWARE_PROVIDER_LABEL: &str = "Microsoft Software Key Storage Provider";

/// Which Windows identity backend underpins the device identity.
///
/// WINDOWS-ONLY diagnostic (§5 / §7): deliberately contains NO Win32 handle and NO secret
/// bytes, but it is a Windows adapter detail — a future Android backend has its own backend
/// vocabulary and never references this type. It is NOT part of the shared
/// [`DeviceIdentityReadiness`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WindowsIdentityBackend {
    /// TPM-backed Microsoft Platform Crypto Provider.
    PlatformCng,
    /// Microsoft Software Key Storage Provider — the no-TPM fallback (NOT an error, §13).
    SoftwareCng,
}

impl WindowsIdentityBackend {
    pub(crate) fn kind(&self) -> &'static str {
        match self {
            Self::PlatformCng => "PLATFORM_CNG",
            Self::SoftwareCng => "SOFTWARE_CNG",
        }
    }
}

/// Windows-only diagnostic detail for a READY capability: which Windows backend was chosen,
/// plus the shared security level. Returned by [`resolve_windows_identity_capability`] to
/// Windows callers; never embedded in the shared [`DeviceIdentityReadiness`] (§7 / §18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsIdentityCapability {
    pub backend: WindowsIdentityBackend,
    pub security_level: IdentitySecurityLevel,
}

/// The Windows resolution result: the shared readiness PLUS the Windows-only diagnostic.
///
/// `readiness` is what the shared [`DeviceIdentityProvider`] contract exposes;
/// `capability` carries the Windows backend detail (present iff ready). This split is how a
/// Windows caller keeps full diagnostics while the shared layer stays platform-neutral
/// (§7 / §18).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsIdentityResolution {
    pub readiness: DeviceIdentityReadiness,
    pub capability: Option<WindowsIdentityCapability>,
}

impl WindowsIdentityResolution {
    /// A ready resolution for the given Windows backend.
    pub(crate) fn ready(
        backend: WindowsIdentityBackend,
        security_level: IdentitySecurityLevel,
    ) -> Self {
        Self {
            readiness: DeviceIdentityReadiness::Ready { security_level },
            capability: Some(WindowsIdentityCapability {
                backend,
                security_level,
            }),
        }
    }

    /// An unavailable resolution with the given platform-neutral reason.
    pub(crate) fn unavailable(reason: IdentityAvailabilityError) -> Self {
        Self {
            readiness: DeviceIdentityReadiness::Unavailable { reason },
            capability: None,
        }
    }
}

/// Windows implementation of [`DeviceIdentityProvider`].
///
/// A zero-state marker: resolution is stateless and read-only. Kept in the Windows adapter
/// (not the shared file) so the shared contract carries no Windows-named type (§5).
pub(crate) struct WindowsDeviceIdentityProvider;

/// Read-only open probe of the Microsoft Software Key Storage Provider.
#[derive(Debug, Clone, Copy)]
pub(crate) struct SoftwareProviderProbe {
    /// `true` iff the provider handle was obtained.
    pub opened: bool,
    /// Raw `SECURITY_STATUS` of the open attempt (structured diagnostics, §25).
    pub open_status: u32,
}

/// Opens the Software KSP and reports whether it succeeded. No key is created (§13).
fn inspect_software_key_storage_provider() -> SoftwareProviderProbe {
    match open_provider(MS_KEY_STORAGE_PROVIDER, SOFTWARE_PROVIDER_LABEL) {
        Ok(_) => SoftwareProviderProbe {
            opened: true,
            open_status: 0,
        },
        Err(error) => SoftwareProviderProbe {
            opened: false,
            // `open_provider` only fails with `ProviderOpenFailed` here; keep its status.
            open_status: error.status().unwrap_or(0),
        },
    }
}

/// Pure resolution: maps already-measured OS observations to a Windows resolution.
///
/// "What the OS said" is deliberately separated from "what the architecture decides" so
/// this function is deterministic and testable on ANY machine — including one that must
/// not have its TPM disabled (§27). The fail-closed rules from §11–§13 are encoded here, and
/// the Windows adapter error is mapped onto the platform-neutral
/// [`IdentityAvailabilityError`] (§10) before it reaches the shared readiness.
pub(crate) fn resolve_capability_from_observations(
    tpm: TpmProbeOutcome,
    platform: PlatformProviderProbe,
    software: SoftwareProviderProbe,
) -> WindowsIdentityResolution {
    match tpm {
        TpmProbeOutcome::ProbeFailed { .. } => {
            // "Could not measure" is NOT "no TPM" (§23).
            WindowsIdentityResolution::unavailable(IdentityAvailabilityError::ProbeFailed)
        }
        TpmProbeOutcome::NotFound => {
            if software.opened {
                WindowsIdentityResolution::ready(
                    WindowsIdentityBackend::SoftwareCng,
                    // A software KSP is never hardware-protected (§23).
                    IdentitySecurityLevel::SoftwareIsolated,
                )
            } else {
                WindowsIdentityResolution::unavailable(
                    IdentityAvailabilityError::NoBackendAvailable,
                )
            }
        }
        TpmProbeOutcome::Available { .. } => {
            if !platform.opened {
                // TPM reported, but its expected secure backend could not be opened. This is
                // an anomaly, NOT a reason to use the software KSP (§12).
                WindowsIdentityResolution::unavailable(
                    IdentityAvailabilityError::NoBackendAvailable,
                )
            } else if !platform.hardware_backed() {
                // Opened but the hardware-backed implementation-type query failed or returned
                // no hardware flag — the claimed security level cannot be trusted.
                WindowsIdentityResolution::unavailable(
                    IdentityAvailabilityError::SecurityLevelUnverified,
                )
            } else {
                WindowsIdentityResolution::ready(
                    WindowsIdentityBackend::PlatformCng,
                    IdentitySecurityLevel::HardwareBacked,
                )
            }
        }
    }
}

/// The production device-identity capability resolver for Windows.
///
/// Performs the real OS observations and delegates the architecture decision to the pure
/// [`resolve_capability_from_observations`]. NEVER creates a key or writes anything (§26).
/// Windows callers get full diagnostics via the returned [`WindowsIdentityResolution`];
/// the shared trait only consumes `.readiness`.
pub(crate) fn resolve_windows_identity_capability() -> WindowsIdentityResolution {
    let tpm = probe_tpm();
    let platform = inspect_platform_crypto_provider();
    let software = inspect_software_key_storage_provider();
    resolve_capability_from_observations(tpm, platform, software)
}

impl DeviceIdentityProvider for WindowsDeviceIdentityProvider {
    fn resolve(&self) -> DeviceIdentityReadiness {
        resolve_windows_identity_capability().readiness
    }
}

#[cfg(test)]
mod tests {
    use super::super::windows_cng::keystore_lock;
    use super::super::TpmVersionReport;
    use super::*;
    use windows_sys::Win32::Security::Cryptography::NCRYPT_IMPL_HARDWARE_FLAG;

    /// A `PlatformProviderProbe` that is open and reports hardware backing.
    fn platform_opened_hardware() -> PlatformProviderProbe {
        PlatformProviderProbe {
            opened: true,
            open_status: 0,
            impl_type: Some(NCRYPT_IMPL_HARDWARE_FLAG),
            impl_type_status: 0,
        }
    }

    /// `ProbeFailed` ⇒ `Unavailable` (never a silent software fallback, §23).
    #[test]
    fn pure_probe_failed_is_unavailable_not_fallback() {
        let resolution = resolve_capability_from_observations(
            TpmProbeOutcome::ProbeFailed {
                status: 0x8028_4001,
            },
            platform_opened_hardware(),
            SoftwareProviderProbe {
                opened: true,
                open_status: 0,
            },
        );
        match resolution.readiness {
            DeviceIdentityReadiness::Unavailable { reason } => {
                assert_eq!(reason, IdentityAvailabilityError::ProbeFailed);
                assert_eq!(reason.kind(), "PROBE_FAILED");
            }
            other => panic!("probe failure must be Unavailable, got {other:?}"),
        }
        assert_eq!(resolution.capability, None);
    }

    /// `NotFound` + Software KSP opens ⇒ `Ready{SoftwareIsolated}` + Windows detail
    /// `SoftwareCng` (§13 / §23).
    #[test]
    fn pure_not_found_with_software_open_is_software_isolated() {
        let resolution = resolve_capability_from_observations(
            TpmProbeOutcome::NotFound,
            platform_opened_hardware(),
            SoftwareProviderProbe {
                opened: true,
                open_status: 0,
            },
        );
        assert_eq!(
            resolution.readiness,
            DeviceIdentityReadiness::Ready {
                security_level: IdentitySecurityLevel::SoftwareIsolated
            }
        );
        let cap = resolution
            .capability
            .expect("a Ready resolution must carry Windows diagnostics");
        assert_eq!(cap.backend, WindowsIdentityBackend::SoftwareCng);
        assert_eq!(cap.security_level, IdentitySecurityLevel::SoftwareIsolated);
    }

    /// `NotFound` + Software KSP cannot open ⇒ `Unavailable(NoBackendAvailable)` — genuinely
    /// unavailable, not silently "ready" (§13).
    #[test]
    fn pure_not_found_without_software_is_unavailable() {
        let resolution = resolve_capability_from_observations(
            TpmProbeOutcome::NotFound,
            platform_opened_hardware(),
            SoftwareProviderProbe {
                opened: false,
                open_status: 0x8009_0000,
            },
        );
        match resolution.readiness {
            DeviceIdentityReadiness::Unavailable { reason } => {
                assert_eq!(reason, IdentityAvailabilityError::NoBackendAvailable);
            }
            other => panic!("no-TPM without software KSP must be Unavailable, got {other:?}"),
        }
        assert_eq!(resolution.capability, None);
    }

    /// `Available` + Platform provider cannot open ⇒ `Unavailable`, NEVER a silent software
    /// fallback (§12 — the core rule this slice must enforce).
    #[test]
    fn pure_available_but_platform_unopened_is_unavailable() {
        let resolution = resolve_capability_from_observations(
            TpmProbeOutcome::Available {
                tpm_version: TpmVersionReport::V2_0,
                interface_type: 3,
            },
            PlatformProviderProbe {
                opened: false,
                open_status: 0x8009_0000,
                impl_type: None,
                impl_type_status: 0,
            },
            SoftwareProviderProbe {
                opened: true,
                open_status: 0,
            },
        );
        match resolution.readiness {
            DeviceIdentityReadiness::Unavailable { reason } => {
                assert_eq!(reason, IdentityAvailabilityError::NoBackendAvailable);
            }
            other => panic!(
                "TPM present but platform provider unopened must NOT silently fall back, got {other:?}"
            ),
        }
        assert_eq!(resolution.capability, None);
    }

    /// `Available` + Platform provider open + hardware ⇒ `Ready{HardwareBacked}` + Windows
    /// detail `PlatformCng`.
    #[test]
    fn pure_available_platform_hardware_is_hardware_backed() {
        let resolution = resolve_capability_from_observations(
            TpmProbeOutcome::Available {
                tpm_version: TpmVersionReport::V2_0,
                interface_type: 3,
            },
            platform_opened_hardware(),
            SoftwareProviderProbe {
                opened: true,
                open_status: 0,
            },
        );
        assert_eq!(
            resolution.readiness,
            DeviceIdentityReadiness::Ready {
                security_level: IdentitySecurityLevel::HardwareBacked
            }
        );
        let cap = resolution
            .capability
            .expect("a Ready resolution must carry Windows diagnostics");
        assert_eq!(cap.backend, WindowsIdentityBackend::PlatformCng);
        assert_eq!(cap.security_level, IdentitySecurityLevel::HardwareBacked);
    }

    /// `Available` + Platform provider open + NOT hardware ⇒
    /// `Unavailable(SecurityLevelUnverified)`, because the claimed security level cannot be
    /// trusted (§22).
    #[test]
    fn pure_available_platform_opened_but_not_hardware_is_unavailable() {
        let resolution = resolve_capability_from_observations(
            TpmProbeOutcome::Available {
                tpm_version: TpmVersionReport::V2_0,
                interface_type: 3,
            },
            PlatformProviderProbe {
                opened: true,
                open_status: 0,
                // Bit 0 with no hardware flag → not hardware-backed.
                impl_type: Some(0),
                impl_type_status: 0,
            },
            SoftwareProviderProbe {
                opened: true,
                open_status: 0,
            },
        );
        match resolution.readiness {
            DeviceIdentityReadiness::Unavailable { reason } => {
                assert_eq!(reason, IdentityAvailabilityError::SecurityLevelUnverified);
            }
            other => panic!(
                "TPM present but platform not hardware-backed must be Unavailable, got {other:?}"
            ),
        }
        assert_eq!(resolution.capability, None);
    }

    /// §18 — Windows diagnostics stay available OUTSIDE the shared readiness: the shared
    /// `DeviceIdentityReadiness` exposes only the platform-neutral security level, while the
    /// Windows backend detail is reached through the Windows-specific `capability` field.
    #[test]
    fn windows_diagnostics_remain_accessible_outside_shared_readiness() {
        let ready = WindowsIdentityResolution::ready(
            WindowsIdentityBackend::PlatformCng,
            IdentitySecurityLevel::HardwareBacked,
        );
        // Shared readiness exposes ONLY the platform-neutral level (§6) …
        assert!(ready.readiness.is_ready());
        assert_eq!(
            ready.readiness.security_level(),
            Some(IdentitySecurityLevel::HardwareBacked)
        );
        // … while the Windows backend detail comes from the Windows-specific field (§18).
        assert_eq!(
            ready.capability.map(|c| c.backend),
            Some(WindowsIdentityBackend::PlatformCng)
        );

        let unavailable =
            WindowsIdentityResolution::unavailable(IdentityAvailabilityError::NoBackendAvailable);
        assert!(!unavailable.readiness.is_ready());
        assert_eq!(unavailable.readiness.security_level(), None);
        assert_eq!(unavailable.capability, None);
    }

    /// §28 / §29 — run the REAL resolver on this machine and verify the result is internally
    /// consistent (the test hardens, it does not assume a TPM).
    ///
    /// - `Ready(PlatformCng)` ⇒ MUST report `HardwareBacked` (§22).
    /// - `Ready(SoftwareCng)` ⇒ MUST report `SoftwareIsolated`, never `HardwareBacked` (§23).
    /// - `Unavailable` ⇒ this is a genuine capability failure on the dev machine and the
    ///   test FAILS loudly (ProbeFailed / platform anomaly / software-KSP-unopenable are all
    ///   real "capability unavailable" outcomes, §29). A no-TPM machine where the Software
    ///   KSP opens is a legitimate `Ready(SoftwareCng)` pass.
    ///
    /// §30 — the resolution must leave no `zhixing-test-cng-*` key behind. It only opens
    /// providers and reads a property, but prove it with a namespace sweep under the shared
    /// keystore lock so it never races a concurrent key test.
    #[test]
    fn resolve_windows_identity_capability_is_observational_and_correct() {
        let _guard = keystore_lock();
        let resolution = resolve_windows_identity_capability();

        match resolution.readiness {
            DeviceIdentityReadiness::Ready { security_level } => {
                let cap = resolution
                    .capability
                    .expect("a Ready resolution must carry Windows diagnostics");
                match cap.backend {
                    WindowsIdentityBackend::PlatformCng => {
                        assert_eq!(
                            security_level,
                            IdentitySecurityLevel::HardwareBacked,
                            "a PlatformCng backend must report HardwareBacked (§22)"
                        );
                    }
                    WindowsIdentityBackend::SoftwareCng => {
                        assert_eq!(
                            security_level,
                            IdentitySecurityLevel::SoftwareIsolated,
                            "a SoftwareCng backend must report SoftwareIsolated, never HardwareBacked (§23)"
                        );
                    }
                }
                eprintln!(
                    "CAPABILITY ready: backend={} security_level={:?}",
                    cap.backend.kind(),
                    cap.security_level
                );
            }
            DeviceIdentityReadiness::Unavailable { reason } => {
                // A genuinely unavailable capability is a FAIL here (§29).
                panic!(
                    "DEVICE IDENTITY CAPABILITY UNAVAILABLE ({}) — this is a fail, not a pass: \
                     ProbeFailed / platform anomaly / software-KSP-unopenable are all real \
                     capability failures (§29)",
                    reason.kind()
                );
            }
        }

        // §30 — prove no production/validation key leaked into the test namespace.
        let leftovers = count_test_namespace_keys_in_software_ksp();
        assert_eq!(
            leftovers, 0,
            "resolve_windows_identity_capability must not create any zhixing-test-cng-* key: found {leftovers}"
        );
    }

    /// Enumerates the Software KSP's current-user keys and returns how many live in the
    /// dedicated `zhixing-test-cng-*` namespace. Test-only proof of "no side effects" (§30).
    fn count_test_namespace_keys_in_software_ksp() -> usize {
        use windows_sys::Win32::Security::Cryptography::{
            NCryptEnumKeys, NCryptFreeBuffer, NCryptKeyName, NCRYPT_PROV_HANDLE,
        };

        let provider = match open_provider(MS_KEY_STORAGE_PROVIDER, SOFTWARE_PROVIDER_LABEL) {
            Ok(provider) => provider,
            // If we cannot even open the provider, the resolution would already have been
            // Unavailable; there is nothing to sweep.
            Err(_) => return 0,
        };
        let handle: NCRYPT_PROV_HANDLE = provider.raw();

        let mut count = 0usize;
        let mut state: *mut std::ffi::c_void = std::ptr::null_mut();
        // The loop can only end through the `break` below, so the terminating status is
        // always produced by the iteration that stops the enumeration.
        let _final_status: u32 = loop {
            let mut entry: *mut NCryptKeyName = std::ptr::null_mut();
            // SAFETY: `handle` is live; a NULL scope means "current user"; out-params are
            // valid; the enumeration state is threaded through `state` as the API requires.
            let status =
                unsafe { NCryptEnumKeys(handle, std::ptr::null(), &mut entry, &mut state, 0) };
            if status != 0 {
                break status as u32;
            }
            if !entry.is_null() {
                // SAFETY: on success the provider handed back a live `NCryptKeyName`.
                let name = unsafe {
                    let p = (*entry).pszName;
                    if p.is_null() {
                        String::new()
                    } else {
                        let mut len = 0usize;
                        while *p.add(len) != 0 {
                            len += 1;
                        }
                        String::from_utf16_lossy(std::slice::from_raw_parts(p, len))
                    }
                };
                if name.starts_with("zhixing-test-cng-") {
                    count += 1;
                }
                // SAFETY: the entry was allocated by the provider for this call and is freed
                // exactly once, immediately after its contents are copied out.
                unsafe {
                    NCryptFreeBuffer(entry as *mut std::ffi::c_void);
                }
            }
        };
        if !state.is_null() {
            // SAFETY: the enumeration state was allocated by the provider across the loop and
            // is freed exactly once, after the loop has ended.
            unsafe {
                NCryptFreeBuffer(state);
            }
        }
        count
    }
}
