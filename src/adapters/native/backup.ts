/**
 * Native backup adapter (P6-S5 · Backup V1).
 *
 * The single place allowed to invoke the `native_backup_create` command for
 * backups. It strictly re-validates every raw DTO field and maps Rust error
 * codes to the shared `BackupError` contract. No absolute path, SQLite detail,
 * or Tauri error internals escape this adapter.
 */

import { invoke } from '@tauri-apps/api/core'

import {
  BackupError,
  isBackupErrorCode,
  type BackupPort,
  type BackupResult,
  type BackupScope,
} from '@/backup/model'

const CREATE_COMMAND = 'native_backup_create'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
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

function parseScope(value: unknown): BackupScope {
  if (!isRecord(value)) throw new BackupError('BACKUP_FAILED')
  const { databaseIncluded, attachmentsIncluded, portableSettingsIncluded } =
    value
  if (
    typeof databaseIncluded !== 'boolean' ||
    typeof attachmentsIncluded !== 'boolean' ||
    typeof portableSettingsIncluded !== 'boolean'
  ) {
    throw new BackupError('BACKUP_FAILED')
  }
  return {
    database: databaseIncluded,
    attachments: attachmentsIncluded,
    portableSettings: portableSettingsIncluded,
  }
}

/** Strictly parse the create-backup DTO; any malformation is a safe failure. */
function parseBackupResult(value: unknown): BackupResult {
  if (!isRecord(value)) throw new BackupError('BACKUP_FAILED')
  const { backupId, createdAtMs, sizeBytes, checksumSha256, bundleRelativePath, scope } =
    value
  if (typeof backupId !== 'string' || backupId.length === 0) {
    throw new BackupError('BACKUP_FAILED')
  }
  if (!Number.isSafeInteger(createdAtMs) || (createdAtMs as number) < 0) {
    throw new BackupError('BACKUP_FAILED')
  }
  if (!Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 0) {
    throw new BackupError('BACKUP_FAILED')
  }
  if (!isSha256Hex(checksumSha256)) throw new BackupError('BACKUP_FAILED')
  if (!isRelativePath(bundleRelativePath)) throw new BackupError('BACKUP_FAILED')
  return {
    backupId,
    createdAtMs: createdAtMs as number,
    sizeBytes: sizeBytes as number,
    checksumSha256,
    bundleRelativePath,
    scope: parseScope(scope),
  }
}

/**
 * Native implementation of the `BackupPort` contract.
 *
 * READ-ONLY with respect to the source: it only asks Rust to produce a bundle
 * and never touches the database, the Data Root, or existing bundles itself.
 */
export class NativeBackupAdapter implements BackupPort {
  async createBackup(): Promise<BackupResult> {
    let raw: unknown
    try {
      raw = await invoke(CREATE_COMMAND)
    } catch (error: unknown) {
      if (isRecord(error) && isBackupErrorCode(error.code)) {
        throw new BackupError(error.code)
      }
      throw new BackupError('BACKUP_FAILED')
    }
    return parseBackupResult(raw)
  }
}

/** Production Native backup port. */
export const nativeBackupAdapter: BackupPort = new NativeBackupAdapter()
