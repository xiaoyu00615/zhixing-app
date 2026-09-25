/**
 * Backup inventory / verification domain (P6-S6).
 *
 * P6-S5 can CREATE a verified bundle. This module is the read-only counterpart:
 * it describes the bundles that already exist and verifies one on request.
 *
 * The two axes are deliberately SEPARATE and must never be conflated:
 *
 *  1. `inventoryStatus` — a cheap STRUCTURAL classification. `STRUCTURALLY_VALID`
 *     means the manifest, the required structure, the safe relative path and the
 *     size metadata all checked out. It does NOT mean the bundle is intact:
 *     the inventory never recomputes SHA-256 and never opens a database.
 *  2. `verificationStatus` — only an EXPLICIT full verification can produce
 *     `VERIFIED`. A fresh listing is always `NOT_VERIFIED`.
 *
 * Never claim "verified" or "safe to restore" from a listing.
 *
 * This module contains NO I/O and NO platform detail, so the Native adapter
 * (and a future Web adapter) can share it. Restore, deletion, retention and
 * cleanup are NOT part of this boundary.
 */

import type { BackupScope } from './model'

/**
 * Structural classification.
 *
 * - `STRUCTURALLY_VALID` — every structural + metadata check passed. NOT verified.
 * - `INCOMPLETE` — a required part is absent (staging dir, manifest, database).
 * - `INVALID` — all parts present but a hard rule is violated (unreadable
 *   manifest, unsafe path, symlink, non-regular database, size mismatch,
 *   duplicated identity).
 * - `UNSUPPORTED` — well-formed under a format/scope this build cannot consume.
 *   Never to be presented as corrupt: a newer bundle may be perfectly valid.
 */
export const BACKUP_INVENTORY_STATUSES = [
  'STRUCTURALLY_VALID',
  'INCOMPLETE',
  'INVALID',
  'UNSUPPORTED',
] as const

export type BackupInventoryStatus = (typeof BACKUP_INVENTORY_STATUSES)[number]

/** Independent, explicit-verification-only axis. */
export const BACKUP_VERIFICATION_STATUSES = [
  'NOT_VERIFIED',
  'VERIFIED',
  'FAILED',
] as const

export type BackupVerificationStatus =
  (typeof BACKUP_VERIFICATION_STATUSES)[number]

/** What an explicit verification can actually conclude. */
export const BACKUP_VERIFICATION_OUTCOMES = ['VERIFIED', 'FAILED'] as const

export type BackupVerificationOutcome =
  (typeof BACKUP_VERIFICATION_OUTCOMES)[number]

/** Safe, UI-exposable reason codes. Never a raw filesystem/SQLite message. */
export const BACKUP_REASON_CODES = [
  'STAGING_INCOMPLETE',
  'MANIFEST_MISSING',
  'MANIFEST_INVALID',
  'UNSUPPORTED_FORMAT',
  'UNSAFE_DATABASE_PATH',
  'DATABASE_MISSING',
  'DATABASE_NOT_REGULAR',
  'SIZE_MISMATCH',
  'INVALID_CHECKSUM_METADATA',
  'UNSUPPORTED_SCOPE',
  'DUPLICATE_BACKUP_ID',
  'SYMLINK_NOT_ALLOWED',
  'CHECKSUM_MISMATCH',
  'INTEGRITY_FAILED',
  'DATABASE_UNREADABLE',
] as const

export type BackupReasonCode = (typeof BACKUP_REASON_CODES)[number]

/** One entry of the backup inventory. Carries no absolute path. */
export interface BackupInventoryItem {
  /** Present iff the manifest was readable and claimed a valid identity. */
  readonly backupId?: string
  readonly createdAtMs?: number
  /** Directory name inside `backup/`, e.g. `backup_<ms>_<uuid>`. */
  readonly bundleName: string
  /** Bundle path RELATIVE to the Data Root, e.g. `backup/backup_<ms>_<uuid>`. */
  readonly bundleRelativePath: string
  readonly inventoryStatus: BackupInventoryStatus
  readonly reasonCode?: BackupReasonCode
  readonly verificationStatus: BackupVerificationStatus
  readonly appVersion?: string
  readonly schemaVersion?: number
  readonly sizeBytes?: number
  readonly checksumSha256?: string
  readonly scope?: BackupScope
}

/** Result of an explicit full verification. */
export interface BackupVerificationResult {
  readonly backupId: string
  /** `NOT_VERIFIED` can never come back from a verification. */
  readonly verificationStatus: BackupVerificationOutcome
  readonly reasonCode?: BackupReasonCode
  readonly sizeBytes?: number
  readonly checksumSha256?: string
}

/** Platform-agnostic inventory boundary. Implemented by the Native adapter. */
export interface BackupInventoryPort {
  /** Cheap structural listing. Never hashes and never opens a database. */
  listBackups(): Promise<readonly BackupInventoryItem[]>
  /** Explicit, expensive full verification of one bundle. */
  verifyBackup(backupId: string): Promise<BackupVerificationResult>
}

export const BACKUP_INVENTORY_ERROR_CODES = [
  /** Bootstrap / Data Root / `backup/` root unavailable. */
  'UNAVAILABLE',
  /** No bundle claims the requested id. */
  'NOT_FOUND',
  /** Several bundles claim the requested id — identity use is unsafe. */
  'AMBIGUOUS',
  /** The located bundle uses a format/scope this build cannot verify. */
  'UNSUPPORTED',
  /** The request itself is unusable (e.g. the id is not a UUID). */
  'REQUEST_INVALID',
  /** Scanning / parsing / subsystem failure. */
  'INTERNAL',
] as const

export type BackupInventoryErrorCode =
  (typeof BACKUP_INVENTORY_ERROR_CODES)[number]

/** UI-safe messages only: no filesystem path or SQLite internals. */
const SAFE_BACKUP_INVENTORY_MESSAGES: Record<BackupInventoryErrorCode, string> = {
  UNAVAILABLE: 'The backup list is currently unavailable.',
  NOT_FOUND: 'The requested backup was not found.',
  AMBIGUOUS: 'The requested backup id is ambiguous and cannot be used.',
  UNSUPPORTED: 'This backup format is not supported by this version.',
  REQUEST_INVALID: 'The backup request was invalid.',
  INTERNAL: 'The backup list could not be read.',
}

export class BackupInventoryError extends Error {
  readonly code: BackupInventoryErrorCode

  constructor(code: BackupInventoryErrorCode) {
    super(SAFE_BACKUP_INVENTORY_MESSAGES[code])
    this.name = 'BackupInventoryError'
    this.code = code
  }
}

export function isBackupInventoryErrorCode(
  value: unknown,
): value is BackupInventoryErrorCode {
  return (
    typeof value === 'string' &&
    (BACKUP_INVENTORY_ERROR_CODES as readonly string[]).includes(value)
  )
}
