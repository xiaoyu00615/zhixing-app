import type { CanvasMutationAction } from '@/canvas/repository'

/**
 * One reversible user command on a canvas.
 *
 * `forward` replays the command; `inverse` reverts it. Both are generic
 * repository mutation batches so the shape also serves future operation
 * replay, not only undo/redo.
 */
export interface CanvasHistoryEntry {
  readonly commandId: string
  readonly timestamp: number
  readonly forward: readonly CanvasMutationAction[]
  readonly inverse: readonly CanvasMutationAction[]
}
