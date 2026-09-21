import { openWebTaskRepository } from '@/adapters/web'
import type { SearchRuntime } from '@/search/runtime.types'
import { createSearchService, SearchApplicationError } from '@/search/service'

export async function openSearchRuntime(): Promise<SearchRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('searchRepository' in opened)) {
      throw new SearchApplicationError('UNAVAILABLE')
    }

    return {
      service: createSearchService({ repository: opened.searchRepository }),
      dispose: opened.dispose,
    }
  } catch {
    throw new SearchApplicationError('UNAVAILABLE')
  }
}
