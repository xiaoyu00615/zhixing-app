import type { Database } from '@sqlite.org/sqlite-wasm'

import createTasksSql from '../../../src-tauri/migrations/0001_create_tasks.sql?raw'
import addTaskPlanningFieldsSql from '../../../src-tauri/migrations/0002_add_task_planning_fields.sql?raw'
import addTaskProjectsSql from '../../../src-tauri/migrations/0003_add_task_projects.sql?raw'
import addTaskTagsSql from '../../../src-tauri/migrations/0004_add_task_tags.sql?raw'
import addTaskSoftDeleteSql from '../../../src-tauri/migrations/0005_add_task_soft_delete.sql?raw'
import addCanvasCoreSql from '../../../src-tauri/migrations/0006_add_canvas_core.sql?raw'

export interface WebMigrationDefinition {
  readonly version: number
  readonly id: string
  readonly sql: string
  readonly highRisk: false
}

export interface WebMigrationHistoryRow {
  readonly version: number
  readonly id: string
  readonly checksumSha256: string
  readonly appliedAtMs: number
}

export interface WebMigrationStore {
  ensureMetadataTable(): void
  validateMetadataStructure(): void
  readHistory(): readonly WebMigrationHistoryRow[]
  transaction<T>(operation: () => T): T
  executeMigration(sql: string): void
  insertHistory(row: WebMigrationHistoryRow): void
}

export type WebMigrationErrorCode =
  'DEFINITION_INVALID' | 'HISTORY_CORRUPT' | 'FUTURE_VERSION' | 'APPLY_FAILED'

export class WebMigrationError extends Error {
  readonly code: WebMigrationErrorCode

  constructor(code: WebMigrationErrorCode) {
    super('Web migration validation or execution failed.')
    this.name = 'WebMigrationError'
    this.code = code
  }
}

export const WEB_MIGRATIONS: readonly WebMigrationDefinition[] = [
  {
    version: 1,
    id: '0001_create_tasks',
    sql: createTasksSql,
    highRisk: false,
  },
  {
    version: 2,
    id: '0002_add_task_planning_fields',
    sql: addTaskPlanningFieldsSql,
    highRisk: false,
  },
  {
    version: 3,
    id: '0003_add_task_projects',
    sql: addTaskProjectsSql,
    highRisk: false,
  },
  {
    version: 4,
    id: '0004_add_task_tags',
    sql: addTaskTagsSql,
    highRisk: false,
  },
  {
    version: 5,
    id: '0005_add_task_soft_delete',
    sql: addTaskSoftDeleteSql,
    highRisk: false,
  },
  {
    version: 6,
    id: '0006_add_canvas_core',
    sql: addCanvasCoreSql,
    highRisk: false,
  },
]

const HISTORY_TABLE_SQL = `CREATE TABLE IF NOT EXISTS schema_migrations (
    version         INTEGER PRIMARY KEY,
    id              TEXT    NOT NULL UNIQUE,
    checksum_sha256 TEXT    NOT NULL,
    applied_at_ms   INTEGER NOT NULL CHECK (applied_at_ms >= 0)
)`

function asSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null
}

function assertMigrationSource(sql: string): void {
  if (sql.length === 0 || sql.charCodeAt(0) === 0xfeff || sql.includes('\r')) {
    throw new WebMigrationError('DEFINITION_INVALID')
  }
}

function validateDefinitions(
  definitions: readonly WebMigrationDefinition[],
): void {
  const ids = new Set<string>()
  definitions.forEach((definition, index) => {
    if (
      definition.version !== index + 1 ||
      definition.id.length === 0 ||
      ids.has(definition.id) ||
      definition.highRisk !== false
    ) {
      throw new WebMigrationError('DEFINITION_INVALID')
    }
    assertMigrationSource(definition.sql)
    ids.add(definition.id)
  })
}

export async function sha256Hex(
  source: string,
  subtle: Pick<SubtleCrypto, 'digest'> = globalThis.crypto.subtle,
): Promise<string> {
  assertMigrationSource(source)
  const digest = await subtle.digest(
    'SHA-256',
    new TextEncoder().encode(source),
  )
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

export async function runWebMigrations(
  store: WebMigrationStore,
  definitions: readonly WebMigrationDefinition[] = WEB_MIGRATIONS,
  now: () => number = Date.now,
): Promise<void> {
  validateDefinitions(definitions)
  const checksums = await Promise.all(
    definitions.map((definition) => sha256Hex(definition.sql)),
  )

  store.ensureMetadataTable()
  store.validateMetadataStructure()
  const history = store.readHistory()

  history.forEach((row, index) => {
    const expectedVersion = index + 1
    if (row.version > definitions.length) {
      throw new WebMigrationError('FUTURE_VERSION')
    }
    if (row.version !== expectedVersion) {
      throw new WebMigrationError('HISTORY_CORRUPT')
    }

    const definition = definitions[index]
    const checksum = checksums[index]
    if (
      definition === undefined ||
      checksum === undefined ||
      row.id !== definition.id ||
      row.checksumSha256 !== checksum ||
      !Number.isSafeInteger(row.appliedAtMs) ||
      row.appliedAtMs < 0
    ) {
      throw new WebMigrationError('HISTORY_CORRUPT')
    }
  })

  for (let index = history.length; index < definitions.length; index += 1) {
    const definition = definitions[index]
    const checksumSha256 = checksums[index]
    const appliedAtMs = now()
    if (
      definition === undefined ||
      checksumSha256 === undefined ||
      !Number.isSafeInteger(appliedAtMs) ||
      appliedAtMs < 0
    ) {
      throw new WebMigrationError('APPLY_FAILED')
    }

    try {
      store.transaction(() => {
        store.executeMigration(definition.sql)
        store.insertHistory({
          version: definition.version,
          id: definition.id,
          checksumSha256,
          appliedAtMs,
        })
      })
    } catch {
      throw new WebMigrationError('APPLY_FAILED')
    }
  }
}

function quoteSqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`
}

export class SqliteWebMigrationStore implements WebMigrationStore {
  readonly #database: Database

  constructor(database: Database) {
    this.#database = database
  }

  ensureMetadataTable(): void {
    this.#database.exec(HISTORY_TABLE_SQL)
  }

  validateMetadataStructure(): void {
    const columns = this.#database.selectObjects(
      "PRAGMA table_info('schema_migrations')",
    )
    const expected = [
      { name: 'version', type: 'INTEGER', notnull: 0, pk: 1 },
      { name: 'id', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'checksum_sha256', type: 'TEXT', notnull: 1, pk: 0 },
      { name: 'applied_at_ms', type: 'INTEGER', notnull: 1, pk: 0 },
    ]

    if (
      columns.length !== expected.length ||
      !columns.every((column, index) => {
        const wanted = expected[index]
        return (
          wanted !== undefined &&
          column.name === wanted.name &&
          column.type === wanted.type &&
          column.notnull === wanted.notnull &&
          column.pk === wanted.pk
        )
      })
    ) {
      throw new WebMigrationError('HISTORY_CORRUPT')
    }

    const indexes = this.#database.selectObjects(
      "PRAGMA index_list('schema_migrations')",
    )
    const idIsUniquelyIndexed = indexes.some((index) => {
      if (index.unique !== 1 || typeof index.name !== 'string') {
        return false
      }
      const keyColumns = this.#database
        .selectObjects(`PRAGMA index_info(${quoteSqlString(index.name)})`)
        .filter((column) => asSafeInteger(column.cid) !== null)
        .sort((left, right) => {
          const leftSequence = asSafeInteger(left.seqno) ?? 0
          const rightSequence = asSafeInteger(right.seqno) ?? 0
          return leftSequence - rightSequence
        })
        .map((column) => column.name)
      return keyColumns.length === 1 && keyColumns[0] === 'id'
    })

    if (!idIsUniquelyIndexed) {
      throw new WebMigrationError('HISTORY_CORRUPT')
    }
  }

  readHistory(): readonly WebMigrationHistoryRow[] {
    const rows = this.#database.selectObjects(
      `SELECT version, id, checksum_sha256, applied_at_ms
       FROM schema_migrations ORDER BY version ASC`,
    )
    return rows.map((row) => {
      const version = asSafeInteger(row.version)
      const appliedAtMs = asSafeInteger(row.applied_at_ms)
      if (
        version === null ||
        typeof row.id !== 'string' ||
        typeof row.checksum_sha256 !== 'string' ||
        appliedAtMs === null
      ) {
        throw new WebMigrationError('HISTORY_CORRUPT')
      }
      return {
        version,
        id: row.id,
        checksumSha256: row.checksum_sha256,
        appliedAtMs,
      }
    })
  }

  transaction<T>(operation: () => T): T {
    return this.#database.transaction(operation)
  }

  executeMigration(sql: string): void {
    this.#database.exec(sql)
  }

  insertHistory(row: WebMigrationHistoryRow): void {
    this.#database.exec({
      sql: `INSERT INTO schema_migrations
            (version, id, checksum_sha256, applied_at_ms)
            VALUES (?, ?, ?, ?)`,
      bind: [row.version, row.id, row.checksumSha256, row.appliedAtMs],
    })
  }
}
