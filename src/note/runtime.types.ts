import type { NoteService } from '@/note/service'

export interface NoteRuntime {
  readonly service: NoteService
  dispose(): Promise<void> | void
}

export type OpenNoteRuntime = () => Promise<NoteRuntime>