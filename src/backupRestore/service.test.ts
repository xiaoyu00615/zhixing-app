/**
 * P6-S8 · Backup Restore service tests
 *
 * The service is a thin boundary: it validates the request shape at the domain
 * edge and forwards the SAME identity, so a malformed id can never reach a
 * platform adapter and a retry can never silently mint a new operation.
 */

import { describe, expect, test, vi } from 'vitest'

import { BackupRestoreError, type BackupRestorePort } from './model'
import { BackupRestoreService } from './service'

const OP = '11111111-1111-4111-8111-111111111111'
const BACKUP = '22222222-2222-4222-8222-222222222222'
const SHA = 'a'.repeat(64)

function makePort() {
  // `Promise.resolve(...)` rather than `async () => ...`: these stubs resolve
  // immediately and never await, so an `async` wrapper would be noise.
  const applyBackupRestore = vi.fn<
    BackupRestorePort['applyBackupRestore']
  >(() =>
    Promise.resolve({
      operationId: OP,
      backupId: BACKUP,
      outcome: 'RESTORED' as const,
      safetyBackupId: '33333333-3333-4333-8333-333333333333',
      restoredChecksumSha256: SHA,
    }),
  )
  const reconcileBackupRestore = vi.fn<
    BackupRestorePort['reconcileBackupRestore']
  >(() =>
    Promise.resolve({
      operationId: OP,
      backupId: BACKUP,
      outcome: 'COMMITTED' as const,
    }),
  )
  const port: BackupRestorePort = {
    applyBackupRestore,
    reconcileBackupRestore,
  }
  return { port, applyBackupRestore, reconcileBackupRestore }
}

describe('BackupRestoreService', () => {
  test('apply forwards the exact operation identity', async () => {
    const { port, applyBackupRestore } = makePort()
    const service = new BackupRestoreService(port)

    const result = await service.apply({ operationId: OP, backupId: BACKUP })

    expect(applyBackupRestore).toHaveBeenCalledTimes(1)
    expect(applyBackupRestore).toHaveBeenCalledWith({
      operationId: OP,
      backupId: BACKUP,
    })
    expect(result.outcome).toBe('RESTORED')
  })

  test('reconcile reuses the SAME operation identity', async () => {
    const { port, reconcileBackupRestore } = makePort()
    const service = new BackupRestoreService(port)

    await service.reconcile({ operationId: OP, backupId: BACKUP })

    expect(reconcileBackupRestore).toHaveBeenCalledWith({
      operationId: OP,
      backupId: BACKUP,
    })
  })

  test('a malformed operation id is refused before the port is reached', async () => {
    const { port, applyBackupRestore, reconcileBackupRestore } = makePort()
    const service = new BackupRestoreService(port)

    await expect(
      service.apply({ operationId: 'not-a-uuid', backupId: BACKUP }),
    ).rejects.toBeInstanceOf(BackupRestoreError)
    await expect(
      service.reconcile({ operationId: OP, backupId: 'nope' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' })

    expect(applyBackupRestore).not.toHaveBeenCalled()
    expect(reconcileBackupRestore).not.toHaveBeenCalled()
  })

  test('an uppercase UUID is refused (identity is canonical)', async () => {
    const { port, applyBackupRestore } = makePort()
    const service = new BackupRestoreService(port)

    // A UUID that actually contains letters — `OP` is digits-only, so
    // `OP.toUpperCase()` would be a no-op and this test would pass vacuously.
    const lowercase = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const uppercase = lowercase.toUpperCase()
    expect(uppercase).not.toBe(lowercase)

    await expect(
      service.apply({ operationId: uppercase, backupId: BACKUP }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
    expect(applyBackupRestore).not.toHaveBeenCalled()
  })
})
