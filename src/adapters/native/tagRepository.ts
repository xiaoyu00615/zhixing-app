import { invoke } from '@tauri-apps/api/core'

import { isNonEmptyTagName, type Tag } from '@/tag/model'
import {
  TagRepositoryError,
  isTagRepositoryErrorCode,
  type CreateTagInput,
  type RenameTagInput,
  type TagRepository,
  type TagRepositoryOperation,
} from '@/tag/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/task/model'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseTag(value: unknown, operation: TagRepositoryOperation): Tag {
  if (!isRecord(value))
    throw new TagRepositoryError('PERSISTENCE_FAILED', operation)
  const { id, name, createdAtMs, updatedAtMs } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyTagName(name) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new TagRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return { id, name, createdAtMs, updatedAtMs }
}

function validateInput(
  input: {
    readonly id: string
    readonly name?: string
    readonly createdAtMs?: number
    readonly updatedAtMs?: number
  },
  operation: TagRepositoryOperation,
): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    (input.name !== undefined && !isNonEmptyTagName(input.name)) ||
    (input.createdAtMs !== undefined &&
      !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs)) ||
    (input.updatedAtMs !== undefined &&
      !isNonNegativeSafeIntegerMilliseconds(input.updatedAtMs))
  ) {
    throw new TagRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

async function call(
  command: string,
  operation: TagRepositoryOperation,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(command, args)
  } catch (error: unknown) {
    if (isRecord(error) && isTagRepositoryErrorCode(error.code)) {
      throw new TagRepositoryError(error.code, operation)
    }
    throw new TagRepositoryError('PERSISTENCE_UNAVAILABLE', operation)
  }
}

export class NativeTagRepository implements TagRepository {
  async createTag(input: CreateTagInput): Promise<Tag> {
    const operation = 'createTag'
    validateInput(input, operation)
    return parseTag(await call('tag_create', operation, { input }), operation)
  }

  async listTags(): Promise<readonly Tag[]> {
    const operation = 'listTags'
    const value = await call('tag_list', operation)
    if (!Array.isArray(value)) {
      throw new TagRepositoryError('PERSISTENCE_FAILED', operation)
    }
    return value.map((tag) => parseTag(tag, operation))
  }

  async renameTag(input: RenameTagInput): Promise<Tag> {
    const operation = 'renameTag'
    validateInput(input, operation)
    return parseTag(await call('tag_rename', operation, { input }), operation)
  }
}
