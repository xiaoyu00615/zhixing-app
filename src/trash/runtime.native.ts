import {
  NativeDiaryRepository,
  NativeNoteRepository,
  NativeTaskRepository,
  NativeTrashRepository,
} from '@/adapters/native'
import { createDiaryService } from '@/diary/service'
import { createNoteService } from '@/note/service'
import { createTaskService } from '@/task/service'
import type { TrashRuntime } from '@/trash/runtime.types'
import { createTrashService } from '@/trash/service'

/**
 * Native trash runtime (P5B S3).
 *
 * No new Tauri command is introduced: restore continues through the canonical
 * source-domain Native commands, and the trash read goes through the existing
 * `trash_list` command already owned by `NativeTrashRepository`.
 *
 * `dispose` is a no-op, matching the current Native runtime convention.
 */
export function openTrashRuntime(): Promise<TrashRuntime> {
  return Promise.resolve({
    service: createTrashService({
      repository: new NativeTrashRepository(),
      taskService: createTaskService({ repository: new NativeTaskRepository() }),
      noteService: createNoteService({ repository: new NativeNoteRepository() }),
      diaryService: createDiaryService({
        repository: new NativeDiaryRepository(),
      }),
    }),
    dispose() {},
  })
}
