import { openWebTaskRepository } from '@/adapters/web'
import { createDiaryService } from '@/diary/service'
import { createNoteService } from '@/note/service'
import { createTaskService } from '@/task/service'
import type { TrashRuntime } from '@/trash/runtime.types'
import { createTrashService, TrashApplicationError } from '@/trash/service'

/**
 * Web trash runtime (P5B S3).
 *
 * Opens the EXISTING shared Web persistence ONCE and builds everything the
 * trash workspace needs from that single open:
 *
 *   one open
 *   → one shared lease / generation
 *   → trashRepository (read)
 *   → canonical TaskService / NoteService / DiaryService (restore)
 *   → TrashService
 *
 * This deliberately creates no second Worker, no second sqlite-wasm instance,
 * no second OPFS database and no second lifecycle: `dispose` is exactly the
 * shared `opened.dispose`.
 */
export async function openTrashRuntime(): Promise<TrashRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('trashRepository' in opened)) {
      throw new TrashApplicationError('UNAVAILABLE')
    }

    return {
      service: createTrashService({
        repository: opened.trashRepository,
        taskService: createTaskService({ repository: opened.repository }),
        noteService: createNoteService({ repository: opened.noteRepository }),
        diaryService: createDiaryService({ repository: opened.diaryRepository }),
      }),
      dispose: opened.dispose,
    }
  } catch {
    throw new TrashApplicationError('UNAVAILABLE')
  }
}
