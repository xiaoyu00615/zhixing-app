import { describe, expect, test } from 'vitest'

import {
  TRASH_REPOSITORY_ERROR_CODES,
  TrashRepositoryError,
  isTrashRepositoryErrorCode,
} from '@/trash/model'

describe('TrashRepositoryError contract', () => {
  test('isTrashRepositoryErrorCode accepts the frozen PERSISTENCE_ERROR code', () => {
    expect(isTrashRepositoryErrorCode('PERSISTENCE_ERROR')).toBe(true)
  })

  test('isTrashRepositoryErrorCode rejects unknown or non-string values', () => {
    expect(isTrashRepositoryErrorCode('NOT_FOUND')).toBe(false)
    expect(isTrashRepositoryErrorCode('')).toBe(false)
    expect(isTrashRepositoryErrorCode(null)).toBe(false)
    expect(isTrashRepositoryErrorCode(42)).toBe(false)
    expect(isTrashRepositoryErrorCode({ code: 'PERSISTENCE_ERROR' })).toBe(false)
  })

  test('constructs with code, operation, and a safe message', () => {
    const error = new TrashRepositoryError('PERSISTENCE_ERROR', 'list')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('TrashRepositoryError')
    expect(error.code).toBe('PERSISTENCE_ERROR')
    expect(error.operation).toBe('list')
    expect(error.message).toBe('Unable to read the trash.')
  })

  test('exposes exactly one frozen error code', () => {
    expect(TRASH_REPOSITORY_ERROR_CODES).toEqual(['PERSISTENCE_ERROR'])
  })
})
