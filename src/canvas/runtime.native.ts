import { NativeCanvasRepository } from '@/adapters/native'
import { createCanvasService } from '@/canvas/service'
import { createCanvasHistoryService } from '@/canvas/history/service'
import type { CanvasRuntime } from '@/canvas/runtime.types'

export function openCanvasRuntime(): Promise<CanvasRuntime> {
  return Promise.resolve({
    service: createCanvasHistoryService(createCanvasService({ repository: new NativeCanvasRepository() })),
    dispose() {},
  })
}
