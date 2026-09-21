/**
 * Search application service (P5 S4).
 *
 * This service owns the PUBLIC application semantics of global search:
 * trimming, empty-query short-circuit, the public default limit policy and
 * the application error mapping.
 *
 * It deliberately does NOT own any persistence semantics. Whitespace term
 * splitting, the <3 LIKE / >=3 FTS classification, LIKE escaping, FTS literal
 * escaping, MATCH construction, bm25 ordering and snippet projection all
 * remain inside the persistence layer.
 */

import {
  DEFAULT_SEARCH_LIMIT,
  SearchRepositoryError,
  type SearchResult,
} from '@/search/model'
import type { SearchRepository } from '@/search/repository'

export const SEARCH_APPLICATION_ERROR_CODES = [
  'VALIDATION',
  'UNAVAILABLE',
] as const

export type SearchApplicationErrorCode =
  (typeof SEARCH_APPLICATION_ERROR_CODES)[number]

const SAFE_ERROR_MESSAGES: Record<SearchApplicationErrorCode, string> = {
  VALIDATION: 'Search input is invalid.',
  UNAVAILABLE: 'Search service is unavailable.',
}

export class SearchApplicationError extends Error {
  readonly code: SearchApplicationErrorCode

  constructor(code: SearchApplicationErrorCode) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'SearchApplicationError'
    this.code = code
  }
}

export interface CreateSearchServiceOptions {
  readonly repository: SearchRepository
}

function readQuery(value: unknown): string {
  if (typeof value !== 'string') {
    throw new SearchApplicationError('VALIDATION')
  }
  return value
}

function mapRepositoryError(error: unknown): SearchApplicationError {
  if (!(error instanceof SearchRepositoryError)) {
    return new SearchApplicationError('UNAVAILABLE')
  }

  switch (error.code) {
    case 'INVALID_QUERY':
      return new SearchApplicationError('VALIDATION')
    case 'PERSISTENCE_ERROR':
      return new SearchApplicationError('UNAVAILABLE')
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw mapRepositoryError(error)
  }
}

export function createSearchService({
  repository,
}: CreateSearchServiceOptions) {
  return {
    async search(publicQuery: string): Promise<SearchResult[]> {
      const query = readQuery(publicQuery).trim()
      if (query === '') {
        return []
      }
      return callRepository(() =>
        repository.query({ query, limit: DEFAULT_SEARCH_LIMIT }),
      )
    },
  }
}

export type SearchService = ReturnType<typeof createSearchService>
