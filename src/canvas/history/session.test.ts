import { describe, expect, test } from 'vitest'

import type { CanvasHistoryEntry } from './model'
import {
  CANVAS_HISTORY_LIMIT,
  CanvasHistorySession,
  getCanvasHistorySession,
} from './session'

function entry(commandId: string): CanvasHistoryEntry {
  return {
    commandId,
    timestamp: Number(commandId),
    forward: [],
    inverse: [],
  }
}

describe('CanvasHistorySession', () => {
  test('starts empty and reports undo/redo availability', () => {
    const session = new CanvasHistorySession()
    expect(session.canUndo).toBe(false)
    expect(session.canRedo).toBe(false)
    expect(session.peekUndo()).toBeUndefined()
    expect(session.peekRedo()).toBeUndefined()
    expect(session.commitUndo()).toBeUndefined()
    expect(session.commitRedo()).toBeUndefined()
  })

  test('pushes onto the undo stack and exposes the newest entry', () => {
    const session = new CanvasHistorySession()
    session.push(entry('10'))
    session.push(entry('20'))
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(false)
    expect(session.peekUndo()?.commandId).toBe('20')
  })

  test('moves entries between stacks on undo then redo without reordering', () => {
    const session = new CanvasHistorySession()
    session.push(entry('10'))
    session.push(entry('20'))

    expect(session.commitUndo()?.commandId).toBe('20')
    expect(session.canUndo).toBe(true)
    expect(session.canRedo).toBe(true)
    expect(session.peekUndo()?.commandId).toBe('10')
    expect(session.peekRedo()?.commandId).toBe('20')

    expect(session.commitUndo()?.commandId).toBe('10')
    expect(session.canUndo).toBe(false)
    expect(session.commitRedo()?.commandId).toBe('10')
    expect(session.commitRedo()?.commandId).toBe('20')
    expect(session.canRedo).toBe(false)
    expect(session.peekUndo()?.commandId).toBe('20')
  })

  test('a new push discards the redo branch', () => {
    const session = new CanvasHistorySession()
    session.push(entry('10'))
    session.push(entry('20'))
    session.commitUndo()
    expect(session.canRedo).toBe(true)

    session.push(entry('30'))
    expect(session.canRedo).toBe(false)
    expect(session.peekRedo()).toBeUndefined()
    expect(session.peekUndo()?.commandId).toBe('30')
  })

  test('caps the undo stack and drops the oldest entries', () => {
    const session = new CanvasHistorySession()
    for (let index = 0; index < CANVAS_HISTORY_LIMIT + 5; index += 1) {
      session.push(entry(String(index)))
    }
    const undone: string[] = []
    let current = session.commitUndo()
    while (current !== undefined) {
      undone.push(current.commandId)
      current = session.commitUndo()
    }
    expect(undone).toHaveLength(CANVAS_HISTORY_LIMIT)
    expect(undone[undone.length - 1]).toBe('5')
    expect(undone[0]).toBe(String(CANVAS_HISTORY_LIMIT + 4))
  })

  test('getCanvasHistorySession reuses one session per canvas id', () => {
    const first = getCanvasHistorySession('canvas-history-a')
    const second = getCanvasHistorySession('canvas-history-a')
    const other = getCanvasHistorySession('canvas-history-b')
    expect(second).toBe(first)
    expect(other).not.toBe(first)
    first.push(entry('1'))
    expect(second.canUndo).toBe(true)
    expect(other.canUndo).toBe(false)
  })
})
