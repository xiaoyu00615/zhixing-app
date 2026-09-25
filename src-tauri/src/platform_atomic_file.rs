//! Narrow OS-level atomic file primitives (P6-S9).
//!
//! Exactly three things live here, and nothing else:
//!
//! - [`atomic_replace_file`] — replace an ALREADY EXISTING file with a new one
//!   in ONE operating-system step, optionally preserving the displaced file.
//! - [`available_space_bytes`] — free bytes on the volume holding a directory.
//! - [`write_file_durable`] / [`write_file_atomic`] — durable byte writes.
//!
//! # Why this is its own module
//!
//! Both Native Restore (`backup_restore`) and Native Data Root Migration
//! (`data_root_migration`) need the SAME Windows capability. A second
//! hand-rolled `ReplaceFileW` call site is exactly how a subtly different —
//! and therefore untested — safety-critical replace gets written, so the logic
//! exists once here.
//!
//! The extraction is deliberately MINIMAL (P6-S9 §41): there is no journal, no
//! rollback, no policy and no transaction object. It is one OS call plus a
//! bounded retry, and each caller keeps its own error model on top.
//!
//! # Frozen rules
//!
//! - The replace is `ReplaceFileW` + `REPLACEFILE_WRITE_THROUGH`. There is NO
//!   `remove-then-rename`, no `copy-over`, no `truncate-in-place` fallback: if
//!   the OS cannot express the atomic replace, the answer is a failure, never a
//!   "best effort" replacement.
//! - The retry bound is FIXED and small, and only a genuine contention error is
//!   retried. No unbounded loop, no unbounded backoff.
//! - Platforms without the primitive fail closed with
//!   [`AtomicReplaceFailure::UnsupportedPlatform`] and are never emulated.

use std::fs;
use std::io::{self, Write};
use std::path::Path;

/// Fixed, small upper bound on OS atomic-replace attempts (1 + retries).
pub(crate) const REPLACE_MAX_ATTEMPTS: u32 = 6;
/// Fixed, short delay between those attempts. No unbounded backoff.
pub(crate) const REPLACE_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(50);

/// One attempt's outcome.
#[derive(Debug)]
pub(crate) enum ReplaceAttempt {
    Done,
    /// Another process holds a handle (or a lock) on one of the files.
    /// Retryable within a fixed bound.
    Contended(String),
    /// Any other failure. Not retryable.
    Failed(String),
}

/// Bounded retry: a FIXED upper bound and a FIXED short delay. No infinite
/// loop, no unbounded backoff, no "sleep a bit longer and hope".
pub(crate) fn run_with_bounded_retry<F>(mut attempt: F) -> Result<(), ReplaceAttempt>
where
    F: FnMut() -> ReplaceAttempt,
{
    let mut attempt_number: u32 = 0;
    loop {
        attempt_number += 1;
        match attempt() {
            ReplaceAttempt::Done => return Ok(()),
            ReplaceAttempt::Failed(detail) => return Err(ReplaceAttempt::Failed(detail)),
            ReplaceAttempt::Contended(detail) => {
                if attempt_number >= REPLACE_MAX_ATTEMPTS {
                    return Err(ReplaceAttempt::Contended(detail));
                }
                std::thread::sleep(REPLACE_RETRY_DELAY);
            }
        }
    }
}

/// Why an atomic replace did not happen.
#[derive(Debug)]
pub(crate) enum AtomicReplaceFailure {
    /// The OS refused (possibly after bounded retries). Whether the destination
    /// was touched is for the CALLER to measure — this type makes no claim.
    CouldNotReplace(String),
    /// This build has no atomic-replace primitive on this platform.
    #[cfg_attr(windows, allow(dead_code))]
    UnsupportedPlatform,
}

impl AtomicReplaceFailure {
    pub(crate) fn detail(&self) -> String {
        match self {
            Self::CouldNotReplace(detail) => detail.clone(),
            Self::UnsupportedPlatform => "atomic replace is unsupported on this platform".into(),
        }
    }
}

/// Replace `destination` with `replacement` in ONE OS operation.
///
/// The destination MUST already exist (this is `ReplaceFileW` semantics — the
/// call fails on a missing destination). When `backup` is `Some`, the displaced
/// destination bytes are saved there by the SAME operation, so the previous
/// content is never lost.
///
/// `replacement` is CONSUMED by a successful call.
#[cfg(windows)]
pub(crate) fn atomic_replace_file(
    destination: &Path,
    replacement: &Path,
    backup: Option<&Path>,
) -> Result<(), AtomicReplaceFailure> {
    match run_with_bounded_retry(|| replace_file_once(destination, replacement, backup)) {
        Ok(()) => Ok(()),
        Err(ReplaceAttempt::Failed(detail)) => Err(AtomicReplaceFailure::CouldNotReplace(detail)),
        Err(_) => Err(AtomicReplaceFailure::CouldNotReplace(
            "the operating system refused the atomic replace after bounded retries".into(),
        )),
    }
}

/// Non-Windows: there is NO atomic-replace primitive, so this fails closed
/// BEFORE touching anything. Android / other platforms get their own
/// implementation in a later slice; nothing here is emulated with a
/// non-atomic substitute.
#[cfg(not(windows))]
pub(crate) fn atomic_replace_file(
    _destination: &Path,
    _replacement: &Path,
    _backup: Option<&Path>,
) -> Result<(), AtomicReplaceFailure> {
    Err(AtomicReplaceFailure::UnsupportedPlatform)
}

/// `ReplaceFileW` — one attempt.
#[cfg(windows)]
fn replace_file_once(
    destination: &Path,
    replacement: &Path,
    backup: Option<&Path>,
) -> ReplaceAttempt {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Foundation::{GetLastError, ERROR_LOCK_VIOLATION, ERROR_SHARING_VIOLATION};
    use windows_sys::Win32::Storage::FileSystem::{ReplaceFileW, REPLACEFILE_WRITE_THROUGH};

    fn wide(path: &Path) -> Vec<u16> {
        path.as_os_str()
            .encode_wide()
            .chain(std::iter::once(0u16))
            .collect()
    }

    let destination_w = wide(destination);
    let replacement_w = wide(replacement);
    let backup_w = backup.map(wide);
    // `ReplaceFileW` takes a NULL `lpBackupFileName` when the caller does not
    // want the displaced file preserved.
    let backup_ptr = match &backup_w {
        Some(buffer) => buffer.as_ptr(),
        None => std::ptr::null(),
    };

    // SAFETY: every pointer is either NULL or a NUL-terminated UTF-16 buffer
    // that outlives the call; the two reserved parameters are documented NULL.
    let ok = unsafe {
        ReplaceFileW(
            destination_w.as_ptr(),
            replacement_w.as_ptr(),
            backup_ptr,
            REPLACEFILE_WRITE_THROUGH,
            std::ptr::null(),
            std::ptr::null(),
        )
    };
    if ok != 0 {
        return ReplaceAttempt::Done;
    }
    let code = unsafe { GetLastError() };
    let detail = format!("replace file failed (win32 error {code})");
    if code == ERROR_SHARING_VIOLATION || code == ERROR_LOCK_VIOLATION {
        ReplaceAttempt::Contended(detail)
    } else {
        ReplaceAttempt::Failed(detail)
    }
}

/// Free bytes available to the caller on the volume that holds `directory`.
///
/// Read-only and advisory: a positive answer is NOT a promise that a later copy
/// will succeed (P6-S9 §34). It exists to refuse an obviously impossible
/// migration BEFORE any byte is written.
#[cfg(windows)]
pub(crate) fn available_space_bytes(directory: &Path) -> Result<u64, String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;

    let mut wide: Vec<u16> = directory.as_os_str().encode_wide().collect();
    wide.push(0);
    let mut available: u64 = 0;
    // SAFETY: `wide` is a NUL-terminated UTF-16 buffer; `available` is a valid
    // `*mut u64`. The remaining two out-parameters are optional (NULL).
    let ok = unsafe {
        GetDiskFreeSpaceExW(
            wide.as_ptr(),
            &mut available,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
        )
    };
    if ok == 0 {
        return Err("the free space of the target volume could not be read".into());
    }
    Ok(available)
}

/// Non-Windows: no space probe, and no migration either (the caller fails
/// closed with `UNSUPPORTED_PLATFORM` before it ever asks).
#[cfg(not(windows))]
pub(crate) fn available_space_bytes(_directory: &Path) -> Result<u64, String> {
    Err("the free space of the target volume could not be read".into())
}

/// Write `bytes` to `path` and flush them to the device: create → write →
/// `sync_all`.
///
/// `sync_all` needs a handle opened WITH WRITE ACCESS, which is why this does
/// not simply reopen a read-only handle to flush it.
pub(crate) fn write_file_durable(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut file = fs::File::create(path)?;
    file.write_all(bytes)?;
    file.sync_all()
}

/// Durable write of a NEW file at `path` WITHOUT ever exposing a partial file
/// there: `<path>.part` → write → `sync_all` → rename.
///
/// The rename target must NOT already exist: replacing an existing file is
/// [`atomic_replace_file`]'s job, and on Windows a plain rename is not a
/// write-through replace (P6-S9 §40).
pub(crate) fn write_file_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let mut part = path.as_os_str().to_os_string();
    part.push(".part");
    let part = std::path::PathBuf::from(part);
    write_file_durable(&part, bytes)?;
    match fs::rename(&part, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            // Best-effort cleanup of THIS operation's part file only.
            let _ = fs::remove_file(&part);
            Err(e)
        }
    }
}
