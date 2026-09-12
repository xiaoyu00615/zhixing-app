import type { CanvasHistoryEntry } from './model'

/**
 * Maximum number of reversible commands kept per canvas. Older entries are
 * dropped from the undo end first.
 */
export const CANVAS_HISTORY_LIMIT = 100

/**
 * Pure, in-memory undo/redo stack for one canvas.
 *
 * The stack never executes mutations: callers peek the entry, run its batch,
 * and only call `commitUndo` / `commitRedo` after the batch succeeds. A failed
 * batch therefore leaves both stacks untouched.
 */
export class CanvasHistorySession {
  #past: CanvasHistoryEntry[] = []
  #future: CanvasHistoryEntry[] = []

  get canUndo(): boolean {
    return this.#past.length > 0
  }

  get canRedo(): boolean {
    return this.#future.length > 0
  }

  /** Records a new command. Any redo branch is discarded. */
  push(entry: CanvasHistoryEntry): void {
    this.#past.push(entry)
    if (this.#past.length > CANVAS_HISTORY_LIMIT) {
      this.#past.splice(0, this.#past.length - CANVAS_HISTORY_LIMIT)
    }
    this.#future = []
  }

  peekUndo(): CanvasHistoryEntry | undefined {
    return this.#past[this.#past.length - 1]
  }

  peekRedo(): CanvasHistoryEntry | undefined {
    return this.#future[this.#future.length - 1]
  }

  /** Moves the newest past entry onto the redo stack. */
  commitUndo(): CanvasHistoryEntry | undefined {
    const entry = this.#past.pop()
    if (entry !== undefined) {
      this.#future.push(entry)
    }
    return entry
  }

  /** Moves the newest future entry back onto the undo stack. */
  commitRedo(): CanvasHistoryEntry | undefined {
    const entry = this.#future.pop()
    if (entry !== undefined) {
      this.#past.push(entry)
    }
    return entry
  }
}

/**
 * Sessions live at module scope, not on a service instance: reopening a canvas
 * constructs a fresh service, but its command history must survive. They are
 * naturally cleared on page reload and isolated by canvas id.
 */
const sessions = new Map<string, CanvasHistorySession>()

export function getCanvasHistorySession(canvasId: string): CanvasHistorySession {
  let session = sessions.get(canvasId)
  if (session === undefined) {
    session = new CanvasHistorySession()
    sessions.set(canvasId, session)
  }
  return session
}
