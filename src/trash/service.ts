/**
 * Unified Trash application service (P5B S3).
 *
 * This service owns the PUBLIC application semantics of the unified trash
 * workspace:
 *   - `list()` is a thin, read-only projection of the frozen
 *     {@link TrashRepository} contract.
 *   - `restore()` dispatches to the CANONICAL source-domain service that owns
 *     the restore operation (`TaskService` / `NoteService` / `DiaryService`).
 *
 * It deliberately owns NO persistence:
 *   - No direct database / worker / repository writes.
 *   - No rebuild of domain objects: restore is dispatched by identity only, so
 *     every source domain keeps its own field semantics (task status, project,
 *     tags, deadline; note title/content; diary date/title/content).
 *
 * Error boundary: repository codes and source-service failures are mapped to
 * the small application error model below. No SQLite / Worker / Tauri / OPFS /
 * SQL text may escape this module.
 */

import {
  TrashRepositoryError,
  type TrashEntityType,
  type TrashItem,
} from '@/trash/model'
import type { TrashRepository } from '@/trash/repository'
import type { DiaryService } from '@/diary/service'
import type { NoteService } from '@/note/service'
import type { TaskService } from '@/task/service'

/**
 * Application error codes for the trash workspace.
 *
 * `NOT_FOUND` is intentionally absent: the trash workspace has no need for it
 * and inventing one would require synthesizing a signal that the UI cannot
 * act on. Every lower-layer failure resolves to `UNAVAILABLE`.
 */
export const TRASH_APPLICATION_ERROR_CODES = [
  'VALIDATION',
  'UNAVAILABLE',
] as const

export type TrashApplicationErrorCode =
  (typeof TRASH_APPLICATION_ERROR_CODES)[number]

const SAFE_ERROR_MESSAGES: Record<TrashApplicationErrorCode, string> = {
  VALIDATION: 'Trash input is invalid.',
  UNAVAILABLE: 'Trash service is unavailable.',
}

export class TrashApplicationError extends Error {
  readonly code: TrashApplicationErrorCode

  constructor(code: TrashApplicationErrorCode) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'TrashApplicationError'
    this.code = code
  }
}

export interface CreateTrashServiceOptions {
  readonly repository: TrashRepository
  readonly taskService: TaskService
  readonly noteService: NoteService
  readonly diaryService: DiaryService
}

/** Identity-only restore input: the source domain owns every other field. */
export interface RestoreTrashItemInput {
  readonly entityType: TrashEntityType
  readonly entityId: string
}

const ALLOWED_ENTITY_TYPES: readonly TrashEntityType[] = ['task', 'note', 'diary']

function isTrashEntityType(value: unknown): value is TrashEntityType {
  return (
    typeof value === 'string' &&
    ALLOWED_ENTITY_TYPES.includes(value as TrashEntityType)
  )
}

function readEntityType(value: unknown): TrashEntityType {
  if (!isTrashEntityType(value)) {
    throw new TrashApplicationError('VALIDATION')
  }
  return value
}

function readEntityId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TrashApplicationError('VALIDATION')
  }
  return value
}

function mapRepositoryError(error: unknown): TrashApplicationError {
  if (!(error instanceof TrashRepositoryError)) {
    return new TrashApplicationError('UNAVAILABLE')
  }

  switch (error.code) {
    case 'PERSISTENCE_ERROR':
      return new TrashApplicationError('UNAVAILABLE')
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw mapRepositoryError(error)
  }
}

export function createTrashService({
  repository,
  taskService,
  noteService,
  diaryService,
}: CreateTrashServiceOptions) {
  return {
    /**
     * List the unified trash view (task / note / diary).
     * An empty result resolves to `[]` — it is never an error.
     */
    list(): Promise<readonly TrashItem[]> {
      return callRepository(() => repository.list())
    },

    /**
     * Restore one trashed entity through its canonical source-domain service.
     *
     * Only the identity is forwarded; the owning domain service continues to
     * own timestamps, validation and field preservation.
     */
    async restore(input: RestoreTrashItemInput): Promise<void> {
      const entityType = readEntityType(input.entityType)
      const entityId = readEntityId(input.entityId)

      try {
        switch (entityType) {
          case 'task':
            await taskService.restoreTask(entityId)
            return
          case 'note':
            await noteService.restore(entityId)
            return
          case 'diary':
            await diaryService.restore(entityId)
            return
        }
      } catch (error: unknown) {
        // The source-domain services already expose a stable application error
        // model; the trash workspace collapses every failure into UNAVAILABLE
        // so no domain/transport detail reaches the UI.
        if (error instanceof TrashApplicationError) {
          throw error
        }
        throw new TrashApplicationError('UNAVAILABLE')
      }
    },
  }
}

export type TrashService = ReturnType<typeof createTrashService>
