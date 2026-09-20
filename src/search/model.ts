/**
 * Search domain contract (P5 S2 — Native query layer only).
 *
 * This module defines the value types and the structured error contract for
 * global search. It contains NO service, NO runtime, and NO I/O: the contract
 * is transport-agnostic so the Native and future Web repositories can share it.
 *
 * The matched text semantics are deliberately frozen for S2:
 *   - A query is split on whitespace into terms (max {@link MAX_SEARCH_TERMS}).
 *   - Terms with >= 3 characters use the FTS trigram index (MATCH).
 *   - Terms with < 3 characters use a LIKE fallback (Chinese 2-char limitation).
 *   - All terms are combined with AND semantics.
 *   - Results are ordered by bm25 ASC (more negative = better) with tie-breakers.
 */

export type SearchEntityType = 'task' | 'note' | 'diary' | 'canvas'

export interface SearchResult {
  /** The domain that owns the matched row. */
  readonly entityType: SearchEntityType
  /** The primary identifier of the owning entity (UUID for task/note/diary). */
  readonly entityId: string
  /** The title of the matched entity (verbatim, may be empty). */
  readonly title: string
  /** A plain-text snippet of the matched content (no markup). */
  readonly snippet: string
  /** Last-updated timestamp of the matched entity, in epoch milliseconds. */
  readonly updatedAtMs: number
}

export interface SearchQuery {
  /** Free-text query. Split into whitespace-separated terms by the repository. */
  readonly query: string
  /**
   * Optional result cap. Defaults to {@link DEFAULT_SEARCH_LIMIT} when omitted.
   * Must be within [MIN_SEARCH_LIMIT, MAX_SEARCH_LIMIT] or the query is rejected.
   */
  readonly limit?: number
}

export const MIN_SEARCH_LIMIT = 1
export const MAX_SEARCH_LIMIT = 200
export const DEFAULT_SEARCH_LIMIT = 50
export const MAX_SEARCH_TERMS = 16

export const SEARCH_REPOSITORY_ERROR_CODES = [
  'INVALID_QUERY',
  'PERSISTENCE_ERROR',
] as const
export type SearchRepositoryErrorCode =
  (typeof SEARCH_REPOSITORY_ERROR_CODES)[number]
export type SearchRepositoryOperation = 'query'

const SAFE_ERROR_MESSAGES: Record<SearchRepositoryErrorCode, string> = {
  INVALID_QUERY: 'The search query is invalid.',
  PERSISTENCE_ERROR: 'Unable to complete the search.',
}

export class SearchRepositoryError extends Error {
  readonly code: SearchRepositoryErrorCode
  readonly operation: SearchRepositoryOperation

  constructor(
    code: SearchRepositoryErrorCode,
    operation: SearchRepositoryOperation,
  ) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'SearchRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isSearchRepositoryErrorCode(
  value: unknown,
): value is SearchRepositoryErrorCode {
  return (
    typeof value === 'string' &&
    (SEARCH_REPOSITORY_ERROR_CODES as readonly string[]).includes(value)
  )
}
