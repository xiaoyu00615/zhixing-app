/**
 * P6-S8 · Backup Restore · shared domain model
 *
 * Naming note (frozen): this module is `backupRestore`, NOT `restore`. The
 * repository already uses "restore" for the Trash soft-delete restore, and two
 * unrelated meanings for one word is how a data-loss bug gets written. The
 * Rust command names are `native_backup_restore_apply` /
 * `native_backup_restore_reconcile` for the same reason.
 *
 * Scope (frozen): **DATABASE RESTORE V1** — `database = true`,
 * `attachments = false`, `portableSettings = false`. It is never called "full
 * restore" or "all-data restore", and it never claims to recover anything the
 * selected bundle does not contain.
 *
 * The contract below is deliberately platform-free: it mentions no native owner
 * id, no web reservation id, no filesystem path, no Tauri, no SQLite connection.
 * A future Web restore implements this same port against OPFS.
 */

/** Every failure this domain can report. */
export const BACKUP_RESTORE_ERROR_CODES = [
  'UNAVAILABLE',
  'REQUEST_INVALID',
  'OWNER_UNAVAILABLE',
  'OWNER_MISMATCH',
  'BACKUP_NOT_FOUND',
  'BACKUP_AMBIGUOUS',
  'BACKUP_UNSUPPORTED',
  'BACKUP_INVALID',
  'BACKUP_VERIFY_FAILED',
  'SAFETY_BACKUP_FAILED',
  'STAGING_FAILED',
  'CHECKPOINT_FAILED',
  'SIDECAR_FAILED',
  'SWITCH_FAILED',
  'SWITCH_INDETERMINATE',
  'ROLLED_BACK',
  'ROLLBACK_FAILED',
  'TRANSPORT_AMBIGUOUS',
  'PROTOCOL_INVALID',
  'INTERNAL',
] as const

export type BackupRestoreErrorCode = (typeof BACKUP_RESTORE_ERROR_CODES)[number]

export function isBackupRestoreErrorCode(
  value: unknown,
): value is BackupRestoreErrorCode {
  return (
    typeof value === 'string' &&
    (BACKUP_RESTORE_ERROR_CODES as readonly string[]).includes(value)
  )
}

/**
 * Fixed, UI-safe message per code. Kept HERE (not taken from the transport) so
 * a malformed or hostile payload can never inject text into the UI, and so an
 * adapter can never quietly reword a data-safety statement.
 */
const SAFE_MESSAGES: Record<BackupRestoreErrorCode, string> = {
  UNAVAILABLE: 'Restore is currently unavailable.',
  REQUEST_INVALID: 'The restore request was invalid.',
  OWNER_UNAVAILABLE: 'The restore was not authorized and nothing was changed.',
  OWNER_MISMATCH: 'The restore was not authorized and nothing was changed.',
  BACKUP_NOT_FOUND: 'The selected backup was not found.',
  BACKUP_AMBIGUOUS: 'The selected backup id is ambiguous and cannot be used.',
  BACKUP_UNSUPPORTED: 'This backup cannot be restored by this version.',
  BACKUP_INVALID: 'The selected backup is damaged and cannot be restored.',
  BACKUP_VERIFY_FAILED:
    'The selected backup failed verification and was not restored.',
  SAFETY_BACKUP_FAILED:
    'The current data could not be backed up, so nothing was restored.',
  STAGING_FAILED: 'The restore could not be prepared, so nothing was changed.',
  CHECKPOINT_FAILED:
    'The current database could not be quiesced, so nothing was changed.',
  SIDECAR_FAILED:
    'The current database files could not be secured, so nothing was changed.',
  SWITCH_FAILED:
    'The restore could not be applied; the current data is unchanged.',
  SWITCH_INDETERMINATE: 'The restore outcome could not be confirmed.',
  ROLLED_BACK: 'The restore failed and the previous data was recovered.',
  ROLLBACK_FAILED:
    'The restore failed and the previous data could not be confirmed.',
  TRANSPORT_AMBIGUOUS: 'The restore outcome could not be confirmed.',
  PROTOCOL_INVALID: 'The restore outcome could not be confirmed.',
  INTERNAL: 'The restore could not be completed.',
}

export function safeMessageForRestoreCode(
  code: BackupRestoreErrorCode,
): string {
  return SAFE_MESSAGES[code]
}

/**
 * Whether releasing the strong barrier after this failure is provable.
 *
 * - RECOVERABLE: the live database state has been PROVEN safe (never modified,
 *   or a failed switch left it byte-identical, or a rollback restored and
 *   re-verified it). The workflow may release the exclusive lease.
 * - BLOCKED: the live database state, or this operation's commit state, cannot
 *   be proven. The workflow MUST NOT release; it hands back a
 *   `BlockedBackupRestoreSession` and the barrier stays active.
 *
 * This is a safety claim about the live database, so it is assigned explicitly
 * per code — never inferred from a message, and never defaulted to RECOVERABLE.
 */
export type BackupRestoreDisposition = 'RECOVERABLE' | 'BLOCKED'

/** Explicit code → disposition table. A missing entry is a programming error. */
const BLOCKED_CODES: readonly BackupRestoreErrorCode[] = [
  'SWITCH_INDETERMINATE',
  'ROLLBACK_FAILED',
  'TRANSPORT_AMBIGUOUS',
  // A malformed transport payload means the outcome is UNREADABLE, not that it
  // failed. Reading it as recoverable would release the barrier over a database
  // nobody has proven.
  'PROTOCOL_INVALID',
  'INTERNAL',
]

export function dispositionForRestoreCode(
  code: BackupRestoreErrorCode,
): BackupRestoreDisposition {
  return BLOCKED_CODES.includes(code) ? 'BLOCKED' : 'RECOVERABLE'
}

/**
 * Typed restore failure. `safeMessage` is UI-safe: no path, no SQLite text, no
 * win32 code, no platform token.
 */
export class BackupRestoreError extends Error {
  public readonly code: BackupRestoreErrorCode
  public readonly disposition: BackupRestoreDisposition
  public readonly safeMessage: string

  constructor(
    code: BackupRestoreErrorCode,
    safeMessage: string,
    disposition: BackupRestoreDisposition = dispositionForRestoreCode(code),
  ) {
    super(safeMessage)
    this.name = 'BackupRestoreError'
    this.code = code
    this.safeMessage = safeMessage
    this.disposition = disposition
  }
}

/** Evidence-based answer to "what actually happened on disk?". */
export const BACKUP_RESTORE_RECONCILE_OUTCOMES = [
  'COMMITTED',
  'NOT_COMMITTED',
  'ROLLED_BACK',
  'INDETERMINATE',
] as const

export type BackupRestoreReconcileOutcome =
  (typeof BACKUP_RESTORE_RECONCILE_OUTCOMES)[number]

export function isBackupRestoreReconcileOutcome(
  value: unknown,
): value is BackupRestoreReconcileOutcome {
  return (
    typeof value === 'string' &&
    (BACKUP_RESTORE_RECONCILE_OUTCOMES as readonly string[]).includes(value)
  )
}

/**
 * Safe reason codes for an INDETERMINATE reconcile. Never a raw OS or SQLite
 * message.
 */
export const BACKUP_RESTORE_RECONCILE_REASONS = [
  'ROOT_UNAVAILABLE',
  'EXPECTED_TARGET_UNKNOWN',
  'JOURNAL_CONTRADICTORY',
  'JOURNAL_UNREADABLE',
  'LIVE_MISSING',
  'LIVE_INVALID',
  'LIVE_SCHEMA_MISMATCH',
  'LIVE_UNKNOWN_DATABASE',
  'PROTOCOL_INVALID',
  'TRANSPORT_AMBIGUOUS',
] as const

export type BackupRestoreReconcileReason =
  (typeof BACKUP_RESTORE_RECONCILE_REASONS)[number]

export function isBackupRestoreReconcileReason(
  value: unknown,
): value is BackupRestoreReconcileReason {
  return (
    typeof value === 'string' &&
    (BACKUP_RESTORE_RECONCILE_REASONS as readonly string[]).includes(value)
  )
}

/**
 * A restore request. `operationId` is generated ONCE by the application
 * workflow and reused verbatim for the transport retry and every reconcile, so
 * a lost acknowledgement can always be resolved against the same operation.
 */
export interface BackupRestoreRequest {
  readonly operationId: string
  readonly backupId: string
}

/** Successful apply. Carries no path and no platform token. */
export interface BackupRestoreApplyResult {
  readonly operationId: string
  readonly backupId: string
  readonly outcome: 'RESTORED'
  /** The Safety Backup bundle created before the switch (for a future UI). */
  readonly safetyBackupId: string
  readonly restoredChecksumSha256: string
}

export interface BackupRestoreReconcileResult {
  readonly operationId: string
  readonly backupId: string
  readonly outcome: BackupRestoreReconcileOutcome
  readonly reasonCode?: BackupRestoreReconcileReason
  readonly safetyBackupId?: string
  readonly restoredChecksumSha256?: string
}

/**
 * The port a platform adapter implements.
 *
 * `applyBackupRestore` resolves ONLY when the restore is proven applied. Every
 * other outcome is either a typed `BackupRestoreError` (with its disposition)
 * or — for an unprovable outcome — a `BLOCKED` error, so the caller can never
 * mistake "we do not know" for "it failed".
 */
export interface BackupRestorePort {
  applyBackupRestore(
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreApplyResult>
  reconcileBackupRestore(
    request: BackupRestoreRequest,
  ): Promise<BackupRestoreReconcileResult>
}

/** Canonical lowercase UUID, as emitted by the backend. */
export const RESTORE_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isRestoreUuid(value: unknown): value is string {
  return typeof value === 'string' && RESTORE_UUID_PATTERN.test(value)
}

/** Lowercase hex SHA-256 (64 chars). */
export function isRestoreSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/** Stable, unique operation identity for one restore attempt. */
export function createRestoreOperationId(): string {
  return crypto.randomUUID()
}
