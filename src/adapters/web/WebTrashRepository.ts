import {
  TrashRepositoryError,
  type TrashEntityType,
  type TrashItem,
} from '@/trash/model'
import type { TrashRepository } from '@/trash/repository'
import {
  TrashWorkerClientError,
  type TaskWorkerClient,
} from '@/adapters/web/taskWorkerClient'
import { isRecord } from '@/adapters/web/taskWorkerProtocol'

type Operation = 'list'

const ALLOWED_ENTITY_TYPES: readonly TrashEntityType[] = [
  'task',
  'note',
  'diary',
]

function parseTrashItem(value: unknown, operation: Operation): TrashItem {
  if (!isRecord(value)) {
    throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
  }
  const { entityType, entityId, title, deletedAtMs } = value
  if (
    typeof entityType !== 'string' ||
    typeof entityId !== 'string' ||
    typeof title !== 'string' ||
    typeof deletedAtMs !== 'number' ||
    !Number.isSafeInteger(deletedAtMs) ||
    deletedAtMs < 0 ||
    !ALLOWED_ENTITY_TYPES.includes(entityType as TrashEntityType)
  ) {
    throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    entityType: entityType as TrashEntityType,
    entityId,
    title,
    deletedAtMs,
  }
}

function mapClientError(
  error: unknown,
  operation: Operation,
): TrashRepositoryError {
  if (error instanceof TrashRepositoryError) {
    return error
  }
  if (error instanceof TrashWorkerClientError) {
    switch (error.code) {
      case 'PERSISTENCE_ERROR':
        return new TrashRepositoryError(error.code, operation)
    }
  }
  return new TrashRepositoryError('PERSISTENCE_ERROR', operation)
}

/**
 * Web implementation of the Unified Trash read contract (P5B S2).
 *
 * Mirrors {@link NativeTrashRepository} but routes the read through the shared
 * Web persistence worker: `WebTrashRepository.list()` -> `TaskWorkerClient
 * .listTrash()` -> `trash.list` op -> `WebTaskDatabase.listTrash()`. The raw
 * worker payload never escapes this boundary: any malformed row, transport
 * error, or non-PERSISTENCE error code is normalized to a
 * {@link TrashRepositoryError} with code `PERSISTENCE_ERROR`.
 */
export class WebTrashRepository implements TrashRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async list(): Promise<TrashItem[]> {
    const operation = 'list'
    try {
      const value = await this.#client.listTrash()
      if (!Array.isArray(value)) {
        throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
      }
      return value.map((row) => parseTrashItem(row, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }
}
