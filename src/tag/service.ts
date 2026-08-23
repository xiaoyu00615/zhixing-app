import { isNonEmptyTagName, type Tag } from '@/tag/model'
import { TagRepositoryError, type TagRepository } from '@/tag/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/task/model'

export type TagApplicationErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'
export type TagApplicationErrorField = 'id' | 'name'

export class TagApplicationError extends Error {
  readonly code: TagApplicationErrorCode
  readonly field?: TagApplicationErrorField

  constructor(code: TagApplicationErrorCode, field?: TagApplicationErrorField) {
    super(
      code === 'VALIDATION'
        ? 'Tag input is invalid.'
        : code === 'NOT_FOUND'
          ? 'Tag not found.'
          : 'Tag service is unavailable.',
    )
    this.name = 'TagApplicationError'
    this.code = code
    this.field = field
  }
}

interface CreateTagServiceOptions {
  readonly repository: TagRepository
  readonly generateTagId?: () => string
  readonly nowMs?: () => number
}

function mapRepositoryError(error: unknown): TagApplicationError {
  if (!(error instanceof TagRepositoryError)) {
    return new TagApplicationError('UNAVAILABLE')
  }
  return error.code === 'NOT_FOUND'
    ? new TagApplicationError('NOT_FOUND')
    : new TagApplicationError('UNAVAILABLE')
}

export function createTagService({
  repository,
  generateTagId = () => globalThis.crypto.randomUUID(),
  nowMs = () => Date.now(),
}: CreateTagServiceOptions) {
  function normalizedName(name: string): string {
    const normalized = name.trim()
    if (!isNonEmptyTagName(normalized)) {
      throw new TagApplicationError('VALIDATION', 'name')
    }
    return normalized
  }

  function validId(id: string): void {
    if (!isCanonicalLowercaseUuid(id)) {
      throw new TagApplicationError('VALIDATION', 'id')
    }
  }

  function generatedId(): string {
    try {
      const id = generateTagId()
      if (!isCanonicalLowercaseUuid(id)) throw new Error()
      return id
    } catch {
      throw new TagApplicationError('UNAVAILABLE')
    }
  }

  function timestamp(): number {
    try {
      const value = nowMs()
      if (!isNonNegativeSafeIntegerMilliseconds(value)) throw new Error()
      return value
    } catch {
      throw new TagApplicationError('UNAVAILABLE')
    }
  }

  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      throw mapRepositoryError(error)
    }
  }

  return {
    async createTag(name: string): Promise<Tag> {
      const normalized = normalizedName(name)
      return call(() =>
        repository.createTag({
          id: generatedId(),
          name: normalized,
          createdAtMs: timestamp(),
        }),
      )
    },
    listTags(): Promise<readonly Tag[]> {
      return call(() => repository.listTags())
    },
    async renameTag(id: string, name: string): Promise<Tag> {
      validId(id)
      const normalized = normalizedName(name)
      return call(() =>
        repository.renameTag({
          id,
          name: normalized,
          updatedAtMs: timestamp(),
        }),
      )
    },
  }
}

export type TagService = ReturnType<typeof createTagService>
