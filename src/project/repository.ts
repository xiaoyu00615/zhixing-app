import type { Project } from '@/project/model'

export interface CreateProjectInput {
  readonly id: string
  readonly name: string
  readonly createdAtMs: number
}

export interface RenameProjectInput {
  readonly id: string
  readonly name: string
  readonly updatedAtMs: number
}

export interface ProjectRepository {
  createProject(input: CreateProjectInput): Promise<Project>
  listProjects(): Promise<readonly Project[]>
  renameProject(input: RenameProjectInput): Promise<Project>
}

export const PROJECT_REPOSITORY_ERROR_CODES = [
  'NOT_FOUND',
  'PERSISTENCE_UNAVAILABLE',
  'PERSISTENCE_FAILED',
] as const

export type ProjectRepositoryErrorCode =
  (typeof PROJECT_REPOSITORY_ERROR_CODES)[number]

export type ProjectRepositoryOperation =
  'createProject' | 'listProjects' | 'renameProject'

const SAFE_MESSAGES: Record<ProjectRepositoryErrorCode, string> = {
  NOT_FOUND: 'Project not found.',
  PERSISTENCE_UNAVAILABLE: 'Project persistence is unavailable.',
  PERSISTENCE_FAILED: 'Project persistence operation failed.',
}

export class ProjectRepositoryError extends Error {
  readonly code: ProjectRepositoryErrorCode
  readonly operation: ProjectRepositoryOperation

  constructor(
    code: ProjectRepositoryErrorCode,
    operation: ProjectRepositoryOperation,
  ) {
    super(SAFE_MESSAGES[code])
    this.name = 'ProjectRepositoryError'
    this.code = code
    this.operation = operation
  }
}

export function isProjectRepositoryErrorCode(
  value: unknown,
): value is ProjectRepositoryErrorCode {
  return (
    typeof value === 'string' &&
    PROJECT_REPOSITORY_ERROR_CODES.some((code) => code === value)
  )
}
