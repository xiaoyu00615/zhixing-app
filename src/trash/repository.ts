import type { TrashItem } from './model'

/**
 * Transport-agnostic Unified Trash read contract (P5B S1 — Native read layer only).
 *
 * Implementations resolve the unified trash view into a list of
 * {@link TrashItem}, applying the frozen ordering rules defined on the domain
 * model. A repository never throws NOT_FOUND for an empty result set — a trash
 * with no entries resolves to an empty array.
 *
 * Write operations (permanent delete, bulk restore, single restore, filters)
 * are explicitly out of scope for S1 and will be composed in a later slice.
 */
export interface TrashRepository {
  /**
   * List the unified trash view.
   *
   * Rejects with {@link TrashRepositoryError} (code `PERSISTENCE_ERROR`) when the
   * underlying store is unavailable, returns a malformed response, or a
   * transport error occurs.
   */
  list(): Promise<readonly TrashItem[]>
}
