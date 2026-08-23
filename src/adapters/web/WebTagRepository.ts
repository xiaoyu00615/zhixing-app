import { isNonEmptyTagName, type Tag } from '@/tag/model'
import {
  TagRepositoryError,
  type CreateTagInput,
  type RenameTagInput,
  type TagRepository,
  type TagRepositoryOperation,
} from '@/tag/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/task/model'
import { TaskWorkerClient, TaskWorkerClientError } from './taskWorkerClient'

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

function validate(
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

function map(
  error: unknown,
  operation: TagRepositoryOperation,
): TagRepositoryError {
  if (error instanceof TagRepositoryError) return error
  if (error instanceof TaskWorkerClientError) {
    return new TagRepositoryError(
      error.code === 'STATUS_CONFLICT' ? 'PERSISTENCE_FAILED' : error.code,
      operation,
    )
  }
  return new TagRepositoryError('PERSISTENCE_FAILED', operation)
}

export class WebTagRepository implements TagRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async createTag(input: CreateTagInput): Promise<Tag> {
    const operation = 'createTag'
    validate(input, operation)
    try {
      return parseTag(await this.#client.createTag(input), operation)
    } catch (error: unknown) {
      throw map(error, operation)
    }
  }

  async listTags(): Promise<readonly Tag[]> {
    const operation = 'listTags'
    try {
      const value = await this.#client.listTags()
      if (!Array.isArray(value)) {
        throw new TagRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((tag) => parseTag(tag, operation))
    } catch (error: unknown) {
      throw map(error, operation)
    }
  }

  async renameTag(input: RenameTagInput): Promise<Tag> {
    const operation = 'renameTag'
    validate(input, operation)
    try {
      return parseTag(await this.#client.renameTag(input), operation)
    } catch (error: unknown) {
      throw map(error, operation)
    }
  }
}
