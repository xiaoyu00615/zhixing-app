import type { SearchService } from '@/search/service'

export interface SearchRuntime {
  readonly service: SearchService
  dispose(): Promise<void> | void
}

export type OpenSearchRuntime = () => Promise<SearchRuntime>
