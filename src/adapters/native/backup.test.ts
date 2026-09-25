/**
 * P6-S5 · Native Backup Adapter tests.
 *
 * `invoke` from `@tauri-apps/api/core` is mocked so we verify the adapter's
 * exact command/argument contract, strict DTO validation, and safe error
 * mapping (spec §47).
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeBackupAdapter } from './backup'
import { BackupError } from '@/backup/model'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: h.invoke,
}))

const VALID_DTO = {
  backupId: '11111111-2222-4333-8444-555555555555',
  createdAtMs: 1_700_000_000_000,
  sizeBytes: 4096,
  checksumSha256: 'a'.repeat(64),
  bundleRelativePath:
    'backup/backup_1700000000000_11111111-2222-4333-8444-555555555555',
  scope: {
    databaseIncluded: true,
    attachmentsIncluded: false,
    portableSettingsIncluded: false,
  },
}

describe('NativeBackupAdapter', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('invokes the exact command and parses a valid DTO', async () => {
    h.invoke.mockResolvedValue(VALID_DTO)
    const adapter = new NativeBackupAdapter()
    const result = await adapter.createBackup()
    expect(h.invoke).toHaveBeenCalledWith('native_backup_create')
    expect(result).toEqual({
      backupId: VALID_DTO.backupId,
      createdAtMs: VALID_DTO.createdAtMs,
      sizeBytes: VALID_DTO.sizeBytes,
      checksumSha256: VALID_DTO.checksumSha256,
      bundleRelativePath: VALID_DTO.bundleRelativePath,
      scope: {
        database: true,
        attachments: false,
        portableSettings: false,
      },
    })
  })

  test('malformed results are rejected with a safe error', async () => {
    const malformed: unknown[] = [
      null,
      'not-an-object',
      { ...VALID_DTO, backupId: '' },
      { ...VALID_DTO, backupId: 123 },
      { ...VALID_DTO, createdAtMs: -1 },
      { ...VALID_DTO, createdAtMs: 1.5 },
      { ...VALID_DTO, sizeBytes: -1 },
      { ...VALID_DTO, checksumSha256: 'xyz' },
      { ...VALID_DTO, checksumSha256: 'A'.repeat(64) }, // uppercase not allowed
      { ...VALID_DTO, bundleRelativePath: '/abs/path' },
      { ...VALID_DTO, bundleRelativePath: 'C:\\abs\\path' },
      { ...VALID_DTO, bundleRelativePath: 'backup/../escape' },
      { ...VALID_DTO, bundleRelativePath: '' },
      { ...VALID_DTO, scope: { databaseIncluded: true } },
      { ...VALID_DTO, scope: 'database' },
    ]
    const adapter = new NativeBackupAdapter()
    for (const value of malformed) {
      h.invoke.mockResolvedValue(value)
      await expect(adapter.createBackup()).rejects.toBeInstanceOf(BackupError)
    }
  })

  test('known error codes are mapped 1:1', async () => {
    const codes = [
      'UNAVAILABLE',
      'SOURCE_INVALID',
      'DESTINATION_INVALID',
      'BACKUP_FAILED',
      'VERIFY_FAILED',
      'MANIFEST_FAILED',
    ] as const
    const adapter = new NativeBackupAdapter()
    for (const code of codes) {
      h.invoke.mockRejectedValue({ code, message: 'safe' })
      await expect(adapter.createBackup()).rejects.toMatchObject({ code })
    }
  })

  test('unknown error shapes are mapped safely to BACKUP_FAILED', async () => {
    const adapter = new NativeBackupAdapter()
    const unknownErrors: unknown[] = [
      new Error('boom'),
      'string-error',
      { code: 'SOMETHING_ELSE' },
      { code: 42 },
      { notACode: true },
    ]
    for (const error of unknownErrors) {
      h.invoke.mockRejectedValue(error)
      await expect(adapter.createBackup()).rejects.toMatchObject({
        code: 'BACKUP_FAILED',
      })
    }
  })
})
