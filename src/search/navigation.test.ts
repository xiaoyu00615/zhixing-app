import { describe, expect, test } from 'vitest'
import { PATHS } from '@/routes/paths'
import type { SearchEntityType, SearchResult } from '@/search/model'
import { buildSearchResultTarget } from '@/search/navigation'

function result(
  entityType: SearchEntityType,
  entityId: string,
): SearchResult {
  return {
    entityType,
    entityId,
    title: '标题',
    snippet: '摘要',
    updatedAtMs: 1_700_000_000_000,
  }
}

describe('buildSearchResultTarget', () => {
  test('task targets the tasks query-param route', () => {
    expect(buildSearchResultTarget(result('task', 'task-1'))).toBe(
      `${PATHS.TASKS}?id=task-1`,
    )
  })

  test('note targets the notes query-param route', () => {
    expect(buildSearchResultTarget(result('note', 'note-1'))).toBe(
      `${PATHS.NOTES}?id=note-1`,
    )
  })

  test('diary targets the diary query-param route', () => {
    expect(buildSearchResultTarget(result('diary', 'diary-1'))).toBe(
      `${PATHS.DIARY}?id=diary-1`,
    )
  })

  test('canvas targets the existing canvas editor path', () => {
    expect(buildSearchResultTarget(result('canvas', 'canvas-1'))).toBe(
      '/canvas/canvas-1',
    )
  })

  test('escapes the entity id instead of raw string concatenation', () => {
    const target = buildSearchResultTarget(result('task', 'a b&c=d'))

    expect(target.startsWith(`${PATHS.TASKS}?id=`)).toBe(true)
    const params = new URLSearchParams(target.slice(target.indexOf('?') + 1))
    expect(params.get('id')).toBe('a b&c=d')
  })
})
