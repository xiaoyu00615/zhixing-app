export type CanvasCommandEventResult = 'success' | 'failure'

export interface CanvasCommandEvent {
  readonly commandId: string
  readonly targetType: 'edge' | 'node'
  readonly targetId: string
  readonly timestamp: number
  readonly result: CanvasCommandEventResult
}

export type CanvasCommandEventListener = (event: CanvasCommandEvent) => void

const listeners = new Set<CanvasCommandEventListener>()

export function subscribeCanvasCommandEvents(
  listener: CanvasCommandEventListener,
): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function emitCanvasCommandEvent(event: CanvasCommandEvent): void {
  for (const listener of listeners) {
    try {
      listener(event)
    } catch {
      // Optional observers must never change the command result.
    }
  }
}
