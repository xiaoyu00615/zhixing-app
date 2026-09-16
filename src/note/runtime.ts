import { openWebTaskRepository } from '@/adapters/web'
import type { NoteRuntime } from '@/note/runtime.types'
import { createNoteService, NoteApplicationError } from '@/note/service'

export async function openNoteRuntime(): Promise<NoteRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('noteRepository' in opened)) {
      throw new NoteApplicationError('UNAVAILABLE')
    }

    return {
      service: createNoteService({ repository: opened.noteRepository }),
      dispose: opened.dispose,
    }
  } catch {
    throw new NoteApplicationError('UNAVAILABLE')
  }
}