import { isNonEmptyProjectName, type Project } from '@/project/model'
import {
  ProjectRepositoryError,
  type CreateProjectInput,
  type ProjectRepository,
  type ProjectRepositoryOperation,
  type RenameProjectInput,
} from '@/project/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/task/model'
import { TaskWorkerClient, TaskWorkerClientError } from './taskWorkerClient'

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
  )
    throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
  return { id, name, createdAtMs, updatedAtMs }
}
function validate(
  input: {
    id: string
    name?: string
    createdAtMs?: number
    updatedAtMs?: number
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
  )
    throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
}
function map(
  error: unknown,
  operation: ProjectRepositoryOperation,
): ProjectRepositoryError {
  if (error instanceof ProjectRepositoryError) return error
  if (error instanceof TaskWorkerClientError)
    return new ProjectRepositoryError(
      error.code === 'STATUS_CONFLICT' ? 'PERSISTENCE_FAILED' : error.code,
      operation,
    )
  return new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
}
export class WebProjectRepository implements ProjectRepository {
  readonly #client: TaskWorkerClient
  constructor(client: TaskWorkerClient) {
    this.#client = client
  }
  async createProject(input: CreateProjectInput): Promise<Project> {
    const operation = 'createProject'
    validate(input, operation)
    try {
      return parseProject(await this.#client.createProject(input), operation)
    } catch (error) {
      throw map(error, operation)
    }
  }
  async listProjects(): Promise<readonly Project[]> {
    const operation = 'listProjects'
    try {
      const value = await this.#client.listProjects()
      if (!Array.isArray(value))
        throw new ProjectRepositoryError('PERSISTENCE_FAILED', operation)
      return value.map((project) => parseProject(project, operation))
    } catch (error) {
      throw map(error, operation)
    }
  }
  async renameProject(input: RenameProjectInput): Promise<Project> {
    const operation = 'renameProject'
    validate(input, operation)
    try {
      return parseProject(await this.#client.renameProject(input), operation)
    } catch (error) {
      throw map(error, operation)
    }
  }
}
