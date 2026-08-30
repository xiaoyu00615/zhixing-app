import { describe, expect, test } from 'vitest'

import {
  isCanvasCoordinate,
  isCanvasEdgeDirection,
  isCanvasEdgeLineStyle,
  isCanvasEdgeRelationType,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isPersistedCanvasNodeName,
  isTextNodeContent,
  isStickyNodeContent,
  parseCanvasNodeContentJson,
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

  test('keeps sticky payload typed and unknown payload opaque', () => {
    expect(isStickyNodeContent({ type: 'sticky', text: '便签' })).toBe(true)
    expect(isStickyNodeContent({ type: 'sticky', text: '便签', color: 'yellow' })).toBe(false)
    expect(parseCanvasNodeContentJson('sticky', '{"type":"sticky","text":"便签"}')).toEqual({ type: 'sticky', text: '便签' })
    expect(parseCanvasNodeContentJson('future', '{"type":"future","value":1}')).toEqual({ type: 'unknown', raw: { type: 'future', value: 1 } })
  })

  test('requires finite world coordinates', () => {
    expect(isCanvasCoordinate(-123.5)).toBe(true)
    expect(isCanvasCoordinate(Number.NaN)).toBe(false)
    expect(isCanvasCoordinate(Number.POSITIVE_INFINITY)).toBe(false)
  })

  test('accepts only the frozen Canvas Edge V1 enums', () => {
    expect(isCanvasEdgeRelationType('default')).toBe(true)
    expect(isCanvasEdgeRelationType('hierarchy')).toBe(true)
    expect(isCanvasEdgeRelationType('peer')).toBe(true)
    expect(isCanvasEdgeRelationType('ordered_box_member')).toBe(false)
    expect(isCanvasEdgeRelationType('dependency')).toBe(false)
    expect(isCanvasEdgeDirection('forward')).toBe(true)
    expect(isCanvasEdgeDirection('bidirectional')).toBe(true)
    expect(isCanvasEdgeDirection('none')).toBe(true)
    expect(isCanvasEdgeDirection('reverse')).toBe(false)
    expect(isCanvasEdgeLineStyle('solid')).toBe(true)
    expect(isCanvasEdgeLineStyle('dashed')).toBe(true)
    expect(isCanvasEdgeLineStyle('dotted')).toBe(true)
    expect(isCanvasEdgeLineStyle('animated')).toBe(false)
  })

  test('validates persisted node names by trimmed Unicode code points', () => {
    expect(isPersistedCanvasNodeName('')).toBe(true)
    expect(isPersistedCanvasNodeName('A')).toBe(true)
    expect(isPersistedCanvasNodeName('中'.repeat(119))).toBe(true)
    expect(isPersistedCanvasNodeName('中'.repeat(120))).toBe(true)
    expect(isPersistedCanvasNodeName('中'.repeat(121))).toBe(false)
    expect(isPersistedCanvasNodeName('😀'.repeat(120))).toBe(true)
    expect(isPersistedCanvasNodeName('😀'.repeat(121))).toBe(false)
    expect(isPersistedCanvasNodeName(' untrimmed ')).toBe(false)
  })
})
