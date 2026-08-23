import { describe, expect, test } from 'vitest'

import {
  isCanvasCoordinate,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isTextNodeContent,
  parseCanvasViewportJson,
  parseTextNodeContentJson,
} from '@/canvas/model'

describe('Canvas domain validation', () => {
  test('validates trimmed non-blank titles', () => {
    expect(isNonEmptyCanvasTitle(' Canvas ')).toBe(true)
    expect(isNonEmptyCanvasTitle('   ')).toBe(false)
  })

  test('accepts only exact finite positive-zoom viewport objects', () => {
    expect(isCanvasViewport({ x: -10, y: 20, zoom: 1.25 })).toBe(true)
    expect(isCanvasViewport({ x: 0, y: 0, zoom: 0 })).toBe(false)
    expect(isCanvasViewport({ x: 0, y: 0, zoom: 1, extra: true })).toBe(false)
    expect(parseCanvasViewportJson('{"x":1,"y":2,"zoom":0.5}')).toEqual({
      x: 1,
      y: 2,
      zoom: 0.5,
    })
    expect(parseCanvasViewportJson('{"x":1,"y":2}')).toBeNull()
  })

  test('accepts only exact text node content', () => {
    expect(isTextNodeContent({ type: 'text', text: 'Hello' })).toBe(true)
    expect(isTextNodeContent({ type: 'text', text: 'Hello', html: '' })).toBe(
      false,
    )
    expect(parseTextNodeContentJson('{"type":"text","text":"Hello"}')).toEqual(
      { type: 'text', text: 'Hello' },
    )
    expect(parseTextNodeContentJson('{"type":"image","text":"Hello"}')).toBeNull()
  })

  test('requires finite world coordinates', () => {
    expect(isCanvasCoordinate(-123.5)).toBe(true)
    expect(isCanvasCoordinate(Number.NaN)).toBe(false)
    expect(isCanvasCoordinate(Number.POSITIVE_INFINITY)).toBe(false)
  })
})
