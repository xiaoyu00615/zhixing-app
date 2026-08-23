import { describe, expect, test, vi } from 'vitest'

import { TagRepositoryError, type TagRepository } from '@/tag/repository'
import { createTagService, TagApplicationError } from '@/tag/service'

const ID = '00000000-0000-4000-8000-000000000101'

function fixture() {
  const createTag = vi.fn<TagRepository['createTag']>()
  createTag.mockImplementation((input) =>
    Promise.resolve({ ...input, updatedAtMs: input.createdAtMs }),
  )
  const listTags = vi.fn<TagRepository['listTags']>()
  listTags.mockResolvedValue([])
  const renameTag = vi.fn<TagRepository['renameTag']>()
  renameTag.mockImplementation((input) =>
    Promise.resolve({ ...input, createdAtMs: 10 }),
  )
  const repository: TagRepository = {
    createTag,
    listTags,
    renameTag,
  }
  return {
    repository,
    service: createTagService({
      repository,
      generateTagId: () => ID,
      nowMs: () => 20,
    }),
    createTag,
    listTags,
    renameTag,
  }
}

describe('TagService', () => {
  test('trims names and owns UUID and timestamps', async () => {
    const { service, createTag, renameTag } = fixture()
    await service.createTag('  Work  ')
    expect(createTag).toHaveBeenCalledWith({
      id: ID,
      name: 'Work',
      createdAtMs: 20,
    })
    await service.renameTag(ID, '  Home  ')
    expect(renameTag).toHaveBeenCalledWith({
      id: ID,
      name: 'Home',
      updatedAtMs: 20,
    })
  })

  test('rejects blank names and invalid ids before persistence', async () => {
    const { service, createTag, renameTag } = fixture()
    await expect(service.createTag('   ')).rejects.toEqual(
      new TagApplicationError('VALIDATION', 'name'),
    )
    await expect(service.renameTag('INVALID', 'Work')).rejects.toEqual(
      new TagApplicationError('VALIDATION', 'id'),
    )
    expect(createTag).not.toHaveBeenCalled()
    expect(renameTag).not.toHaveBeenCalled()
  })

  test('maps missing and persistence failures to the narrow public errors', async () => {
    const { service, renameTag, listTags } = fixture()
    renameTag.mockRejectedValueOnce(
      new TagRepositoryError('NOT_FOUND', 'renameTag'),
    )
    await expect(service.renameTag(ID, 'Work')).rejects.toEqual(
      new TagApplicationError('NOT_FOUND'),
    )
    listTags.mockRejectedValueOnce(new Error('raw SQL'))
    await expect(service.listTags()).rejects.toEqual(
      new TagApplicationError('UNAVAILABLE'),
    )
  })
})
