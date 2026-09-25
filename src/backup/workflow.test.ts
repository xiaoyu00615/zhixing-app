/**
 * P6-S5 · Weak backup workflow tests.
 *
 * Proves the frozen weak-quiescence contract (spec §29-§32):
 *   - editors are flushed BEFORE the backup is created
 *   - an editor flush failure means the backup is never attempted
 *   - a successful / failed backup ALWAYS releases the PREPARED lease
 *   - the workflow never uses strong maintenance
 */

import { describe, expect, test, vi } from 'vitest'

import { MaintenanceCoordinator } from '@/maintenance/coordinator'
import {
  PersistenceMaintenanceError,
  type PersistenceMaintenanceLease,
  type PersistenceMaintenancePort,
} from '@/maintenance/model'

import type { BackupPort, BackupResult } from './model'
import { BackupService } from './service'
import { runWeakBackupWorkflow } from './workflow'

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

/** A platform port that must never be entered by a weak backup. */
class CountingPort implements PersistenceMaintenancePort {
  enterCallCount = 0

  enterStrongMaintenance(): Promise<PersistenceMaintenanceLease> {
    this.enterCallCount += 1
    return Promise.reject(
      new PersistenceMaintenanceError(
        'FAKE',
        'BLOCKED',
        'weak backup must not enter strong maintenance',
      ),
    )
  }
}

describe('runWeakBackupWorkflow', () => {
  test('flushes editors BEFORE creating the backup', async () => {
    const coordinator = new MaintenanceCoordinator()
    const order: string[] = []
    coordinator.register({
      id: 'note-editor',
      flush: () => {
        order.push('flush')
        return Promise.resolve()
      },
    })
    const port: BackupPort = {
      createBackup: () => {
        order.push('backup')
        return Promise.resolve(backupResult())
      },
    }
    await runWeakBackupWorkflow({
      coordinator,
      backupService: new BackupService(port),
    })
    expect(order).toEqual(['flush', 'backup'])
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('editor flush failure => the backup is never attempted, state IDLE', async () => {
    const coordinator = new MaintenanceCoordinator()
    coordinator.register({
      id: 'note-editor',
      flush: () => Promise.reject(new Error('save failed')),
    })
    const createBackup = vi.fn(() => Promise.resolve(backupResult()))
    await expect(
      runWeakBackupWorkflow({
        coordinator,
        backupService: new BackupService({ createBackup }),
      }),
    ).rejects.toThrow(/save failed/i)
    expect(createBackup).not.toHaveBeenCalled()
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('backup success releases the prepared lease (PREPARED during, IDLE after)', async () => {
    const coordinator = new MaintenanceCoordinator()
    let stateDuringBackup: string | null = null
    const backupService = new BackupService({
      createBackup: () => {
        stateDuringBackup = coordinator.getState()
        return Promise.resolve(backupResult())
      },
    })
    const result = await runWeakBackupWorkflow({ coordinator, backupService })
    expect(result.backupId).toBe('11111111-2222-4333-8444-555555555555')
    expect(stateDuringBackup).toBe('PREPARED')
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('backup failure still releases the prepared lease', async () => {
    const coordinator = new MaintenanceCoordinator()
    const backupService = new BackupService({
      createBackup: () => Promise.reject(new Error('backup blew up')),
    })
    await expect(
      runWeakBackupWorkflow({ coordinator, backupService }),
    ).rejects.toThrow(/backup blew up/i)
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('does NOT use strong maintenance (port never entered)', async () => {
    const port = new CountingPort()
    const coordinator = new MaintenanceCoordinator(port)
    const enterSpy = vi.spyOn(coordinator, 'enterExclusiveMaintenance')
    const backupService = new BackupService({
      createBackup: () => Promise.resolve(backupResult()),
    })

    await runWeakBackupWorkflow({ coordinator, backupService })

    expect(enterSpy).not.toHaveBeenCalled()
    expect(port.enterCallCount).toBe(0)
    expect(coordinator.getState()).toBe('IDLE')
  })

  test('a second backup can run after the first released (coordinator reusable)', async () => {
    const coordinator = new MaintenanceCoordinator()
    let count = 0
    const backupService = new BackupService({
      createBackup: () => {
        count += 1
        return Promise.resolve(backupResult())
      },
    })
    await runWeakBackupWorkflow({ coordinator, backupService })
    await runWeakBackupWorkflow({ coordinator, backupService })
    expect(count).toBe(2)
    expect(coordinator.getState()).toBe('IDLE')
  })
})
