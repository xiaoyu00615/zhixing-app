/**
 * P6-S9 · Data Root Migration service tests
 *
 * The service is a thin boundary: it validates the request shape at the domain
 * edge and forwards the SAME identity, so a malformed id or an unusable
 * destination can never reach a platform adapter and a retry can never silently
 * mint a new operation.
 */

import { describe, expect, test, vi } from 'vitest'

import {
  DataRootMigrationError,
  type DataRootMigrationPort,
} from './model'
import { DataRootMigrationService } from './service'

const OP = '11111111-1111-4111-8111-111111111111'
const SAFETY = '33333333-3333-4333-8333-333333333333'
const TARGET = 'D:\\Data\\zhixing'

function makePort() {
  // `Promise.resolve(...)` rather than `async () => ...`: these stubs resolve
  // immediately and never await, so an `async` wrapper would be noise.
  const applyDataRootMigration = vi.fn<
    DataRootMigrationPort['applyDataRootMigration']
  >(() =>
    Promise.resolve({
      operationId: OP,
      targetDataRoot: TARGET,
      outcome: 'MIGRATED' as const,
      safetyBackupId: SAFETY,
    }),
  )
  const reconcileDataRootMigration = vi.fn<
    DataRootMigrationPort['reconcileDataRootMigration']
  >(() =>
    Promise.resolve({
      operationId: OP,
      targetDataRoot: TARGET,
      outcome: 'COMMITTED' as const,
    }),
  )
  const port: DataRootMigrationPort = {
    applyDataRootMigration,
    reconcileDataRootMigration,
  }
  return { port, applyDataRootMigration, reconcileDataRootMigration }
}

describe('DataRootMigrationService', () => {
  test('apply forwards the exact operation identity and target', async () => {
    const { port, applyDataRootMigration } = makePort()
    const service = new DataRootMigrationService(port)

    const result = await service.apply({
      operationId: OP,
      targetDataRoot: TARGET,
    })

    expect(applyDataRootMigration).toHaveBeenCalledTimes(1)
    expect(applyDataRootMigration).toHaveBeenCalledWith({
      operationId: OP,
      targetDataRoot: TARGET,
    })
    expect(result.outcome).toBe('MIGRATED')
  })

  test('reconcile reuses the SAME operation identity and target', async () => {
    const { port, reconcileDataRootMigration } = makePort()
    const service = new DataRootMigrationService(port)

    await service.reconcile({ operationId: OP, targetDataRoot: TARGET })

    expect(reconcileDataRootMigration).toHaveBeenCalledWith({
      operationId: OP,
      targetDataRoot: TARGET,
    })
  })

  test('a malformed request is refused before the port is reached', async () => {
    const { port, applyDataRootMigration, reconcileDataRootMigration } =
      makePort()
    const service = new DataRootMigrationService(port)

    await expect(
      service.apply({ operationId: 'not-a-uuid', targetDataRoot: TARGET }),
    ).rejects.toBeInstanceOf(DataRootMigrationError)
    await expect(
      service.apply({ operationId: OP, targetDataRoot: 'relative/folder' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
    await expect(
      service.reconcile({ operationId: OP, targetDataRoot: '' }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' })

    expect(applyDataRootMigration).not.toHaveBeenCalled()
    expect(reconcileDataRootMigration).not.toHaveBeenCalled()
  })

  test('an uppercase UUID is refused (identity is canonical)', async () => {
    const { port, applyDataRootMigration } = makePort()
    const service = new DataRootMigrationService(port)

    // A UUID that actually contains letters — `OP` is digits-only, so
    // `OP.toUpperCase()` would be a no-op and this test would pass vacuously.
    const lowercase = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
    const uppercase = lowercase.toUpperCase()
    expect(uppercase).not.toBe(lowercase)

    await expect(
      service.apply({ operationId: uppercase, targetDataRoot: TARGET }),
    ).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
    expect(applyDataRootMigration).not.toHaveBeenCalled()
  })

  test('a validation failure arrives as a REJECTED PROMISE, not a sync throw', async () => {
    const { port } = makePort()
    const service = new DataRootMigrationService(port)

    // If `apply` threw synchronously this would escape `expect(...).rejects`
    // entirely and the test would fail with a thrown error instead.
    const promise = service.apply({ operationId: 'nope', targetDataRoot: TARGET })
    await expect(promise).rejects.toMatchObject({ code: 'REQUEST_INVALID' })
  })
})
