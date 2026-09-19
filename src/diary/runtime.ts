import { openWebTaskRepository } from '@/adapters/web'
import type { DiaryRuntime } from '@/diary/runtime.types'
import { createDiaryService, DiaryApplicationError } from '@/diary/service'

export async function openDiaryRuntime(): Promise<DiaryRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('diaryRepository' in opened)) {
      throw new DiaryApplicationError('UNAVAILABLE')
    }

    return {
      service: createDiaryService({ repository: opened.diaryRepository }),
      dispose: opened.dispose,
    }
  } catch {
    throw new DiaryApplicationError('UNAVAILABLE')
  }
}
