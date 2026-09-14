import { describe, expect, it } from 'vitest'

import type { Note } from './model'
import { isNote } from './model'

const VALID_ID = '3f2504e0-4f89-41d3-9a0c-0305e82c3301'

function makeNote(overrides: Partial<Note> = {}): Note {
  return {
    id: VALID_ID,
    title: 'My note',
    content: '# Heading\n\nSome **markdown** content.',
    createdAtMs: 1716547200000,
    updatedAtMs: 1716547200000,
    deletedAtMs: null,
    ...overrides,
  }
}

describe('isNote', () => {
  it('accepts a fully valid Note', () => {
    expect(isNote(makeNote())).toBe(true)
  })

  it('accepts empty title', () => {
    expect(isNote(makeNote({ title: '' }))).toBe(true)
  })

  it('accepts empty content', () => {
    expect(isNote(makeNote({ content: '' }))).toBe(true)
  })

  it('accepts deletedAtMs = null', () => {
    expect(isNote(makeNote({ deletedAtMs: null }))).toBe(true)
  })

  it('accepts deletedAtMs as non-negative integer', () => {
    expect(isNote(makeNote({ deletedAtMs: 1716547200000 }))).toBe(true)
  })

  it('rejects non-object', () => {
    expect(isNote(null)).toBe(false)
    expect(isNote(undefined)).toBe(false)
    expect(isNote('not-a-note')).toBe(false)
    expect(isNote(42)).toBe(false)
    expect(isNote([])).toBe(false)
  })

  it('rejects invalid id (uppercase)', () => {
    expect(isNote(makeNote({ id: VALID_ID.toUpperCase() }))).toBe(false)
  })

  it('rejects invalid id (malformed)', () => {
    expect(isNote(makeNote({ id: 'not-a-uuid' }))).toBe(false)
  })

  it('rejects invalid id (non-string)', () => {
    expect(isNote(makeNote({ id: 12345 as unknown as string }))).toBe(false)
  })

  it('rejects non-string title', () => {
    expect(isNote(makeNote({ title: 42 as unknown as string }))).toBe(false)
    expect(isNote(makeNote({ title: null as unknown as string }))).toBe(false)
  })

  it('rejects non-string content', () => {
    expect(isNote(makeNote({ content: 42 as unknown as string }))).toBe(false)
  })

  it('rejects negative createdAtMs', () => {
    expect(isNote(makeNote({ createdAtMs: -1 }))).toBe(false)
  })

  it('rejects fractional updatedAtMs', () => {
    expect(isNote(makeNote({ updatedAtMs: 1.5 }))).toBe(false)
  })

  it('rejects unsafe integer timestamps', () => {
    expect(isNote(makeNote({ createdAtMs: Number.MAX_SAFE_INTEGER + 2 }))).toBe(false)
  })

  it('rejects non-numeric timestamps', () => {
    expect(isNote(makeNote({ createdAtMs: '123' as unknown as number }))).toBe(false)
  })

  it('rejects invalid deletedAtMs', () => {
    expect(isNote(makeNote({ deletedAtMs: -1 as unknown as number | null }))).toBe(false)
    expect(isNote(makeNote({ deletedAtMs: 'nope' as unknown as number | null }))).toBe(false)
    expect(isNote(makeNote({ deletedAtMs: undefined as unknown as number | null }))).toBe(false)
  })

  it('accepts createdAtMs = 0', () => {
    expect(isNote(makeNote({ createdAtMs: 0, updatedAtMs: 0 }))).toBe(true)
  })
})

describe('Markdown exact content preservation', () => {
  it('preserves empty content', () => {
    const note = makeNote({ content: '' })
    expect(note.content).toBe('')
  })

  it('preserves leading spaces', () => {
    const content = '   leading spaces preserved'
    const note = makeNote({ content })
    expect(note.content).toBe(content)
    expect(note.content.startsWith('   ')).toBe(true)
  })

  it('preserves trailing spaces', () => {
    const content = 'trailing spaces preserved   '
    const note = makeNote({ content })
    expect(note.content).toBe(content)
    expect(note.content.endsWith('   ')).toBe(true)
  })

  it('preserves multiple newlines', () => {
    const content = 'line one\n\n\n\nline five'
    const note = makeNote({ content })
    expect(note.content).toBe(content)
    expect(note.content).toContain('\n\n\n\n')
  })

  it('preserves markdown code fences', () => {
    const content = '```\nfunction foo() {\n  return 1\n}\n```\n'
    const note = makeNote({ content })
    expect(note.content).toBe(content)
    expect(note.content.startsWith('```')).toBe(true)
    expect(note.content).toContain('\n```\n')
  })

  it('preserves unicode content', () => {
    const content = '中文内容 · emoji 🎉 · émojis'
    const note = makeNote({ content })
    expect(note.content).toBe(content)
  })

  it('does not trim title', () => {
    const note = makeNote({ title: '  padded title  ' })
    expect(note.title).toBe('  padded title  ')
  })
})
