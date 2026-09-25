/**
 * Backup service (P6-S5 · Backup V1).
 *
 * A thin application-layer wrapper over the platform `BackupPort`. It exists so
 * the workflow depends on an application service rather than a platform
 * adapter, and so future slices can add cross-cutting behavior (retention,
 * scheduling) without touching the port. It deliberately does NOT reinterpret
 * the V1 scope: the port's `BackupResult` already declares exactly what the
 * bundle contains, so this layer never claims a "full backup".
 */

import type { BackupPort, BackupResult } from './model'

export class BackupService {
  private readonly port: BackupPort

  constructor(port: BackupPort) {
    this.port = port
  }

  /** Create one backup bundle via the injected platform port. */
  createBackup(): Promise<BackupResult> {
    return this.port.createBackup()
  }
}
