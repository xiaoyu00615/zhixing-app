import { describe, expect, test } from 'vitest'

import type { Project } from '@/project/model'
import {
  ProjectRepositoryError,
  type CreateProjectInput,
  type ProjectRepository,
  type RenameProjectInput,
} from '@/project/repository'

export const PROJECT_IDS = {
  a: '00000000-0000-4000-8000-000000000101',
  b: '00000000-0000-4000-8000-000000000102',
  missing: '00000000-0000-4000-8000-000000000199',
} as const

export class ProjectContractBackend {
  readonly #projects = new Map<string, Project>()
  createProject(input: CreateProjectInput): Project {
    if (this.#projects.has(input.id))
      throw new ProjectRepositoryError('PERSISTENCE_FAILED', 'createProject')
    const project = {
      id: input.id,
      name: input.name,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
    }
    this.#projects.set(project.id, project)
    return { ...project }
  }
  listProjects(): readonly Project[] {
    return [...this.#projects.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))
      .map((project) => ({ ...project }))
  }
  renameProject(input: RenameProjectInput): Project {
    const current = this.#projects.get(input.id)
    if (current === undefined)
      throw new ProjectRepositoryError('NOT_FOUND', 'renameProject')
    const renamed = {
      ...current,
      name: input.name,
      updatedAtMs: input.updatedAtMs,
    }
    this.#projects.set(input.id, renamed)
    return { ...renamed }
  }
}

export interface ProjectRepositoryContractFixture {
  readonly repository: ProjectRepository
  readonly backend: ProjectContractBackend
}

export function defineProjectRepositoryContract(
  name: string,
  createFixture: () => ProjectRepositoryContractFixture,
): void {
  describe(`${name} Project parity contract`, () => {
    test('creates, lists, and renames with stable ordering', async () => {
      const { repository } = createFixture()
      await repository.createProject({
        id: PROJECT_IDS.a,
        name: 'Work',
        createdAtMs: 10,
      })
      await repository.createProject({
        id: PROJECT_IDS.b,
        name: 'Home',
        createdAtMs: 20,
      })
      await expect(repository.listProjects()).resolves.toMatchObject([
        { id: PROJECT_IDS.b },
        { id: PROJECT_IDS.a },
      ])
      await expect(
        repository.renameProject({
          id: PROJECT_IDS.a,
          name: '工作',
          updatedAtMs: 30,
        }),
      ).resolves.toMatchObject({ name: '工作', updatedAtMs: 30 })
    })
    test('maps missing project rename to NOT_FOUND', async () => {
      const { repository } = createFixture()
      await expect(
        repository.renameProject({
          id: PROJECT_IDS.missing,
          name: 'Missing',
          updatedAtMs: 10,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'renameProject' })
    })
    test('fails closed on invalid project input', async () => {
      const { repository } = createFixture()
      await expect(
        repository.createProject({
          id: 'INVALID',
          name: 'Work',
          createdAtMs: 10,
        }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await expect(
        repository.createProject({
          id: PROJECT_IDS.a,
          name: '   ',
          createdAtMs: 10,
        }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    })
  })
}
