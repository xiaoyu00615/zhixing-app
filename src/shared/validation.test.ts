import { describe, expect, it } from 'vitest'

import {
  getDaysInLocalMonth,
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
  isValidLocalDate,
} from './validation'

describe('isCanonicalLowercaseUuid', () => {
  const valid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'
  it('accepts a canonical lowercase UUID', () => {
    expect(isCanonicalLowercaseUuid(valid)).toBe(true)
  })
  it('rejects uppercase UUID', () => {
    expect(isCanonicalLowercaseUuid(valid.toUpperCase())).toBe(false)
  })
  it('rejects mixed-case UUID', () => {
    expect(isCanonicalLowercaseUuid(valid.replace('3f', '3F'))).toBe(false)
  })
  it('rejects malformed UUID (missing hyphen)', () => {
    expect(isCanonicalLowercaseUuid(valid.replace(/-/g, ''))).toBe(false)
  })
  it('rejects malformed UUID (too short)', () => {
    expect(isCanonicalLowercaseUuid('3f2504e0-4f89-41d3-9a0c-0305e82c330')).toBe(false)
  })
  it('rejects non-hex characters', () => {
    expect(isCanonicalLowercaseUuid('zzzzzzzz-4f89-41d3-9a0c-0305e82c3301')).toBe(false)
  })
  it('rejects non-string', () => {
    expect(isCanonicalLowercaseUuid(12345)).toBe(false)
    expect(isCanonicalLowercaseUuid(null)).toBe(false)
    expect(isCanonicalLowercaseUuid(undefined)).toBe(false)
    expect(isCanonicalLowercaseUuid([])).toBe(false)
  })
})

describe('isNonNegativeSafeIntegerMilliseconds', () => {
  it('accepts 0', () => {
    expect(isNonNegativeSafeIntegerMilliseconds(0)).toBe(true)
  })
  it('accepts positive safe integers', () => {
    expect(isNonNegativeSafeIntegerMilliseconds(1)).toBe(true)
    expect(isNonNegativeSafeIntegerMilliseconds(Number.MAX_SAFE_INTEGER)).toBe(true)
    expect(isNonNegativeSafeIntegerMilliseconds(1716547200000)).toBe(true)
  })
  it('rejects negative values', () => {
    expect(isNonNegativeSafeIntegerMilliseconds(-1)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(-Infinity)).toBe(false)
  })
  it('rejects fractional values', () => {
    expect(isNonNegativeSafeIntegerMilliseconds(0.5)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(1.0000000001)).toBe(false)
  })
  it('rejects unsafe integers', () => {
    expect(isNonNegativeSafeIntegerMilliseconds(Number.MAX_SAFE_INTEGER + 2)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(Number.MAX_SAFE_INTEGER + 1)).toBe(false)
  })
  it('rejects NaN', () => {
    expect(isNonNegativeSafeIntegerMilliseconds(NaN)).toBe(false)
  })
  it('rejects non-number', () => {
    expect(isNonNegativeSafeIntegerMilliseconds('123')).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(null)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds(undefined)).toBe(false)
    expect(isNonNegativeSafeIntegerMilliseconds([])).toBe(false)
  })
})

describe('isValidLocalDate', () => {
  it('accepts valid dates', () => {
    expect(isValidLocalDate('2026-01-01')).toBe(true)
    expect(isValidLocalDate('2024-02-29')).toBe(true)
    expect(isValidLocalDate('2026-12-31')).toBe(true)
    expect(isValidLocalDate('0001-01-01')).toBe(true)
    expect(isValidLocalDate('9999-12-31')).toBe(true)
  })
  it('rejects invalid leap day in non-leap year', () => {
    expect(isValidLocalDate('2026-02-29')).toBe(false)
    expect(isValidLocalDate('2025-02-29')).toBe(false)
  })
  it('accepts century-leap year 2000-02-29', () => {
    expect(isValidLocalDate('2000-02-29')).toBe(true)
  })
  it('rejects non-century-leap year 1900-02-29', () => {
    expect(isValidLocalDate('1900-02-29')).toBe(false)
  })
  it('rejects invalid month', () => {
    expect(isValidLocalDate('2026-00-01')).toBe(false)
    expect(isValidLocalDate('2026-13-01')).toBe(false)
  })
  it('rejects invalid day', () => {
    expect(isValidLocalDate('2026-04-31')).toBe(false)
    expect(isValidLocalDate('2026-01-00')).toBe(false)
    expect(isValidLocalDate('2026-01-32')).toBe(false)
  })
  it('rejects malformed YYYY-MM-DD', () => {
    expect(isValidLocalDate('2026-1-1')).toBe(false)
    expect(isValidLocalDate('2026-01-1')).toBe(false)
    expect(isValidLocalDate('2026/01/01')).toBe(false)
    expect(isValidLocalDate('20260101')).toBe(false)
    expect(isValidLocalDate('')).toBe(false)
  })
  it('rejects year out of range', () => {
    expect(isValidLocalDate('0000-01-01')).toBe(false)
    expect(isValidLocalDate('10000-01-01')).toBe(false)
  })
  it('rejects non-string', () => {
    expect(isValidLocalDate(20260101)).toBe(false)
    expect(isValidLocalDate(null)).toBe(false)
    expect(isValidLocalDate(undefined)).toBe(false)
    expect(isValidLocalDate([])).toBe(false)
  })
})

describe('getDaysInLocalMonth', () => {
  it('returns 29 for leap February', () => {
    expect(getDaysInLocalMonth(2024, 2)).toBe(29)
    expect(getDaysInLocalMonth(2000, 2)).toBe(29)
  })
  it('returns 28 for non-leap February', () => {
    expect(getDaysInLocalMonth(2026, 2)).toBe(28)
    expect(getDaysInLocalMonth(1900, 2)).toBe(28)
  })
  it('returns 30/31 for other months', () => {
    expect(getDaysInLocalMonth(2026, 1)).toBe(31)
    expect(getDaysInLocalMonth(2026, 4)).toBe(30)
    expect(getDaysInLocalMonth(2026, 12)).toBe(31)
  })
  it('returns null for invalid input', () => {
    expect(getDaysInLocalMonth(0, 1)).toBe(null)
    expect(getDaysInLocalMonth(10000, 1)).toBe(null)
    expect(getDaysInLocalMonth(2026, 0)).toBe(null)
    expect(getDaysInLocalMonth(2026, 13)).toBe(null)
    expect(getDaysInLocalMonth(2.5, 1)).toBe(null)
  })
})
