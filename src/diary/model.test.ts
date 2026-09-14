import { describe, expect, it } from 'vitest'

import type { DiaryEntry } from './model'
import { isDiaryEntry, validateDiaryDateAgainstToday } from './model'

const VALID_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function makeEntry(overrides: Partial<DiaryEntry> = {}): DiaryEntry {
  return {
    id: VALID_ID,
    title: 'Daily entry',
    content: '# Today\n\nReflections.',
    diaryDate: '2026-09-14',
    createdAtMs: 1716547200000,
    updatedAtMs: 1716547200000,
    deletedAtMs: null,
    ...overrides,
  }
}

describe('isDiaryEntry', () => {
  it('accepts a fully valid DiaryEntry', () => {
    expect(isDiaryEntry(makeEntry())).toBe(true)
  })

  it('accepts empty title', () => {
    expect(isDiaryEntry(makeEntry({ title: '' }))).toBe(true)
  })

  it('accepts empty content', () => {
    expect(isDiaryEntry(makeEntry({ content: '' }))).toBe(true)
  })

  it('accepts deletedAtMs = null', () => {
    expect(isDiaryEntry(makeEntry({ deletedAtMs: null }))).toBe(true)
  })

  it('accepts valid leap date 2024-02-29', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2024-02-29' }))).toBe(true)
  })

  it('accepts century leap date 2000-02-29', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2000-02-29' }))).toBe(true)
  })

  it('rejects non-leap day 2026-02-29', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026-02-29' }))).toBe(false)
  })

  it('rejects non-century leap 1900-02-29', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '1900-02-29' }))).toBe(false)
  })

  it('rejects invalid month 2026-13-01', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026-13-01' }))).toBe(false)
  })

  it('rejects invalid month 2026-00-01', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026-00-01' }))).toBe(false)
  })

  it('rejects invalid day 2026-04-31', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026-04-31' }))).toBe(false)
  })

  it('rejects invalid day 2026-02-30', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026-02-30' }))).toBe(false)
  })

  it('rejects malformed YYYY-MM-DD', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026-9-14' }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ diaryDate: '2026/09/14' }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ diaryDate: '09-14-2026' }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ diaryDate: '' }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ diaryDate: '20260914' }))).toBe(false)
  })

  it('rejects non-string diaryDate', () => {
    expect(isDiaryEntry(makeEntry({ diaryDate: 20260914 as unknown as string }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ diaryDate: new Date() as unknown as string }))).toBe(false)
  })

  it('rejects invalid id', () => {
    expect(isDiaryEntry(makeEntry({ id: 'bad-id' }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ id: VALID_ID.toUpperCase() }))).toBe(false)
  })

  it('rejects non-string title/content', () => {
    expect(isDiaryEntry(makeEntry({ title: 1 as unknown as string }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ content: null as unknown as string }))).toBe(false)
  })

  it('rejects negative / fractional / unsafe timestamps', () => {
    expect(isDiaryEntry(makeEntry({ createdAtMs: -1 }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ updatedAtMs: 1.5 }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ createdAtMs: Number.MAX_SAFE_INTEGER + 2 }))).toBe(false)
  })

  it('rejects invalid deletedAtMs', () => {
    expect(isDiaryEntry(makeEntry({ deletedAtMs: -1 as unknown as number | null }))).toBe(false)
    expect(isDiaryEntry(makeEntry({ deletedAtMs: 'nope' as unknown as number | null }))).toBe(false)
  })
})

describe('validateDiaryDateAgainstToday', () => {
  it('allows past date', () => {
    const result = validateDiaryDateAgainstToday('2026-09-01', '2026-09-14')
    expect(result).toEqual({ ok: true })
  })

  it('allows today date', () => {
    const result = validateDiaryDateAgainstToday('2026-09-14', '2026-09-14')
    expect(result).toEqual({ ok: true })
  })

  it('rejects future date', () => {
    const result = validateDiaryDateAgainstToday('2026-09-15', '2026-09-14')
    expect(result).toEqual({ ok: false, code: 'FUTURE_DIARY_DATE_NOT_ALLOWED' })
  })

  it('rejects future date at year boundary', () => {
    const result = validateDiaryDateAgainstToday('2027-01-01', '2026-12-31')
    expect(result).toEqual({ ok: false, code: 'FUTURE_DIARY_DATE_NOT_ALLOWED' })
  })

  it('rejects invalid diaryDate', () => {
    const result = validateDiaryDateAgainstToday('2026-02-30', '2026-09-14')
    expect(result).toEqual({ ok: false, code: 'INVALID_DIARY_DATE' })
  })

  it('rejects malformed diaryDate', () => {
    const result = validateDiaryDateAgainstToday('not-a-date', '2026-09-14')
    expect(result).toEqual({ ok: false, code: 'INVALID_DIARY_DATE' })
  })

  it('rejects invalid today', () => {
    const result = validateDiaryDateAgainstToday('2026-09-14', 'not-a-date')
    expect(result).toEqual({ ok: false, code: 'INVALID_TODAY' })
  })

  it('returns INVALID_DIARY_DATE before INVALID_TODAY when both invalid', () => {
    const result = validateDiaryDateAgainstToday('bad', 'also-bad')
    expect(result).toEqual({ ok: false, code: 'INVALID_DIARY_DATE' })
  })

  it('does not depend on Date.now()', () => {
    const past = '2001-01-01'
    const today = '2026-09-14'
    expect(validateDiaryDateAgainstToday(past, today)).toEqual({ ok: true })
    expect(validateDiaryDateAgainstToday(today, today)).toEqual({ ok: true })
    expect(validateDiaryDateAgainstToday('2027-01-01', today)).toEqual({
      ok: false,
      code: 'FUTURE_DIARY_DATE_NOT_ALLOWED',
    })
  })
})

describe('DiaryEntry content exact preservation', () => {
  it('preserves empty content', () => {
    const entry = makeEntry({ content: '' })
    expect(entry.content).toBe('')
  })

  it('preserves leading / trailing spaces', () => {
    const content = '  spaces preserved  '
    const entry = makeEntry({ content })
    expect(entry.content).toBe(content)
  })

  it('preserves multiple newlines', () => {
    const content = 'a\n\n\n\nb'
    const entry = makeEntry({ content })
    expect(entry.content).toBe(content)
  })

  it('preserves markdown code fence', () => {
    const content = '```\nprint("hi")\n```\n'
    const entry = makeEntry({ content })
    expect(entry.content).toBe(content)
  })

  it('preserves unicode', () => {
    const content = '日记 · 📅 · émojis'
    const entry = makeEntry({ content })
    expect(entry.content).toBe(content)
  })
})
