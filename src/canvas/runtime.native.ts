import { NativeCanvasRepository } from '@/adapters/native'
import { createCanvasService } from '@/canvas/service'
import type { CanvasRuntime } from '@/canvas/runtime.types'

export function openCanvasRuntime(): Promise<CanvasRuntime> {
  return Promise.resolve({
    service: createCanvasService({ repository: new NativeCanvasRepository() }),
    dispose() {},
  })
}
