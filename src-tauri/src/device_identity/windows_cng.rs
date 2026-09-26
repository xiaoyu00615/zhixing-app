//! Gate A — Windows CNG private-export / public-export validation (P7-S2).
//!
//! The single question this module answers: **with the private-export policy set to
//! "no export", can the PUBLIC key blob still be read?** If yes, the frozen
//! "operation-oriented, provider-managed, non-exportable identity key" direction is
//! implementable on Windows CNG. If no, the architecture has to be revisited before
//! any of Phase 7 is built on it.
//!
//! # Scope discipline
//!
//! - Gate A targets the **Microsoft Software Key Storage Provider**, NOT the TPM
//!   provider, so the result does not depend on whether the machine under test has a
//!   TPM (§9).
//! - The probe key is a **temporary test key** in a dedicated namespace; it is never a
//!   production Device Identity and is always deleted (§16 / §17 / §27).
//! - `ECDSA P-256` is used here as a **TEST / CAPABILITY PROBE ONLY** value (§10). It
//!   is NOT the frozen identity algorithm.
//! - The private-export negative test never materializes private bytes: it queries the
//!   export and reads **only the status code** (§15). Private material is never
//!   allocated, printed, logged or returned by any function in this file.

use super::IdentityBackendError;
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Foundation::NTE_BAD_KEYSET;
use windows_sys::Win32::Security::Cryptography::{
    NCryptCreatePersistedKey, NCryptDeleteKey, NCryptExportKey, NCryptFinalizeKey,
    NCryptFreeObject, NCryptGetProperty, NCryptOpenKey, NCryptOpenStorageProvider,
    NCryptSetProperty, BCRYPT_ECCPRIVATE_BLOB, BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDSA_P256_ALGORITHM,
    MS_KEY_STORAGE_PROVIDER, NCRYPT_EXPORT_POLICY_PROPERTY, NCRYPT_KEY_HANDLE, NCRYPT_PROV_HANDLE,
};

/// CNG success (`SECURITY_STATUS == 0`). Every `NCrypt*` call returns an `HRESULT`;
/// only `0` is success.
pub(crate) const CNG_SUCCESS: i32 = 0;

/// `NCRYPT_EXPORT_POLICY_PROPERTY` is a DWORD. `0` means "no export is permitted"
/// (§12) — the policy is set EXPLICITLY so no provider default is ever used as proof.
const EXPORT_POLICY_DISABLED: u32 = 0;

/// Display name of the probe algorithm. **TEST / CAPABILITY PROBE ONLY** (§10).
pub(crate) const PROBE_ALGORITHM_LABEL: &str = "ECDSA_P256";

/// §16 — every real CNG key this slice creates lives in a dedicated test namespace, so
/// it can never collide with a future production identity key name.
const TEST_KEY_PREFIX: &str = "zhixing-test-cng-";

/// Provider Gate A targets: the documented **fallback** backend, chosen here so the
/// Gate A result is independent of the machine's TPM state (§9).
const PROVIDER_LABEL: &str = "Microsoft Software Key Storage Provider";
const PROVIDER_NAME: PCWSTR = MS_KEY_STORAGE_PROVIDER;

/// §15 — the only facts this module is allowed to report are provider names, status
/// codes, blob sizes and capability verdicts. No secret, no seed, no private bytes.
#[derive(Debug)]
pub(crate) struct GateAReport {
    /// Provider under test. Gate A deliberately uses the Software KSP (§9).
    pub provider_name: &'static str,
    /// `ECDSA_P256` — TEST / CAPABILITY PROBE ONLY (§10), never the frozen algorithm.
    pub probe_algorithm: &'static str,
    /// Identifier of the temporary test key, so a human can clean up by hand if the
    /// deletion ever fails (§17).
    pub key_name: String,

    // --- observations ---
    pub provider_opened: bool,
    pub key_created: bool,
    pub export_policy_disabled: bool,
    /// Read-back of `NCRYPT_EXPORT_POLICY_PROPERTY` after it was written.
    pub export_policy_readback: Option<u32>,
    pub finalized: bool,
    /// Size in bytes of the exported PUBLIC blob (0 = not exported).
    pub public_export_bytes: u32,
    pub private_export_attempted: bool,
    /// Raw `SECURITY_STATUS` of the private-export attempt (diagnostics only — §12
    /// forbids hard-coding one specific error code as the only legal answer).
    pub private_export_status: u32,
    pub private_export_succeeded: bool,
    /// Raw `SECURITY_STATUS` of `NCryptDeleteKey`, when a key existed.
    pub cleanup_status: Option<u32>,
    /// Independent, black-box proof that the key is gone: re-opening it by name fails.
    /// A status code alone is not proof of absence (§17).
    pub cleanup_verified_absent: bool,
    /// Raw `SECURITY_STATUS` of the `NCryptFreeObject` that released the still-owned key
    /// handle AFTER a `NCryptDeleteKey` failure (§4). `None` when deletion succeeded (no
    /// extra free needed, none performed). Retained so a delete-failure's handle-release
    /// step is observable and never silently swallowed.
    pub cleanup_release_status: Option<u32>,
    pub first_error: Option<IdentityBackendError>,
}

impl GateAReport {
    fn initial(key_name: String) -> Self {
        Self {
            provider_name: PROVIDER_LABEL,
            probe_algorithm: PROBE_ALGORITHM_LABEL,
            key_name,
            provider_opened: false,
            key_created: false,
            export_policy_disabled: false,
            export_policy_readback: None,
            finalized: false,
            public_export_bytes: 0,
            private_export_attempted: false,
            private_export_status: 0,
            private_export_succeeded: false,
            cleanup_status: None,
            cleanup_verified_absent: false,
            cleanup_release_status: None,
            first_error: None,
        }
    }

    /// §17 — cleanup is a HARD requirement, but only for a key that was actually
    /// created: if the run never got that far there is nothing to delete, and the
    /// cleanup obligation is trivially satisfied.
    pub(crate) fn cleanup_ok(&self) -> bool {
        if !self.key_created {
            return true;
        }
        self.cleanup_status == Some(CNG_SUCCESS as u32) && self.cleanup_verified_absent
    }

    /// Gate A passes only if ALL of the following hold:
    ///
    /// 1. no step reported an error;
    /// 2. the export policy was explicitly disabled AND read back as disabled;
    /// 3. the PUBLIC blob exported successfully with a non-zero length (§13);
    /// 4. the PRIVATE blob export did NOT succeed (§14) — this is the core claim;
    /// 5. the temporary test key was deleted, proven by absence (§17).
    pub(crate) fn pass(&self) -> bool {
        self.first_error.is_none()
            && self.provider_opened
            && self.key_created
            && self.finalized
            && self.export_policy_disabled
            && self.export_policy_readback == Some(EXPORT_POLICY_DISABLED)
            && self.public_export_bytes > 0
            && self.private_export_attempted
            && !self.private_export_succeeded
            && self.cleanup_ok()
    }
}

// ---------------------------------------------------------------------------
// Minimal RAII for the two CNG handle kinds (§18)
// ---------------------------------------------------------------------------

/// A key-storage provider handle. `Drop` always calls `NCryptFreeObject`, so the handle
/// can never be leaked by an early return or a panic.
///
/// Shared with the Gate B module, which reuses this RAII wrapper rather than writing a
/// second one (§6 — reuse before create).
pub(crate) struct CngProviderHandle(NCRYPT_PROV_HANDLE);

impl CngProviderHandle {
    pub(crate) fn raw(&self) -> NCRYPT_PROV_HANDLE {
        self.0
    }
}

impl Drop for CngProviderHandle {
    fn drop(&mut self) {
        // SAFETY: `self.0` is a live provider handle produced by a successful
        // `NCryptOpenStorageProvider`, and it is freed exactly once because `Drop` runs
        // once and nothing else can take it out of this type.
        unsafe {
            NCryptFreeObject(self.0);
        }
    }
}

/// A PERSISTED test key plus its handle.
///
/// Deleting a persisted key is not the same operation as freeing a handle:
/// `NCryptFreeObject` would release the handle while leaving the key behind in the
/// user's key store. This type therefore owns the *deletion* obligation (§17), and
/// `Drop` guarantees it happens on every path — success, failure, or panic.
struct PersistedTestKey {
    handle: Option<NCRYPT_KEY_HANDLE>,
}

impl PersistedTestKey {
    fn new(handle: NCRYPT_KEY_HANDLE) -> Self {
        Self {
            handle: Some(handle),
        }
    }

    fn handle(&self) -> Option<NCRYPT_KEY_HANDLE> {
        self.handle
    }

    /// Removes the persisted key. Idempotent: the second call is a no-op, which is what
    /// makes the explicit call in [`run_gate_a`] and the `Drop` backstop safe to
    /// combine.
    ///
    /// The ownership rule is encoded in [`classify_delete_outcome`] (§3): a successful
    /// `NCryptDeleteKey` *consumes* the handle (the key object is destroyed), so it must
    /// NOT be freed again; a failed `NCryptDeleteKey` leaves the key — and the still-owned
    /// handle — intact, so the handle is released with `NCryptFreeObject` to avoid a leak.
    /// The outcome (the delete status plus the release status) is returned so neither can
    /// be silently lost (§4).
    fn delete(&mut self) -> Option<DeleteOutcome> {
        let handle = self.handle.take()?;
        // SAFETY: `handle` is a live persisted-key handle owned by this value, taken out of
        // `self` first so it can never be passed twice.
        let status = unsafe { NCryptDeleteKey(handle, 0) };
        let release_after_delete_failure_status = match classify_delete_outcome(status) {
            DeleteHandleAction::ConsumedByDelete => {
                // SUCCESS: the handle was consumed by `NCryptDeleteKey`. Freeing it again
                // would be a double free, so nothing more is done (§3).
                None
            }
            DeleteHandleAction::FreeAfterFailure => {
                // FAILURE: the key still exists and `handle` is still owned by the caller.
                // Release it to avoid a handle leak (§3).
                // SAFETY: `handle` is a live, still-owned key handle (the delete did not
                // consume it).
                Some(unsafe { NCryptFreeObject(handle) } as u32)
            }
        };
        Some(DeleteOutcome {
            delete_status: status as u32,
            release_after_delete_failure_status,
        })
    }
}

impl Drop for PersistedTestKey {
    fn drop(&mut self) {
        // Best-effort: `Drop` cannot return the outcome. `delete` already releases the
        // handle on the failure path, so this never leaks (§5). It also never panics and
        // never touches secret material.
        self.delete();
    }
}

/// Pure ownership rule for a `NCryptDeleteKey` result (§3).
///
/// Kept separate from the FFI call so the rule is unit-testable without forcing a real
/// Windows key-store failure (§22).
#[derive(Debug, PartialEq)]
pub(crate) enum DeleteHandleAction {
    /// `NCryptDeleteKey` succeeded → the handle is consumed; no extra `NCryptFreeObject`.
    ConsumedByDelete,
    /// `NCryptDeleteKey` failed → the handle is still owned → release it with
    /// `NCryptFreeObject` to avoid a leak.
    FreeAfterFailure,
}

/// Decides the cleanup ownership action for a raw `NCryptDeleteKey` status (§3).
pub(crate) fn classify_delete_outcome(delete_status: i32) -> DeleteHandleAction {
    if delete_status == CNG_SUCCESS {
        DeleteHandleAction::ConsumedByDelete
    } else {
        DeleteHandleAction::FreeAfterFailure
    }
}

/// Outcome of [`PersistedTestKey::delete`] (§3 / §4).
///
/// Both pieces of evidence are retained so a cleanup failure is never mistaken for success,
/// and the best-effort handle release after a failed delete is itself observable.
#[derive(Debug, PartialEq)]
pub(crate) struct DeleteOutcome {
    /// Raw `SECURITY_STATUS` of `NCryptDeleteKey`.
    pub delete_status: u32,
    /// Raw `SECURITY_STATUS` of the `NCryptFreeObject` that released the still-owned handle
    /// after a delete failure. `None` when deletion succeeded (no extra free needed or done).
    pub release_after_delete_failure_status: Option<u32>,
}

impl DeleteOutcome {
    /// `true` iff the deletion itself succeeded.
    pub fn succeeded(&self) -> bool {
        self.delete_status == CNG_SUCCESS as u32
    }
}

/// Owns everything that must outlive the steps, so cleanup runs while the provider is
/// still open.
///
/// Field order matters: `key` is declared first, so it is dropped (and therefore
/// deleted) BEFORE the provider handle is freed.
struct GateASlots {
    key: Option<PersistedTestKey>,
    provider: Option<CngProviderHandle>,
}

impl GateASlots {
    fn new() -> Self {
        Self {
            key: None,
            provider: None,
        }
    }
}

// ---------------------------------------------------------------------------
// Thin CNG wrappers
// ---------------------------------------------------------------------------

/// NUL-terminated UTF-16 buffer for the `PCWSTR` parameters that take a runtime string.
fn wide(value: &str) -> Vec<u16> {
    value.encode_utf16().chain(std::iter::once(0u16)).collect()
}

/// §16 — a fresh, unique key name inside the dedicated test namespace.
fn unique_test_key_name(purpose: &str) -> String {
    format!("{TEST_KEY_PREFIX}{purpose}-{}", uuid::Uuid::new_v4())
}

/// Opens a key-storage provider. `label` is the same provider name as a `&str`, used for
/// reporting; `provider_name` is the CNG constant actually passed to the OS.
///
/// Visible to the sibling Gate B module so the Platform Crypto Provider is opened through
/// the SAME RAII wrapper and the same error mapping (§6).
pub(crate) fn open_provider(
    provider_name: PCWSTR,
    label: &'static str,
) -> Result<CngProviderHandle, IdentityBackendError> {
    let mut handle: NCRYPT_PROV_HANDLE = 0;
    // SAFETY: `provider_name` is a static NUL-terminated UTF-16 string, and `handle` is
    // a valid out-parameter. A failed open produces no handle, so there is nothing to
    // free on the error path.
    let status = unsafe { NCryptOpenStorageProvider(&mut handle, provider_name, 0) };
    if status != CNG_SUCCESS {
        return Err(IdentityBackendError::ProviderOpenFailed {
            provider: label,
            status: status as u32,
        });
    }
    Ok(CngProviderHandle(handle))
}

/// Serializes every test that touches the Microsoft Software Key Storage Provider.
///
/// The key store is a SHARED, process-external resource, and `cargo test` runs tests in
/// parallel by default. Without this lock a "namespace is empty" check (here or in the
/// sibling `windows_capability` module) could observe a key a concurrently running test is
/// legitimately holding — a flaky failure rather than a finding. `pub(crate)` so the
/// capability module's read-only sweep joins the SAME critical section.
pub(crate) static KEYSTORE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// Acquires [`KEYSTORE_LOCK`], ignoring poisoning: a test that panicked while holding it
/// must not turn every later test into a failure about the lock.
pub(crate) fn keystore_lock() -> std::sync::MutexGuard<'static, ()> {
    KEYSTORE_LOCK
        .lock()
        .unwrap_or_else(|error| error.into_inner())
}

fn create_persisted_key(
    provider: &CngProviderHandle,
    key_name: &str,
    algorithm: PCWSTR,
) -> Result<NCRYPT_KEY_HANDLE, IdentityBackendError> {
    let name = wide(key_name);
    let mut handle: NCRYPT_KEY_HANDLE = 0;
    // Flags are 0 on purpose: no `NCRYPT_MACHINE_KEY_FLAG` (Current User scope, §35) and
    // no `NCRYPT_OVERWRITE_KEY_FLAG`.
    //
    // IMPORTANT contract distinction (corrected in P7-S2R):
    // - An UNFINALIZED persisted key is a *candidate* that is not yet in the key store. A
    //   second `NCryptCreatePersistedKey` with the same name before finalization does NOT
    //   raise an error and is therefore NOT a usable uniqueness check.
    // - A FINALIZED persisted key really lives in the store. A duplicate
    //   `NCryptCreatePersistedKey` with the same name and no `NCRYPT_OVERWRITE_KEY_FLAG`
    //   returns `NTE_EXISTS` (0x8009000F) — this is the documented Microsoft CNG contract
    //   and is asserted by `finalized_persisted_key_duplicate_name_returns_nte_exists`.
    // Uniqueness for THIS slice's test keys therefore relies on the dedicated namespace (§16),
    // not on the provider rejecting duplicates, and never on the unfinalized-candidate behavior.
    // SAFETY: the provider handle is live, `algorithm` is a static NUL-terminated UTF-16
    // string, `name` is a NUL-terminated UTF-16 buffer that outlives the call, and
    // `handle` is a valid out-parameter.
    let status = unsafe {
        NCryptCreatePersistedKey(provider.raw(), &mut handle, algorithm, name.as_ptr(), 0, 0)
    };
    if status != CNG_SUCCESS {
        return Err(IdentityBackendError::KeyCreateFailed {
            status: status as u32,
        });
    }
    Ok(handle)
}

/// Sets `NCRYPT_EXPORT_POLICY_PROPERTY` to an explicit value. The policy is always set
/// EXPLICITLY (never relying on a provider default) so the effective value is exactly what the
/// caller asked for (§12).
fn set_export_policy(key: NCRYPT_KEY_HANDLE, policy: u32) -> Result<(), IdentityBackendError> {
    let value = policy.to_ne_bytes();
    // SAFETY: the property is documented as a DWORD, so `value` is a live 4-byte buffer
    // of exactly that size, and the property name is a static NUL-terminated UTF-16
    // string.
    let status = unsafe {
        NCryptSetProperty(
            key,
            NCRYPT_EXPORT_POLICY_PROPERTY,
            value.as_ptr(),
            value.len() as u32,
            0,
        )
    };
    if status != CNG_SUCCESS {
        return Err(IdentityBackendError::PropertySetFailed {
            property: "Export Policy",
            status: status as u32,
        });
    }
    Ok(())
}

/// §12 — disables private export: `NCRYPT_EXPORT_POLICY_PROPERTY = 0` ("no export permitted").
fn set_export_policy_disabled(key: NCRYPT_KEY_HANDLE) -> Result<(), IdentityBackendError> {
    set_export_policy(key, EXPORT_POLICY_DISABLED)
}

/// Reads a DWORD property. Failure is reported through
/// [`IdentityBackendError::PropertySetFailed`], whose documented scope covers a failed
/// read-back verification of a property THIS slice wrote — not only the write itself.
fn read_dword_property(
    key: NCRYPT_KEY_HANDLE,
    property: PCWSTR,
    label: &'static str,
) -> Result<u32, IdentityBackendError> {
    let mut value: u32 = 0;
    let mut written: u32 = 0;
    // SAFETY: `value` is a live 4-byte buffer whose exact size is passed in, and the
    // property is documented as a DWORD.
    let status = unsafe {
        NCryptGetProperty(
            key,
            property,
            &mut value as *mut u32 as *mut u8,
            std::mem::size_of::<u32>() as u32,
            &mut written,
            0,
        )
    };
    if status != CNG_SUCCESS || written != std::mem::size_of::<u32>() as u32 {
        return Err(IdentityBackendError::PropertySetFailed {
            property: label,
            status: status as u32,
        });
    }
    Ok(value)
}

fn finalize_key(key: NCRYPT_KEY_HANDLE) -> Result<(), IdentityBackendError> {
    // SAFETY: `key` is a live persisted-key handle created by this module.
    let status = unsafe { NCryptFinalizeKey(key, 0) };
    if status != CNG_SUCCESS {
        return Err(IdentityBackendError::KeyFinalizeFailed {
            status: status as u32,
        });
    }
    Ok(())
}

/// Exports a PUBLIC blob and returns ONLY its length. The bytes are dropped immediately:
/// the caller needs the capability, not the material.
fn export_public_blob_len(
    key: NCRYPT_KEY_HANDLE,
    blob_type: PCWSTR,
) -> Result<u32, IdentityBackendError> {
    // First call: size query only.
    let mut needed: u32 = 0;
    // SAFETY: a NULL output buffer with `cbOutput = 0` is the documented size-query form
    // of `NCryptExportKey`; `needed` is a valid out-parameter.
    let status = unsafe {
        NCryptExportKey(
            key,
            0,
            blob_type,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
            &mut needed,
            0,
        )
    };
    if status != CNG_SUCCESS {
        return Err(IdentityBackendError::PublicExportFailed {
            status: status as u32,
        });
    }
    if needed == 0 {
        return Err(IdentityBackendError::PublicExportFailed { status: 0 });
    }

    // Second call: perform the export for real, so a success is an actual export and not
    // only a size estimate.
    let mut buffer = vec![0u8; needed as usize];
    let mut written: u32 = 0;
    // SAFETY: `buffer` is allocated with exactly `needed` bytes, the size the API itself
    // reported, and `written` is a valid out-parameter.
    let status = unsafe {
        NCryptExportKey(
            key,
            0,
            blob_type,
            std::ptr::null(),
            buffer.as_mut_ptr(),
            needed,
            &mut written,
            0,
        )
    };
    if status != CNG_SUCCESS {
        return Err(IdentityBackendError::PublicExportFailed {
            status: status as u32,
        });
    }
    Ok(written)
}

/// Attempts a PRIVATE blob export and returns ONLY the status code.
///
/// Deliberately never allocates an output buffer and never returns any bytes: if the
/// provider were ever to permit the export, the very last thing this code should do is
/// capture the private material (§15). A `0` status is proof enough that the key was
/// exportable — the caller treats that as a failure.
fn attempt_private_export_status(key: NCRYPT_KEY_HANDLE, blob_type: PCWSTR) -> u32 {
    let mut needed: u32 = 0;
    // SAFETY: a NULL output buffer with `cbOutput = 0` is the documented size-query form,
    // and `needed` is a valid out-parameter. No caller-owned buffer is passed, so no
    // private material can be written anywhere by this call.
    let status = unsafe {
        NCryptExportKey(
            key,
            0,
            blob_type,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
            &mut needed,
            0,
        )
    };
    status as u32
}

/// Queries the required buffer size for a PRIVATE blob export WITHOUT allocating any output
/// buffer and WITHOUT receiving any private bytes (§11 / §15 / §16).
///
/// `pbOutput = NULL` and `cbOutput = 0` is the documented size-query form of `NCryptExportKey`.
/// On `SECURITY_STATUS == 0` the required size is returned (proving the export is permitted with a
/// non-zero length); on any failure the raw status is returned so the caller can distinguish "not
/// permitted" from "provider broke". No caller-owned buffer is ever passed, so no private material
/// can be written anywhere by this call.
fn query_private_export_required_size(
    key: NCRYPT_KEY_HANDLE,
    blob_type: PCWSTR,
) -> Result<u32, u32> {
    let mut needed: u32 = 0;
    // SAFETY: see `attempt_private_export_status` — a NULL output buffer with `cbOutput = 0` is the
    // documented size-query form, and `needed` is a valid out-parameter. No private bytes are
    // materialized.
    let status = unsafe {
        NCryptExportKey(
            key,
            0,
            blob_type,
            std::ptr::null(),
            std::ptr::null_mut(),
            0,
            &mut needed,
            0,
        )
    };
    if status == CNG_SUCCESS {
        Ok(needed)
    } else {
        Err(status as u32)
    }
}

/// Tri-state result of a read-only presence probe (§6 / §7).
///
/// Only `NTE_BAD_KEYSET` may be read as "absent". Any other non-success status is treated as
/// "the probe could not determine the answer" and must NOT be flattened into "absent" —
/// "could not prove it is gone" is not the same as "it is gone" (fail-closed, §8 / §9).
#[derive(Debug, PartialEq)]
pub(crate) enum PersistedKeyPresence {
    /// The key is present (the open succeeded).
    Present,
    /// The key is absent. Only ever produced for `NTE_BAD_KEYSET` (§7).
    Absent,
    /// The probe failed for a reason other than "key not there". The raw status travels so
    /// the failure is never mis-reported as "deleted" (§8 / §9).
    ProbeFailed { status: u32 },
}

/// Pure classifier for a raw `NCryptOpenKey` status (§10). Kept separate from the FFI call so
/// the tri-state rule is unit-testable without touching the real key store.
pub(crate) fn classify_open_key_status(status: i32) -> PersistedKeyPresence {
    if status == CNG_SUCCESS {
        PersistedKeyPresence::Present
    } else if status == NTE_BAD_KEYSET as i32 {
        PersistedKeyPresence::Absent
    } else {
        PersistedKeyPresence::ProbeFailed {
            status: status as u32,
        }
    }
}

/// Read-only presence probe. Frees the handle it opens and never deletes anything, which
/// is what makes it usable as proof that a deletion already happened (§17).
fn persisted_key_is_present(provider: &CngProviderHandle, key_name: &str) -> PersistedKeyPresence {
    let name = wide(key_name);
    let mut handle: NCRYPT_KEY_HANDLE = 0;
    // SAFETY: the provider handle is live, `name` is a NUL-terminated UTF-16 buffer that
    // outlives the call, and `handle` is a valid out-parameter.
    let status = unsafe { NCryptOpenKey(provider.raw(), &mut handle, name.as_ptr(), 0, 0) };
    let presence = classify_open_key_status(status);
    if let PersistedKeyPresence::Present = presence {
        // SAFETY: `handle` was just produced by a successful `NCryptOpenKey` and is not
        // stored anywhere, so it is freed exactly once here.
        unsafe {
            NCryptFreeObject(handle);
        }
    }
    presence
}

// ---------------------------------------------------------------------------
// Gate A
// ---------------------------------------------------------------------------

/// Runs Gate A end to end and returns the structured observations (§44).
///
/// The steps follow the Windows API contract: open provider → create persisted key →
/// configure usage / export policy → finalize → export public blob → attempt private blob
/// export → delete the test key. Cleanup happens while the provider is still open, on the
/// success and the failure path alike.
pub(crate) fn run_gate_a() -> GateAReport {
    let key_name = unique_test_key_name("gate-a");
    let mut report = GateAReport::initial(key_name.clone());
    let mut slots = GateASlots::new();

    if let Err(error) = gate_a_steps(&mut report, &mut slots, &key_name) {
        report.first_error.get_or_insert(error);
    }

    // §17 — delete the test key explicitly so its status can be reported, and then prove
    // the deletion independently by re-opening the key by name.
    if let Some(mut key) = slots.key.take() {
        if let Some(outcome) = key.delete() {
            report.cleanup_status = Some(outcome.delete_status);
            report.cleanup_release_status = outcome.release_after_delete_failure_status;
            if !outcome.succeeded() {
                // The deletion itself failed. The handle was already released on the failure
                // path (§3), so there is no leak, but cleanup did NOT happen and this must
                // surface as an error (§4).
                report
                    .first_error
                    .get_or_insert(IdentityBackendError::CleanupFailed {
                        key_name: key_name.clone(),
                        status: outcome.delete_status,
                    });
            }
        }
    }
    if let Some(provider) = slots.provider.as_ref() {
        match persisted_key_is_present(provider, &key_name) {
            PersistedKeyPresence::Absent => {
                // Independent, black-box proof that the key is gone (§17).
                report.cleanup_verified_absent = true;
            }
            PersistedKeyPresence::Present => {
                // The key is still openable: cleanup did not remove it.
                report.cleanup_verified_absent = false;
                report
                    .first_error
                    .get_or_insert(IdentityBackendError::CleanupFailed {
                        key_name: key_name.clone(),
                        status: CNG_SUCCESS as u32,
                    });
            }
            PersistedKeyPresence::ProbeFailed { status } => {
                // The probe could not determine presence. "Could not prove absence" must NOT
                // be reported as "deleted" — fail closed (§8 / §9).
                report.cleanup_verified_absent = false;
                report
                    .first_error
                    .get_or_insert(IdentityBackendError::KeyPresenceProbeFailed {
                        key_name: key_name.clone(),
                        status,
                    });
            }
        }
    }

    report
}

fn gate_a_steps(
    report: &mut GateAReport,
    slots: &mut GateASlots,
    key_name: &str,
) -> Result<(), IdentityBackendError> {
    // 1) Open the Microsoft Software Key Storage Provider. §9: Gate A must not depend on
    //    whether this machine has a TPM, so the software provider is the target.
    let provider = open_provider(PROVIDER_NAME, PROVIDER_LABEL)?;
    report.provider_opened = true;
    slots.provider = Some(provider);
    let provider = slots.provider.as_ref().expect("provider was just stored");

    // 2) Create a PERSISTED key in the dedicated test namespace (§16).
    //    TEST / CAPABILITY PROBE ONLY — `ECDSA_P256` here is NOT the frozen identity
    //    algorithm (§10).
    let handle = create_persisted_key(provider, key_name, BCRYPT_ECDSA_P256_ALGORITHM)?;
    report.key_created = true;
    slots.key = Some(PersistedTestKey::new(handle));
    let handle = slots
        .key
        .as_ref()
        .and_then(PersistedTestKey::handle)
        .expect("key was just stored");

    // 3) §12 — set the private-export policy EXPLICITLY to "no export", then read it
    //    back: the provider default is never accepted as proof.
    set_export_policy_disabled(handle)?;
    report.export_policy_disabled = true;
    let readback = read_dword_property(
        handle,
        NCRYPT_EXPORT_POLICY_PROPERTY,
        "Export Policy (read-back)",
    )?;
    report.export_policy_readback = Some(readback);
    if readback != EXPORT_POLICY_DISABLED {
        return Err(IdentityBackendError::ExportPolicyReadBackMismatch {
            expected: EXPORT_POLICY_DISABLED,
            actual: readback,
        });
    }

    // 4) Finalize the key so it becomes usable.
    finalize_key(handle)?;
    report.finalized = true;

    // 5) §13 — the PUBLIC blob must still be obtainable, and non-empty.
    report.public_export_bytes = export_public_blob_len(handle, BCRYPT_ECCPUBLIC_BLOB)?;

    // 6) §14 — the PRIVATE blob must NOT be obtainable. "public identity is readable"
    //    must not imply "private material is exportable": this is the core of Gate A.
    report.private_export_attempted = true;
    report.private_export_status = attempt_private_export_status(handle, BCRYPT_ECCPRIVATE_BLOB);
    report.private_export_succeeded = report.private_export_status == CNG_SUCCESS as u32;
    if report.private_export_succeeded {
        return Err(IdentityBackendError::UnexpectedPrivateExportSuccess);
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use windows_sys::Win32::Foundation::{NTE_EXISTS, NTE_INVALID_HANDLE, NTE_INVALID_PARAMETER};
    use windows_sys::Win32::Security::Cryptography::{
        NCRYPT_ALLOW_EXPORT_FLAG, NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG,
    };

    /// Gate A, end to end, against the REAL Microsoft Software Key Storage Provider
    /// (§32). If the environment cannot support this, the test must be BLOCKED rather
    /// than reported as a pass — so it fails loudly instead of skipping silently.
    #[test]
    fn gate_a_public_export_survives_while_private_export_is_denied() {
        // The key store is shared with the other tests in this binary (§17 sweep).
        let _guard = keystore_lock();
        let report = run_gate_a();

        // Environment evidence (§15 allows provider name / status / blob size).
        eprintln!(
            "GATE_A provider={} algorithm={} key={}",
            report.provider_name, report.probe_algorithm, report.key_name
        );
        eprintln!(
            "GATE_A export_policy(readback)={:?} public_export_bytes={} private_export_status=0x{:08X} private_export_succeeded={}",
            report.export_policy_readback,
            report.public_export_bytes,
            report.private_export_status,
            report.private_export_succeeded
        );
        eprintln!(
            "GATE_A cleanup_status={:?} cleanup_verified_absent={} first_error={:?}",
            report.cleanup_status,
            report.cleanup_verified_absent,
            report
                .first_error
                .as_ref()
                .map(|e| (e.kind(), format!("{e:?}")))
        );

        assert!(report.provider_opened, "{report:?}");
        assert!(report.key_created, "{report:?}");
        assert!(report.export_policy_disabled, "{report:?}");
        assert_eq!(
            report.export_policy_readback,
            Some(EXPORT_POLICY_DISABLED),
            "the export policy must read back exactly as written: {report:?}"
        );
        assert!(report.finalized, "{report:?}");

        // §13 — public export succeeds, with a non-zero length.
        assert!(
            report.public_export_bytes > 0,
            "public blob export must succeed with a non-zero length: {report:?}"
        );

        // §14 — private export does NOT succeed. Only "not success" is asserted: §12
        // forbids hard-coding one specific error code as the only legal answer.
        assert!(report.private_export_attempted, "{report:?}");
        assert!(
            !report.private_export_succeeded,
            "a key with export disabled must not export its private blob: {report:?}"
        );
        assert_ne!(
            report.private_export_status, 0,
            "a non-success status is expected for the private export: {report:?}"
        );

        // §17 — the temporary test key is gone, proven by absence.
        assert_eq!(
            report.cleanup_status,
            Some(0),
            "deleting the test key must succeed: {report:?}"
        );
        assert!(
            report.cleanup_verified_absent,
            "the test key must be verifiably absent afterwards: {report:?}"
        );

        assert!(report.first_error.is_none(), "{report:?}");
        assert!(report.pass(), "Gate A must pass: {report:?}");
    }

    /// §17 / §18 — the RAII guarantee on the FAILURE path: a persisted test key that was
    /// COMMITTED is removed by the guard even when a later step fails.
    ///
    /// The failure is real, produced by the OS, happens AFTER the test key is committed,
    /// and has no side effect of its own, so the deletion proven at the end is a deletion
    /// and not an absent key.
    ///
    /// Two environment facts shaped this test:
    ///
    /// - a persisted key is only openable by name AFTER `NCryptFinalizeKey` (before that,
    ///   `NCryptOpenKey` answers `NTE_BAD_KEYSET`). The key is therefore finalized first —
    ///   which is also the point in the real Gate A flow where the "must not be left
    ///   behind" obligation starts;
    /// - an UNFINALIZED persisted key is not yet in the store, so it is not a usable
    ///   uniqueness anchor; the duplicate-name `NTE_EXISTS` contract applies only to
    ///   FINALIZED keys (see `finalized_persisted_key_duplicate_name_returns_nte_exists`).
    ///   A deliberate, side-effect-free OS rejection (reading an unknown property) is used
    ///   as the failure instead.
    #[test]
    fn persisted_test_key_is_deleted_when_a_later_step_fails() {
        // The key store is shared with the other tests in this binary (§17 sweep).
        let _guard = keystore_lock();
        let key_name = unique_test_key_name("gate-a-abort");

        {
            let mut slots = GateASlots::new();
            slots.provider = Some(
                open_provider(PROVIDER_NAME, PROVIDER_LABEL)
                    .expect("the Software KSP must be available in this environment"),
            );

            let handle = create_persisted_key(
                slots.provider.as_ref().unwrap(),
                &key_name,
                BCRYPT_ECDSA_P256_ALGORITHM,
            )
            .expect("creating the persisted test key must succeed");
            slots.key = Some(PersistedTestKey::new(handle));

            // Commit it, so the key really is in the user's key store.
            finalize_key(handle).expect("finalizing the persisted test key must succeed");

            // Precondition: the committed key is present, so the assertion after the guard
            // runs proves a deletion and not an absent key.
            let presence = persisted_key_is_present(slots.provider.as_ref().unwrap(), &key_name);
            assert_eq!(
                presence,
                PersistedKeyPresence::Present,
                "precondition: the finalized test key must exist: {presence:?}"
            );

            // A REAL failure from the OS, after the key is committed, with no side effect:
            // reading a property name the provider does not implement is rejected. This is
            // the same call the export-policy read-back uses.
            let unknown_property = wide("ZHIXING_NO_SUCH_PROPERTY");
            let rejected = read_dword_property(
                handle,
                unknown_property.as_ptr(),
                "unknown property (deliberate failure)",
            );
            assert!(
                rejected.is_err(),
                "reading an unknown property must be rejected, got {rejected:?}"
            );

            // `slots` is dropped here WITHOUT an explicit delete: only `Drop` can remove
            // the key.
        }

        // Independent proof of absence. A `ProbeFailed` here is NOT "deleted": if the
        // presence probe could not determine the answer, the test must fail loudly rather
        // than treat the unknown as a success (fail-closed, §8 / §9).
        let provider = open_provider(PROVIDER_NAME, PROVIDER_LABEL).unwrap();
        let presence = persisted_key_is_present(&provider, &key_name);
        assert_eq!(
            presence,
            PersistedKeyPresence::Absent,
            "the cleanup guard must delete the persisted test key on the failure path: {presence:?}"
        );
    }

    /// §17 / §18 — deleting twice is safe: the explicit call and the `Drop` backstop must
    /// not have to know about each other.
    #[test]
    fn persisted_test_key_deletion_is_idempotent() {
        // The key store is shared with the other tests in this binary (§17 sweep).
        let _guard = keystore_lock();
        let key_name = unique_test_key_name("gate-a-idempotent");
        let provider = open_provider(PROVIDER_NAME, PROVIDER_LABEL)
            .expect("the Software KSP must be available");
        let handle = create_persisted_key(&provider, &key_name, BCRYPT_ECDSA_P256_ALGORITHM)
            .expect("creating the persisted test key must succeed");

        // Commit it first: a created-but-unfinalized persisted key is not in the store yet
        // (`NCryptOpenKey` answers `NTE_BAD_KEYSET`), so without this the "stays deleted"
        // assertion below would hold even if nothing had ever been deleted.
        finalize_key(handle).expect("finalizing the persisted test key must succeed");
        let presence = persisted_key_is_present(&provider, &key_name);
        assert_eq!(
            presence,
            PersistedKeyPresence::Present,
            "precondition: the finalized test key must exist: {presence:?}"
        );

        let mut key = PersistedTestKey::new(handle);
        let first = key.delete().expect("the first deletion must succeed");
        assert!(first.succeeded(), "the first deletion must succeed");
        assert_eq!(key.delete(), None, "the second deletion must be a no-op");
        // …and the `Drop` backstop still runs without deleting anything twice.
        drop(key);

        let presence = persisted_key_is_present(&provider, &key_name);
        assert_eq!(
            presence,
            PersistedKeyPresence::Absent,
            "the key must stay deleted: {presence:?}"
        );
    }

    /// §16 — the test-key namespace is dedicated, so no production identity key name can
    /// ever be collided with.
    #[test]
    fn test_key_names_are_unique_and_namespaced() {
        let a = unique_test_key_name("gate-a");
        let b = unique_test_key_name("gate-a");
        assert!(a.starts_with(TEST_KEY_PREFIX));
        assert!(b.starts_with(TEST_KEY_PREFIX));
        assert_ne!(a, b, "every probe run must use a fresh key name");
    }

    /// §15 — nothing this module reports may contain private material. The report may only
    /// carry the provider name, the probe-algorithm label, the key identifier, status
    /// numbers, blob sizes and booleans. The detector: no long all-hex token (a key or
    /// blob dump) may appear anywhere in the rendered report.
    #[test]
    fn gate_a_report_never_carries_secret_material() {
        // The key store is shared with the other tests in this binary (§17 sweep).
        let _guard = keystore_lock();
        let report = run_gate_a();
        let rendered = format!("{report:?}");
        assert!(
            report.key_name.starts_with(TEST_KEY_PREFIX),
            "test keys must live in the {TEST_KEY_PREFIX} namespace: {}",
            report.key_name
        );
        assert_eq!(report.probe_algorithm, PROBE_ALGORITHM_LABEL);
        for token in rendered.split(|c: char| !c.is_ascii_alphanumeric()) {
            if token.len() > 16 {
                assert!(
                    !token.chars().all(|c| c.is_ascii_hexdigit()),
                    "no long hex blob may appear in the report (private/public material leak): {token}"
                );
            }
        }
    }

    /// §4 / §5 / §8 — the Microsoft CNG contract for a FINALIZED persisted key.
    ///
    /// When a persisted key has been FINALIZED and therefore really lives in the key store, a
    /// second `NCryptCreatePersistedKey` with the SAME name and without `NCRYPT_OVERWRITE_KEY_FLAG`
    /// must return `NTE_EXISTS` (0x8009000F). This is the documented contract. The old comment in
    /// `create_persisted_key` was wrong to generalize the *unfinalized* duplicate observation into a
    /// statement about persisted-key uniqueness.
    ///
    /// If the real machine returns anything other than `NTE_EXISTS`, that is a WINDOWS CNG CONTRACT
    /// ANOMALY and is reported, never papered over (§6).
    #[test]
    fn finalized_persisted_key_duplicate_name_returns_nte_exists() {
        let _guard = keystore_lock();
        let key_name = unique_test_key_name("dup-finalized");

        let provider = open_provider(PROVIDER_NAME, PROVIDER_LABEL)
            .expect("the Software KSP must be available in this environment");

        // Create + configure + FINALIZE key A so it truly exists in the store.
        let handle_a = create_persisted_key(&provider, &key_name, BCRYPT_ECDSA_P256_ALGORITHM)
            .expect("creating key A must succeed");
        let key_a = PersistedTestKey::new(handle_a);
        set_export_policy_disabled(handle_a).expect("setting policy on key A must succeed");
        finalize_key(handle_a).expect("finalizing key A must succeed");

        // Precondition: key A is really present, so the duplicate attempt targets a real key.
        let presence = persisted_key_is_present(&provider, &key_name);
        assert_eq!(
            presence,
            PersistedKeyPresence::Present,
            "precondition: finalized key A must exist: {presence:?}"
        );

        // Second create, SAME name, flags = 0 (no `NCRYPT_OVERWRITE_KEY_FLAG`, Current User).
        let name = wide(&key_name);
        let mut handle_b: NCRYPT_KEY_HANDLE = 0;
        // SAFETY: the provider handle is live, `name` is a NUL-terminated UTF-16 buffer that outlives
        // the call, and `handle_b` is a valid out-parameter. On `NTE_EXISTS` the provider does NOT
        // hand back a usable handle, so `handle_b` stays 0 and is never freed.
        let status = unsafe {
            NCryptCreatePersistedKey(
                provider.raw(),
                &mut handle_b,
                BCRYPT_ECDSA_P256_ALGORITHM,
                name.as_ptr(),
                0,
                0,
            )
        };

        let actual = status as u32;
        let nte_exists = NTE_EXISTS as u32;
        assert_eq!(
            actual,
            nte_exists,
            "a duplicate create of a FINALIZED persisted key (same name, no overwrite flag) \
             must return NTE_EXISTS (0x{nte_exists:08X}); actual status 0x{actual:08X} (key={key_name})"
        );
        // On `NTE_EXISTS` no usable handle is produced; `handle_b` is left 0 and must not be freed.
        assert_eq!(handle_b, 0, "NTE_EXISTS must not yield a second key handle");

        drop(key_a);
        let presence = persisted_key_is_present(&provider, &key_name);
        assert_eq!(
            presence,
            PersistedKeyPresence::Absent,
            "key A must be verifiably absent after cleanup: {presence:?}"
        );

        eprintln!(
            "DUP_CONTRACT first_key_finalized=true open_by_name=true second_create_flags=0 \
             actual_result=0x{actual:08X} expected_NTE_EXISTS=0x{nte_exists:08X} status=MATCH"
        );
    }

    /// §9 / §10 / §11 — POSITIVE CONTROL for Gate A.
    ///
    /// Gate A's negative case proves "export policy = 0 ⇒ private export denied". This control proves
    /// the OPPOSITE half: when the export policy explicitly *allows* export, the PRIVATE blob size
    /// query succeeds with a non-zero required size. Together they prove the export policy actively
    /// controls private exportability — not that the provider simply never exports private keys.
    ///
    /// NO private bytes are ever materialized: the export query passes `pbOutput = NULL, cbOutput = 0`
    /// and reads only the required size (§11 / §15 / §16).
    #[test]
    fn gate_a_exportable_control_allows_private_size_query() {
        let _guard = keystore_lock();
        let key_name = unique_test_key_name("gate-a-control");

        let provider = open_provider(PROVIDER_NAME, PROVIDER_LABEL)
            .expect("the Software KSP must be available in this environment");

        let export_policy = NCRYPT_ALLOW_EXPORT_FLAG | NCRYPT_ALLOW_PLAINTEXT_EXPORT_FLAG;
        let handle = create_persisted_key(&provider, &key_name, BCRYPT_ECDSA_P256_ALGORITHM)
            .expect("creating the control test key must succeed");
        let mut key = PersistedTestKey::new(handle);

        // The policy is set EXPLICITLY (never a provider default) and read back to confirm.
        set_export_policy(handle, export_policy)
            .expect("setting the exportable policy must succeed");
        let readback = read_dword_property(
            handle,
            NCRYPT_EXPORT_POLICY_PROPERTY,
            "Export Policy (read-back)",
        )
        .expect("reading the export policy back must succeed");
        assert_eq!(
            readback, export_policy,
            "the exportable policy must read back exactly as written"
        );

        finalize_key(handle).expect("finalizing the control test key must succeed");

        // PUBLIC identity remains readable on an exportable key (§14).
        let public_bytes = export_public_blob_len(handle, BCRYPT_ECCPUBLIC_BLOB)
            .expect("public export must succeed on the exportable control key");
        assert!(public_bytes > 0, "public blob must be non-empty");

        // The PRIVATE blob size query is now permitted; only the size is read, never the bytes.
        let private_size = query_private_export_required_size(handle, BCRYPT_ECCPRIVATE_BLOB)
            .expect("the exportable control key must permit a private blob size query");
        assert!(
            private_size > 0,
            "a permitted private export must report a non-zero required size"
        );

        // Explicit cleanup, then black-box proof of absence (§17).
        let cleanup_outcome = key.delete().expect("deleting the control key must succeed");
        assert!(
            cleanup_outcome.succeeded(),
            "deleting the control key must succeed"
        );
        let presence = persisted_key_is_present(&provider, &key_name);
        assert_eq!(
            presence,
            PersistedKeyPresence::Absent,
            "the control key must be verifiably absent afterwards: {presence:?}"
        );

        eprintln!(
            "GATE_A_CONTROL export_policy=0x{export_policy:08X} readback=0x{readback:08X} \
             public_export_bytes={public_bytes} private_size_query=SUCCESS private_required_size={private_size} \
             private_bytes_allocated=false"
        );
    }

    // -----------------------------------------------------------------------
    // §17 — proof that the suite leaves nothing behind in the user's key store
    // -----------------------------------------------------------------------

    /// Enumerates the key names the provider reports for the CURRENT USER.
    ///
    /// Used only by tests: no part of the production code in this module enumerates keys.
    /// Returns the names plus the status that TERMINATED the enumeration, so a caller can
    /// tell "the enumeration completed" apart from "the enumeration broke early".
    fn list_persisted_key_names(provider: &CngProviderHandle) -> (Vec<String>, u32) {
        use windows_sys::Win32::Security::Cryptography::{
            NCryptEnumKeys, NCryptFreeBuffer, NCryptKeyName,
        };

        /// Reads a provider-allocated NUL-terminated UTF-16 string.
        fn read_pwstr(pointer: windows_sys::core::PWSTR) -> String {
            if pointer.is_null() {
                return String::new();
            }
            let mut length = 0usize;
            // SAFETY: `pointer` is provider-allocated and NUL-terminated; the scan stops at
            // the first NUL, so it never reads past the allocated string.
            unsafe {
                while *pointer.add(length) != 0 {
                    length += 1;
                }
                String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length))
            }
        }

        let mut names = Vec::new();
        let mut state: *mut std::ffi::c_void = std::ptr::null_mut();
        // The loop can only end through the `break` below, so the terminating status is
        // always produced by the iteration that stops the enumeration.
        let final_status: u32 = loop {
            let mut entry: *mut NCryptKeyName = std::ptr::null_mut();
            // SAFETY: the provider handle is live; a NULL scope means "current user"; both
            // out-parameters are valid; and the enumeration state is threaded through
            // `state` across iterations as the API requires.
            let status = unsafe {
                NCryptEnumKeys(provider.raw(), std::ptr::null(), &mut entry, &mut state, 0)
            };
            if status != CNG_SUCCESS {
                break status as u32;
            }
            if !entry.is_null() {
                // SAFETY: on success the provider handed back a live `NCryptKeyName`.
                names.push(unsafe { read_pwstr((*entry).pszName) });
                // SAFETY: the entry was allocated by the provider for this call and is freed
                // exactly once, immediately after its contents are copied out.
                unsafe {
                    NCryptFreeBuffer(entry as *mut std::ffi::c_void);
                }
            }
        };
        if !state.is_null() {
            // SAFETY: the enumeration state was allocated by the provider across the loop
            // and is freed exactly once, after the loop has ended.
            unsafe {
                NCryptFreeBuffer(state);
            }
        }
        (names, final_status)
    }

    /// §17 — the mandatory cleanup obligation, checked GLOBALLY rather than per test.
    ///
    /// Every other test proves that ITS OWN key is gone. This one proves the stronger
    /// statement the requirement actually makes: after the Gate A work has run, the
    /// dedicated test namespace contains NOTHING, so a cleanup regression cannot hide
    /// behind a passing per-key assertion.
    #[test]
    fn no_keys_are_left_behind_in_the_test_namespace() {
        let _guard = keystore_lock();
        let provider = open_provider(PROVIDER_NAME, PROVIDER_LABEL)
            .expect("the Software KSP must be available in this environment");
        let (names, final_status) = list_persisted_key_names(&provider);

        // A completed enumeration ends with NTE_NO_MORE_ITEMS. Asserting it means an
        // enumeration that broke early cannot masquerade as "there was nothing to find".
        assert_eq!(
            final_status,
            windows_sys::Win32::Foundation::NTE_NO_MORE_ITEMS as u32,
            "key enumeration must complete normally; names seen: {names:?}"
        );

        let leftovers: Vec<&String> = names
            .iter()
            .filter(|name| name.starts_with(TEST_KEY_PREFIX))
            .collect();
        assert!(
            leftovers.is_empty(),
            "the {TEST_KEY_PREFIX} namespace must be empty after the suite: {leftovers:?}"
        );
    }

    // -----------------------------------------------------------------------
    // §22 — PURE classifier / ownership unit tests (no real key store needed)
    // -----------------------------------------------------------------------

    /// `SECURITY_STATUS == 0` from `NCryptOpenKey` means the key is present (§6).
    #[test]
    fn classify_open_key_status_success_maps_to_present() {
        assert_eq!(classify_open_key_status(0), PersistedKeyPresence::Present);
    }

    /// Only `NTE_BAD_KEYSET` may be read as "absent": the key store literally reports
    /// "no such key set" (§7).
    #[test]
    fn classify_open_key_status_bad_keyset_maps_to_absent() {
        assert_eq!(
            classify_open_key_status(NTE_BAD_KEYSET as i32),
            PersistedKeyPresence::Absent
        );
    }

    /// Any OTHER non-success status is "the probe could not determine the answer", and
    /// must NOT be flattened into "absent" (fail-closed, §8 / §9).
    #[test]
    fn classify_open_key_status_unexpected_error_maps_to_probe_failed() {
        let status = NTE_INVALID_HANDLE as i32;
        match classify_open_key_status(status) {
            PersistedKeyPresence::ProbeFailed { status: reported } => {
                assert_eq!(reported, status as u32);
            }
            other => panic!("unexpected OpenKey status must be ProbeFailed, got {other:?}"),
        }
    }

    /// A second distinct unexpected error is also `ProbeFailed` — the classifier is not
    /// special-casing one particular failure code (§8).
    #[test]
    fn classify_open_key_status_other_unexpected_error_maps_to_probe_failed() {
        let status = NTE_INVALID_PARAMETER as i32;
        match classify_open_key_status(status) {
            PersistedKeyPresence::ProbeFailed { status: reported } => {
                assert_eq!(reported, status as u32);
            }
            other => panic!("unexpected OpenKey status must be ProbeFailed, got {other:?}"),
        }
    }

    /// A successful `NCryptDeleteKey` CONSUMES the handle: it must not be freed again
    /// (double-free), so the ownership action is `ConsumedByDelete` (§3).
    #[test]
    fn classify_delete_outcome_success_consumes_handle() {
        assert_eq!(
            classify_delete_outcome(0),
            DeleteHandleAction::ConsumedByDelete
        );
    }

    /// A failed `NCryptDeleteKey` leaves the handle owned by the caller: it must be
    /// released with `NCryptFreeObject` to avoid a leak, so the action is
    /// `FreeAfterFailure` (§3).
    #[test]
    fn classify_delete_outcome_failure_releases_handle() {
        assert_eq!(
            classify_delete_outcome(NTE_INVALID_HANDLE as i32),
            DeleteHandleAction::FreeAfterFailure
        );
    }

    /// On success, `DeleteOutcome` records the successful status and NO extra free was
    /// needed or performed (§3 / §4).
    #[test]
    fn delete_outcome_success_has_no_extra_release() {
        let outcome = DeleteOutcome {
            delete_status: 0,
            release_after_delete_failure_status: None,
        };
        assert!(outcome.succeeded());
        assert_eq!(outcome.release_after_delete_failure_status, None);
    }

    /// On failure, `DeleteOutcome` records the failing status AND keeps the best-effort
    /// handle-release status observable, so a leak can never be silently swallowed (§4).
    #[test]
    fn delete_outcome_failure_keeps_release_status_observable() {
        let release_status: u32 = NTE_INVALID_HANDLE as u32;
        let outcome = DeleteOutcome {
            delete_status: NTE_INVALID_HANDLE as u32,
            release_after_delete_failure_status: Some(release_status),
        };
        assert!(!outcome.succeeded());
        assert_eq!(
            outcome.release_after_delete_failure_status,
            Some(release_status)
        );
    }
}
