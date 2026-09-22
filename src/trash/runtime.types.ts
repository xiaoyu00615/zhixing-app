import type { TrashService } from '@/trash/service'

export interface TrashRuntime {
  readonly service: TrashService
  dispose(): Promise<void> | void
}

export type OpenTrashRuntime = () => Promise<TrashRuntime>
