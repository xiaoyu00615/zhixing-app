import {
  ArchiveRepositoryError,
  type ArchiveEntityType,
  type ArchiveItem,
} from '@/archive/model'
import type { ArchiveRepository } from '@/archive/repository'
import {
  ArchiveWorkerClientError,
  type TaskWorkerClient,
} from '@/adapters/web/taskWorkerClient'
import { isRecord } from '@/adapters/web/taskWorkerProtocol'

type Operation = 'list'

const ALLOWED_ENTITY_TYPES: readonly ArchiveEntityType[] = ['task', 'note']

function parseArchiveItem(
  value: unknown,
  operation: Operation,
): ArchiveItem {
  if (!isRecord(value)) {
    throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
  }
  const { entityType, entityId, title, archivedAtMs } = value
  if (
    typeof entityType !== 'string' ||
    typeof entityId !== 'string' ||
    typeof title !== 'string' ||
    typeof archivedAtMs !== 'number' ||
    !Number.isSafeInteger(archivedAtMs) ||
    archivedAtMs < 0 ||
    !ALLOWED_ENTITY_TYPES.includes(entityType as ArchiveEntityType)
  ) {
    throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    entityType: entityType as ArchiveEntityType,
    entityId,
    title,
    archivedAtMs,
  }
}

function mapClientError(
  error: unknown,
  operation: Operation,
): ArchiveRepositoryError {
  if (error instanceof ArchiveRepositoryError) {
    return error
  }
  if (error instanceof ArchiveWorkerClientError) {
    switch (error.code) {
      case 'PERSISTENCE_ERROR':
        return new ArchiveRepositoryError(error.code, operation)
    }
  }
  return new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
}

/**
 * Web implementation of the Unified Archive read contract (P5C S2).
 *
 * Mirrors {@link NativeArchiveRepository} but routes the read through the
 * shared Web persistence worker: `WebArchiveRepository.list()` ->
 * `TaskWorkerClient.listArchive()` -> `archive.list` op ->
 * `WebTaskDatabase.listArchive()`. The raw worker payload never escapes this
 * boundary: any malformed row, transport error, or non-PERSISTENCE error code
 * is normalized to an {@link ArchiveRepositoryError} with code
 * `PERSISTENCE_ERROR`.
 *
 * READ ONLY: this repository owns no archive/unarchive/delete/restore write.
 * Canonical writes stay on the Task and Note domains.
 */
export class WebArchiveRepository implements ArchiveRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async list(): Promise<ArchiveItem[]> {
    const operation = 'list'
    try {
      const value = await this.#client.listArchive()
      if (!Array.isArray(value)) {
        throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
      }
      return value.map((row) => parseArchiveItem(row, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }
}
