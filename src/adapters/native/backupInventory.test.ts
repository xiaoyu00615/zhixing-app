/**
 * P6-S6 · Native backup inventory adapter tests.
 *
 * `invoke` from `@tauri-apps/api/core` is mocked so we verify the adapter's
 * exact command/argument contract, its strict DTO validation (nothing
 * unvalidated may reach the domain layer), and its safe error mapping.
 */

import { beforeEach, describe, expect, test, vi } from 'vitest'

import { NativeBackupInventoryAdapter } from './backupInventory'
import { BackupInventoryError } from '@/backup/inventory.model'

const h = vi.hoisted(() => ({
  invoke: vi.fn(),
}))

vi.mock('@tauri-apps/api/core', () => ({
  invoke: h.invoke,
}))

const BACKUP_ID = '11111111-2222-4333-8444-555555555555'
const NAME = `backup_1700000000000_${BACKUP_ID}`

const VALID_ITEM = {
  backupId: BACKUP_ID,
  createdAtMs: 1_700_000_000_000,
  bundleName: NAME,
  bundleRelativePath: `backup/${NAME}`,
  inventoryStatus: 'STRUCTURALLY_VALID',
  verificationStatus: 'NOT_VERIFIED',
  appVersion: '0.1.0',
  schemaVersion: 15,
  sizeBytes: 4096,
  checksumSha256: 'a'.repeat(64),
  scope: {
    databaseIncluded: true,
    attachmentsIncluded: false,
    portableSettingsIncluded: false,
  },
}

const EXPECTED_ITEM = {
  backupId: BACKUP_ID,
  createdAtMs: 1_700_000_000_000,
  bundleName: NAME,
  bundleRelativePath: `backup/${NAME}`,
  inventoryStatus: 'STRUCTURALLY_VALID',
  verificationStatus: 'NOT_VERIFIED',
  appVersion: '0.1.0',
  schemaVersion: 15,
  sizeBytes: 4096,
  checksumSha256: 'a'.repeat(64),
  scope: {
    database: true,
    attachments: false,
    portableSettings: false,
  },
}

const SPARSE_ITEM = {
  bundleName: '.creating_abc',
  bundleRelativePath: 'backup/.creating_abc',
  inventoryStatus: 'INCOMPLETE',
  reasonCode: 'STAGING_INCOMPLETE',
  verificationStatus: 'NOT_VERIFIED',
}

describe('NativeBackupInventoryAdapter', () => {
  beforeEach(() => {
    h.invoke.mockReset()
  })

  test('list invokes the exact command and parses valid items', async () => {
    h.invoke.mockResolvedValue([VALID_ITEM, SPARSE_ITEM])
    const adapter = new NativeBackupInventoryAdapter()

    const result = await adapter.listBackups()

    expect(h.invoke).toHaveBeenCalledWith('native_backup_list')
    expect(result).toEqual([
      EXPECTED_ITEM,
      {
        bundleName: '.creating_abc',
        bundleRelativePath: 'backup/.creating_abc',
        inventoryStatus: 'INCOMPLETE',
        reasonCode: 'STAGING_INCOMPLETE',
        verificationStatus: 'NOT_VERIFIED',
      },
    ])
  })

  test('an empty inventory is a valid result', async () => {
    h.invoke.mockResolvedValue([])
    const adapter = new NativeBackupInventoryAdapter()
    await expect(adapter.listBackups()).resolves.toEqual([])
  })

  test('verify invokes the exact command with the backupId argument', async () => {
    h.invoke.mockResolvedValue({
      backupId: BACKUP_ID,
      verificationStatus: 'VERIFIED',
      sizeBytes: 4096,
      checksumSha256: 'a'.repeat(64),
    })
    const adapter = new NativeBackupInventoryAdapter()

    const result = await adapter.verifyBackup(BACKUP_ID)

    expect(h.invoke).toHaveBeenCalledWith('native_backup_verify', {
      backupId: BACKUP_ID,
    })
    expect(result).toEqual({
      backupId: BACKUP_ID,
      verificationStatus: 'VERIFIED',
      sizeBytes: 4096,
      checksumSha256: 'a'.repeat(64),
    })
  })

  test('verify parses a FAILED result with its reason code', async () => {
    h.invoke.mockResolvedValue({
      backupId: BACKUP_ID,
      verificationStatus: 'FAILED',
      reasonCode: 'CHECKSUM_MISMATCH',
      sizeBytes: 4096,
      checksumSha256: 'b'.repeat(64),
    })
    const adapter = new NativeBackupInventoryAdapter()

    await expect(adapter.verifyBackup(BACKUP_ID)).resolves.toEqual({
      backupId: BACKUP_ID,
      verificationStatus: 'FAILED',
      reasonCode: 'CHECKSUM_MISMATCH',
      sizeBytes: 4096,
      checksumSha256: 'b'.repeat(64),
    })
  })

  test('verify refuses NOT_VERIFIED as an outcome', async () => {
    h.invoke.mockResolvedValue({
      backupId: BACKUP_ID,
      verificationStatus: 'NOT_VERIFIED',
    })
    const adapter = new NativeBackupInventoryAdapter()

    await expect(adapter.verifyBackup(BACKUP_ID)).rejects.toMatchObject({
      name: 'BackupInventoryError',
      code: 'UNAVAILABLE',
    })
  })

  test('malformed list payloads are refused with a safe error', async () => {
    const malformed: unknown[] = [
      null,
      'not-an-array',
      {},
      [null],
      ['an-item'],
      [42],
      [{ ...VALID_ITEM, bundleName: '' }],
      [{ ...VALID_ITEM, bundleName: 'a/b' }],
      [{ ...VALID_ITEM, bundleRelativePath: '' }],
      [{ ...VALID_ITEM, bundleRelativePath: '/abs/path' }],
      [{ ...VALID_ITEM, bundleRelativePath: 'C:\\abs\\path' }],
      [{ ...VALID_ITEM, bundleRelativePath: 'backup/../escape' }],
      [{ ...VALID_ITEM, backupId: 'not-a-uuid' }],
      [{ ...VALID_ITEM, backupId: '' }],
      [{ ...VALID_ITEM, createdAtMs: -1 }],
      [{ ...VALID_ITEM, createdAtMs: 1.5 }],
      [{ ...VALID_ITEM, sizeBytes: -1 }],
      [{ ...VALID_ITEM, sizeBytes: 'big' }],
      [{ ...VALID_ITEM, checksumSha256: 'xyz' }],
      [{ ...VALID_ITEM, checksumSha256: 'A'.repeat(64) }],
      [{ ...VALID_ITEM, appVersion: '' }],
      [{ ...VALID_ITEM, schemaVersion: 'fifteen' }],
      [{ ...VALID_ITEM, scope: { databaseIncluded: true } }],
      [{ ...VALID_ITEM, scope: 'database' }],
    ]
    const adapter = new NativeBackupInventoryAdapter()
    for (const value of malformed) {
      h.invoke.mockResolvedValue(value)
      await expect(adapter.listBackups()).rejects.toMatchObject({
        name: 'BackupInventoryError',
        code: 'UNAVAILABLE',
      })
    }
  })

  test('unknown or malformed enum values are refused', async () => {
    const malformed: unknown[] = [
      [{ ...VALID_ITEM, inventoryStatus: 'VALID' }],
      [{ ...VALID_ITEM, inventoryStatus: 'valid' }],
      [{ ...VALID_ITEM, inventoryStatus: 1 }],
      [{ ...VALID_ITEM, verificationStatus: 'MAYBE' }],
      [{ ...VALID_ITEM, verificationStatus: true }],
      [{ ...VALID_ITEM, reasonCode: 'WAT' }],
      [{ ...VALID_ITEM, reasonCode: 7 }],
    ]
    const adapter = new NativeBackupInventoryAdapter()
    for (const value of malformed) {
      h.invoke.mockResolvedValue(value)
      await expect(adapter.listBackups()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    }
  })

  test('malformed verify payloads are refused', async () => {
    const malformed: unknown[] = [
      null,
      'verified',
      {},
      { backupId: 'not-a-uuid', verificationStatus: 'VERIFIED' },
      { backupId: BACKUP_ID, verificationStatus: 'NOT_VERIFIED' },
      { backupId: BACKUP_ID, verificationStatus: 'okay' },
      { backupId: BACKUP_ID, verificationStatus: 'FAILED', reasonCode: 'NOPE' },
      { backupId: BACKUP_ID, verificationStatus: 'FAILED', sizeBytes: -1 },
      {
        backupId: BACKUP_ID,
        verificationStatus: 'FAILED',
        checksumSha256: 'zz',
      },
    ]
    const adapter = new NativeBackupInventoryAdapter()
    for (const value of malformed) {
      h.invoke.mockResolvedValue(value)
      await expect(adapter.verifyBackup(BACKUP_ID)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    }
  })

  test('known command error codes are mapped 1:1', async () => {
    const codes = [
      'UNAVAILABLE',
      'NOT_FOUND',
      'AMBIGUOUS',
      'UNSUPPORTED',
      'REQUEST_INVALID',
      'INTERNAL',
    ] as const
    const adapter = new NativeBackupInventoryAdapter()
    for (const code of codes) {
      h.invoke.mockRejectedValue({ code, message: 'safe' })
      await expect(adapter.listBackups()).rejects.toMatchObject({ code })
      await expect(adapter.verifyBackup(BACKUP_ID)).rejects.toMatchObject({
        code,
      })
    }
  })

  test('unknown error shapes are mapped safely to UNAVAILABLE', async () => {
    const adapter = new NativeBackupInventoryAdapter()
    const unknownErrors: unknown[] = [
      new Error('boom'),
      'string-error',
      { code: 'SOMETHING_ELSE' },
      { code: 42 },
      { notACode: true },
    ]
    for (const error of unknownErrors) {
      h.invoke.mockRejectedValue(error)
      await expect(adapter.listBackups()).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
      await expect(adapter.verifyBackup(BACKUP_ID)).rejects.toMatchObject({
        code: 'UNAVAILABLE',
      })
    }
  })

  test('a refused payload throws the shared error contract, not a bare Error', async () => {
    h.invoke.mockResolvedValue({})
    const adapter = new NativeBackupInventoryAdapter()
    await expect(adapter.listBackups()).rejects.toBeInstanceOf(
      BackupInventoryError,
    )
  })
})
