/**
 * Backup inventory service (P6-S6).
 *
 * A thin application-layer wrapper over the platform `BackupInventoryPort`. It
 * exists so callers depend on an application service rather than a platform
 * adapter, and so a future UI slice can add presentation concerns without
 * touching the port.
 *
 * It deliberately exposes ONLY observation: `list()` and `verify(id)`.
 * Restore, deletion, retention and cleanup are out of scope and must not be
 * smuggled in here.
 */

import type {
  BackupInventoryItem,
  BackupInventoryPort,
  BackupVerificationResult,
} from './inventory.model'

export class BackupInventoryService {
  private readonly port: BackupInventoryPort

  constructor(port: BackupInventoryPort) {
    this.port = port
  }

  /** List the known backup bundles (structural only — never verified). */
  list(): Promise<readonly BackupInventoryItem[]> {
    return this.port.listBackups()
  }

  /**
   * Fully verify one bundle by id. This is the only path that can report
   * `VERIFIED`, and the path a future Restore must use first.
   */
  verify(backupId: string): Promise<BackupVerificationResult> {
    return this.port.verifyBackup(backupId)
  }
}
