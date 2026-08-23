import type { Tag } from '@/tag/model'

export interface CreateTagInput {
  readonly id: string
  readonly name: string
  readonly createdAtMs: number
}

export interface RenameTagInput {
  readonly id: string
  readonly name: string
  readonly updatedAtMs: number
}

export interface TagRepository {
  createTag(input: CreateTagInput): Promise<Tag>
  listTags(): Promise<readonly Tag[]>
  renameTag(input: RenameTagInput): Promise<Tag>
}

export const TAG_REPOSITORY_ERROR_CODES = [
  'NOT_FOUND',
  'PERSISTENCE_UNAVAILABLE',
  'PERSISTENCE_FAILED',
] as const

export type TagRepositoryErrorCode =
  (typeof TAG_REPOSITORY_ERROR_CODES)[number]

export type TagRepositoryOperation = 'createTag' | 'listTags' | 'renameTag'

const SAFE_MESSAGES: Record<TagRepositoryErrorCode, string> = {
  NOT_FOUND: 'Tag not found.',
  PERSISTENCE_UNAVAILABLE: 'Tag persistence is unavailable.',
  PERSISTENCE_FAILED: 'Tag persistence operation failed.',
}

export class TagRepositoryError extends Error {
  readonly code: TagRepositoryErrorCode
  readonly operation: TagRepositoryOperation

  constructor(code: TagRepositoryErrorCode, operation: TagRepositoryOperation) {
    super(SAFE_MESSAGES[code])
    this.name = 'TagRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isTagRepositoryErrorCode(
  value: unknown,
): value is TagRepositoryErrorCode {
  return (
    typeof value === 'string' &&
    TAG_REPOSITORY_ERROR_CODES.some((code) => code === value)
  )
}
