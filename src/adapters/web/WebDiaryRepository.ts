import type { DiaryDate, DiaryEntry } from '@/diary/model'
import {
  DiaryRepositoryError,
  type ChangeDiaryDateInput,
  type CreateDiaryEntryInput,
  type DiaryRepository,
  type DiaryRepositoryOperation,
  type RestoreDiaryEntryInput,
  type SoftDeleteDiaryEntryInput,
  type UpdateDiaryEntryInput,
} from '@/diary/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
  isValidLocalDate,
} from '@/shared/validation'
import {
  DiaryWorkerClientError,
  type TaskWorkerClient,
} from '@/adapters/web/taskWorkerClient'
import { isRecord } from '@/adapters/web/taskWorkerProtocol'

function parseDiaryEntry(
  value: unknown,
  operation: DiaryRepositoryOperation,
): DiaryEntry {
  if (!isRecord(value)) {
    throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
  }
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

function validateTimestamp(
  timestamp: number,
  operation: DiaryRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(timestamp)) {
    throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
  }
}

function validateDiaryDate(
  diaryDate: unknown,
  operation: DiaryRepositoryOperation,
): void {
  if (!isValidLocalDate(diaryDate)) {
    throw new DiaryRepositoryError('INVALID_DIARY_DATE', operation)
  }
}

function validateTextFields(
  title: unknown,
  content: unknown,
  operation: DiaryRepositoryOperation,
): void {
  if (typeof title !== 'string' || typeof content !== 'string') {
    throw new DiaryRepositoryError('INVALID_TITLE', operation)
  }
}

function mapClientError(
  error: unknown,
  operation: DiaryRepositoryOperation,
): DiaryRepositoryError {
  if (error instanceof DiaryRepositoryError) {
    return error
  }
  if (error instanceof DiaryWorkerClientError) {
    switch (error.code) {
      case 'INVALID_ID':
      case 'NOT_FOUND':
      case 'INVALID_TITLE':
      case 'INVALID_DIARY_DATE':
      case 'DIARY_DATE_CONFLICT':
      case 'PERSISTENCE_ERROR':
        return new DiaryRepositoryError(error.code, operation)
    }
  }
  return new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
}

export class WebDiaryRepository implements DiaryRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async create(input: CreateDiaryEntryInput): Promise<DiaryEntry> {
    const operation = 'create'
    validateId(input.id, operation)
    validateTimestamp(input.createdAtMs, operation)
    validateDiaryDate(input.diaryDate, operation)
    validateTextFields(input.title, input.content, operation)
    try {
      return parseDiaryEntry(await this.#client.createDiaryEntry(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async getActiveById(id: string): Promise<DiaryEntry | null> {
    const operation = 'getActiveById'
    validateId(id, operation)
    try {
      const value = await this.#client.getActiveDiaryEntryById(id)
      if (value === null) return null
      return parseDiaryEntry(value, operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async getActiveByDiaryDate(
    diaryDate: DiaryDate,
  ): Promise<DiaryEntry | null> {
    const operation = 'getActiveByDiaryDate'
    validateDiaryDate(diaryDate, operation)
    try {
      const value = await this.#client.getActiveDiaryEntryByDate(diaryDate)
      if (value === null) return null
      return parseDiaryEntry(value, operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async listActive(): Promise<DiaryEntry[]> {
    const operation = 'listActive'
    try {
      const value = await this.#client.listActiveDiaryEntries()
      if (!Array.isArray(value)) {
        throw new DiaryRepositoryError('PERSISTENCE_ERROR', operation)
      }
      return value.map((entry) => parseDiaryEntry(entry, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async updateDiaryEntry(
    input: UpdateDiaryEntryInput,
  ): Promise<DiaryEntry> {
    const operation = 'updateDiaryEntry'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    validateTextFields(input.title, input.content, operation)
    try {
      return parseDiaryEntry(await this.#client.updateDiaryEntry(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async changeDiaryDate(
    input: ChangeDiaryDateInput,
  ): Promise<DiaryEntry> {
    const operation = 'changeDiaryDate'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    validateDiaryDate(input.diaryDate, operation)
    try {
      return parseDiaryEntry(await this.#client.changeDiaryDate(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async softDelete(input: SoftDeleteDiaryEntryInput): Promise<void> {
    const operation = 'softDelete'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.softDeleteDiaryEntry(input)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async restore(input: RestoreDiaryEntryInput): Promise<void> {
    const operation = 'restore'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.restoreDiaryEntry(input)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }
}
