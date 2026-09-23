import type { ArchiveItem } from './model'

/**
 * Transport-agnostic Unified Archive read contract (P5C S2).
 *
 * Implementations resolve the unified archive view into a list of
 * {@link ArchiveItem}, applying the frozen ordering rules defined on the
 * domain model. A repository never throws NOT_FOUND for an empty result set —
 * an archive with no entries resolves to an empty array.
 *
 * This contract is READ ONLY: it owns no archive / unarchive / delete /
 * restore / bulk operation. Canonical writes belong to the source domains
 * (`TaskRepository` / `TaskService`, `NoteRepository` / `NoteService`), and a
 * future unified Archive service must dispatch writes by identity to those
 * owners instead of writing canonical tables directly.
 */
export interface ArchiveRepository {
  /**
   * List the unified archive view (task + note).
   *
   * Rejects with {@link ArchiveRepositoryError} (code `PERSISTENCE_ERROR`) when
   * the underlying store is unavailable, returns a malformed response, or a
   * transport error occurs.
   */
  list(): Promise<readonly ArchiveItem[]>
}
