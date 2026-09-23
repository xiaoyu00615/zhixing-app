import {
  NativeArchiveRepository,
  NativeNoteRepository,
  NativeTaskRepository,
} from '@/adapters/native'
import { createNoteService } from '@/note/service'
import { createTaskService } from '@/task/service'
import type { ArchiveRuntime } from '@/archive/runtime.types'
import { createArchiveService } from '@/archive/service'

/**
 * Native archive runtime (P5C S3).
 *
 * No new Tauri command is introduced: unarchive and move-to-trash continue
 * through the canonical source-domain Native commands, and the archive read
 * goes through the existing `archive_list` command already owned by
 * `NativeArchiveRepository`.
 *
 * `dispose` is a no-op, matching the current Native runtime convention.
 */
export function openArchiveRuntime(): Promise<ArchiveRuntime> {
  return Promise.resolve({
    service: createArchiveService({
      repository: new NativeArchiveRepository(),
      taskService: createTaskService({ repository: new NativeTaskRepository() }),
      noteService: createNoteService({ repository: new NativeNoteRepository() }),
    }),
    dispose() {},
  })
}
