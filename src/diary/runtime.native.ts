import { NativeDiaryRepository } from '@/adapters/native'
import type { DiaryRuntime } from '@/diary/runtime.types'
import { createDiaryService } from '@/diary/service'

export function openDiaryRuntime(): Promise<DiaryRuntime> {
  const repository = new NativeDiaryRepository()
  return Promise.resolve({
    service: createDiaryService({ repository }),
    dispose() {},
  })
}
