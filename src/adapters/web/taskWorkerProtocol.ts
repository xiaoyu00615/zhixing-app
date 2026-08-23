import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatusOperation,
  isValidLocalDate,
} from '@/task/model'
import {
  isTaskRepositoryErrorCode,
  type ChangeTaskStatusInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type RestoreTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
  type TaskRepositoryErrorCode,
  type TrashTaskInput,
} from '@/task/repository'
import type {
  CreateProjectInput,
  RenameProjectInput,
} from '@/project/repository'
import { isNonEmptyTagName } from '@/tag/model'
import type { CreateTagInput, RenameTagInput } from '@/tag/repository'

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
  | { readonly requestId: number; readonly type: 'task.listTrashed' }
  | {
      readonly requestId: number
      readonly type: 'task.trash'
      readonly input: TrashTaskInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.restore'
      readonly input: RestoreTaskInput
    }
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
  | {
      readonly requestId: number
      readonly type: 'task.setImportance'
      readonly input: SetTaskImportanceInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.setUrgency'
      readonly input: SetTaskUrgencyInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.setDeadline'
      readonly input: SetTaskDeadlineInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.clearDeadline'
      readonly input: ClearTaskDeadlineInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.setProject'
      readonly input: import('@/task/repository').SetTaskProjectInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.clearProject'
      readonly input: import('@/task/repository').ClearTaskProjectInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.addTag'
      readonly input: import('@/task/repository').AddTaskTagInput
    }
  | {
      readonly requestId: number
      readonly type: 'task.removeTag'
      readonly input: import('@/task/repository').RemoveTaskTagInput
    }
  | {
      readonly requestId: number
      readonly type: 'project.create'
      readonly input: CreateProjectInput
    }
  | { readonly requestId: number; readonly type: 'project.list' }
  | {
      readonly requestId: number
      readonly type: 'project.rename'
      readonly input: RenameProjectInput
    }
  | {
      readonly requestId: number
      readonly type: 'tag.create'
      readonly input: CreateTagInput
    }
  | { readonly requestId: number; readonly type: 'tag.list' }
  | {
      readonly requestId: number
      readonly type: 'tag.rename'
      readonly input: RenameTagInput
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
    isNonNegativeSafeIntegerMilliseconds(value.createdAtMs) &&
    (value.isImportant === undefined ||
      typeof value.isImportant === 'boolean') &&
    (value.isUrgent === undefined || typeof value.isUrgent === 'boolean') &&
    (value.dueDate === undefined ||
      value.dueDate === null ||
      isValidLocalDate(value.dueDate)) &&
    (value.projectId === undefined ||
      value.projectId === null ||
      isCanonicalLowercaseUuid(value.projectId)) &&
    (value.tagIds === undefined ||
      (Array.isArray(value.tagIds) &&
        value.tagIds.every(isCanonicalLowercaseUuid) &&
        new Set(value.tagIds).size === value.tagIds.length))
  )
}

function isTagInput(
  value: unknown,
  withCreatedAt: boolean,
): value is CreateTagInput | RenameTagInput {
  return (
    isRecord(value) &&
    isCanonicalLowercaseUuid(value.id) &&
    isNonEmptyTagName(value.name) &&
    (withCreatedAt
      ? isNonNegativeSafeIntegerMilliseconds(value.createdAtMs)
      : isNonNegativeSafeIntegerMilliseconds(value.updatedAtMs))
  )
}

function isProjectInput(
  value: unknown,
  withCreatedAt: boolean,
): value is CreateProjectInput | RenameProjectInput {
  return (
    isRecord(value) &&
    isCanonicalLowercaseUuid(value.id) &&
    isNonEmptyTaskTitle(value.name) &&
    (withCreatedAt
      ? isNonNegativeSafeIntegerMilliseconds(value.createdAtMs)
      : isNonNegativeSafeIntegerMilliseconds(value.updatedAtMs))
  )
}

function isPlanningBaseInput(value: unknown): value is Record<
  string,
  unknown
> & {
  readonly id: string
  readonly updatedAtMs: number
} {
  return (
    isRecord(value) &&
    isCanonicalLowercaseUuid(value.id) &&
    isNonNegativeSafeIntegerMilliseconds(value.updatedAtMs)
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
    case 'task.listTrashed':
    case 'project.list':
    case 'tag.list':
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
    case 'task.setImportance':
      return isPlanningBaseInput(value.input) &&
        typeof value.input.isImportant === 'boolean'
        ? {
            requestId: value.requestId,
            type: value.type,
            input: {
              id: value.input.id,
              isImportant: value.input.isImportant,
              updatedAtMs: value.input.updatedAtMs,
            },
          }
        : null
    case 'task.setUrgency':
      return isPlanningBaseInput(value.input) &&
        typeof value.input.isUrgent === 'boolean'
        ? {
            requestId: value.requestId,
            type: value.type,
            input: {
              id: value.input.id,
              isUrgent: value.input.isUrgent,
              updatedAtMs: value.input.updatedAtMs,
            },
          }
        : null
    case 'task.setDeadline':
      return isPlanningBaseInput(value.input) &&
        isValidLocalDate(value.input.dueDate)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: {
              id: value.input.id,
              dueDate: value.input.dueDate,
              updatedAtMs: value.input.updatedAtMs,
            },
          }
        : null
    case 'task.clearDeadline':
    case 'task.trash':
    case 'task.restore':
      return isPlanningBaseInput(value.input)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: {
              id: value.input.id,
              updatedAtMs: value.input.updatedAtMs,
            },
          }
        : null
    case 'task.setProject':
      return isPlanningBaseInput(value.input) &&
        isCanonicalLowercaseUuid(value.input.projectId)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: {
              id: value.input.id,
              projectId: value.input.projectId,
              updatedAtMs: value.input.updatedAtMs,
            },
          }
        : null
    case 'task.clearProject':
      return isPlanningBaseInput(value.input)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: { id: value.input.id, updatedAtMs: value.input.updatedAtMs },
          }
        : null
    case 'task.addTag':
    case 'task.removeTag':
      return isPlanningBaseInput(value.input) &&
        isCanonicalLowercaseUuid(value.input.tagId)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: {
              id: value.input.id,
              tagId: value.input.tagId,
              updatedAtMs: value.input.updatedAtMs,
            },
          }
        : null
    case 'project.create':
      return isProjectInput(value.input, true)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: value.input as CreateProjectInput,
          }
        : null
    case 'project.rename':
      return isProjectInput(value.input, false)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: value.input as RenameProjectInput,
          }
        : null
    case 'tag.create':
      return isTagInput(value.input, true)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: value.input as CreateTagInput,
          }
        : null
    case 'tag.rename':
      return isTagInput(value.input, false)
        ? {
            requestId: value.requestId,
            type: value.type,
            input: value.input as RenameTagInput,
          }
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
