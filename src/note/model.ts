import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/shared/validation'

export interface Note {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly deletedAtMs: number | null
}

export function isNote(value: unknown): value is Note {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  return (
    isCanonicalLowercaseUuid(candidate.id) &&
    typeof candidate.title === 'string' &&
    typeof candidate.content === 'string' &&
    isNonNegativeSafeIntegerMilliseconds(candidate.createdAtMs) &&
    isNonNegativeSafeIntegerMilliseconds(candidate.updatedAtMs) &&
    (candidate.deletedAtMs === null ||
      isNonNegativeSafeIntegerMilliseconds(candidate.deletedAtMs))
  )
}
