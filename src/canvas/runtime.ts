import { openWebTaskRepository } from '@/adapters/web'
import { CanvasApplicationError, createCanvasService } from '@/canvas/service'
import { createCanvasHistoryService } from '@/canvas/history/service'
import type { CanvasRuntime } from '@/canvas/runtime.types'

export async function openCanvasRuntime(): Promise<CanvasRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('canvasRepository' in opened)) {
      throw new CanvasApplicationError('UNAVAILABLE')
    }
    return {
      service: createCanvasHistoryService(createCanvasService({ repository: opened.canvasRepository })),
      dispose: opened.dispose,
    }
  } catch {
    throw new CanvasApplicationError('UNAVAILABLE')
  }
}
