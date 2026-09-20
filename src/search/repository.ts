import type { SearchQuery, SearchResult } from './model'

/**
 * Transport-agnostic search query contract (P5 S2).
 *
 * Implementations resolve a {@link SearchQuery} into a list of
 * {@link SearchResult}, applying the frozen term-splitting, AND-semantics, and
 * ordering rules defined on the domain model. A repository never throws
 * NOT_FOUND for an empty result set — a query that matches nothing resolves to
 * an empty array.
 */
export interface SearchRepository {
  /**
   * Execute a global search.
   *
   * Rejects with {@link SearchRepositoryError} (code `INVALID_QUERY`) when the
   * query or limit fails validation, or `PERSISTENCE_ERROR` when the underlying
   * store is unavailable or returns a malformed response.
   */
  query(input: SearchQuery): Promise<SearchResult[]>
}
