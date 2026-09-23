/**
 * Unified Archive application service (P5C S3).
 *
 * This service owns the PUBLIC application semantics of the unified archive
 * workspace:
 *   - `list()` is a thin, read-only projection of the frozen
 *     {@link ArchiveRepository} contract.
 *   - `unarchive()` and `moveToTrash()` dispatch to the CANONICAL source-domain
 *     services (`TaskService` / `NoteService`) by identity only.
 *
 * It deliberately owns NO persistence:
 *   - No direct database / worker / repository writes of its own.
 *   - No rebuild of domain objects: every write is dispatched by identity, so
 *     the source domains keep their own field semantics (task status, project,
 *     tags, deadline; note title/content).
 *
 * Lifecycle contract relied upon here (frozen by P5C S1 / S2 / S2.5):
 *   - Archive is a neutral state: ACTIVE -> ARCHIVED (task_archive / note_archive).
 *   - Unarchive returns to ACTIVE (task_unarchive / note_unarchive).
 *   - Move-to-trash from ARCHIVED preserves `archivedAtMs`, so a later Trash
 *     restore returns the row to ARCHIVED (not ACTIVE) — handled entirely by the
 *     canonical source services, never here.
 *
 * Error boundary: repository codes and source-service failures are mapped to
 * the small application error model below. No SQLite / Worker / Tauri / OPFS /
 * SQL text may escape this module.
 */

import {
  ArchiveRepositoryError,
  type ArchiveEntityType,
  type ArchiveItem,
} from '@/archive/model'
import type { ArchiveRepository } from '@/archive/repository'
import type { NoteService } from '@/note/service'
import type { TaskService } from '@/task/service'

/**
 * Application error codes for the archive workspace.
 *
 * `NOT_FOUND` is intentionally absent: the archive workspace has no need for
 * it and inventing one would require synthesizing a signal the UI cannot act
 * on. Every lower-layer failure resolves to `UNAVAILABLE`.
 */
export const ARCHIVE_APPLICATION_ERROR_CODES = [
  'VALIDATION',
  'UNAVAILABLE',
] as const

export type ArchiveApplicationErrorCode =
  (typeof ARCHIVE_APPLICATION_ERROR_CODES)[number]

const SAFE_ERROR_MESSAGES: Record<ArchiveApplicationErrorCode, string> = {
  VALIDATION: 'Archive input is invalid.',
  UNAVAILABLE: 'Archive service is unavailable.',
}

export class ArchiveApplicationError extends Error {
  readonly code: ArchiveApplicationErrorCode

  constructor(code: ArchiveApplicationErrorCode) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'ArchiveApplicationError'
    this.code = code
  }
}

export interface CreateArchiveServiceOptions {
  readonly repository: ArchiveRepository
  readonly taskService: TaskService
  readonly noteService: NoteService
}

/** Identity-only unarchive input: the source domain owns every other field. */
export interface UnarchiveInput {
  readonly entityType: ArchiveEntityType
  readonly entityId: string
}

/** Identity-only move-to-trash input: the source domain owns every other field. */
export interface MoveToTrashInput {
  readonly entityType: ArchiveEntityType
  readonly entityId: string
}

const ALLOWED_ENTITY_TYPES: readonly ArchiveEntityType[] = ['task', 'note']

function isArchiveEntityType(value: unknown): value is ArchiveEntityType {
  return (
    typeof value === 'string' &&
    ALLOWED_ENTITY_TYPES.includes(value as ArchiveEntityType)
  )
}

function readEntityType(value: unknown): ArchiveEntityType {
  if (!isArchiveEntityType(value)) {
    throw new ArchiveApplicationError('VALIDATION')
  }
  return value
}

function readEntityId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ArchiveApplicationError('VALIDATION')
  }
  return value
}

function mapRepositoryError(error: unknown): ArchiveApplicationError {
  if (!(error instanceof ArchiveRepositoryError)) {
    return new ArchiveApplicationError('UNAVAILABLE')
  }

  switch (error.code) {
    case 'PERSISTENCE_ERROR':
      return new ArchiveApplicationError('UNAVAILABLE')
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw mapRepositoryError(error)
  }
}

/**
 * Every source-domain write is dispatched by identity only; the canonical
 * services own validation, timestamps and field preservation. Any failure is
 * collapsed into UNAVAILABLE so no domain/transport detail reaches the UI.
 */
async function callSourceService(operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch {
    throw new ArchiveApplicationError('UNAVAILABLE')
  }
}

export function createArchiveService({
  repository,
  taskService,
  noteService,
}: CreateArchiveServiceOptions) {
  return {
    /**
     * List the unified archive view (task / note).
     * An empty result resolves to `[]` — it is never an error.
     */
    list(): Promise<readonly ArchiveItem[]> {
      return callRepository(() => repository.list())
    },

    /**
     * Unarchive one archived entity through its canonical source-domain service.
     * Only the identity is forwarded; the owning domain service continues to own
     * timestamps, validation and field preservation.
     */
    async unarchive(input: UnarchiveInput): Promise<void> {
      const entityType = readEntityType(input.entityType)
      const entityId = readEntityId(input.entityId)
      await callSourceService(async () => {
        switch (entityType) {
          case 'task':
            await taskService.unarchiveTask(entityId)
            return
          case 'note':
            await noteService.unarchive(entityId)
            return
        }
      })
    },

    /**
     * Move one archived entity into the Trash through its canonical source
     * service. `archivedAtMs` is preserved by the canonical persistence, so a
     * later Trash restore returns the entity to ARCHIVED (not ACTIVE).
     */
    async moveToTrash(input: MoveToTrashInput): Promise<void> {
      const entityType = readEntityType(input.entityType)
      const entityId = readEntityId(input.entityId)
      await callSourceService(async () => {
        switch (entityType) {
          case 'task':
            await taskService.trashTask(entityId)
            return
          case 'note':
            await noteService.softDelete(entityId)
            return
        }
      })
    },
  }
}

export type ArchiveService = ReturnType<typeof createArchiveService>
