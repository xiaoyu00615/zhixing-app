import { openWebTaskRepository } from '@/adapters/web'
import { createNoteService } from '@/note/service'
import { createTaskService } from '@/task/service'
import type { ArchiveRuntime } from '@/archive/runtime.types'
import { createArchiveService, ArchiveApplicationError } from '@/archive/service'

/**
 * Web archive runtime (P5C S3).
 *
 * Opens the EXISTING shared Web persistence ONCE and builds everything the
 * archive workspace needs from that single open:
 *
 *   one open
 *   → one shared lease / generation
 *   → archiveRepository (read)
 *   → canonical TaskService / NoteService (unarchive / move-to-trash)
 *   → ArchiveService
 *
 * This deliberately creates no second Worker, no second sqlite-wasm instance,
 * no second OPFS database and no second lifecycle: `dispose` is exactly the
 * shared `opened.dispose`.
 */
export async function openArchiveRuntime(): Promise<ArchiveRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('archiveRepository' in opened)) {
      throw new ArchiveApplicationError('UNAVAILABLE')
    }

    return {
      service: createArchiveService({
        repository: opened.archiveRepository,
        taskService: createTaskService({ repository: opened.repository }),
        noteService: createNoteService({ repository: opened.noteRepository }),
      }),
      dispose: opened.dispose,
    }
  } catch {
    throw new ArchiveApplicationError('UNAVAILABLE')
  }
}
