import { invoke } from '@tauri-apps/api/core'

import {
  DEFAULT_SEARCH_LIMIT,
  MAX_SEARCH_LIMIT,
  MAX_SEARCH_TERMS,
  MIN_SEARCH_LIMIT,
  SearchRepositoryError,
  isSearchRepositoryErrorCode,
  type SearchEntityType,
  type SearchQuery,
  type SearchResult,
} from '@/search/model'
import type { SearchRepository } from '@/search/repository'

type Operation = 'query'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const ALLOWED_ENTITY_TYPES: readonly SearchEntityType[] = [
  'task',
  'note',
  'diary',
  'canvas',
]

function parseSearchResult(value: unknown, operation: Operation): SearchResult {
  if (!isRecord(value))
    throw new SearchRepositoryError('PERSISTENCE_ERROR', operation)
  const { entityType, entityId, title, snippet, updatedAtMs } = value
  if (
    typeof entityType !== 'string' ||
    typeof entityId !== 'string' ||
    typeof title !== 'string' ||
    typeof snippet !== 'string' ||
    !Number.isSafeInteger(updatedAtMs) ||
    (updatedAtMs as number) < 0 ||
    !ALLOWED_ENTITY_TYPES.includes(entityType as SearchEntityType)
  ) {
    throw new SearchRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    entityType: entityType as SearchEntityType,
    entityId,
    title,
    snippet,
    updatedAtMs: updatedAtMs as number,
  }
}

function validateQuery(query: unknown, operation: Operation): string {
  if (typeof query !== 'string') {
    throw new SearchRepositoryError('INVALID_QUERY', operation)
  }
  const terms = query.split(/\s+/).filter((term) => term.length > 0)
  if (terms.length > MAX_SEARCH_TERMS) {
    throw new SearchRepositoryError('INVALID_QUERY', operation)
  }
  return query
}

function validateLimit(limit: unknown, operation: Operation): number {
  if (limit === undefined) return DEFAULT_SEARCH_LIMIT
  if (
    !Number.isSafeInteger(limit) ||
    (limit as number) < MIN_SEARCH_LIMIT ||
    (limit as number) > MAX_SEARCH_LIMIT
  ) {
    throw new SearchRepositoryError('INVALID_QUERY', operation)
  }
  return limit as number
}

async function call(
  command: string,
  operation: Operation,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(command, args)
  } catch (error: unknown) {
    if (isRecord(error) && isSearchRepositoryErrorCode(error.code))
      throw new SearchRepositoryError(error.code, operation)
    throw new SearchRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

export class NativeSearchRepository implements SearchRepository {
  async query(input: SearchQuery): Promise<SearchResult[]> {
    const operation = 'query'
    const query = validateQuery(input.query, operation)
    const limit = validateLimit(input.limit, operation)
    const value = await call('search_query', operation, { query, limit })
    if (!Array.isArray(value))
      throw new SearchRepositoryError('PERSISTENCE_ERROR', operation)
    return value.map((row) => parseSearchResult(row, operation))
  }
}
