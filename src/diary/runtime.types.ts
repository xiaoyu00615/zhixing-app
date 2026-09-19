import type { DiaryService } from '@/diary/service'

export interface DiaryRuntime {
  readonly service: DiaryService
  dispose(): Promise<void> | void
}

export type OpenDiaryRuntime = () => Promise<DiaryRuntime>
