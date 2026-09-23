import type { ArchiveService } from '@/archive/service'

export interface ArchiveRuntime {
  readonly service: ArchiveService
  dispose(): Promise<void> | void
}

export type OpenArchiveRuntime = () => Promise<ArchiveRuntime>
