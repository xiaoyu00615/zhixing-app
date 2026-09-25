/**
 * Weak backup workflow (P6-S5 · Backup V1).
 *
 * Backup = WEAK QUIESCENCE. The workflow flushes dirty Note/Diary editors by
 * acquiring the coordinator's PREPARED lease, runs the backup, and ALWAYS
 * releases the lease (success or failure). It deliberately does NOT call
 * `enterExclusiveMaintenance()` — taking the platform strong persistence
 * barrier belongs to Restore / Data Root Migration (later slices).
 *
 * Editor flush ≠ persistence drain ≠ maintenance write barrier. The editor
 * flush here is exactly what `prepareForMaintenance()` guarantees; consistency
 * of the database snapshot itself is the SQLite Online Backup API's job.
 *
 * If `prepareForMaintenance()` rejects (a dirty editor failed to flush), the
 * backup is never attempted: we must not produce "backup missing the last
 * draft" and then report success.
 */

import type { MaintenanceCoordinator } from '@/maintenance/coordinator'

import type { BackupResult } from './model'
import type { BackupService } from './service'

export interface BackupWorkflowDeps {
  /** The App-level editor-flush coordinator (weak quiescence). */
  readonly coordinator: MaintenanceCoordinator
  /** The application backup service. */
  readonly backupService: BackupService
}

/**
 * Run one weak-quiescence backup:
 *
 *   prepareForMaintenance() → createBackup() → release() (always)
 *
 * The PREPARED lease is released in `finally`, so both a failed backup and a
 * cancelled flush leave the coordinator back in IDLE and never permanently
 * lock ordinary work.
 */
export async function runWeakBackupWorkflow(
  deps: BackupWorkflowDeps,
): Promise<BackupResult> {
  const prepared = await deps.coordinator.prepareForMaintenance()
  try {
    return await deps.backupService.createBackup()
  } finally {
    prepared.release()
  }
}
