import { describe, expect, test, vi } from 'vitest'

import {
  ProjectRepositoryError,
  type CreateProjectInput,
  type ProjectRepository,
  type RenameProjectInput,
} from '@/project/repository'
import {
  createProjectService,
  ProjectApplicationError,
} from '@/project/service'

const ID = '00000000-0000-4000-8000-000000000101'
function fixture() {
  const createProject = vi.fn((input: CreateProjectInput) =>
    Promise.resolve({ ...input, updatedAtMs: input.createdAtMs }),
  )
  const listProjects = vi.fn(() => Promise.resolve([]))
  const renameProject = vi.fn((input: RenameProjectInput) =>
    Promise.resolve({ ...input, createdAtMs: 10 }),
  )
  const repository: ProjectRepository = {
    createProject,
    listProjects,
    renameProject,
  }
  return {
    repository,
    createProject,
    renameProject,
    service: createProjectService({
      repository,
      generateProjectId: () => ID,
      nowMs: () => 20,
    }),
  }
}

describe('ProjectService', () => {
  test('trims names and owns canonical id and millisecond timestamp', async () => {
    const { createProject, renameProject, service } = fixture()
    await service.createProject('  Work  ')
    expect(createProject).toHaveBeenCalledWith({
      id: ID,
      name: 'Work',
      createdAtMs: 20,
    })
    await service.renameProject(ID, '  工作  ')
    expect(renameProject).toHaveBeenCalledWith({
      id: ID,
      name: '工作',
      updatedAtMs: 20,
    })
  })
  test('rejects blank name before persistence', async () => {
    const { createProject, service } = fixture()
    await expect(service.createProject('   ')).rejects.toEqual(
      new ProjectApplicationError('VALIDATION', 'name'),
    )
    expect(createProject).not.toHaveBeenCalled()
  })
  test('maps repository failures to safe application errors', async () => {
    const { renameProject, service } = fixture()
    renameProject.mockRejectedValueOnce(
      new ProjectRepositoryError('NOT_FOUND', 'renameProject'),
    )
    await expect(service.renameProject(ID, 'Work')).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })
})
