const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isCanonicalLowercaseUuid(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_LOWERCASE_UUID.test(value)
}

export function isNonNegativeSafeIntegerMilliseconds(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

export type LocalDate = string

const LOCAL_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
}

export function getDaysInLocalMonth(year: number, month: number): number | null {
  if (!Number.isInteger(year) || year < 1 || year > 9999) return null
  if (!Number.isInteger(month) || month < 1 || month > 12) return null
  return [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][
    month - 1
  ]!
}

export function isValidLocalDate(value: unknown): value is LocalDate {
  if (typeof value !== 'string') return false

  const match = LOCAL_DATE_PATTERN.exec(value)
  if (!match) return false

  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  if (year < 1 || year > 9999 || month < 1 || month > 12) return false

  const daysInMonth = getDaysInLocalMonth(year, month)
  if (daysInMonth === null || day < 1 || day > daysInMonth) return false
  return true
}

export function localDateFromDate(date: Date): LocalDate {
  const year = date.getFullYear()
  const month = date.getMonth() + 1
  const day = date.getDate()
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}
