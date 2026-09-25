/**
 * P6-S9 · Data Root Migration · shared domain model
 *
 * Naming note (frozen): this module is `dataRootMigration`. It is the physical
 * relocation of the whole Simple Data Root, and it is NOT the database **schema**
 * migration (`src/adapters/web/webMigrations.ts`, `db/migrate`). The Rust
 * subsystem tag is `data_root_migration`; the Tauri commands are
 * `native_data_root_migration_apply` / `native_data_root_migration_reconcile`.
 * Two unrelated meanings for one word is how a data-loss bug gets written.
 *
 * Scope (frozen): **SIMPLE DATA ROOT MIGRATION V1**. It moves the five fixed
 * subdirectories + `manifest.json` and re-points `bootstrap.json`. It never
 * converts layouts, never touches a Network Share, and never claims to have
 * moved anything it could not verify byte-for-byte.
 *
 * The contract mentions no native owner id, no lease id, no maintenance token
 * and no hidden platform path. The ONE path it carries is the caller's own
 * target folder — user-chosen input the domain legitimately holds (§110), and
 * exactly the value the user typed into a picker.
 */

/** Every failure this domain can report. */
export const DATA_ROOT_MIGRATION_ERROR_CODES = [
  'UNAVAILABLE',
  'REQUEST_INVALID',
  'TARGET_INVALID',
  'UNSUPPORTED_SOURCE_LAYOUT',
  'INSUFFICIENT_SPACE',
  'SAFETY_BACKUP_FAILED',
  'COPY_FAILED',
  'VERIFY_FAILED',
  'TARGET_PUBLISH_FAILED',
  'BOOTSTRAP_SWITCH_FAILED',
  'BOOTSTRAP_CHANGED',
  'ROLLED_BACK',
  'SWITCH_INDETERMINATE',
  'UNSUPPORTED_PLATFORM',
  'OWNER_UNAVAILABLE',
  'TRANSPORT_AMBIGUOUS',
  'PROTOCOL_INVALID',
  'INTERNAL',
] as const

export type DataRootMigrationErrorCode =
  (typeof DATA_ROOT_MIGRATION_ERROR_CODES)[number]

export function isDataRootMigrationErrorCode(
  value: unknown,
): value is DataRootMigrationErrorCode {
  return (
    typeof value === 'string' &&
    (DATA_ROOT_MIGRATION_ERROR_CODES as readonly string[]).includes(value)
  )
}

/**
 * Fixed, UI-safe message per code. Kept HERE (not taken from the transport) so
 * a malformed or hostile payload can never inject text into the UI, and so an
 * adapter can never quietly reword a data-safety statement.
 *
 * Every message that describes an incomplete migration says so explicitly: the
 * user must never be left believing files moved when they did not.
 */
const SAFE_MESSAGES: Record<DataRootMigrationErrorCode, string> = {
  UNAVAILABLE: 'The data folder cannot be moved right now.',
  REQUEST_INVALID: 'The move request was invalid.',
  TARGET_INVALID: 'The destination folder is not usable.',
  UNSUPPORTED_SOURCE_LAYOUT:
    'The current data folder has an unsupported layout, so nothing was moved.',
  INSUFFICIENT_SPACE:
    'There is not enough free space at the destination, so nothing was moved.',
  SAFETY_BACKUP_FAILED:
    'The current data could not be backed up, so nothing was moved.',
  COPY_FAILED:
    'The data could not be copied; the current data folder is unchanged.',
  VERIFY_FAILED:
    'The copied data failed verification, so nothing was moved.',
  TARGET_PUBLISH_FAILED:
    'The destination folder could not be created; the current data folder is unchanged.',
  BOOTSTRAP_SWITCH_FAILED:
    'The app could not be pointed at the destination folder; the current data folder is unchanged.',
  BOOTSTRAP_CHANGED:
    'The stored data location changed during the move, so the result could not be confirmed.',
  ROLLED_BACK: 'The move failed and the previous data folder was restored.',
  SWITCH_INDETERMINATE: 'The move outcome could not be confirmed.',
  UNSUPPORTED_PLATFORM: 'Moving the data folder is not supported here.',
  OWNER_UNAVAILABLE:
    'The move was not authorized and nothing was changed.',
  TRANSPORT_AMBIGUOUS: 'The move outcome could not be confirmed.',
  PROTOCOL_INVALID: 'The move outcome could not be confirmed.',
  INTERNAL: 'The move could not be completed.',
}

export function safeMessageForMigrationCode(
  code: DataRootMigrationErrorCode,
): string {
  return SAFE_MESSAGES[code]
}

/**
 * Whether releasing the strong barrier after this failure is provable.
 *
 * - RECOVERABLE: the authoritative Data Root is PROVEN to be either the
 *   unchanged source or the fully verified target. The workflow may release the
 *   exclusive lease.
 * - BLOCKED: which root is authoritative cannot be proven. The workflow MUST
 *   NOT release; it hands back a `BlockedDataRootMigrationSession` and the
 *   barrier stays active until a reconcile proves otherwise.
 *
 * This is a safety claim about which directory holds the user's only copy of
 * their data, so it is assigned explicitly per code — never inferred from a
 * message, and never defaulted to RECOVERABLE.
 */
export type DataRootMigrationDisposition = 'RECOVERABLE' | 'BLOCKED'

/** Explicit code → disposition table. A missing entry is a programming error. */
const BLOCKED_CODES: readonly DataRootMigrationErrorCode[] = [
  // The bootstrap moved under us: which root is authoritative is exactly what we
  // can no longer prove (Rust `BootstrapChanged`).
  'BOOTSTRAP_CHANGED',
  'SWITCH_INDETERMINATE',
  // A malformed transport payload means the outcome is UNREADABLE, not that it
  // failed. Reading it as recoverable would release the barrier over a data
  // folder nobody has proven.
  'TRANSPORT_AMBIGUOUS',
  'PROTOCOL_INVALID',
  'INTERNAL',
]

export function dispositionForMigrationCode(
  code: DataRootMigrationErrorCode,
): DataRootMigrationDisposition {
  return BLOCKED_CODES.includes(code) ? 'BLOCKED' : 'RECOVERABLE'
}

/**
 * Typed migration failure. `safeMessage` is UI-safe: no path, no OS text, no
 * SQLite text, no platform token.
 */
export class DataRootMigrationError extends Error {
  public readonly code: DataRootMigrationErrorCode
  public readonly disposition: DataRootMigrationDisposition
  public readonly safeMessage: string

  constructor(
    code: DataRootMigrationErrorCode,
    safeMessage: string,
    disposition: DataRootMigrationDisposition = dispositionForMigrationCode(code),
  ) {
    super(safeMessage)
    this.name = 'DataRootMigrationError'
    this.code = code
    this.safeMessage = safeMessage
    this.disposition = disposition
  }
}

/** Evidence-based answer to "which folder holds the authoritative data?". */
export const DATA_ROOT_MIGRATION_RECONCILE_OUTCOMES = [
  'COMMITTED',
  'NOT_COMMITTED',
  'ROLLED_BACK',
  'INDETERMINATE',
] as const

export type DataRootMigrationReconcileOutcome =
  (typeof DATA_ROOT_MIGRATION_RECONCILE_OUTCOMES)[number]

export function isDataRootMigrationReconcileOutcome(
  value: unknown,
): value is DataRootMigrationReconcileOutcome {
  return (
    typeof value === 'string' &&
    (DATA_ROOT_MIGRATION_RECONCILE_OUTCOMES as readonly string[]).includes(value)
  )
}

/**
 * Safe reason codes for an INDETERMINATE reconcile. Never a raw OS or SQLite
 * message. Mirrors the Rust `MigrationReconcileReason` enum one-for-one, plus
 * the two transport-level reasons an adapter can raise on its own.
 */
export const DATA_ROOT_MIGRATION_RECONCILE_REASONS = [
  'JOURNAL_MISSING',
  'JOURNAL_UNREADABLE',
  'COPY_MANIFEST_UNREADABLE',
  'BOOTSTRAP_MISSING',
  'BOOTSTRAP_UNREADABLE',
  'BOOTSTRAP_POINTS_NEITHER',
  'TARGET_INVALID',
  'SOURCE_INVALID',
  'EVIDENCE_CONTRADICTORY',
  'TRANSPORT_AMBIGUOUS',
  'PROTOCOL_INVALID',
] as const

export type DataRootMigrationReconcileReason =
  (typeof DATA_ROOT_MIGRATION_RECONCILE_REASONS)[number]

export function isDataRootMigrationReconcileReason(
  value: unknown,
): value is DataRootMigrationReconcileReason {
  return (
    typeof value === 'string' &&
    (DATA_ROOT_MIGRATION_RECONCILE_REASONS as readonly string[]).includes(value)
  )
}

/**
 * A migration request.
 *
 * `operationId` is generated ONCE by the application workflow and reused
 * verbatim for the transport retry and every reconcile, so a lost
 * acknowledgement can always be resolved against the same operation.
 *
 * `targetDataRoot` is the user's own destination folder. It is sent as the user
 * spelled it; the backend returns the AUTHORITATIVE, normalised root, so a
 * result is never required to echo this string character-for-character.
 */
export interface DataRootMigrationRequest {
  readonly operationId: string
  readonly targetDataRoot: string
}

/** Successful apply. Carries no hidden path and no platform token. */
export interface DataRootMigrationApplyResult {
  readonly operationId: string
  /** The authoritative target root as the backend normalised it. */
  readonly targetDataRoot: string
  readonly outcome: 'MIGRATED'
  /** The Safety Backup bundle created before anything was copied. */
  readonly safetyBackupId: string
}

export interface DataRootMigrationReconcileResult {
  readonly operationId: string
  /** The authoritative target root recorded in the migration journal. */
  readonly targetDataRoot: string
  readonly outcome: DataRootMigrationReconcileOutcome
  readonly reasonCode?: DataRootMigrationReconcileReason
  readonly safetyBackupId?: string
}

/**
 * The port a platform adapter implements.
 *
 * `applyDataRootMigration` resolves ONLY when the migration is proven applied.
 * Every other outcome is either a typed `DataRootMigrationError` (with its
 * disposition) or — for an unprovable outcome — a `BLOCKED` error, so the
 * caller can never mistake "we do not know" for "it failed".
 */
export interface DataRootMigrationPort {
  applyDataRootMigration(
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationApplyResult>
  reconcileDataRootMigration(
    request: DataRootMigrationRequest,
  ): Promise<DataRootMigrationReconcileResult>
}

/** Canonical lowercase UUID, as emitted by the backend. */
export const MIGRATION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isMigrationUuid(value: unknown): value is string {
  return typeof value === 'string' && MIGRATION_UUID_PATTERN.test(value)
}

/**
 * A CHEAP, boundary-level sanity check on a user-chosen destination folder.
 *
 * It is deliberately a *necessary* condition, not a sufficient one: it accepts
 * a POSIX-absolute path, a Windows drive-absolute path and a UNC path, and the
 * backend still performs the authoritative validation (absolute, local, an
 * existing parent, the target itself absent, and no containment either way).
 * Being permissive here can never make an unsafe target succeed — the backend
 * fails closed — while being overly strict could reject a legitimate folder.
 */
export function isUsableTargetDataRoot(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const trimmed = value.trim()
  if (trimmed.length === 0) return false
  if (trimmed.startsWith('/') || trimmed.startsWith('\\')) return true
  return /^[A-Za-z]:[\\/]/.test(trimmed)
}

/** Stable, unique operation identity for one migration attempt. */
export function createDataRootMigrationOperationId(): string {
  return crypto.randomUUID()
}
