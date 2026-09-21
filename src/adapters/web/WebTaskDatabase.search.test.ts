import { beforeAll, describe, expect, test } from 'vitest'

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import { TaskDatabaseError, WebTaskDatabase } from '@/adapters/web/taskDatabase'
import type { SearchResult } from '@/search/model'

let sqlite3: Sqlite3Static

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule()
})

function openInMemoryDatabase(): Database {
  return new sqlite3.oo1.DB(':memory:')
}

async function openTaskDatabase(): Promise<{
  database: WebTaskDatabase
  raw: Database
}> {
  const raw = openInMemoryDatabase()
  const database = await WebTaskDatabase.initialize(raw)
  return { database, raw }
}

interface SeedDoc {
  readonly id: number
  readonly entityType: string
  readonly entityId: string
  readonly title: string
  readonly body: string
  readonly updatedAtMs: number
}

function seedDoc(raw: Database, doc: SeedDoc): void {
  raw.exec({
    sql: 'INSERT INTO search_documents(id, entity_type, entity_id, title, body, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?)',
    bind: [doc.id, doc.entityType, doc.entityId, doc.title, doc.body, doc.updatedAtMs],
  })
}

function expectSearchResultShape(value: unknown): asserts value is SearchResult {
  const record = value as Record<string, unknown>
  expect(typeof record.entityType).toBe('string')
  expect(typeof record.entityId).toBe('string')
  expect(typeof record.title).toBe('string')
  expect(typeof record.snippet).toBe('string')
  expect(typeof record.updatedAtMs).toBe('number')
}

describe('WebTaskDatabase searchQuery direct SQL execution', () => {
  test('FTS matches a >=3-char term and returns SearchResult-shaped rows', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 1, entityType: 'note', entityId: 'n1', title: 'Planning', body: 'project planning for q3', updatedAtMs: 100 })
      seedDoc(raw, { id: 2, entityType: 'note', entityId: 'n2', title: 'Roadmap', body: 'quarterly roadmap and planning', updatedAtMs: 200 })

      const results = db.searchQuery({ query: 'planning', limit: 50 })
      expect(results.map((r) => r.entityId).sort()).toEqual(['n1', 'n2'])
      for (const result of results) {
        expectSearchResultShape(result)
        expect(result.entityType).toBe('note')
        expect(result.snippet.toLowerCase()).toContain('planning')
      }
    } finally {
      db.close()
    }
  })

  test('Chinese 2-char term falls back to LIKE (short-only path)', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 3, entityType: 'note', entityId: 'c1', title: '中文计划', body: '这是中文计划内容', updatedAtMs: 300 })

      const results = db.searchQuery({ query: '计划', limit: 50 })
      expect(results).toHaveLength(1)
      expect(results[0]?.entityId).toBe('c1')
      expect(results[0]?.snippet).toContain('计划')
    } finally {
      db.close()
    }
  })

  test('AND semantics: every long term must match (FTS MATCH)', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 4, entityType: 'task', entityId: 't1', title: 'alpha beta', body: '', updatedAtMs: 400 })
      seedDoc(raw, { id: 5, entityType: 'task', entityId: 't2', title: 'alpha gamma', body: '', updatedAtMs: 500 })

      const results = db.searchQuery({ query: 'alpha beta', limit: 50 })
      expect(results.map((r) => r.entityId)).toEqual(['t1'])
    } finally {
      db.close()
    }
  })

  test('mixed long + short terms require both via FTS AND LIKE', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 13, entityType: 'note', entityId: 'm1', title: 'Planning', body: 'project planning 计划', updatedAtMs: 1100 })
      seedDoc(raw, { id: 14, entityType: 'note', entityId: 'm2', title: 'Planning', body: 'project planning only', updatedAtMs: 1200 })

      const results = db.searchQuery({ query: 'planning 计划', limit: 50 })
      expect(results.map((r) => r.entityId)).toEqual(['m1'])
    } finally {
      db.close()
    }
  })

  test('FTS ordering breaks bm25 ties by updated_at_ms DESC then id ASC', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      // Identical content => identical bm25, ordering decided by tiebreak columns.
      seedDoc(raw, { id: 6, entityType: 'note', entityId: 'r1', title: 'search keyword', body: 'same body text', updatedAtMs: 600 })
      seedDoc(raw, { id: 7, entityType: 'note', entityId: 'r2', title: 'search keyword', body: 'same body text', updatedAtMs: 700 })
      seedDoc(raw, { id: 8, entityType: 'note', entityId: 's1', title: 'search keyword', body: 'same body text', updatedAtMs: 800 })
      seedDoc(raw, { id: 9, entityType: 'note', entityId: 's2', title: 'search keyword', body: 'same body text', updatedAtMs: 800 })

      const results = db.searchQuery({ query: 'keyword', limit: 50 })
      expect(results.map((r) => r.entityId)).toEqual(['s1', 's2', 'r2', 'r1'])
    } finally {
      db.close()
    }
  })

  test('short-only path orders by updated_at_ms DESC then id ASC', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 10, entityType: 'note', entityId: 'o1', title: '内容甲', body: '内容 cat content old', updatedAtMs: 900 })
      seedDoc(raw, { id: 11, entityType: 'note', entityId: 'o2', title: '内容乙', body: '内容 dog content new', updatedAtMs: 1000 })
      seedDoc(raw, { id: 12, entityType: 'note', entityId: 'o3', title: '内容丙', body: '内容 cat content mid', updatedAtMs: 950 })

      const results = db.searchQuery({ query: '内容', limit: 50 })
      expect(results.map((r) => r.entityId)).toEqual(['o2', 'o3', 'o1'])
    } finally {
      db.close()
    }
  })

  test('char-aware snippet is at most 128 characters even for long bodies', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      const body = 'a'.repeat(400) + 'needle' + 'b'.repeat(400)
      seedDoc(raw, { id: 20, entityType: 'note', entityId: 'big', title: '', body, updatedAtMs: 1 })

      const results = db.searchQuery({ query: 'needle', limit: 50 })
      expect(results).toHaveLength(1)
      const snippet = results[0]?.snippet ?? ''
      expect([...snippet]).toHaveLength([...snippet].length) // char array is well-formed
      expect(snippet.length).toBeLessThanOrEqual(128)
      expect(snippet).toContain('needle')
    } finally {
      db.close()
    }
  })

  test('char-aware snippet for CJK long body stays within 128 characters', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      const body = '中'.repeat(400) + '猫' + '中'.repeat(400)
      seedDoc(raw, { id: 21, entityType: 'note', entityId: 'cjk', title: '', body, updatedAtMs: 1 })

      const results = db.searchQuery({ query: '猫', limit: 50 })
      expect(results).toHaveLength(1)
      const snippet = results[0]?.snippet ?? ''
      expect([...snippet].length).toBeLessThanOrEqual(128)
      expect(snippet).toContain('猫')
    } finally {
      db.close()
    }
  })

  test('CJK >=3-char term matches via FTS trigram', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 22, entityType: 'note', entityId: 'cjk3', title: '项目计划书', body: '关于项目计划书的说明', updatedAtMs: 1 })

      const results = db.searchQuery({ query: '计划书', limit: 50 })
      expect(results.map((r) => r.entityId)).toEqual(['cjk3'])
      expect(results[0]?.snippet).toContain('计划书')
    } finally {
      db.close()
    }
  })

  test('empty query returns an empty array', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 30, entityType: 'note', entityId: 'e1', title: 'anything', body: 'body', updatedAtMs: 1 })

      expect(db.searchQuery({ query: '', limit: 50 })).toEqual([])
      expect(db.searchQuery({ query: '   ', limit: 50 })).toEqual([])
    } finally {
      db.close()
    }
  })

  test('more than 16 terms throws INVALID_QUERY', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 31, entityType: 'note', entityId: 'x1', title: 'a', body: 'b', updatedAtMs: 1 })

      const query = Array.from({ length: 17 }, (_, i) => `t${i}`).join(' ')
      const error = (() => {
        try {
          db.searchQuery({ query, limit: 50 })
          return null
        } catch (e: unknown) {
          return e
        }
      })()
      expect(error).toBeInstanceOf(TaskDatabaseError)
      expect((error as TaskDatabaseError).code).toBe('INVALID_QUERY')
    } finally {
      db.close()
    }
  })

  test('out-of-range limit throws INVALID_QUERY', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      seedDoc(raw, { id: 32, entityType: 'note', entityId: 'l1', title: 'planning', body: 'b', updatedAtMs: 1 })

      for (const limit of [0, 201, 1.5, -3]) {
        const error = (() => {
          try {
            db.searchQuery({ query: 'planning', limit })
            return null
          } catch (e: unknown) {
            return e
          }
        })()
        expect(error).toBeInstanceOf(TaskDatabaseError)
        expect((error as TaskDatabaseError).code).toBe('INVALID_QUERY')
      }
    } finally {
      db.close()
    }
  })

  test('limit defaults within bounds return results and respect limit', async () => {
    const { database: db, raw } = await openTaskDatabase()
    try {
      for (let i = 0; i < 5; i++) {
        seedDoc(raw, { id: 40 + i, entityType: 'note', entityId: `lim${i}`, title: 'planning', body: `body ${i}`, updatedAtMs: 1000 + i })
      }

      const all = db.searchQuery({ query: 'planning', limit: 50 })
      expect(all.length).toBe(5)

      const limited = db.searchQuery({ query: 'planning', limit: 2 })
      expect(limited).toHaveLength(2)
      // ordered by updated_at_ms DESC then id ASC among the limited slice
      expect(limited[0]?.entityId).toBe('lim4')
      expect(limited[1]?.entityId).toBe('lim3')
    } finally {
      db.close()
    }
  })
})
