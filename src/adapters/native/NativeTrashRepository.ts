import { invoke } from '@tauri-apps/api/core'

import {
  TrashRepositoryError,
  isTrashRepositoryErrorCode,
  type TrashEntityType,
  type TrashItem,
} from '@/trash/model'
import type { TrashRepository } from '@/trash/repository'

type Operation = 'list'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ALLOWED_ENTITY_TYPES: readonly TrashEntityType[] = ['task', 'note', 'diary']

function parseTrashItem(value: unknown, operation: Operation): TrashItem {
  if (!isRecord(value))
    throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
  const { entityType, entityId, title, deletedAtMs } = value
  if (
    typeof entityType !== 'string' ||
    typeof entityId !== 'string' ||
    typeof title !== 'string' ||
    !Number.isSafeInteger(deletedAtMs) ||
    (deletedAtMs as number) < 0 ||
    !ALLOWED_ENTITY_TYPES.includes(entityType as TrashEntityType)
  ) {
    throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    entityType: entityType as TrashEntityType,
    entityId,
    title,
    deletedAtMs: deletedAtMs as number,
  }
}

async function call(command: string, operation: Operation): Promise<unknown> {
  try {
    return await invoke(command)
  } catch (error: unknown) {
    if (isRecord(error) && isTrashRepositoryErrorCode(error.code))
      throw new TrashRepositoryError(error.code, operation)
    throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

export class NativeTrashRepository implements TrashRepository {
  async list(): Promise<TrashItem[]> {
    const operation = 'list'
    const value = await call('trash_list', operation)
    if (!Array.isArray(value))
      throw new TrashRepositoryError('PERSISTENCE_ERROR', operation)
    return value.map((row) => parseTrashItem(row, operation))
  }
}
