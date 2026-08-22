import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatusOperation,
} from '@/task/model'
import {
  isTaskRepositoryErrorCode,
  type ChangeTaskStatusInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type TaskRepositoryErrorCode,
} from '@/task/repository'

export type WebPersistenceCapability =
  | { readonly status: 'AVAILABLE' }
  | {
      readonly status: 'UNAVAILABLE'
      readonly reason:
        'WORKER_UNSUPPORTED' | 'OPFS_UNSUPPORTED' | 'INITIALIZATION_FAILED'
    }
  | {
      readonly status: 'RESTRICTED'
      readonly reason: 'CROSS_ORIGIN_ISOLATION_REQUIRED' | 'SECURITY_POLICY'
    }

export type TaskWorkerRequest =
  | { readonly requestId: number; readonly type: 'initialize' }
  | {
      readonly requestId: number
      readonly type: 'task.create'
      readonly input: CreateTaskInput
    }
  | { readonly requestId: number; readonly type: 'task.list' }
  | {
      readonly requestId: number
      readonly type: 'task.rename'
      readonly input: RenameTaskInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.changeStatus'
      readonly input: ChangeTaskStatusInput
    }
  | { readonly requestId: number; readonly type: 'shutdown' }

export interface TaskWorkerSuccessResponse {
  readonly requestId: number
  readonly ok: true
  readonly result: unknown
}

export interface TaskWorkerErrorResponse {
  readonly requestId: number
  readonly ok: false
  readonly error: {
    readonly code: TaskRepositoryErrorCode
  }
}

export type TaskWorkerResponse =
  TaskWorkerSuccessResponse | TaskWorkerErrorResponse

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value > 0
}

function isCreateInput(value: unknown): value is CreateTaskInput {
  if (!isRecord(value)) {
    return false
  }
  return (
    isCanonicalLowercaseUuid(value.id) &&
    isNonEmptyTaskTitle(value.title) &&
    isNonNegativeSafeIntegerMilliseconds(value.createdAtMs)
  )
}

function isRenameInput(value: unknown): value is RenameTaskInput {
  if (!isRecord(value)) {
    return false
  }
  return (
    isCanonicalLowercaseUuid(value.id) &&
    isNonEmptyTaskTitle(value.title) &&
    isNonNegativeSafeIntegerMilliseconds(value.updatedAtMs)
  )
}

function isChangeStatusInput(value: unknown): value is ChangeTaskStatusInput {
  if (!isRecord(value)) {
    return false
  }
  return (
    isCanonicalLowercaseUuid(value.id) &&
    isTaskStatusOperation(value.operation) &&
    isNonNegativeSafeIntegerMilliseconds(value.updatedAtMs)
  )
}

export function parseTaskWorkerRequest(
  value: unknown,
): TaskWorkerRequest | null {
  if (!isRecord(value) || !isRequestId(value.requestId)) {
    return null
  }

  switch (value.type) {
    case 'initialize':
    case 'task.list':
    case 'shutdown':
      return { requestId: value.requestId, type: value.type }
    case 'task.create':
      return isCreateInput(value.input)
        ? { requestId: value.requestId, type: value.type, input: value.input }
        : null
    case 'task.rename':
      return isRenameInput(value.input)
        ? { requestId: value.requestId, type: value.type, input: value.input }
        : null
    case 'task.changeStatus':
      return isChangeStatusInput(value.input)
        ? { requestId: value.requestId, type: value.type, input: value.input }
        : null
    default:
      return null
  }
}

export function extractRequestId(value: unknown): number | null {
  return isRecord(value) && isRequestId(value.requestId)
    ? value.requestId
    : null
}

export function parseTaskWorkerResponse(
  value: unknown,
): TaskWorkerResponse | null {
  if (
    !isRecord(value) ||
    !isRequestId(value.requestId) ||
    typeof value.ok !== 'boolean'
  ) {
    return null
  }

  if (value.ok) {
    if (!('result' in value)) {
      return null
    }
    return {
      requestId: value.requestId,
      ok: true,
      result: value.result,
    }
  }

  if (!isRecord(value.error) || !isTaskRepositoryErrorCode(value.error.code)) {
    return null
  }

  return {
    requestId: value.requestId,
    ok: false,
    error: { code: value.error.code },
  }
}

export function parseWebPersistenceCapability(
  value: unknown,
): WebPersistenceCapability | null {
  if (!isRecord(value)) {
    return null
  }

  if (value.status === 'AVAILABLE') {
    return { status: 'AVAILABLE' }
  }
  if (
    value.status === 'UNAVAILABLE' &&
    (value.reason === 'WORKER_UNSUPPORTED' ||
      value.reason === 'OPFS_UNSUPPORTED' ||
      value.reason === 'INITIALIZATION_FAILED')
  ) {
    return { status: value.status, reason: value.reason }
  }
  if (
    value.status === 'RESTRICTED' &&
    (value.reason === 'CROSS_ORIGIN_ISOLATION_REQUIRED' ||
      value.reason === 'SECURITY_POLICY')
  ) {
    return { status: value.status, reason: value.reason }
  }
  return null
}
