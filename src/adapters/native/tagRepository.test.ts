import { beforeEach, vi } from 'vitest'

import { NativeTagRepository } from './tagRepository'
import type { CreateTagInput, RenameTagInput } from '@/tag/repository'
import {
  defineTagRepositoryContract,
  TagContractBackend,
} from '@/test/tagRepositoryContract'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))

beforeEach(() => {
  invokeMock.mockReset()
})

defineTagRepositoryContract('NativeTagRepository', () => {
  const backend = new TagContractBackend()
  invokeMock.mockImplementation(
    (command: string, args?: Record<string, unknown>) => {
      if (command === 'tag_create')
        return backend.createTag(args?.input as CreateTagInput)
      if (command === 'tag_list') return backend.listTags()
      if (command === 'tag_rename')
        return backend.renameTag(args?.input as RenameTagInput)
      throw new Error(`Unexpected command ${command}`)
    },
  )
  return { repository: new NativeTagRepository(), backend }
})
