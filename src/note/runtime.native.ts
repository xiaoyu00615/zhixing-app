import { NativeNoteRepository } from '@/adapters/native'
import type { NoteRuntime } from '@/note/runtime.types'
import { createNoteService } from '@/note/service'

export function openNoteRuntime(): Promise<NoteRuntime> {
  const repository = new NativeNoteRepository()
  return Promise.resolve({
    service: createNoteService({ repository }),
    dispose() {},
  })
}