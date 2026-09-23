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
  /**
   * Archive V1 canonical state (P5C-S1). Orthogonal to `deletedAtMs`:
   *
   * - ACTIVE:               deletedAtMs === null && archivedAtMs === null
   * - ARCHIVED:             deletedAtMs === null && archivedAtMs !== null
   * - TRASHED_FROM_ACTIVE:  deletedAtMs !== null && archivedAtMs === null
   * - TRASHED_FROM_ARCHIVE: deletedAtMs !== null && archivedAtMs !== null
   *
   * Canonical Trash restore clears `deletedAtMs` and PRESERVES
   * `archivedAtMs`, so an archived note returns to the archived state.
   */
  readonly archivedAtMs: number | null
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
      isNonNegativeSafeIntegerMilliseconds(candidate.deletedAtMs)) &&
    (candidate.archivedAtMs === null ||
      isNonNegativeSafeIntegerMilliseconds(candidate.archivedAtMs))
  )
}
