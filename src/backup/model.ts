/**
 * Native User Backup domain (P6-S5 · Backup V1).
 *
 * This module defines ONLY the transport-agnostic contract for creating a
 * backup: the value types, the `BackupPort` boundary, and a safe structured
 * error contract. It contains NO I/O and NO platform detail, so the Native
 * adapter (and a future Web adapter) can share it.
 *
 * V1 scope is intentionally narrow and must be declared explicitly everywhere:
 *   - database:           SUPPORTED
 *   - attachments:        NOT YET INCLUDED
 *   - portable settings:  NOT YET INCLUDED
 *   - device-local settings (device_id / Trust Token / Pairing Credential /
 *     permission state): NEVER PORTABLE. These are never part of a bundle.
 *
 * Backup is WEAK quiescence (see `workflow.ts`): it does not take the exclusive
 * maintenance barrier. Restore / Data Root Migration are STRONG and belong to
 * later slices.
 */

/** What a bundle actually contains. Absent capabilities are `false`, never omitted. */
export interface BackupScope {
  readonly database: boolean
  readonly attachments: boolean
  readonly portableSettings: boolean
}

/** Result of a successful backup. `bundleRelativePath` is NEVER absolute. */
export interface BackupResult {
  /** Unique id of this backup (UUID v4), matches the manifest. */
  readonly backupId: string
  /** Creation timestamp (epoch milliseconds). */
  readonly createdAtMs: number
  /** Size of the backed-up database in bytes. */
  readonly sizeBytes: number
  /** Lowercase hex SHA-256 of the backed-up database. */
  readonly checksumSha256: string
  /** Bundle path RELATIVE to the Data Root, e.g. `backup/backup_<ms>_<uuid>`. */
  readonly bundleRelativePath: string
  /** Explicit V1 scope declaration. */
  readonly scope: BackupScope
}

/** Platform-agnostic backup boundary. Implemented by the Native adapter. */
export interface BackupPort {
  createBackup(): Promise<BackupResult>
}

export const BACKUP_ERROR_CODES = [
  'UNAVAILABLE',
  'SOURCE_INVALID',
  'DESTINATION_INVALID',
  'BACKUP_FAILED',
  'VERIFY_FAILED',
  'MANIFEST_FAILED',
] as const

export type BackupErrorCode = (typeof BACKUP_ERROR_CODES)[number]

/** UI-safe messages only: no filesystem path or SQLite internals. */
const SAFE_BACKUP_MESSAGES: Record<BackupErrorCode, string> = {
  UNAVAILABLE: 'Backup is currently unavailable.',
  SOURCE_INVALID: 'The source database is not available for backup.',
  DESTINATION_INVALID: 'The backup destination is not available.',
  BACKUP_FAILED: 'The backup could not be completed.',
  VERIFY_FAILED: 'The backup failed verification and was discarded.',
  MANIFEST_FAILED: 'The backup manifest could not be written.',
}

export class BackupError extends Error {
  readonly code: BackupErrorCode

  constructor(code: BackupErrorCode) {
    super(SAFE_BACKUP_MESSAGES[code])
    this.name = 'BackupError'
    this.code = code
  }
}

export function isBackupErrorCode(value: unknown): value is BackupErrorCode {
  return (
    typeof value === 'string' &&
    (BACKUP_ERROR_CODES as readonly string[]).includes(value)
  )
}
