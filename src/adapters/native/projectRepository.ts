import { invoke } from '@tauri-apps/api/core'

import { isNonEmptyProjectName, type Project } from '@/project/model'
import {
  ProjectRepositoryError,
  isProjectRepositoryErrorCode,
  type CreateProjectInput,
  type ProjectRepository,
  type ProjectRepositoryOperation,
  type RenameProjectInput,
} from '@/project/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/task/model'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseProject(
  value: unknown,
  operation: ProjectRepositoryOperation,
): Project {
  if (!isRecord(value))
    throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
  const { id, name, createdAtMs, updatedAtMs } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyProjectName(name) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return { id, name, createdAtMs, updatedAtMs }
}

function validateInput(
  input: {
    readonly id: string
    readonly name?: string
    readonly createdAtMs?: number
    readonly updatedAtMs?: number
  },
  operation: ProjectRepositoryOperation,
): void {
  if (
    !isCanonicalLowercaseUuid(input.id) ||
    (input.name !== undefined && !isNonEmptyProjectName(input.name)) ||
    (input.createdAtMs !== undefined &&
      !isNonNegativeSafeIntegerMilliseconds(input.createdAtMs)) ||
    (input.updatedAtMs !== undefined &&
      !isNonNegativeSafeIntegerMilliseconds(input.updatedAtMs))
  ) {
    throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

async function call(
  command: string,
  operation: ProjectRepositoryOperation,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(command, args)
  } catch (error: unknown) {
    if (isRecord(error) && isProjectRepositoryErrorCode(error.code))
      throw new ProjectRepositoryError(error.code, operation)
    throw new ProjectRepositoryError('PERSISTENCE_UNAVAILABLE', operation)
  }
}

export class NativeProjectRepository implements ProjectRepository {
  async createProject(input: CreateProjectInput): Promise<Project> {
    const operation = 'createProject'
    validateInput(input, operation)
    return parseProject(
      await call('project_create', operation, { input }),
      operation,
    )
  }
  async listProjects(): Promise<readonly Project[]> {
    const operation = 'listProjects'
    const value = await call('project_list', operation)
    if (!Array.isArray(value))
      throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
    return value.map((project) => parseProject(project, operation))
  }
  async renameProject(input: RenameProjectInput): Promise<Project> {
    const operation = 'renameProject'
    validateInput(input, operation)
    return parseProject(
      await call('project_rename', operation, { input }),
      operation,
    )
  }
}
