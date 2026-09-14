import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
  isValidLocalDate,
  type LocalDate,
} from '@/shared/validation'

export type DiaryDate = LocalDate

export interface DiaryEntry {
  readonly id: string
  readonly title: string
  readonly content: string
  readonly diaryDate: DiaryDate
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly deletedAtMs: number | null
}

export function isDiaryEntry(value: unknown): value is DiaryEntry {
  if (typeof value !== 'object' || value === null) return false
  const candidate = value as Record<string, unknown>

  return (
    isCanonicalLowercaseUuid(candidate.id) &&
    typeof candidate.title === 'string' &&
    typeof candidate.content === 'string' &&
    isValidLocalDate(candidate.diaryDate) &&
    isNonNegativeSafeIntegerMilliseconds(candidate.createdAtMs) &&
    isNonNegativeSafeIntegerMilliseconds(candidate.updatedAtMs) &&
    (candidate.deletedAtMs === null ||
      isNonNegativeSafeIntegerMilliseconds(candidate.deletedAtMs))
  )
}

export type DiaryDateValidationCode =
  | 'INVALID_DIARY_DATE'
  | 'INVALID_TODAY'
  | 'FUTURE_DIARY_DATE_NOT_ALLOWED'

export type DiaryDateValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly code: DiaryDateValidationCode }

export function validateDiaryDateAgainstToday(
  diaryDate: unknown,
  today: unknown,
): DiaryDateValidationResult {
  if (!isValidLocalDate(diaryDate)) return { ok: false, code: 'INVALID_DIARY_DATE' }
  if (!isValidLocalDate(today)) return { ok: false, code: 'INVALID_TODAY' }

  const todayStr = today
  if (diaryDate > todayStr) return { ok: false, code: 'FUTURE_DIARY_DATE_NOT_ALLOWED' }
  return { ok: true }
}
