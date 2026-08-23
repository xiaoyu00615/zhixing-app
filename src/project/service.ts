import { isNonEmptyProjectName, type Project } from '@/project/model'
import {
  ProjectRepositoryError,
  type ProjectRepository,
} from '@/project/repository'
import {
  isCanonicalLowercaseUuid,
  isNonNegativeSafeIntegerMilliseconds,
} from '@/task/model'

export type ProjectApplicationErrorCode =
  'VALIDATION' | 'NOT_FOUND' | 'UNAVAILABLE'
export type ProjectApplicationErrorField = 'id' | 'name'

export class ProjectApplicationError extends Error {
  readonly code: ProjectApplicationErrorCode
  readonly field?: ProjectApplicationErrorField

  constructor(
    code: ProjectApplicationErrorCode,
    field?: ProjectApplicationErrorField,
  ) {
    super(
      code === 'VALIDATION'
        ? 'Project input is invalid.'
        : code === 'NOT_FOUND'
          ? 'Project not found.'
          : 'Project service is unavailable.',
    )
    this.name = 'ProjectApplicationError'
    this.code = code
    this.field = field
  }
}

interface CreateProjectServiceOptions {
  readonly repository: ProjectRepository
  readonly generateProjectId?: () => string
  readonly nowMs?: () => number
}

function mapRepositoryError(error: unknown): ProjectApplicationError {
  if (!(error instanceof ProjectRepositoryError)) {
    return new ProjectApplicationError('UNAVAILABLE')
  }
  return error.code === 'NOT_FOUND'
    ? new ProjectApplicationError('NOT_FOUND')
    : new ProjectApplicationError('UNAVAILABLE')
}

export function createProjectService({
  repository,
  generateProjectId = () => globalThis.crypto.randomUUID(),
  nowMs = () => Date.now(),
}: CreateProjectServiceOptions) {
  function normalizedName(name: string): string {
    const normalized = name.trim()
    if (!isNonEmptyProjectName(normalized)) {
      throw new ProjectApplicationError('VALIDATION', 'name')
    }
    return normalized
  }

  function validId(id: string): void {
    if (!isCanonicalLowercaseUuid(id)) {
      throw new ProjectApplicationError('VALIDATION', 'id')
    }
  }

  function generatedId(): string {
    try {
      const id = generateProjectId()
      if (!isCanonicalLowercaseUuid(id)) throw new Error()
      return id
    } catch {
      throw new ProjectApplicationError('UNAVAILABLE')
    }
  }

  function timestamp(): number {
    try {
      const value = nowMs()
      if (!isNonNegativeSafeIntegerMilliseconds(value)) throw new Error()
      return value
    } catch {
      throw new ProjectApplicationError('UNAVAILABLE')
    }
  }

  async function call<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation()
    } catch (error: unknown) {
      throw mapRepositoryError(error)
    }
  }

  return {
    async createProject(name: string): Promise<Project> {
      const normalized = normalizedName(name)
      return call(() =>
        repository.createProject({
          id: generatedId(),
          name: normalized,
          createdAtMs: timestamp(),
        }),
      )
    },
    listProjects(): Promise<readonly Project[]> {
      return call(() => repository.listProjects())
    },
    async renameProject(id: string, name: string): Promise<Project> {
      validId(id)
      const normalized = normalizedName(name)
      return call(() =>
        repository.renameProject({
          id,
          name: normalized,
          updatedAtMs: timestamp(),
        }),
      )
    },
  }
}

export type ProjectService = ReturnType<typeof createProjectService>
