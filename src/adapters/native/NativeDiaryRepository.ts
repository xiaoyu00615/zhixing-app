import { invoke } from '@tauri-apps/api/core'

import {
  DiaryRepositoryError,
  isDiaryRepositoryErrorCode,
  type ChangeDiaryDateInput,
  type CreateDiaryEntryInput,
  type DiaryRepository,
  type DiaryRepositoryOperation,
  type RestoreDiaryEntryInput,
  type SoftDeleteDiaryEntryInput,
  type UpdateDiaryEntryInput,
} from '@/diary/repository'
import type { DiaryEntry } from '@/diary/model'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
  isValidLocalDate,
} from '@/shared/validation'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseDiaryEntry(
  value: unknown,
  operation: DiaryRepositoryOperation,
): DiaryEntry {
  if (!isRecord(value))
    throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
  const {
    id,
    title,
    content,
    diaryDate,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
  } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    typeof title !== 'string' ||
    typeof content !== 'string' ||
    !isValidLocalDate(diaryDate) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    (deletedAtMs !== null &&
      !isNonNegativeSafeIntegerMilliseconds(deletedAtMs))
  ) {
    throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
  }
  return {
    id,
    title,
    content,
    diaryDate,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
  }
}

function validateId(id: string, operation: DiaryRepositoryOperation): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new DiaryRepositoryError('INVALID_ID', operation)
  }
}

function validateDiaryDate(
  diaryDate: string,
  operation: DiaryRepositoryOperation,
): void {
  if (!isValidLocalDate(diaryDate)) {
    throw new DiaryRepositoryError('INVALID_DIARY_DATE', operation)
  }
}

function validateTimestamp(
  value: number,
  operation: DiaryRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(value)) {
    throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

function validateTextFields(
  title: string,
  content: string,
  operation: DiaryRepositoryOperation,
): void {
  if (typeof title !== 'string' || typeof content !== 'string') {
    throw new DiaryRepositoryError('INVALID_TITLE', operation)
  }
}

async function call(
  command: string,
  operation: DiaryRepositoryOperation,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(command, args)
  } catch (error: unknown) {
    if (isRecord(error) && isDiaryRepositoryErrorCode(error.code))
      throw new DiaryRepositoryError(error.code, operation)
    throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

export class NativeDiaryRepository implements DiaryRepository {
  async create(input: CreateDiaryEntryInput): Promise<DiaryEntry> {
    const operation = 'create'
    validateId(input.id, operation)
    validateDiaryDate(input.diaryDate, operation)
    validateTextFields(input.title, input.content, operation)
    validateTimestamp(input.createdAtMs, operation)
    return parseDiaryEntry(
      await call('diary_create', operation, { input }),
      operation,
    )
  }

  async getActiveById(id: string): Promise<DiaryEntry | null> {
    const operation = 'getActiveById'
    validateId(id, operation)
    const value = await call('diary_get_active_by_id', operation, { id })
    if (value === null) return null
    return parseDiaryEntry(value, operation)
  }

  async getActiveByDiaryDate(diaryDate: string): Promise<DiaryEntry | null> {
    const operation = 'getActiveByDiaryDate'
    validateDiaryDate(diaryDate, operation)
    const value = await call('diary_get_active_by_diary_date', operation, {
      diaryDate,
    })
    if (value === null) return null
    return parseDiaryEntry(value, operation)
  }

  async listActive(): Promise<DiaryEntry[]> {
    const operation = 'listActive'
    const value = await call('diary_list_active', operation)
    if (!Array.isArray(value))
      throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
    return value.map((entry) => parseDiaryEntry(entry, operation))
  }

  async updateDiaryEntry(input: UpdateDiaryEntryInput): Promise<DiaryEntry> {
    const operation = 'updateDiaryEntry'
    validateId(input.id, operation)
    validateTextFields(input.title, input.content, operation)
    validateTimestamp(input.updatedAtMs, operation)
    return parseDiaryEntry(
      await call('diary_update', operation, { input }),
      operation,
    )
  }

  async changeDiaryDate(input: ChangeDiaryDateInput): Promise<DiaryEntry> {
    const operation = 'changeDiaryDate'
    validateId(input.id, operation)
    validateDiaryDate(input.diaryDate, operation)
    validateTimestamp(input.updatedAtMs, operation)
    return parseDiaryEntry(
      await call('diary_change_date', operation, { input }),
      operation,
    )
  }

  async softDelete(input: SoftDeleteDiaryEntryInput): Promise<void> {
    const operation = 'softDelete'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    await call('diary_soft_delete', operation, { input })
  }

  async restore(input: RestoreDiaryEntryInput): Promise<void> {
    const operation = 'restore'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    await call('diary_restore', operation, { input })
  }
}
