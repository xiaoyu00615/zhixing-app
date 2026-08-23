import type { CanvasService } from '@/canvas/service'

export interface CanvasRuntime {
  readonly service: CanvasService
  dispose(): Promise<void> | void
}

export type OpenCanvasRuntime = () => Promise<CanvasRuntime>
