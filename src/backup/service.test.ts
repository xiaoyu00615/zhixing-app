/**
 * P6-S5 · BackupService tests.
 *
 * The service is a thin application-layer wrapper: it must delegate verbatim
 * and propagate the port's structured error unchanged (no reinterpretation of
 * the V1 scope, no "full backup" claim).
 */

import { describe, expect, test, vi } from 'vitest'

import { BackupError, type BackupPort, type BackupResult } from './model'
import { BackupService } from './service'

function backupResult(): BackupResult {
  return {
    backupId: '11111111-2222-4333-8444-555555555555',
    createdAtMs: 1_700_000_000_000,
    sizeBytes: 8192,
    checksumSha256: 'a'.repeat(64),
    bundleRelativePath:
      'backup/backup_1700000000000_11111111-2222-4333-8444-555555555555',
    scope: { database: true, attachments: false, portableSettings: false },
  }
}

describe('BackupService', () => {
  test('delegates createBackup to the port verbatim', async () => {
    const createBackup = vi.fn(() => Promise.resolve(backupResult()))
    const port: BackupPort = { createBackup }
    const service = new BackupService(port)
    const result = await service.createBackup()
    expect(result).toEqual(backupResult())
    expect(createBackup).toHaveBeenCalledOnce()
  })

  test('propagates the port error unchanged', async () => {
    const port: BackupPort = {
      createBackup: () => Promise.reject(new BackupError('VERIFY_FAILED')),
    }
    const service = new BackupService(port)
    await expect(service.createBackup()).rejects.toMatchObject({
      code: 'VERIFY_FAILED',
    })
  })
})
