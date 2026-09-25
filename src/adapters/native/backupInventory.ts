/**
 * Native backup inventory adapter (P6-S6).
 *
 * The single place allowed to invoke `native_backup_list` / `native_backup_verify`.
 * It strictly re-validates every raw DTO field and maps Rust error codes to the
 * shared `BackupInventoryError` contract. No absolute path, SQLite detail, or
 * Tauri error internals escape this adapter.
 *
 * It performs NO business classification: the classification truth lives in the
 * Rust backup subsystem. A malformed transport payload is refused here rather
 * than handed to the domain layer.
 */

import { invoke } from '@tauri-apps/api/core'

import {
  BACKUP_INVENTORY_STATUSES,
  BACKUP_REASON_CODES,
  BACKUP_VERIFICATION_OUTCOMES,
  BACKUP_VERIFICATION_STATUSES,
  BackupInventoryError,
  isBackupInventoryErrorCode,
  type BackupInventoryItem,
  type BackupInventoryPort,
  type BackupInventoryStatus,
  type BackupReasonCode,
  type BackupVerificationOutcome,
  type BackupVerificationResult,
  type BackupVerificationStatus,
} from '@/backup/inventory.model'
import type { BackupScope } from '@/backup/model'

const LIST_COMMAND = 'native_backup_list'
const VERIFY_COMMAND = 'native_backup_verify'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isOneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return (
    typeof value === 'string' && (allowed as readonly string[]).includes(value)
  )
}

/** A malformed transport payload is a protocol violation, not a domain state. */
function protocolError(): BackupInventoryError {
  return new BackupInventoryError('UNAVAILABLE')
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Canonical lowercase UUID, as emitted by the backend. */
function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  )
}

/** A bare directory name: non-empty and cannot contain a path separator. */
function isBundleName(value: unknown): value is string {
  return isNonEmptyString(value) && !/[\\/]/.test(value)
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
  )
}

/** Lowercase hex SHA-256 (64 chars). */
function isSha256Hex(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
}

/**
 * A portable, bundle-relative path: non-empty, not absolute (POSIX `/` or
 * Windows `\` / drive letter), and containing no `..` segment.
 */
function isRelativePath(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false
  if (value.startsWith('/') || value.startsWith('\\')) return false
  if (/^[A-Za-z]:/.test(value)) return false
  return !value.split(/[\\/]/).includes('..')
}

function isReasonCode(value: unknown): value is BackupReasonCode {
  return isOneOf(value, BACKUP_REASON_CODES)
}

/** Raw transport shape of the V1 scope: camelCase `…Included` booleans. */
interface RawScope {
  readonly databaseIncluded: boolean
  readonly attachmentsIncluded: boolean
  readonly portableSettingsIncluded: boolean
}

function isRawScope(value: unknown): value is RawScope {
  return (
    isRecord(value) &&
    typeof value.databaseIncluded === 'boolean' &&
    typeof value.attachmentsIncluded === 'boolean' &&
    typeof value.portableSettingsIncluded === 'boolean'
  )
}

/** `undefined` / `null` mean "absent"; anything else must satisfy `check`. */
function parseOptional<T>(
  value: unknown,
  check: (candidate: unknown) => candidate is T,
): T | undefined {
  if (value === undefined || value === null) return undefined
  if (!check(value)) throw protocolError()
  return value
}

function parseScope(value: unknown): BackupScope {
  if (!isRawScope(value)) throw protocolError()
  return {
    database: value.databaseIncluded,
    attachments: value.attachmentsIncluded,
    portableSettings: value.portableSettingsIncluded,
  }
}

/** Strictly parse one inventory item; any malformation is a protocol error. */
function parseInventoryItem(value: unknown): BackupInventoryItem {
  if (!isRecord(value)) throw protocolError()
  const {
    backupId,
    createdAtMs,
    bundleName,
    bundleRelativePath,
    inventoryStatus,
    reasonCode,
    verificationStatus,
    appVersion,
    schemaVersion,
    sizeBytes,
    checksumSha256,
    scope,
  } = value

  if (!isBundleName(bundleName)) throw protocolError()
  if (!isRelativePath(bundleRelativePath)) throw protocolError()
  if (!isOneOf<BackupInventoryStatus>(inventoryStatus, BACKUP_INVENTORY_STATUSES)) {
    throw protocolError()
  }
  if (
    !isOneOf<BackupVerificationStatus>(verificationStatus, BACKUP_VERIFICATION_STATUSES)
  ) {
    throw protocolError()
  }

  return {
    bundleName,
    bundleRelativePath,
    inventoryStatus,
    verificationStatus,
    backupId: parseOptional(backupId, isUuid),
    createdAtMs: parseOptional(createdAtMs, isNonNegativeSafeInteger),
    reasonCode: parseOptional(reasonCode, isReasonCode),
    appVersion: parseOptional(appVersion, isNonEmptyString),
    schemaVersion: parseOptional(schemaVersion, isNonNegativeSafeInteger),
    sizeBytes: parseOptional(sizeBytes, isNonNegativeSafeInteger),
    checksumSha256: parseOptional(checksumSha256, isSha256Hex),
    scope: scope === undefined || scope === null ? undefined : parseScope(scope),
  }
}

/** Strictly parse a verification result. `NOT_VERIFIED` is not a legal outcome. */
function parseVerificationResult(value: unknown): BackupVerificationResult {
  if (!isRecord(value)) throw protocolError()
  const { backupId, verificationStatus, reasonCode, sizeBytes, checksumSha256 } =
    value

  if (!isUuid(backupId)) throw protocolError()
  if (
    !isOneOf<BackupVerificationOutcome>(
      verificationStatus,
      BACKUP_VERIFICATION_OUTCOMES,
    )
  ) {
    throw protocolError()
  }

  return {
    backupId,
    verificationStatus,
    reasonCode: parseOptional(reasonCode, isReasonCode),
    sizeBytes: parseOptional(sizeBytes, isNonNegativeSafeInteger),
    checksumSha256: parseOptional(checksumSha256, isSha256Hex),
  }
}

/** Map a thrown command error onto the shared contract. */
function mapCommandError(error: unknown): BackupInventoryError {
  if (isRecord(error) && isBackupInventoryErrorCode(error.code)) {
    return new BackupInventoryError(error.code)
  }
  // Unknown shape (a Tauri internals object, a string, …): refuse safely.
  return new BackupInventoryError('UNAVAILABLE')
}

/**
 * Native implementation of the `BackupInventoryPort` contract.
 *
 * READ-ONLY by construction: it only asks Rust to scan bundles and verify one
 * of them, and never touches the live database or mutates a bundle itself.
 */
export class NativeBackupInventoryAdapter implements BackupInventoryPort {
  async listBackups(): Promise<readonly BackupInventoryItem[]> {
    let raw: unknown
    try {
      raw = await invoke(LIST_COMMAND)
    } catch (error: unknown) {
      throw mapCommandError(error)
    }
    if (!Array.isArray(raw)) throw protocolError()
    // `Array.isArray` narrows to `any[]`; re-type so nothing unvalidated can
    // reach the domain layer.
    const entries: readonly unknown[] = raw as unknown[]
    return entries.map((entry) => parseInventoryItem(entry))
  }

  async verifyBackup(backupId: string): Promise<BackupVerificationResult> {
    let raw: unknown
    try {
      raw = await invoke(VERIFY_COMMAND, { backupId })
    } catch (error: unknown) {
      throw mapCommandError(error)
    }
    return parseVerificationResult(raw)
  }
}

/** Production Native backup inventory port. */
export const nativeBackupInventoryAdapter: BackupInventoryPort =
  new NativeBackupInventoryAdapter()
