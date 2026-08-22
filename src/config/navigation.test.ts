import { describe, expect, test } from 'vitest'

import { NAV_ITEMS } from '@/config/navigation'
import { DEFAULT_PATH } from '@/routes/paths'

describe('navigation contract', () => {
  test('keeps the frozen primary navigation order and unique paths', () => {
    expect(NAV_ITEMS.map(({ label, path }) => [label, path])).toEqual([
      ['首页', '/today'],
      ['任务', '/tasks'],
      ['画布', '/canvas'],
      ['日记', '/diary'],
      ['笔记', '/notes'],
      ['搜索', '/search'],
      ['标签', '/tags'],
      ['归档', '/archive'],
      ['回收站', '/trash'],
      ['设置', '/settings'],
    ])

    const paths = NAV_ITEMS.map(({ path }) => path)
    expect(new Set(paths).size).toBe(paths.length)
    expect(DEFAULT_PATH).toBe('/today')
  })
})
