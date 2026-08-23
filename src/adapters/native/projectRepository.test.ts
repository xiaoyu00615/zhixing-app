import { beforeEach, vi } from 'vitest'

import { NativeProjectRepository } from './projectRepository'
import type {
  CreateProjectInput,
  RenameProjectInput,
} from '@/project/repository'
import {
  defineProjectRepositoryContract,
  ProjectContractBackend,
} from '@/test/projectRepositoryContract'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

beforeEach(() => {
  invokeMock.mockReset()
})

defineProjectRepositoryContract('NativeProjectRepository', () => {
  const backend = new ProjectContractBackend()
  invokeMock.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === 'project_create')
        return backend.createProject(args?.input as CreateProjectInput)
      if (command === 'project_list') return backend.listProjects()
      if (command === 'project_rename')
        return backend.renameProject(args?.input as RenameProjectInput)
      throw new Error(`Unexpected command ${command}`)
    },
  )
  return { repository: new NativeProjectRepository(), backend }
})
