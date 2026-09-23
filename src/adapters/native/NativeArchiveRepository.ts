import { invoke } from '@tauri-apps/api/core'

import {
  ArchiveRepositoryError,
  isArchiveRepositoryErrorCode,
  type ArchiveEntityType,
  type ArchiveItem,
} from '@/archive/model'
import type { ArchiveRepository } from '@/archive/repository'

type Operation = 'list'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ALLOWED_ENTITY_TYPES: readonly ArchiveEntityType[] = ['task', 'note']

function parseArchiveItem(
  value: unknown,
  operation: Operation,
): ArchiveItem {
  if (!isRecord(value))
    throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
  const { entityType, entityId, title, archivedAtMs } = value
  if (
    typeof entityType !== 'string' ||
    typeof entityId !== 'string' ||
    typeof title !== 'string' ||
    !Number.isSafeInteger(archivedAtMs) ||
    (archivedAtMs as number) < 0 ||
    !ALLOWED_ENTITY_TYPES.includes(entityType as ArchiveEntityType)
  ) {
    throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    entityType: entityType as ArchiveEntityType,
    entityId,
    title,
    archivedAtMs: archivedAtMs as number,
  }
}

async function call(command: string, operation: Operation): Promise<unknown> {
  try {
    return await invoke(command)
  } catch (error: unknown) {
    if (isRecord(error) && isArchiveRepositoryErrorCode(error.code))
      throw new ArchiveRepositoryError(error.code, operation)
    throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

/**
 * Native implementation of the Unified Archive read contract (P5C S2).
 *
 * READ ONLY: routes `archive_list` through the existing Tauri command boundary
 * and re-validates every raw DTO field. No SQLite detail, SQL text, filesystem
 * path or Tauri error internals escape this adapter.
 */
export class NativeArchiveRepository implements ArchiveRepository {
  async list(): Promise<ArchiveItem[]> {
    const operation = 'list'
    const value = await call('archive_list', operation)
    if (!Array.isArray(value))
      throw new ArchiveRepositoryError('PERSISTENCE_ERROR', operation)
    return value.map((row) => parseArchiveItem(row, operation))
  }
}
