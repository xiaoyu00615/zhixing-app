import { NativeSearchRepository } from '@/adapters/native'
import type { SearchRuntime } from '@/search/runtime.types'
import { createSearchService } from '@/search/service'

export function openSearchRuntime(): Promise<SearchRuntime> {
  const repository = new NativeSearchRepository()
  return Promise.resolve({
    service: createSearchService({ repository }),
    dispose() {},
  })
}
