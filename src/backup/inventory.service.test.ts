/**
 * P6-S6 · BackupInventoryService tests.
 *
 * The service is a thin application-layer wrapper: it must delegate verbatim
 * and must NOT expose anything that mutates backups (no restore / delete /
 * retention / cleanup).
 */

import { describe, expect, test, vi } from 'vitest'

import { BackupInventoryService } from './inventory.service'
import type {
  BackupInventoryItem,
  BackupInventoryPort,
  BackupVerificationResult,
} from './inventory.model'

const BACKUP_ID = '11111111-2222-4333-8444-555555555555'

const ITEM: BackupInventoryItem = {
  backupId: BACKUP_ID,
  createdAtMs: 1_700_000_000_000,
  bundleName: `backup_1700000000000_${BACKUP_ID}`,
  bundleRelativePath: `backup/backup_1700000000000_${BACKUP_ID}`,
  inventoryStatus: 'STRUCTURALLY_VALID',
  verificationStatus: 'NOT_VERIFIED',
  sizeBytes: 4096,
  checksumSha256: 'a'.repeat(64),
}

const VERIFIED: BackupVerificationResult = {
  backupId: BACKUP_ID,
  verificationStatus: 'VERIFIED',
  sizeBytes: 4096,
  checksumSha256: 'a'.repeat(64),
}

/**
 * The mocks are kept as standalone consts (never accessed through `port`) so
 * their identity is unambiguous both at runtime and for the linter.
 */
function makePort() {
  const listBackups = vi.fn(() => Promise.resolve([ITEM]))
  const verifyBackup = vi.fn(() => Promise.resolve(VERIFIED))
  const port: BackupInventoryPort = { listBackups, verifyBackup }
  return { port, listBackups, verifyBackup }
}

describe('BackupInventoryService', () => {
  test('delegates list() to the port verbatim', async () => {
    const { port, listBackups } = makePort()
    const service = new BackupInventoryService(port)

    await expect(service.list()).resolves.toEqual([ITEM])
    expect(listBackups).toHaveBeenCalledOnce()
  })

  test('delegates verify() with the id and returns the port result verbatim', async () => {
    const { port, verifyBackup } = makePort()
    const service = new BackupInventoryService(port)

    await expect(service.verify(BACKUP_ID)).resolves.toEqual(VERIFIED)
    expect(verifyBackup).toHaveBeenCalledWith(BACKUP_ID)
  })

  test('propagates the port error unchanged', async () => {
    const failure = new Error('list exploded')
    const port: BackupInventoryPort = {
      listBackups: () => Promise.reject(failure),
      verifyBackup: () => Promise.reject(failure),
    }
    const service = new BackupInventoryService(port)

    await expect(service.list()).rejects.toBe(failure)
    await expect(service.verify(BACKUP_ID)).rejects.toBe(failure)
  })

  test('exposes only observation — no restore / delete / retention surface', () => {
    const service = new BackupInventoryService(makePort().port)
    const surface = service as unknown as Record<string, unknown>
    for (const forbidden of [
      'restore',
      'delete',
      'deleteBackup',
      'remove',
      'prune',
      'retention',
      'cleanup',
      'keepLatest',
    ]) {
      expect(surface[forbidden]).toBeUndefined()
    }
    expect(typeof surface.list).toBe('function')
    expect(typeof surface.verify).toBe('function')
  })
})
