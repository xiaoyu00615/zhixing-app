//! Windows production Device Identity provider (P7-S4).
//!
//! # What this module is
//!
//! The Windows implementation of the shared [`DeviceIdentityCapability`]: provisioning,
//! reading, and signing with a **provider-managed, non-exportable** P-256 identity key
//! (§15 / §28 / §30). Everything platform-shaped stays here — provider names, `NCrypt*`
//! calls, raw `SECURITY_STATUS` codes — and is mapped onto the platform-neutral
//! [`IdentityError`] before it leaves.
//!
//! # What it deliberately does NOT do
//!
//! - No Trust Store, no pairing, no revocation (§42).
//! - No transport: no TCP, no rustls, no RPK handshake, no discovery (§38 / §39 / §43).
//! - No frontend command: this is an internal native capability, never a "sign arbitrary
//!   bytes" IPC entry point (§13 / §44).
//! - No Android code and no Android emulation: the Android provider is the next platform
//!   implementation (§40).
//!
//! # Signing pipeline (§28)
//!
//! ```text
//! UNHASHED message ──▶ SHA-256 (exactly once) ──▶ NCryptSignHash ──▶ P-1363 (64B)
//!                                                                      │
//!                                                                      ▼
//!                                                        DER ECDSA-Sig-Value
//! ```
//!
//! The single SHA-256 is what keeps this identical to the P7-T2V validated rustls
//! `Signer` semantics (rustls hands the signer the UNHASHED message) and identical to the
//! Android path (`SHA256withECDSA` hashes internally). Hashing twice would produce a
//! signature no peer could verify, so the digest is computed here and nowhere else.
//!
//! # Two resources, no cross-resource atomicity (P7-S4R §11)
//!
//! An established identity consists of a **CNG persisted key** and a **filesystem
//! metadata record**. There is no transaction that commits both at once, and this slice
//! does not pretend there is one: **cross-resource atomicity does not exist**.
//!
//! The consequence is written down instead of hidden — if the process crashes between
//! the key creation and the record write, the leftover state is
//!
//! ```text
//! key exists + metadata absent
//! ```
//!
//! and the next call FAILS CLOSED with `IDENTITY_METADATA_MISSING` (an orphan key is never
//! silently adopted). Recovery/reset UX is explicitly out of this slice: the state is
//! reported, not repaired.
//!
//! P7-S4R2 narrows what is claimed: this is the ACCEPTED **crash** behaviour, and nothing
//! more. The key created by a provisioning attempt carries a deletion obligation until
//! establishment is committed (see [`ProvisioningKeyGuard`]), so **ordinary Rust error
//! returns do not unnecessarily leave an orphan** — but no amount of RAII can make
//! "CNG persisted key + filesystem metadata" a single atomic transaction.

use super::{
    der, metadata, windows_capability, windows_cng, windows_tpm, DeviceIdentityCapability,
    DeviceIdentityReadiness, DevicePublicIdentity, DeviceSignature, DeviceSignatureScheme,
    IdentityBackendError, IdentityError, IdentitySecurityLevel,
};
// SHA-256 over the UNHASHED message, computed exactly once (§28).
use sha2::Digest;
use std::path::Path;
use windows_cng::{CngKeyHandle, CngProviderHandle, PersistedKeyPresence};
use windows_sys::core::PCWSTR;
use windows_sys::Win32::Security::Cryptography::{
    BCRYPT_ECCPRIVATE_BLOB, BCRYPT_ECCPUBLIC_BLOB, BCRYPT_ECDSA_P256_ALGORITHM,
    MS_KEY_STORAGE_PROVIDER, MS_PLATFORM_CRYPTO_PROVIDER, NCRYPT_EXPORT_POLICY_PROPERTY,
};

/// §16 — the production V1 identity key name.
///
/// Stable, app-specific and versioned, and strictly separate from the `zhixing-test-*`
/// probe namespace: a test key can never collide with it and a test can never create it
/// (§31). A future V2 identity would use a `…-v2` name, never an overwrite of this one.
pub(crate) const PRODUCTION_KEY_NAME: &str = "zhixing-device-identity-v1";

/// §12 / §28 — `NCRYPT_EXPORT_POLICY_PROPERTY = 0` means "no export permitted".
///
/// The production key must be non-exportable, and the value is read back after it is
/// written: a policy that did not stick is treated as "cannot prove non-exportable" ⇒ fail
/// closed (§30).
const NON_EXPORTABLE_POLICY: u32 = 0;

/// The platform decision that production operations run against.
///
/// Built once per operation from the (side-effect free) capability resolution, so no
/// operation can silently run against a different backend than the one that was measured.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct WindowsIdentityContext {
    pub(crate) backend: windows_capability::WindowsIdentityBackend,
    pub(crate) security_level: IdentitySecurityLevel,
}

/// Resolves the Windows backend to operate against, or fails closed (§15).
pub(crate) fn resolve_identity_context() -> Result<WindowsIdentityContext, IdentityError> {
    let resolution = windows_capability::resolve_windows_identity_capability();
    match resolution.readiness {
        DeviceIdentityReadiness::Ready { security_level } => {
            let capability = resolution.capability.ok_or(IdentityError::ProviderFailure {
                kind: "MissingBackendDiagnostics",
                status: None,
            })?;
            Ok(WindowsIdentityContext {
                backend: capability.backend,
                security_level,
            })
        }
        DeviceIdentityReadiness::Unavailable { reason } => {
            Err(IdentityError::Unavailable { reason })
        }
    }
}

/// The CNG provider that implements a selected backend (Windows-only detail, §4).
fn provider_for(
    backend: windows_capability::WindowsIdentityBackend,
) -> (PCWSTR, &'static str) {
    match backend {
        windows_capability::WindowsIdentityBackend::PlatformCng => {
            (MS_PLATFORM_CRYPTO_PROVIDER, windows_tpm::PLATFORM_PROVIDER_LABEL)
        }
        windows_capability::WindowsIdentityBackend::SoftwareCng => (
            MS_KEY_STORAGE_PROVIDER,
            windows_capability::SOFTWARE_PROVIDER_LABEL,
        ),
    }
}

/// Maps a Windows adapter error onto the platform-neutral identity failure (§10).
fn backend_failure(error: &super::IdentityBackendError) -> IdentityError {
    IdentityError::ProviderFailure {
        kind: error.kind(),
        status: error.status(),
    }
}

// ---------------------------------------------------------------------------
// Ensure planning (pure — deterministic and testable without touching the key store)
// ---------------------------------------------------------------------------

/// What [`ensure_identity`] must do for one observed (key, metadata) combination (§20–§24).
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum EnsurePlan {
    /// Neither a key nor a record exists: legal first provisioning (§20).
    Provision,
    /// Both exist: the recorded identity must still BE the provider identity — same
    /// fingerprint and same security level (§23 / §24 / P7-S4R §7 / §8).
    Verify,
    /// Fail closed. Carries the exact reason so a caller can never flatten it into
    /// "provision a new identity".
    FailClosed(IdentityError),
}

/// Pure planner for the four (key present, metadata present) combinations.
///
/// Kept separate from every FFI call so the recovery / fail-closed rules are testable on
/// any machine — and so "no silent regeneration" is a property of the code, not of
/// whichever machine runs it (§21 / §22 / §25).
pub(crate) fn plan_ensure(key_present: bool, metadata_present: bool) -> EnsurePlan {
    match (key_present, metadata_present) {
        (false, false) => EnsurePlan::Provision,
        // P7-S4R §2 / §3 — NO SILENT ADOPT.
        //
        // Without trusted metadata, an existing production-name key cannot be
        // distinguished from interrupted provisioning, deleted state, or an
        // unexpected/pre-seeded key. Therefore it is not silently adopted: the identity
        // is never reconstructed from the key alone and the record is never rewritten
        // from an untrusted observation.
        //
        // (This is also the state a crash between key creation and record write leaves
        // behind — see the module docs: cross-resource atomicity does not exist.)
        (true, false) => EnsurePlan::FailClosed(IdentityError::IdentityMetadataMissing),
        (true, true) => EnsurePlan::Verify,
        // §22 — the identity material is gone. This is identity SECRET loss, never a
        // reason to mint a new identity: a silently regenerated identity would look like a
        // NEW device to every peer that once trusted this one.
        (false, true) => EnsurePlan::FailClosed(IdentityError::IdentityMaterialMissing),
    }
}

/// Pure verifier: does the recorded identity still describe the provider identity?
/// (P7-S4R §7 / §8)
///
/// Two independent facts are checked, and both fail closed:
///
/// - the canonical fingerprint (§23) — a same-named key in a different provider is a
///   DIFFERENT identity, never the same one with another security level;
/// - the security level — the recorded classification must equal the level currently
///   observed from the platform. V1 does NOT distinguish an upgrade from a downgrade:
///   `HardwareBacked → SoftwareIsolated` and `SoftwareIsolated → HardwareBacked` both fail,
///   and the record is never silently rewritten.
pub(crate) fn verify_established_state(
    record: &metadata::IdentityMetadata,
    identity: &DevicePublicIdentity,
    observed_level: IdentitySecurityLevel,
) -> Result<(), IdentityError> {
    if !identity.matches_fingerprint_hex(&record.fingerprint_hex) {
        return Err(IdentityError::FingerprintMismatch);
    }
    if record.security_level != observed_level {
        return Err(IdentityError::SecurityLevelMismatch);
    }
    Ok(())
}

/// Outcome of the best-effort cleanup of a key THIS CALL just created (P7-S4R §10).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ProvisionCleanup {
    /// The key was deleted and its absence was proven by an independent re-probe.
    Verified,
    /// The deletion itself failed.
    DeleteFailed { status: u32 },
    /// Deletion reported success, but absence could not be proven by re-probe.
    AbsenceNotProven { status: u32 },
    /// Presence could not be determined at all, so nothing is proven either way.
    ProbeFailed { status: u32 },
}

/// Pure mapper from a failed record write plus its cleanup outcome to the error a caller
/// sees (P7-S4R §10).
///
/// Only a PROVEN cleanup lets the original record error through. Anything else is reported
/// as `ProvisionCleanupIncomplete`, because "provisioning failed" must never be
/// understood as "the environment is back as it was".
pub(crate) fn provision_cleanup_error(
    record_error: IdentityError,
    cleanup: ProvisionCleanup,
) -> IdentityError {
    match cleanup {
        ProvisionCleanup::Verified => record_error,
        ProvisionCleanup::DeleteFailed { status } => IdentityError::ProvisionCleanupIncomplete {
            kind: "KeyDeleteFailed",
            status: Some(status),
        },
        ProvisionCleanup::AbsenceNotProven { status } => {
            IdentityError::ProvisionCleanupIncomplete {
                kind: "KeyAbsenceNotProven",
                status: Some(status),
            }
        }
        ProvisionCleanup::ProbeFailed { status } => IdentityError::ProvisionCleanupIncomplete {
            kind: "KeyPresenceProbeFailed",
            status: Some(status),
        },
    }
}

// ---------------------------------------------------------------------------
// Production operations
// ---------------------------------------------------------------------------

/// Ensures a V1 identity exists for `key_name` and returns its canonical public identity.
///
/// `key_name` is a parameter so the production path and the test path share ONE
/// implementation: tests pass a `zhixing-test-*` name, production passes
/// [`PRODUCTION_KEY_NAME`] (§31 / §32).
pub(crate) fn ensure_identity_locked(
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
) -> Result<DevicePublicIdentity, IdentityError> {
    // NOTE: the caller holds the key-store lock (see the `*_in` wrappers below).
    let (provider_name, label) = provider_for(context.backend);
    let provider = windows_cng::open_provider(provider_name, label)
        .map_err(|error| backend_failure(&error))?;

    // One OPEN per call, from which presence is derived. Nothing below re-opens the key by
    // name: everything that needs material derived from the key uses THIS handle.
    let key = windows_cng::open_persisted_key(&provider, key_name)
        .map_err(|error| backend_failure(&error))?;

    // A damaged record is fail-closed everywhere: it must never be treated as "no record",
    // because that would turn corruption into first provisioning (§19 / §23).
    let stored = metadata::load_identity_metadata(metadata_dir)?;

    match plan_ensure(key.is_some(), stored.is_some()) {
        EnsurePlan::FailClosed(error) => Err(error),
        EnsurePlan::Provision => provision_and_record(&provider, metadata_dir, key_name, context),
        EnsurePlan::Verify => {
            let record = stored.expect("Verify is only planned when a record exists");
            // §13 — the SAME verification every other entry point uses, on the SAME handle
            // whose presence was just established. No second open, and no second copy of
            // the rules: `ensure` must not grow its own reading of an established state.
            let key = key.expect("Verify is only planned when a key exists");
            Ok(verify_open_key(key, record, context.security_level)?.into_identity())
        }
    }
}

/// Creates the key, the policy, the identity — and records it (P7-S4R2 §2–§7 / §12).
///
/// Ownership: the key created by THIS attempt is held by a [`ProvisioningKeyGuard`] from
/// the moment it exists until identity establishment is COMMITTED. Every fallible step
/// runs inside that guard, so an ordinary `Err` from this function does not leave an
/// orphan behind: the key is deleted and its absence proven before returning.
fn provision_and_record(
    provider: &CngProviderHandle,
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
) -> Result<DevicePublicIdentity, IdentityError> {
    let handle = match windows_cng::create_persisted_key(
        provider,
        key_name,
        BCRYPT_ECDSA_P256_ALGORITHM,
    ) {
        Ok(handle) => CngKeyHandle::from_raw(handle),
        // §12 — an existing production-name key is NEVER overwritten. `NTE_EXISTS` means
        // another instance (or an earlier crashed run) created it, so re-enter state
        // reconciliation instead of forcing creation to succeed. Note that NO key is
        // created in this branch, so there is nothing to clean up.
        Err(error) if matches!(error, IdentityBackendError::KeyAlreadyExists { .. }) => {
            let status = error.status();
            return reconcile_after_duplicate(provider, metadata_dir, key_name, context, status);
        }
        Err(error) => return Err(backend_failure(&error)),
    };
    let mut guard = ProvisioningKeyGuard::new(provider, key_name, handle);

    // Steps BEFORE the durable record exists. Each one is fallible, and the guard owns
    // the key across all of them.
    let identity = match provision_pipeline(&mut guard) {
        Ok(identity) => identity,
        Err(error) => {
            // §6 — never hide an incomplete cleanup behind the original step error.
            let cleanup = guard.cleanup_armed();
            return Err(provision_cleanup_error(error, cleanup));
        }
    };

    // §4 — the logical COMMIT POINT of identity establishment is:
    //   key created + export policy validated + policy read back + key finalized
    //   + private export rejected + public identity derived + metadata durably written.
    // Only when ALL of those have happened does the guard give up the deletion
    // obligation; before that, every normal error path removes the new key.
    match persist_record(metadata_dir, &identity, context.security_level) {
        Ok(()) => {
            let _established_key = guard.disarm();
            Ok(identity)
        }
        Err(record_error) => {
            let cleanup = guard.cleanup_armed();
            Err(provision_cleanup_error(record_error, cleanup))
        }
    }
}

/// §12 — re-enters state reconciliation after a duplicate-name rejection.
///
/// The key is never overwritten. If a record now exists it is verified; if the record is
/// still missing the key stays unidentified and the call FAILS CLOSED.
fn reconcile_after_duplicate(
    provider: &CngProviderHandle,
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
    duplicate_status: Option<u32>,
) -> Result<DevicePublicIdentity, IdentityError> {
    // §12 + P7-S4R2 §13 — re-use the SAME reconciliation every other entry point uses.
    // A special second opinion here is exactly how two subtly different verification rules
    // get written.
    match open_established_identity(provider, metadata_dir, key_name, context.security_level) {
        Ok(verified) => Ok(verified.into_identity()),
        // Contradictory: a duplicate was rejected but the key is not there. Reported,
        // never papered over into a retry that could overwrite.
        Err(IdentityError::NotProvisioned) => Err(IdentityError::ProviderFailure {
            kind: "DuplicateCreateThenKeyAbsent",
            status: duplicate_status,
        }),
        // A record without a key stays `IdentityMaterialMissing`; a key without a record
        // stays `IdentityMetadataMissing`: never adopt, never overwrite.
        Err(error) => Err(error),
    }
}

// ---------------------------------------------------------------------------
// Provisioning key ownership (P7-S4R2 §2 / §3)
// ---------------------------------------------------------------------------

/// A key created by THIS provisioning attempt, carrying a DELETION OBLIGATION until
/// identity establishment is committed (P7-S4R2 §2 / §3).
///
/// This is NOT the general-purpose handle type. A [`CngKeyHandle`] means "free the
/// handle, never delete the persisted key", which is exactly right for an EXISTING
/// identity key (opening an identity key must never be able to delete it) and exactly
/// wrong for a half-created one (a dropped-but-not-recorded key is an orphan).
///
/// Therefore:
///
/// - a key created here is placed in this guard while it is still uncommitted;
/// - any `Drop` while still armed deletes it (best effort; the normal error paths do this
///   explicitly so they can PROVE it);
/// - a successful establishment DISARMS it, and the key continues life as a plain
///   [`CngKeyHandle`];
/// - an EXISTING key opened by [`open_established_identity`] is never put in this guard.
pub(crate) struct ProvisioningKeyGuard<'provider> {
    /// Needed for the independent absence probe that turns a delete into proof.
    provider: &'provider CngProviderHandle,
    key_name: String,
    /// `Some` while armed, `None` once cleaned up or disarmed.
    key: Option<CngKeyHandle>,
}

impl<'provider> ProvisioningKeyGuard<'provider> {
    /// Arms the guard with a key that THIS attempt just created.
    fn new(provider: &'provider CngProviderHandle, key_name: &str, key: CngKeyHandle) -> Self {
        Self {
            provider,
            key_name: key_name.to_string(),
            key: Some(key),
        }
    }

    /// The live handle of the key being provisioned.
    ///
    /// Every step operates on THIS handle, so there is never a second lookup by name to
    /// disagree with (P7-S4R2 §8).
    fn key(&self) -> Result<&CngKeyHandle, IdentityError> {
        self.key.as_ref().ok_or(IdentityError::ProviderFailure {
            kind: "ProvisionGuardDisarmed",
            status: None,
        })
    }

    /// Deletes the armed key now and returns how far the cleanup could be PROVEN.
    ///
    /// `None` (already cleaned / disarmed) counts as `Verified`: nothing left behind is
    /// the thing that was wanted.
    fn cleanup_armed(&mut self) -> ProvisionCleanup {
        match self.key.take() {
            None => ProvisionCleanup::Verified,
            Some(key) => delete_and_prove_absence(self.provider, key, &self.key_name),
        }
    }

    /// COMMIT POINT: hands the key back as an ordinary handle with NO deletion
    /// obligation, because identity establishment succeeded (§4).
    fn disarm(mut self) -> CngKeyHandle {
        self.key
            .take()
            .expect("disarm is reached only while the guard is still armed")
    }

    /// `true` while a deletion obligation exists. Used by tests to prove the ownership
    /// rules without guessing at them.
    pub(crate) fn is_armed(&self) -> bool {
        self.key.is_some()
    }
}

impl Drop for ProvisioningKeyGuard<'_> {
    fn drop(&mut self) {
        // Only reached while armed on a panic path (every ordinary error path cleans up
        // first so it can REPORT the evidence). Still best-effort cleanup so an unwinding
        // panic does not leave an orphan either.
        if self.key.is_some() {
            self.cleanup_armed();
        }
    }
}

/// Deletes THIS handle's key and proves absence with a FRESH probe (§6).
///
/// A delete STATUS is not proof, so the result is `Verified` only when an independent
/// probe reports the key absent.
fn delete_and_prove_absence(
    provider: &CngProviderHandle,
    key: CngKeyHandle,
    key_name: &str,
) -> ProvisionCleanup {
    if let Err(error) = windows_cng::delete_persisted_key(key, key_name) {
        return ProvisionCleanup::DeleteFailed {
            status: error.status().unwrap_or(0),
        };
    }
    match windows_cng::persisted_key_is_present(provider, key_name) {
        PersistedKeyPresence::Absent => ProvisionCleanup::Verified,
        PersistedKeyPresence::Present => ProvisionCleanup::AbsenceNotProven { status: 0 },
        // §8 — "could not determine presence" is its own outcome, not a weaker form of
        // "still there". Keeping them apart is what lets the machine token stay
        // `KeyPresenceProbeFailed` and lets diagnostics tell the two apart.
        PersistedKeyPresence::ProbeFailed { status } => ProvisionCleanup::ProbeFailed { status },
    }
}

// ---------------------------------------------------------------------------
// Single reconciliation — the one state machine every entry point shares (P7-S4R2 §9–§13)
// ---------------------------------------------------------------------------

/// An EXISTING identity key that has been opened ONCE and verified against the durable
/// record, together with the identity derived from THAT handle (P7-S4R2 §9).
///
/// Bundling them is the invariant itself: the only way to get a signature is to consume
/// `self`, so the handle that signs is necessarily the handle whose identity was verified
/// — there is no second key lookup anywhere downstream.
pub(crate) struct VerifiedIdentityKey {
    key: CngKeyHandle,
    identity: DevicePublicIdentity,
}

impl VerifiedIdentityKey {
    /// The handle that was verified. Signing uses THIS handle, never a freshly opened one.
    pub(crate) fn key(&self) -> &CngKeyHandle {
        &self.key
    }

    /// The canonical identity derived from that same handle.
    pub(crate) fn identity(&self) -> &DevicePublicIdentity {
        &self.identity
    }

    pub(crate) fn into_identity(self) -> DevicePublicIdentity {
        self.identity
    }

    /// Splits into (handle, identity) so the sign path can consume the handle it verified.
    fn into_parts(self) -> (CngKeyHandle, DevicePublicIdentity) {
        (self.key, self.identity)
    }
}

impl std::fmt::Debug for VerifiedIdentityKey {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // The raw HANDLE is never rendered: it is not diagnostics, it is a key reference.
        formatter
            .debug_struct("VerifiedIdentityKey")
            .field("identity", &self.identity)
            .finish_non_exhaustive()
    }
}

/// The ONE verification of an ALREADY-OPEN key against an ALREADY-LOADED record
/// (P7-S4R2 §9 / §13).
///
/// Every entry point goes through here for the "both present" state: `ensure`'s Verify
/// branch hands in the handle it already opened, and [`open_established_identity`] hands
/// in the one it just opened. That is why there is no second, subtly different
/// verification rule — and why the identity is always derived from the very handle that
/// the caller is about to act on.
fn verify_open_key(
    key: CngKeyHandle,
    record: metadata::IdentityMetadata,
    observed_level: IdentitySecurityLevel,
) -> Result<VerifiedIdentityKey, IdentityError> {
    // Derived from THIS handle; nothing reopens the key afterwards (§11 / §12).
    let identity = derive_identity_from_key(&key)?;
    verify_established_state(&record, &identity, observed_level)?;
    Ok(VerifiedIdentityKey { key, identity })
}

/// The SINGLE state reconciliation used by `ensure`, `public_identity` and `sign`
/// (P7-S4R2 §10).
///
/// Deliberately total over the four combinations, so no caller can invent its own reading
/// of an incomplete state:
///
/// ```text
/// key absent  + metadata absent  → NOT_PROVISIONED
/// key present + metadata absent  → IDENTITY_METADATA_MISSING
/// key absent  + metadata present → IDENTITY_MATERIAL_MISSING
/// key present + metadata present → derive from THIS handle → fingerprint verify
///                                                          → security-level verify → READY
/// ```
///
/// The error consistency requirement (§14 / §15) lives here: there is no code path that
/// can report `NOT_PROVISIONED` for anything other than "both absent".
fn open_established_identity(
    provider: &CngProviderHandle,
    metadata_dir: &Path,
    key_name: &str,
    observed_level: IdentitySecurityLevel,
) -> Result<VerifiedIdentityKey, IdentityError> {
    let stored = metadata::load_identity_metadata(metadata_dir)?;
    let key = windows_cng::open_persisted_key(provider, key_name)
        .map_err(|error| backend_failure(&error))?;
    match (key, stored) {
        (None, None) => Err(IdentityError::NotProvisioned),
        // An orphaned key is not silently adopted and is never reported as
        // "nothing provisioned" either — the same answer every entry point must give.
        (Some(_), None) => Err(IdentityError::IdentityMetadataMissing),
        (None, Some(_)) => Err(IdentityError::IdentityMaterialMissing),
        (Some(key), Some(record)) => verify_open_key(key, record, observed_level),
    }
}

/// Reads the already-established identity. NEVER provisions (§26).
pub(crate) fn public_identity_locked(
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
) -> Result<DevicePublicIdentity, IdentityError> {
    let (provider_name, label) = provider_for(context.backend);
    let provider = windows_cng::open_provider(provider_name, label)
        .map_err(|error| backend_failure(&error))?;

    // P7-S4R2 §10 / §11 — ONE open, ONE derivation, ONE verification. The identity
    // returned is the one derived from that very handle: no open → drop → re-open-by-name.
    let verified = open_established_identity(
        &provider,
        metadata_dir,
        key_name,
        context.security_level,
    )?;
    Ok(verified.into_identity())
}

/// Signs an UNHASHED authentication message with the identity key (§12 / §28).
///
/// SHA-256 is computed exactly once here; the provider signs the digest. The recorded
/// identity must still match the key, so a key that no longer corresponds to the recorded
/// fingerprint can never produce a signature (§23).
pub(crate) fn sign_identity_locked(
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
    message: &[u8],
) -> Result<DeviceSignature, IdentityError> {
    let (provider_name, label) = provider_for(context.backend);
    let provider = windows_cng::open_provider(provider_name, label)
        .map_err(|error| backend_failure(&error))?;

    // §10 / §12 — ONE open, ONE derivation from that handle, ONE verification, and then
    // the SAME handle signs. The verification cannot be reopened later, because the
    // verified bundle is what gets consumed.
    let verified = open_established_identity(
        &provider,
        metadata_dir,
        key_name,
        context.security_level,
    )?;
    sign_with_verified_key(verified, message)
}

/// Encodes the Windows CNG signing output into the shared DER signature format
/// (P7-S4R3 §3 / §4).
///
/// `NCryptSignHash` emits a fixed-width IEEE-P1363 `r || s` (64 bytes for P-256). That is
/// a CONTRACT FACT about the Windows provider — established by the P7-T2V runtime evidence
/// and the rustls-cng reference path — so here the length is REQUIRED and the conversion
/// is unconditional:
///
/// ```text
/// len != 64  →  FAIL CLOSED  SignFailed / "UnexpectedSignatureFormat"
/// len == 64  →  p1363_to_der(raw)
/// ```
///
/// There is deliberately no "if it parses as DER, hand the provider bytes straight back"
/// branch. A 64-byte P-1363 signature is not guaranteed to lie outside the set of
/// syntactically valid DER byte strings, so such a branch could return the provider's raw
/// output AS the DER signature — a signature no peer could ever verify — and would do it
/// only for the inputs that happen to parse. Deciding by contract removes the ambiguity;
/// a future Android adapter knows its own provider emits DER and validates that itself.
fn windows_signature_der(raw: &[u8]) -> Result<Vec<u8>, IdentityError> {
    if raw.len() != der::P1363_SIGNATURE_LEN {
        // Not the contracted representation, so nothing may be assumed about it.
        return Err(IdentityError::SignFailed {
            kind: "UnexpectedSignatureFormat",
            status: None,
        });
    }
    der::p1363_to_der(raw).map_err(|_| IdentityError::SignFailed {
        kind: "DerConversionFailed",
        status: None,
    })
}

/// Signs with the key handle whose identity was just verified (P7-S4R2 §12).
///
/// Invariant, enforced by the signature of this function: it receives no provider and no
/// key name, so there is literally no way to look the key up a second time. The handle
/// that produced the verified public identity is the handle that signs.
fn sign_with_verified_key(
    verified: VerifiedIdentityKey,
    message: &[u8],
) -> Result<DeviceSignature, IdentityError> {
    let (key, _verified_identity) = verified.into_parts();

    // SHA-256 exactly once, over the UNHASHED message.
    let digest = sha2::Sha256::digest(message);
    let raw = windows_cng::sign_hash(key.raw(), digest.as_slice())
        .map_err(|error| IdentityError::SignFailed {
            kind: error.kind(),
            status: error.status(),
        })?;

    // P7-S4R3 — the provider representation is KNOWN, never inferred: require the
    // contracted 64-byte P-1363 form and convert it deterministically.
    let der = windows_signature_der(&raw)?;

    Ok(DeviceSignature {
        scheme: DeviceSignatureScheme::EcdsaP256Sha256,
        der,
    })
}

// P7-S4R §13 — there is deliberately NO `reset_identity` function here. Rotation and
// reset remain frozen ARCHITECTURE semantics; the API is deferred until a real caller
// exists, because a function whose only behavior is "not permitted" is a fake API.

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Test-only provisioning fault injection (P7-S4R2 §7 / §18)
// ---------------------------------------------------------------------------
//
// Five provisioning steps cannot be made to fail on a healthy machine without damaging
// it. To test the CLEANUP POLICY deterministically, a one-shot fault can be armed at
// exactly one of those steps.
//
// The injection exists ONLY under `cfg(test)`: in a production build every `fault_gate!`
// expands to nothing, so no test vocabulary and no injection point reaches production
// code. This deliberately does NOT become a generic "inject anything" mechanism — it is
// one enum, one thread-local, six call sites.

#[cfg(test)]
pub(crate) mod provision_fault {
    use std::cell::Cell;

    /// The provisioning steps that accept an injected failure.
    #[derive(Debug, Clone, Copy, PartialEq, Eq)]
    pub(crate) enum Stage {
        SetExportPolicy,
        PolicyReadbackMismatch,
        Finalize,
        PrivateExportValidation,
        PublicIdentityDerivation,
    }

    impl Stage {
        /// Stable name for assertion messages.
        pub(crate) fn name(self) -> &'static str {
            match self {
                Self::SetExportPolicy => "SetExportPolicy",
                Self::PolicyReadbackMismatch => "PolicyReadbackMismatch",
                Self::Finalize => "Finalize",
                Self::PrivateExportValidation => "PrivateExportValidation",
                Self::PublicIdentityDerivation => "PublicIdentityDerivation",
            }
        }
    }

    thread_local! {
        /// One-shot and per test thread: `cargo test` runs each test on its own thread, so
        /// an armed fault can never leak into another test.
        static ARMED: Cell<Option<Stage>> = const { Cell::new(None) };
    }

    /// Arms a one-shot fault; it fires at its own step and nowhere else.
    pub(crate) fn arm(stage: Stage) {
        ARMED.set(Some(stage));
    }

    /// `true` exactly once, only when `stage` is the armed step. A mismatch leaves the
    /// fault armed, so it cannot silently fire somewhere else instead.
    pub(crate) fn fire(stage: Stage) -> bool {
        ARMED.with(|cell| {
            if cell.get() == Some(stage) {
                cell.set(None);
                true
            } else {
                false
            }
        })
    }

    /// Safety net for a test that arms a fault and then takes an early return.
    pub(crate) fn clear() {
        ARMED.set(None);
    }
}

/// Injects a deterministic failure at one provisioning step. Contributes NOTHING to a
/// production build.
macro_rules! fault_gate {
    ($stage:ident => $error:expr) => {
        #[cfg(test)]
        {
            if provision_fault::fire(provision_fault::Stage::$stage) {
                return Err($error);
            }
        }
    };
}

/// Every step between "the key exists" and "a derivable public identity", run on ONE
/// handle (P7-S4R2 §4 / §7).
///
/// Order matters: the export policy is written and READ BACK before the key is finalized,
/// so a key that could turn out to be exportable is never finalized into an identity.
/// There is only ONE caller ([`provision_pipeline`]), which always runs it inside the
/// provisioning guard — no other code path may create a key and then fail unguarded.
fn provision_key_steps(key: &CngKeyHandle) -> Result<DevicePublicIdentity, IdentityError> {
    // §30 — private export disabled, explicitly.
    fault_gate!(
        SetExportPolicy =>
        IdentityError::ProviderFailure { kind: "ExportPolicyWriteFailed", status: None }
    );
    windows_cng::set_export_policy_disabled(key.raw()).map_err(|error| backend_failure(&error))?;

    // Read back BEFORE finalizing: a policy that did not stick is never finalized into an
    // identity (fail closed).
    fault_gate!(
        PolicyReadbackMismatch =>
        IdentityError::UnexpectedPrivateExportSuccess
    );
    let policy = windows_cng::read_dword_property(
        key.raw(),
        NCRYPT_EXPORT_POLICY_PROPERTY,
        "Export Policy",
    )
    .map_err(|error| backend_failure(&error))?;
    if policy != NON_EXPORTABLE_POLICY {
        return Err(IdentityError::UnexpectedPrivateExportSuccess);
    }

    fault_gate!(
        Finalize =>
        IdentityError::ProviderFailure { kind: "FinalizeFailed", status: None }
    );
    windows_cng::finalize_key(key.raw()).map_err(|error| backend_failure(&error))?;

    // Belt and braces: the private blob must STILL not be exportable after finalization.
    fault_gate!(
        PrivateExportValidation =>
        IdentityError::UnexpectedPrivateExportSuccess
    );
    let private_export_status =
        windows_cng::attempt_private_export_status(key.raw(), BCRYPT_ECCPRIVATE_BLOB);
    if private_export_status == 0 {
        return Err(IdentityError::UnexpectedPrivateExportSuccess);
    }

    // The canonical public identity, derived from THIS handle.
    fault_gate!(
        PublicIdentityDerivation =>
        IdentityError::PublicIdentityUnavailable { kind: "PublicBlobExportFailed", status: None }
    );
    derive_identity_from_key(key)
}

/// The provisioning pipeline proper: the guarded handle, through every step that has to
/// succeed before an identity may be recorded (P7-S4R2 §2 / §4 / §7).
///
/// Every step runs INSIDE [`ProvisioningKeyGuard`], so any `Err` here leaves the caller an
/// armed guard to clean up with evidence.
fn provision_pipeline(
    guard: &mut ProvisioningKeyGuard<'_>,
) -> Result<DevicePublicIdentity, IdentityError> {
    provision_key_steps(guard.key()?)
}

/// Exports the PUBLIC blob of an open key and turns it into the canonical identity (§8).
fn derive_identity_from_key(key: &CngKeyHandle) -> Result<DevicePublicIdentity, IdentityError> {
    let blob = windows_cng::export_public_blob(key.raw(), BCRYPT_ECCPUBLIC_BLOB)
        .map_err(|error| IdentityError::PublicIdentityUnavailable {
            kind: error.kind(),
            status: error.status(),
        })?;
    let point = der::parse_bcrypt_public_blob(&blob).map_err(|_| {
        IdentityError::PublicIdentityUnavailable {
            kind: "NonP256PublicBlob",
            status: None,
        }
    })?;
    let spki = der::spki_from_point(&point);
    DevicePublicIdentity::from_spki(spki.to_vec())
}

/// Records the established identity atomically (§18 / §19).
fn persist_record(
    metadata_dir: &Path,
    identity: &DevicePublicIdentity,
    security_level: IdentitySecurityLevel,
) -> Result<(), IdentityError> {
    let record = metadata::IdentityMetadata::established(
        identity.algorithm(),
        identity.fingerprint_hex(),
        security_level,
    );
    metadata::store_identity_metadata(metadata_dir, &record)?;
    Ok(())
}

// ---------------------------------------------------------------------------
// Locking wrappers — the single place the key-store lock is taken
// ---------------------------------------------------------------------------
//
// The Windows key store is a SHARED, process-external resource and `cargo test` runs
// tests in parallel, so every public entry point serializes its work with every other
// user of the store (including the capability sweep). The implementations above assume
// the lock is already held — a `std::sync::Mutex` is NOT reentrant, so taking it twice
// on one thread would deadlock.

/// `ensure_identity` against an explicit key name (production: [`PRODUCTION_KEY_NAME`];
/// tests: a `zhixing-test-*` name, §31 / §32).
pub(crate) fn ensure_identity_in(
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
) -> Result<DevicePublicIdentity, IdentityError> {
    let _guard = windows_cng::keystore_lock();
    ensure_identity_locked(metadata_dir, key_name, context)
}

/// Read-only identity read against an explicit key name (§26).
pub(crate) fn public_identity_in(
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
) -> Result<DevicePublicIdentity, IdentityError> {
    let _guard = windows_cng::keystore_lock();
    public_identity_locked(metadata_dir, key_name, context)
}

/// Signing against an explicit key name (§12 / §28).
pub(crate) fn sign_in(
    metadata_dir: &Path,
    key_name: &str,
    context: WindowsIdentityContext,
    message: &[u8],
) -> Result<DeviceSignature, IdentityError> {
    let _guard = windows_cng::keystore_lock();
    sign_identity_locked(metadata_dir, key_name, context, message)
}

// ---------------------------------------------------------------------------
// Trait implementation for the Windows adapter
// ---------------------------------------------------------------------------

impl DeviceIdentityCapability for windows_capability::WindowsDeviceIdentityProvider {
    fn ensure_identity(
        &self,
        metadata_dir: &Path,
    ) -> Result<DevicePublicIdentity, IdentityError> {
        let context = resolve_identity_context()?;
        // The locking wrapper: production entry points must serialize key-store access.
        ensure_identity_in(metadata_dir, PRODUCTION_KEY_NAME, context)
    }

    fn public_identity(
        &self,
        metadata_dir: &Path,
    ) -> Result<DevicePublicIdentity, IdentityError> {
        let context = resolve_identity_context()?;
        public_identity_in(metadata_dir, PRODUCTION_KEY_NAME, context)
    }

    fn sign(&self, metadata_dir: &Path, message: &[u8]) -> Result<DeviceSignature, IdentityError> {
        let context = resolve_identity_context()?;
        sign_in(metadata_dir, PRODUCTION_KEY_NAME, context, message)
    }
}

/// The production key name is app-specific, versioned, and outside the test namespace.
/// Exposed for the string-level unit test required by §31 (no test ever creates it).
pub(crate) fn production_key_name_for_test() -> &'static str {
    PRODUCTION_KEY_NAME
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::device_identity::DeviceIdentityAlgorithm;
    use windows_cng::{keystore_lock, CNG_SUCCESS};
    use windows_sys::Win32::Foundation::NTE_EXISTS;
    use windows_sys::Win32::Security::Cryptography::{
        BCryptCloseAlgorithmProvider, BCryptDestroyKey, BCryptImportKeyPair,
        BCryptOpenAlgorithmProvider, BCryptVerifySignature, BCRYPT_ALG_HANDLE, BCRYPT_KEY_HANDLE,
    };

    /// Tests run against the Software KSP on purpose: the identity lifecycle rules under
    /// test (provisioning, adoption, mismatch, signing) are backend-independent, and this
    /// keeps the probe from consuming the machine's limited TPM persistent-key slots.
    /// Backend SELECTION (hardware vs software) is covered by the pure tests in
    /// `windows_capability`.
    fn test_context() -> WindowsIdentityContext {
        WindowsIdentityContext {
            backend: windows_capability::WindowsIdentityBackend::SoftwareCng,
            security_level: IdentitySecurityLevel::SoftwareIsolated,
        }
    }

    fn software_provider() -> CngProviderHandle {
        windows_cng::open_provider(
            MS_KEY_STORAGE_PROVIDER,
            windows_capability::SOFTWARE_PROVIDER_LABEL,
        )
        .expect("the Software KSP must open on this machine")
    }

    /// Owns a `zhixing-test-*` key and deletes it on every exit path (§32 / §40).
    struct TestKeyGuard {
        name: String,
    }

    impl TestKeyGuard {
        fn new(purpose: &str) -> Self {
            Self {
                name: windows_cng::unique_test_key_name(purpose),
            }
        }

        fn name(&self) -> &str {
            &self.name
        }

        /// Deletes the key and proves it is gone (a delete status alone is not proof).
        fn cleanup(&self) {
            let provider = software_provider();
            if let Ok(Some(key)) = windows_cng::open_persisted_key(&provider, &self.name) {
                windows_cng::delete_persisted_key(key, &self.name).expect("test key delete");
            }
            assert_eq!(
                windows_cng::persisted_key_is_present(&provider, &self.name),
                PersistedKeyPresence::Absent,
                "test key {} must be gone",
                self.name
            );
        }
    }

    impl Drop for TestKeyGuard {
        fn drop(&mut self) {
            self.cleanup();
        }
    }

    // --- §16 / §31 — the production key name (value only, never created) ------

    #[test]
    fn production_key_name_is_versioned_and_outside_the_test_namespace() {
        let name = production_key_name_for_test();
        assert!(name.starts_with("zhixing-"), "app-specific: {name}");
        assert!(name.contains("device-identity"), "names the identity: {name}");
        assert!(name.ends_with("-v1"), "versioned: {name}");
        assert!(
            !name.starts_with("zhixing-test"),
            "the production name must never live in the test namespace: {name}"
        );
    }

    // --- §20–§25 — the pure ensure plan ---------------------------------------

    #[test]
    fn ensure_plan_covers_all_four_combinations() {
        assert_eq!(plan_ensure(false, false), EnsurePlan::Provision);
        // P7-S4R §2 — SILENT ADOPT REMOVED: an orphaned key is FAIL CLOSED, because
        // without trusted metadata it cannot be told apart from interrupted provisioning,
        // deleted state, or an unexpected/pre-seeded key.
        assert_eq!(
            plan_ensure(true, false),
            EnsurePlan::FailClosed(IdentityError::IdentityMetadataMissing)
        );
        assert_eq!(plan_ensure(true, true), EnsurePlan::Verify);
        // §22 / §25 — a lost key with a record is FAIL CLOSED, never a regeneration.
        assert_eq!(
            plan_ensure(false, true),
            EnsurePlan::FailClosed(IdentityError::IdentityMaterialMissing)
        );
        // …and the two fail-closed answers are never the same answer.
        assert_ne!(plan_ensure(true, false), plan_ensure(false, true));
        // P7-S4R2 §13 — the planner and the shared reconciliation speak the SAME error
        // vocabulary, so `ensure` can never drift from `public_identity` / `sign`.
        for (plan, expected) in [
            (plan_ensure(true, false), "IDENTITY_METADATA_MISSING"),
            (plan_ensure(false, true), "IDENTITY_MATERIAL_MISSING"),
        ] {
            match plan {
                EnsurePlan::FailClosed(error) => assert_eq!(error.kind(), expected),
                other => panic!("expected a fail-closed plan, got {other:?}"),
            }
        }
    }

    /// P7-S4R §7 — a recorded fingerprint that no longer matches fails closed.
    #[test]
    fn verify_established_state_rejects_a_fingerprint_change() {
        let record = metadata::IdentityMetadata::established(
            DeviceIdentityAlgorithm::EcdsaP256Sha256,
            "0".repeat(64),
            IdentitySecurityLevel::SoftwareIsolated,
        );
        let identity = DevicePublicIdentity::from_spki(canonical_test_spki(0x11)).expect("spki");
        let error = verify_established_state(&record, &identity, IdentitySecurityLevel::SoftwareIsolated)
            .expect_err("a fingerprint change must fail closed");
        assert_eq!(error.kind(), "FINGERPRINT_MISMATCH");
    }

    /// P7-S4R §8 — security-level DRIFT fails closed in BOTH directions: V1 does not
    /// distinguish an upgrade from a downgrade, and never rewrites the record.
    #[test]
    fn verify_established_state_rejects_security_level_drift_in_both_directions() {
        let identity = DevicePublicIdentity::from_spki(canonical_test_spki(0x11)).expect("spki");
        let hex = identity.fingerprint_hex();

        // Recorded HardwareBacked, observed SoftwareIsolated (a downgrade).
        let stored_hardware = metadata::IdentityMetadata::established(
            DeviceIdentityAlgorithm::EcdsaP256Sha256,
            hex.clone(),
            IdentitySecurityLevel::HardwareBacked,
        );
        let error = verify_established_state(
            &stored_hardware,
            &identity,
            IdentitySecurityLevel::SoftwareIsolated,
        )
        .expect_err("HardwareBacked → SoftwareIsolated must fail closed");
        assert_eq!(error.kind(), "SECURITY_LEVEL_MISMATCH");

        // Recorded SoftwareIsolated, observed HardwareBacked (an upgrade).
        let stored_software = metadata::IdentityMetadata::established(
            DeviceIdentityAlgorithm::EcdsaP256Sha256,
            hex.clone(),
            IdentitySecurityLevel::SoftwareIsolated,
        );
        let error = verify_established_state(
            &stored_software,
            &identity,
            IdentitySecurityLevel::HardwareBacked,
        )
        .expect_err("SoftwareIsolated → HardwareBacked must fail closed too");
        assert_eq!(error.kind(), "SECURITY_LEVEL_MISMATCH");

        // Matching level: accepted (this is the Verify steady state).
        verify_established_state(&stored_software, &identity, IdentitySecurityLevel::SoftwareIsolated)
            .expect("a matching level must verify");
    }

    /// P7-S4R §10 — only a PROVEN cleanup lets the record error through; anything else is
    /// reported as an incomplete cleanup, never as "provisioning failed, all clean".
    #[test]
    fn provision_cleanup_only_reports_success_when_absence_is_proven() {
        let record_error = IdentityError::MetadataIo {
            detail: "atomic_write_failed",
        };
        let verified =
            provision_cleanup_error(record_error.clone(), ProvisionCleanup::Verified);
        assert_eq!(verified.kind(), "METADATA_IO");

        for (cleanup, expected_detail) in [
            (ProvisionCleanup::DeleteFailed { status: 5 }, "KeyDeleteFailed"),
            (
                ProvisionCleanup::AbsenceNotProven { status: 0 },
                "KeyAbsenceNotProven",
            ),
            (
                ProvisionCleanup::ProbeFailed { status: 7 },
                "KeyPresenceProbeFailed",
            ),
        ] {
            let error = provision_cleanup_error(record_error.clone(), cleanup);
            assert_eq!(error.kind(), "PROVISION_CLEANUP_INCOMPLETE", "{cleanup:?}");
            assert_eq!(error.detail(), Some(expected_detail), "{cleanup:?}");
            assert_eq!(error.status(), Some(cleanup_status(cleanup)), "{cleanup:?}");
        }
    }

    fn cleanup_status(cleanup: ProvisionCleanup) -> u32 {
        match cleanup {
            ProvisionCleanup::Verified => 0,
            ProvisionCleanup::DeleteFailed { status }
            | ProvisionCleanup::AbsenceNotProven { status }
            | ProvisionCleanup::ProbeFailed { status } => status,
        }
    }

    /// A canonical P-256 SPKI for pure tests that never touch the key store.
    fn canonical_test_spki(fill: u8) -> Vec<u8> {
        let mut spki = der::P256_SPKI_PREFIX.to_vec();
        spki.push(0x04);
        spki.extend(std::iter::repeat(fill).take(der::P256_POINT_LEN - 1));
        spki
    }

    /// §25 — repeated `ensure_identity` returns the SAME identity and never a second key.
    #[test]
    fn ensure_identity_is_idempotent() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("ensure-idempotent");

        let first = ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let second = ensure_identity_locked(dir.path(), key.name(), test_context()).expect("re-ensure");
        assert_eq!(first, second, "ensure must be idempotent");
        assert_eq!(first.algorithm(), DeviceIdentityAlgorithm::EcdsaP256Sha256);
        assert_eq!(first.spki_der().len(), der::P256_SPKI_LEN);

        // The record exists exactly once and matches the identity (§18 / §19).
        let record = metadata::load_identity_metadata(dir.path())
            .expect("load")
            .expect("record present");
        assert!(first.matches_fingerprint_hex(&record.fingerprint_hex));
        assert_eq!(record.security_level, IdentitySecurityLevel::SoftwareIsolated);
    }

    /// §20 — first provisioning creates the key AND records it atomically.
    #[test]
    fn first_provisioning_records_the_identity() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("first-provisioning");
        let provider = software_provider();

        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent
        );
        let identity = ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Present
        );
        let record = metadata::load_identity_metadata(dir.path())
            .expect("load")
            .expect("record written");
        assert!(record.established);
        assert_eq!(record.generation, metadata::IDENTITY_GENERATION_V1);
        assert_eq!(record.algorithm, DeviceIdentityAlgorithm::EcdsaP256Sha256);
        assert!(identity.matches_fingerprint_hex(&record.fingerprint_hex));
    }

    /// §26 — `public_identity` reads an existing identity and never creates one.
    #[test]
    fn public_identity_never_creates_a_key() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("public-readonly");
        let provider = software_provider();

        let error = public_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("nothing provisioned yet");
        assert_eq!(error.kind(), "NOT_PROVISIONED");
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent,
            "a read must not provision"
        );

        // Once provisioned, the read returns the same identity.
        let provisioned =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let read = public_identity_locked(dir.path(), key.name(), test_context()).expect("read");
        assert_eq!(provisioned, read);
    }

    /// P7-S4R §2 / §3 — SILENT ADOPT IS GONE.
    ///
    /// A key without a record is FAIL CLOSED with `IDENTITY_METADATA_MISSING`: without
    /// trusted metadata an existing production-name key cannot be distinguished from
    /// interrupted provisioning, deleted state, or an unexpected/pre-seeded key. The key
    /// is not overwritten, not deleted, and no record is reconstructed from it.
    #[test]
    fn key_without_metadata_fails_closed_and_is_never_adopted() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("no-adopt");
        let provider = software_provider();

        let original =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        metadata::delete_identity_metadata(dir.path()).expect("drop the record");

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("an orphaned key must fail closed");
        assert_eq!(error.kind(), "IDENTITY_METADATA_MISSING");
        // No record was reconstructed from the key (no silent adopt).
        assert_eq!(
            metadata::load_identity_metadata(dir.path()).expect("load"),
            None,
            "metadata must never be reconstructed from an untrusted key"
        );
        // The key itself was neither deleted nor replaced.
        let handle = windows_cng::open_persisted_key(&provider, key.name())
            .expect("probe")
            .expect("the orphaned key must be left alone");
        let blob = windows_cng::export_public_blob(handle.raw(), BCRYPT_ECCPUBLIC_BLOB)
            .expect("public export");
        let point = der::parse_bcrypt_public_blob(&blob).expect("P-256 blob");
        assert_eq!(
            &der::spki_from_point(&point)[..],
            original.spki_der(),
            "the existing key must never be overwritten with a new one"
        );
        // …and EVERY other entry point gives the SAME answer for this state (P7-S4R2 §14:
        // `NOT_PROVISIONED` means both absent, never an incomplete established state).
        assert_eq!(
            public_identity_locked(dir.path(), key.name(), test_context())
                .expect_err("read on an orphaned key")
                .kind(),
            "IDENTITY_METADATA_MISSING"
        );
        assert_eq!(
            sign_identity_locked(dir.path(), key.name(), test_context(), b"message")
                .expect_err("sign on an orphaned key")
                .kind(),
            "IDENTITY_METADATA_MISSING"
        );
        // NOT_PROVISIONED is reserved for "nothing at all here".
        assert_eq!(
            plan_ensure(false, false),
            EnsurePlan::Provision,
            "both absent is the only NOT_PROVISIONED state"
        );
        assert_eq!(
            open_established_identity(
                &provider,
                dir.path(),
                key.name(),
                IdentitySecurityLevel::SoftwareIsolated
            )
            .expect_err("single reconciliation")
            .kind(),
            "IDENTITY_METADATA_MISSING"
        );
    }

    /// P7-S4R §8 — drift between the recorded and the observed security level fails
    /// closed against the REAL backend, in the downgrade direction the platform can
    /// actually produce here (recorded hardware-backed, observed software-isolated).
    #[test]
    fn security_level_drift_fails_closed_on_the_real_backend() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("level-drift");

        ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let mut record = metadata::load_identity_metadata(dir.path())
            .expect("load")
            .expect("record");
        record.security_level = IdentitySecurityLevel::HardwareBacked;
        metadata::store_identity_metadata(dir.path(), &record).expect("rewrite record");

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("drift must fail closed");
        assert_eq!(error.kind(), "SECURITY_LEVEL_MISMATCH");
        // The record is never silently rewritten back to the observed level.
        assert_eq!(
            metadata::load_identity_metadata(dir.path())
                .expect("load")
                .expect("record")
                .security_level,
            IdentitySecurityLevel::HardwareBacked
        );
        // Reading and signing fail closed for exactly the same reason.
        assert_eq!(
            public_identity_locked(dir.path(), key.name(), test_context())
                .expect_err("read")
                .kind(),
            "SECURITY_LEVEL_MISMATCH"
        );
        assert_eq!(
            sign_identity_locked(dir.path(), key.name(), test_context(), b"message")
                .expect_err("sign")
                .kind(),
            "SECURITY_LEVEL_MISMATCH"
        );
    }

    /// P7-S4R §5 — a corrupt record fails closed WITH the key present, and neither the
    /// record nor the key is touched on the way out.
    #[test]
    fn corrupt_metadata_with_the_key_present_fails_closed() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("corrupt-with-key");
        let provider = software_provider();

        ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        std::fs::write(metadata::metadata_path(dir.path()), b"{ not json").expect("write");

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("a corrupt record must fail closed");
        assert_eq!(error.kind(), "METADATA_CORRUPT");
        assert_eq!(error.detail(), Some("invalid_json"));
        // The corrupt document is left exactly as found: not deleted, not regenerated,
        // not treated as "first boot".
        assert_eq!(
            std::fs::read_to_string(metadata::metadata_path(dir.path())).expect("read"),
            "{ not json"
        );
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Present,
            "a corrupt record must never delete or regenerate the key"
        );
    }

    /// P7-S4R §10 — when the record cannot be written, the key THIS CALL created is
    /// deleted and its absence is proven: provisioning failure must not leave an orphan.
    #[test]
    fn metadata_write_failure_removes_the_newly_created_key() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("provision-cleanup");
        let provider = software_provider();

        // Deterministic write failure: the atomic writer stages
        // `device-identity.json.part`, so occupying that path with a directory makes the
        // record write fail while the record itself still reads as absent.
        let part = metadata::metadata_path(dir.path()).with_extension("json.part");
        std::fs::create_dir(&part).expect("stage blocker");
        assert_eq!(
            metadata::load_identity_metadata(dir.path()).expect("load"),
            None,
            "precondition: no record, so this call really reaches provisioning"
        );

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("the record write must fail");
        assert_eq!(error.kind(), "METADATA_IO");
        // Cleanup happened AND was proven: only then may the plain record error surface.
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent,
            "the key created by this call must be gone, proven by re-probe"
        );
        assert_eq!(
            metadata::load_identity_metadata(dir.path()).expect("load"),
            None,
            "nothing was established"
        );
        std::fs::remove_dir(&part).expect("clean up the blocker");
    }

    /// P7-S4R2 §7 / §18 — every injected failure INSIDE provisioning (i.e. BEFORE the
    /// durable record exists) removes the key this attempt created and proves its absence.
    /// These steps cannot be made to fail on a healthy machine without damaging it, so the
    /// fault is injected through the test-only hook that compiles away in production.
    #[test]
    fn every_provisioning_step_failure_removes_the_newly_created_key() {
        let cases: [(provision_fault::Stage, &str); 5] = [
            (
                provision_fault::Stage::SetExportPolicy,
                "PROVIDER_FAILURE",
            ),
            (
                provision_fault::Stage::PolicyReadbackMismatch,
                "UNEXPECTED_PRIVATE_EXPORT_SUCCESS",
            ),
            (provision_fault::Stage::Finalize, "PROVIDER_FAILURE"),
            (
                provision_fault::Stage::PrivateExportValidation,
                "UNEXPECTED_PRIVATE_EXPORT_SUCCESS",
            ),
            (
                provision_fault::Stage::PublicIdentityDerivation,
                "PUBLIC_IDENTITY_UNAVAILABLE",
            ),
        ];
        for (stage, expected_kind) in cases {
            let _guard = keystore_lock();
            let provider = software_provider();
            let dir = tempfile::tempdir().expect("temp dir");
            let key = TestKeyGuard::new("provision-step-fault");

            let key_present_before =
                windows_cng::persisted_key_is_present(&provider, key.name());
            assert_eq!(key_present_before, PersistedKeyPresence::Absent);

            provision_fault::arm(stage);
            let error = ensure_identity_locked(dir.path(), key.name(), test_context())
                .expect_err("the injected step must fail provisioning");
            provision_fault::clear();
            assert_eq!(error.kind(), expected_kind, "stage {}", stage.name());

            // The cleanup already happened and is proven by absence: an ordinary Rust error
            // return does not leave an orphan (§5 / §6).
            assert_eq!(
                windows_cng::persisted_key_is_present(&provider, key.name()),
                PersistedKeyPresence::Absent,
                "the key created during stage {} must be gone",
                stage.name()
            );
            assert_eq!(
                metadata::load_identity_metadata(dir.path()).expect("load"),
                None,
                "nothing was established for stage {}",
                stage.name()
            );
        }
    }

    /// P7-S4R2 §3 — an ARMED guard owns deletion: explicit cleanup and a still-armed Drop
    /// both remove the new key, and neither does it twice.
    #[test]
    fn an_armed_provisioning_guard_deletes_the_new_key() {
        let _guard = keystore_lock();
        let provider = software_provider();

        let key = TestKeyGuard::new("guard-armed");
        let handle = windows_cng::create_persisted_key(
            &provider,
            key.name(),
            BCRYPT_ECDSA_P256_ALGORITHM,
        )
        .expect("create");
        let mut guard =
            ProvisioningKeyGuard::new(&provider, key.name(), CngKeyHandle::from_raw(handle));
        assert!(guard.is_armed(), "a freshly created key carries the obligation");
        assert_eq!(guard.cleanup_armed(), ProvisionCleanup::Verified);
        assert!(!guard.is_armed(), "the obligation is discharged once cleaned up");
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent
        );
        // Dropping afterwards is a no-op, never a second delete of anything.
        drop(guard);
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent
        );

        // …and a still-armed Drop (the panic path) cleans up too.
        let dropped = TestKeyGuard::new("guard-drop-armed");
        let handle = windows_cng::create_persisted_key(
            &provider,
            dropped.name(),
            BCRYPT_ECDSA_P256_ALGORITHM,
        )
        .expect("create");
        drop(ProvisioningKeyGuard::new(
            &provider,
            dropped.name(),
            CngKeyHandle::from_raw(handle),
        ));
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, dropped.name()),
            PersistedKeyPresence::Absent,
            "an armed Drop must not leave an orphan either"
        );
    }

    /// P7-S4R2 §3 — DISARM releases the obligation: once identity establishment is
    /// committed, nothing may delete the established key any more.
    #[test]
    fn a_committed_identity_key_is_never_deleted_by_the_guard() {
        let _guard = keystore_lock();
        let provider = software_provider();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("guard-disarmed");

        let identity =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        // The guard is gone by now (it was disarmed at the commit point), so presence here
        // is the proof that disarm really happened.
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Present
        );
        // A second ensure must re-VERIFY the same identity — had Drop deleted the key,
        // this would silently produce a brand-new identity instead.
        let second =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("re-ensure");
        assert_eq!(second, identity, "the established key must survive provisioning");
    }

    /// P7-S4R2 §10 — ONE reconciliation for all four states, shared by every entry point.
    #[test]
    fn single_reconciliation_covers_all_four_states() {
        let _guard = keystore_lock();
        let provider = software_provider();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("single-reconcile");
        let reconcile = |dir: &Path, name: &str| {
            open_established_identity(
                &provider,
                dir,
                name,
                IdentitySecurityLevel::SoftwareIsolated,
            )
        };

        // Nothing at all ⇒ NOT_PROVISIONED (the ONLY state with that name).
        assert_eq!(
            reconcile(dir.path(), key.name())
                .expect_err("both absent")
                .kind(),
            "NOT_PROVISIONED"
        );
        // Key without a record ⇒ IDENTITY_METADATA_MISSING.
        let handle = windows_cng::create_persisted_key(
            &provider,
            key.name(),
            BCRYPT_ECDSA_P256_ALGORITHM,
        )
        .expect("create");
        windows_cng::finalize_key(handle).expect("finalize");
        assert_eq!(
            reconcile(dir.path(), key.name())
                .expect_err("orphan")
                .kind(),
            "IDENTITY_METADATA_MISSING"
        );
        windows_cng::delete_persisted_key(
            windows_cng::open_persisted_key(&provider, key.name())
                .expect("probe")
                .expect("key"),
            key.name(),
        )
        .expect("remove the orphan before the real test");
        // Record without a key ⇒ IDENTITY_MATERIAL_MISSING.
        metadata::store_identity_metadata(
            dir.path(),
            &metadata::IdentityMetadata::established(
                DeviceIdentityAlgorithm::EcdsaP256Sha256,
                "0".repeat(64),
                IdentitySecurityLevel::SoftwareIsolated,
            ),
        )
        .expect("record only");
        assert_eq!(
            reconcile(dir.path(), key.name())
                .expect_err("secret loss")
                .kind(),
            "IDENTITY_MATERIAL_MISSING"
        );
        metadata::delete_identity_metadata(dir.path()).expect("drop the record");
        // Both present ⇒ READY, with the identity derived from THAT handle.
        let identity =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let verified = reconcile(dir.path(), key.name()).expect("established");
        assert_eq!(*verified.identity(), identity);
    }

    /// P7-S4R2 §17 — same-handle evidence rather than a fragile string check.
    ///
    /// [`sign_with_verified_key`] receives NO provider and NO key name, so it CANNOT reopen
    /// the key; the public blob used for verification below and the private key that signs
    /// both come from ONE [`VerifiedIdentityKey`].
    #[test]
    fn signing_uses_the_same_verified_handle() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("same-handle");
        let provider = software_provider();

        ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let verified = open_established_identity(
            &provider,
            dir.path(),
            key.name(),
            IdentitySecurityLevel::SoftwareIsolated,
        )
        .expect("established state");
        let attested = verified.identity().clone();

        // From the VERY handle that is about to sign.
        let blob = windows_cng::export_public_blob(verified.key().raw(), BCRYPT_ECCPUBLIC_BLOB)
            .expect("public export");
        let message = b"zhixing-p7s4r2-same-handle";
        let signature = sign_with_verified_key(verified, message).expect("sign");
        let digest = sha2::Sha256::digest(message);
        assert!(
            platform_verify(&blob, digest.as_slice(), &signature.der),
            "the signature must verify against the public key of the verified handle"
        );
        // The read path returns the identity attested by the same handle.
        let read = public_identity_locked(dir.path(), key.name(), test_context()).expect("read");
        assert_eq!(read, attested);
    }

    /// P7-S4R §12 — an existing FINALIZED key is never overwritten: CNG rejects the
    /// duplicate create with `NTE_EXISTS` and this slice reports that as its own verdict.
    #[test]
    fn an_existing_finalized_key_is_never_overwritten() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("no-overwrite");
        let provider = software_provider();

        let original =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");

        // CNG itself rejects a second creation attempt on the SAME finalized name, and the
        // failure is classified as its own verdict (never "make it succeed somehow").
        let error = windows_cng::create_persisted_key(
            &provider,
            key.name(),
            BCRYPT_ECDSA_P256_ALGORITHM,
        )
        .expect_err("a duplicate create must be rejected");
        assert_eq!(error.kind(), "KeyAlreadyExists");
        assert_eq!(error.status(), Some(NTE_EXISTS as u32));

        // The original key is untouched: same public identity, same fingerprint.
        let handle = windows_cng::open_persisted_key(&provider, key.name())
            .expect("probe")
            .expect("key still there");
        let blob = windows_cng::export_public_blob(handle.raw(), BCRYPT_ECCPUBLIC_BLOB)
            .expect("public export");
        let point = der::parse_bcrypt_public_blob(&blob).expect("P-256 blob");
        assert_eq!(
            &der::spki_from_point(&point)[..],
            original.spki_der(),
            "the existing key must not have been replaced"
        );
    }

    /// P7-S4R §12 — after a duplicate rejection the caller re-enters reconciliation:
    /// verify when a record exists, fail closed when it does not.
    #[test]
    fn duplicate_rejection_reconciles_instead_of_overwriting() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("duplicate-reconcile");
        let provider = software_provider();

        let identity =
            ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let reconciled = reconcile_after_duplicate(
            &provider,
            dir.path(),
            key.name(),
            test_context(),
            Some(NTE_EXISTS as u32),
        )
        .expect("a recorded identity must verify");
        assert_eq!(reconciled, identity);

        // Same key, no record: reconciliation FAILS CLOSED rather than adopting.
        metadata::delete_identity_metadata(dir.path()).expect("drop the record");
        let error = reconcile_after_duplicate(
            &provider,
            dir.path(),
            key.name(),
            test_context(),
            Some(NTE_EXISTS as u32),
        )
        .expect_err("an unidentified key must fail closed");
        assert_eq!(error.kind(), "IDENTITY_METADATA_MISSING");
        assert_eq!(
            metadata::load_identity_metadata(dir.path()).expect("load"),
            None
        );
    }

    /// §22 — a record without its key is identity SECRET loss: fail closed, no new key.
    #[test]
    fn missing_key_with_metadata_fails_closed_without_regenerating() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("secret-loss");
        let provider = software_provider();

        // Establish an identity, then remove ONLY the key material (simulating loss).
        ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let fingerprint = metadata::load_identity_metadata(dir.path())
            .expect("load")
            .expect("record")
            .fingerprint_hex;
        let handle = windows_cng::open_persisted_key(&provider, key.name())
            .expect("probe")
            .expect("key present");
        windows_cng::delete_persisted_key(handle, key.name()).expect("delete key");

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("secret loss must fail closed");
        assert_eq!(error.kind(), "IDENTITY_MATERIAL_MISSING");
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent,
            "no silent regeneration: the key must stay absent"
        );
        // The record is still the original one: nothing was rewritten.
        assert_eq!(
            metadata::load_identity_metadata(dir.path())
                .expect("load")
                .expect("record")
                .fingerprint_hex,
            fingerprint
        );
    }

    /// §23 — a fingerprint that no longer matches the key fails closed, and the record is
    /// never auto-updated.
    #[test]
    fn fingerprint_mismatch_fails_closed() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("mismatch");

        ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let mut record = metadata::load_identity_metadata(dir.path())
            .expect("load")
            .expect("record");
        let original = record.fingerprint_hex.clone();
        record.fingerprint_hex = "0".repeat(64);
        metadata::store_identity_metadata(dir.path(), &record).expect("rewrite record");

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("mismatch must fail closed");
        assert_eq!(error.kind(), "FINGERPRINT_MISMATCH");
        assert_eq!(
            metadata::load_identity_metadata(dir.path())
                .expect("load")
                .expect("record")
                .fingerprint_hex,
            "0".repeat(64),
            "the record must never be auto-corrected"
        );
        // Reading and signing fail closed for the same reason.
        assert_eq!(
            public_identity_locked(dir.path(), key.name(), test_context())
                .expect_err("read")
                .kind(),
            "FINGERPRINT_MISMATCH"
        );
        assert_eq!(
            sign_identity_locked(dir.path(), key.name(), test_context(), b"message")
                .expect_err("sign")
                .kind(),
            "FINGERPRINT_MISMATCH"
        );
        let _ = original;
    }

    /// §19 — a corrupted record is never treated as "no record".
    #[test]
    fn corrupt_metadata_fails_closed() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("corrupt-metadata");
        std::fs::write(metadata::metadata_path(dir.path()), b"{ not json").expect("write");

        let error = ensure_identity_locked(dir.path(), key.name(), test_context())
            .expect_err("corrupt record must fail closed");
        assert_eq!(error.kind(), "METADATA_CORRUPT");
    }

    // --- §12 / §14 / §28 — signing -------------------------------------------

    /// Verifies a signature with the platform verifier: `BCryptVerifySignature` consumes
    /// the NATIVE fixed-width form, so the DER output is converted back — which is also a
    /// round-trip proof of the conversion (Windows) and of the DER shape (shared).
    fn platform_verify(public_blob: &[u8], digest: &[u8], signature_der: &[u8]) -> bool {
        let p1363 = der::der_to_p1363(signature_der).expect("DER signature must parse");
        unsafe {
            let mut alg: BCRYPT_ALG_HANDLE = std::ptr::null_mut();
            let status = BCryptOpenAlgorithmProvider(&mut alg, BCRYPT_ECDSA_P256_ALGORITHM, std::ptr::null(), 0);
            assert_eq!(status, 0, "opening the P-256 algorithm provider must succeed");
            let mut key: BCRYPT_KEY_HANDLE = std::ptr::null_mut();
            let status = BCryptImportKeyPair(
                alg,
                std::ptr::null_mut(),
                BCRYPT_ECCPUBLIC_BLOB,
                &mut key,
                public_blob.as_ptr(),
                public_blob.len() as u32,
                0,
            );
            assert_eq!(status, 0, "importing the public blob must succeed");
            let verify = BCryptVerifySignature(
                key,
                std::ptr::null(),
                digest.as_ptr(),
                digest.len() as u32,
                p1363.as_ptr(),
                p1363.len() as u32,
                0,
            );
            BCryptDestroyKey(key);
            BCryptCloseAlgorithmProvider(alg, 0);
            verify == 0
        }
    }

    /// §28 — sign an UNHASHED message: SHA-256 exactly once, DER out, verifiable.
    #[test]
    fn sign_produces_a_verifiable_der_signature() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("sign");

        let identity = ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let message = b"zhixing-p7s4-authentication-message";
        let signature = sign_identity_locked(dir.path(), key.name(), test_context(), message).expect("sign");
        assert_eq!(signature.scheme, DeviceSignatureScheme::EcdsaP256Sha256);
        assert_eq!(signature.der.first(), Some(&0x30), "DER SEQUENCE expected");
        assert!(der::try_parse_der_sig_value(&signature.der).is_some());

        // Verify with the platform over the SHA-256 of the UNHASHED message (a second hash
        // here would be the double-hash bug this design forbids).
        let provider = software_provider();
        let key_handle = windows_cng::open_persisted_key(&provider, key.name())
            .expect("probe")
            .expect("key");
        let blob = windows_cng::export_public_blob(key_handle.raw(), BCRYPT_ECCPUBLIC_BLOB)
            .expect("public export");
        let digest = sha2::Sha256::digest(message);
        assert!(
            platform_verify(&blob, digest.as_slice(), &signature.der),
            "the production signature must verify against the identity public key"
        );

        // §18 negative: a modified message must be rejected.
        let other_digest = sha2::Sha256::digest(b"zhixing-p7s4-authentication-message!");
        assert!(
            !platform_verify(&blob, other_digest.as_slice(), &signature.der),
            "a tampered message must be rejected"
        );
        let _ = identity;
    }

    /// Signing requires an established identity: no record ⇒ no signature (§26).
    #[test]
    fn sign_without_an_established_identity_fails_closed() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("sign-unestablished");
        let error = sign_identity_locked(dir.path(), key.name(), test_context(), b"message")
            .expect_err("no identity established");
        assert_eq!(error.kind(), "NOT_PROVISIONED");
    }

    // --- P7-S4R3 — Windows signature format determinism ----------------------

    /// 64 bytes laid out as a genuinely well-formed `ECDSA-Sig-Value`:
    /// `SEQUENCE(62) { INTEGER(31 bytes), INTEGER(27 bytes) }`.
    ///
    /// This is the case that made byte inspection unreliable — the input is simultaneously
    /// a plausible P-1363 signature and valid DER, so its bytes cannot say which one it is.
    fn ambiguous_sixty_four_byte_der() -> Vec<u8> {
        let mut out = vec![0x30u8, 0x3E];
        out.extend([0x02, 31]);
        out.extend((0u8..31).map(|index| index + 1));
        out.extend([0x02, 27]);
        out.extend((0u8..27).map(|index| index + 1));
        assert_eq!(out.len(), der::P1363_SIGNATURE_LEN, "built to 64 bytes");
        out
    }

    /// §6 — a 64-byte input that is ALSO valid DER must still be encoded as P-1363 by the
    /// Windows path. This is the structural proof that no guessing remains: the previous
    /// test only used a 64-byte input that was deliberately invalid DER, which an
    /// ambiguous Input cannot distinguish from the real thing.
    #[test]
    fn a_sixty_four_byte_valid_der_is_still_encoded_as_p1363() {
        let ambiguous = ambiguous_sixty_four_byte_der();
        // Precondition: the ambiguity is genuine — this really does parse as DER.
        assert!(
            der::try_parse_der_sig_value(&ambiguous).is_some(),
            "the input must be a well-formed ECDSA-Sig-Value for this test to mean anything"
        );
        // …and it is still converted, never handed back unchanged.
        let encoded = windows_signature_der(&ambiguous).expect("64 bytes is the contracted form");
        assert_ne!(
            encoded, ambiguous,
            "the Windows path must never pass raw provider bytes through as DER"
        );
        assert_eq!(
            encoded,
            der::p1363_to_der(&ambiguous).expect("reference conversion"),
            "on Windows, 64 bytes always means P1363 → DER, whatever else those bytes parse as"
        );
        assert!(
            der::try_parse_der_sig_value(&encoded).is_some(),
            "the output is always the shared DER signature format"
        );
    }

    /// §3 — anything that is NOT the contracted 64-byte form fails closed; nothing about a
    /// non-conforming provider output is assumed.
    #[test]
    fn a_signature_that_is_not_sixty_four_bytes_fails_closed() {
        let cases: [&[u8]; 4] = [&[], &[0x30, 0x00], &[0xAA; 63], &[0xAA; 65]];
        for raw in cases {
            let error = windows_signature_der(raw)
                .expect_err("the Windows provider contract requires exactly 64 bytes");
            assert_eq!(error.kind(), "SIGN_FAILED", "len {}", raw.len());
            assert_eq!(error.detail(), Some("UnexpectedSignatureFormat"));
        }
    }

    // --- §30 — private export policy -----------------------------------------

    /// §30 — the production key is created non-exportable: the private blob is denied
    /// while the PUBLIC identity stays readable.
    #[test]
    fn provisioned_key_refuses_private_export_but_exports_public_identity() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("export-policy");
        let provider = software_provider();

        let identity = ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let handle = windows_cng::open_persisted_key(&provider, key.name())
            .expect("probe")
            .expect("key present");

        // Private export: denied (status != 0). No private bytes are ever materialized.
        let private_status =
            windows_cng::attempt_private_export_status(handle.raw(), BCRYPT_ECCPRIVATE_BLOB);
        assert_ne!(
            private_status, CNG_SUCCESS as u32,
            "the production identity key must not be exportable"
        );
        // Public export: required (§30), and it must produce the recorded identity.
        let blob = windows_cng::export_public_blob(handle.raw(), BCRYPT_ECCPUBLIC_BLOB)
            .expect("public export must succeed");
        let point = der::parse_bcrypt_public_blob(&blob).expect("P-256 blob");
        assert_eq!(
            identity.spki_der(),
            &der::spki_from_point(&point)[..],
            "the exported public identity must match the recorded identity"
        );
    }

    // P7-S4R §13 — there is no reset test, because there is no reset API: rotation and
    // reset remain frozen architecture semantics with the API deferred until a real
    // caller exists. A "returns NotPermitted" test would only prove a fake API exists.

    // --- §40 — cleanup ---------------------------------------------------------

    /// §40 — every test key is removed: the namespace is empty afterwards.
    #[test]
    fn test_key_namespace_is_left_empty() {
        let _guard = keystore_lock();
        let dir = tempfile::tempdir().expect("temp dir");
        let key = TestKeyGuard::new("cleanup-proof");
        ensure_identity_locked(dir.path(), key.name(), test_context()).expect("provision");
        let provider = software_provider();
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Present
        );
        key.cleanup();
        assert_eq!(
            windows_cng::persisted_key_is_present(&provider, key.name()),
            PersistedKeyPresence::Absent,
            "test keys must never survive a test"
        );
    }
}
