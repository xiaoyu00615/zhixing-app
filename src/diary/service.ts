import type { DiaryDate, DiaryEntry } from './model'
import {
  DiaryRepositoryError,
  type ChangeDiaryDateInput,
  type CreateDiaryEntryInput,
  type DiaryRepository,
  type RestoreDiaryEntryInput,
  type SoftDeleteDiaryEntryInput,
  type UpdateDiaryEntryInput,
} from './repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
  isValidLocalDate,
  localDateFromDate,
} from '@/shared/validation'

export const DIARY_APPLICATION_ERROR_CODES = [
  'VALIDATION',
  'NOT_FOUND',
  'CONFLICT',
  'UNAVAILABLE',
] as const

export type DiaryApplicationErrorCode =
  (typeof DIARY_APPLICATION_ERROR_CODES)[number]

export type DiaryApplicationErrorField = 'id' | 'diaryDate' | 'title' | 'content'

const SAFE_ERROR_MESSAGES: Record<DiaryApplicationErrorCode, string> = {
  VALIDATION: 'Diary input is invalid.',
  NOT_FOUND: 'Diary entry not found.',
  CONFLICT: 'A diary entry already exists for this date.',
  UNAVAILABLE: 'Diary service is unavailable.',
}

export class DiaryApplicationError extends Error {
  readonly code: DiaryApplicationErrorCode
  readonly field?: DiaryApplicationErrorField

  constructor(code: DiaryApplicationErrorCode, field?: DiaryApplicationErrorField) {
    super(SAFE_ERROR_MESSAGES[code])
    this.name = 'DiaryApplicationError'
    this.code = code
    this.field = field
  }
}

export type GenerateDiaryId = () => string
export type NowMs = () => number
export type TodayDiaryDate = () => DiaryDate

export interface CreateDiaryServiceOptions {
  readonly repository: DiaryRepository
  readonly generateDiaryId?: GenerateDiaryId
  readonly nowMs?: NowMs
  readonly today?: TodayDiaryDate
}

function defaultGenerateDiaryId(): string {
  return globalThis.crypto.randomUUID()
}

function defaultNowMs(): number {
  return Date.now()
}

function defaultToday(): DiaryDate {
  return localDateFromDate(new Date())
}

function validatePublicId(id: unknown): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new DiaryApplicationError('VALIDATION', 'id')
  }
}

function readText(value: unknown, field: 'title' | 'content'): string {
  if (typeof value !== 'string') {
    throw new DiaryApplicationError('VALIDATION', field)
  }
  return value
}

function readGeneratedDiaryId(generateDiaryId: GenerateDiaryId): string {
  try {
    const id = generateDiaryId()
    if (!isCanonicalLowercaseUuid(id)) {
      throw new DiaryApplicationError('UNAVAILABLE')
    }
    return id
  } catch (error: unknown) {
    if (error instanceof DiaryApplicationError) {
      throw error
    }
    throw new DiaryApplicationError('UNAVAILABLE')
  }
}

function readNowMs(nowMs: NowMs): number {
  try {
    const value = nowMs()
    if (!isNonNegativeSafeIntegerMilliseconds(value)) {
      throw new DiaryApplicationError('UNAVAILABLE')
    }
    return value
  } catch (error: unknown) {
    if (error instanceof DiaryApplicationError) {
      throw error
    }
    throw new DiaryApplicationError('UNAVAILABLE')
  }
}

function readToday(today: TodayDiaryDate): DiaryDate {
  try {
    const value = today()
    if (!isValidLocalDate(value)) {
      throw new DiaryApplicationError('UNAVAILABLE')
    }
    return value
  } catch (error: unknown) {
    if (error instanceof DiaryApplicationError) {
      throw error
    }
    throw new DiaryApplicationError('UNAVAILABLE')
  }
}

function mapRepositoryError(error: unknown): DiaryApplicationError {
  if (!(error instanceof DiaryRepositoryError)) {
    return new DiaryApplicationError('UNAVAILABLE')
  }

  switch (error.code) {
    case 'NOT_FOUND':
      return new DiaryApplicationError('NOT_FOUND')
    case 'DIARY_DATE_CONFLICT':
      return new DiaryApplicationError('CONFLICT')
    case 'INVALID_ID':
    case 'INVALID_TITLE':
    case 'INVALID_DIARY_DATE':
    case 'PERSISTENCE_ERROR':
      return new DiaryApplicationError('UNAVAILABLE')
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    throw mapRepositoryError(error)
  }
}

/**
 * Diary application service (V1). Mirrors the Note application service in
 * shape: small injected function dependencies, a service-owned clock and
 * today, and an application error boundary that hides repository codes.
 *
 * The service owns mutation timestamps (nowMs) and the mutation-date business
 * rule (today): a diary entry may never be created or moved into the future of
 * the local calendar. Read methods never call nowMs or today.
 */
export function createDiaryService({
  repository,
  generateDiaryId = defaultGenerateDiaryId,
  nowMs = defaultNowMs,
  today = defaultToday,
}: CreateDiaryServiceOptions) {
  return {
    async createDiaryEntry(input: {
      readonly diaryDate: DiaryDate
      readonly title: string
      readonly content: string
    }): Promise<DiaryEntry> {
      const title = readText(input.title, 'title')
      const content = readText(input.content, 'content')
      if (!isValidLocalDate(input.diaryDate)) {
        throw new DiaryApplicationError('VALIDATION', 'diaryDate')
      }
      const todayValue = readToday(today)
      if (input.diaryDate > todayValue) {
        throw new DiaryApplicationError('VALIDATION', 'diaryDate')
      }
      const id = readGeneratedDiaryId(generateDiaryId)
      const createdAtMs = readNowMs(nowMs)
      const createInput: CreateDiaryEntryInput = {
        id,
        diaryDate: input.diaryDate,
        title,
        content,
        createdAtMs,
      }
      return callRepository(() => repository.create(createInput))
    },

    async getActiveById(id: string): Promise<DiaryEntry | null> {
      validatePublicId(id)
      return callRepository(() => repository.getActiveById(id))
    },

    async getActiveByDiaryDate(diaryDate: DiaryDate): Promise<DiaryEntry | null> {
      if (!isValidLocalDate(diaryDate)) {
        throw new DiaryApplicationError('VALIDATION', 'diaryDate')
      }
      return callRepository(() => repository.getActiveByDiaryDate(diaryDate))
    },

    listActive(): Promise<DiaryEntry[]> {
      return callRepository(() => repository.listActive())
    },

    async updateDiaryEntry(input: {
      readonly id: string
      readonly title: string
      readonly content: string
    }): Promise<DiaryEntry> {
      validatePublicId(input.id)
      const title = readText(input.title, 'title')
      const content = readText(input.content, 'content')
      const updatedAtMs = readNowMs(nowMs)
      const updateInput: UpdateDiaryEntryInput = {
        id: input.id,
        title,
        content,
        updatedAtMs,
      }
      return callRepository(() => repository.updateDiaryEntry(updateInput))
    },

    async changeDiaryDate(input: {
      readonly id: string
      readonly diaryDate: DiaryDate
    }): Promise<DiaryEntry> {
      validatePublicId(input.id)
      if (!isValidLocalDate(input.diaryDate)) {
        throw new DiaryApplicationError('VALIDATION', 'diaryDate')
      }
      const todayValue = readToday(today)
      if (input.diaryDate > todayValue) {
        throw new DiaryApplicationError('VALIDATION', 'diaryDate')
      }
      const updatedAtMs = readNowMs(nowMs)
      const changeInput: ChangeDiaryDateInput = {
        id: input.id,
        diaryDate: input.diaryDate,
        updatedAtMs,
      }
      return callRepository(() => repository.changeDiaryDate(changeInput))
    },

    async softDelete(id: string): Promise<void> {
      validatePublicId(id)
      const updatedAtMs = readNowMs(nowMs)
      const softDeleteInput: SoftDeleteDiaryEntryInput = { id, updatedAtMs }
      await callRepository(() => repository.softDelete(softDeleteInput))
    },

    async restore(id: string): Promise<void> {
      validatePublicId(id)
      const updatedAtMs = readNowMs(nowMs)
      const restoreInput: RestoreDiaryEntryInput = { id, updatedAtMs }
      await callRepository(() => repository.restore(restoreInput))
    },
  }
}

export type DiaryService = ReturnType<typeof createDiaryService>
