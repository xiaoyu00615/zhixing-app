import { canvasEditorPath, PATHS } from '@/routes/paths'
import type { SearchResult } from '@/search/model'

function withEntityId(path: string, entityId: string): string {
  const params = new URLSearchParams()
  params.set('id', entityId)
  return `${path}?${params.toString()}`
}

/**
 * Builds the navigation target for one search result.
 *
 * The switch is intentionally exhaustive over SearchEntityType: adding a new
 * entity type without a target here is a compile-time error.
 */
export function buildSearchResultTarget(result: SearchResult): string {
  switch (result.entityType) {
    case 'task':
      return withEntityId(PATHS.TASKS, result.entityId)
    case 'note':
      return withEntityId(PATHS.NOTES, result.entityId)
    case 'diary':
      return withEntityId(PATHS.DIARY, result.entityId)
    case 'canvas':
      return canvasEditorPath(result.entityId)
  }
}
