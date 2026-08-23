import { describe, expect, test } from 'vitest'

import type { Tag } from '@/tag/model'
import {
  TagRepositoryError,
  type CreateTagInput,
  type RenameTagInput,
  type TagRepository,
} from '@/tag/repository'

export const TAG_IDS = {
  a: '00000000-0000-4000-8000-000000000101',
  b: '00000000-0000-4000-8000-000000000102',
  missing: '00000000-0000-4000-8000-000000000199',
} as const

export class TagContractBackend {
  readonly #tags = new Map<string, Tag>()

  createTag(input: CreateTagInput): Tag {
    if (
      this.#tags.has(input.id) ||
      [...this.#tags.values()].some((tag) => tag.name === input.name)
    ) {
      throw new TagRepositoryError('PERSISTENCE_FAILED', 'createTag')
    }
    const tag = {
      id: input.id,
      name: input.name,
      createdAtMs: input.createdAtMs,
      updatedAtMs: input.createdAtMs,
    }
    this.#tags.set(tag.id, tag)
    return { ...tag }
  }

  listTags(): readonly Tag[] {
    return [...this.#tags.values()]
      .sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id))
      .map((tag) => ({ ...tag }))
  }

  renameTag(input: RenameTagInput): Tag {
    const current = this.#tags.get(input.id)
    if (current === undefined) {
      throw new TagRepositoryError('NOT_FOUND', 'renameTag')
    }
    if (
      [...this.#tags.values()].some(
        (tag) => tag.id !== input.id && tag.name === input.name,
      )
    ) {
      throw new TagRepositoryError('PERSISTENCE_FAILED', 'renameTag')
    }
    const renamed = { ...current, name: input.name, updatedAtMs: input.updatedAtMs }
    this.#tags.set(input.id, renamed)
    return { ...renamed }
  }
}

export function defineTagRepositoryContract(
  name: string,
  createFixture: () => {
    readonly repository: TagRepository
    readonly backend: TagContractBackend
  },
): void {
  describe(`${name} Tag parity contract`, () => {
    test('creates, lists, renames, and preserves case-sensitive names', async () => {
      const { repository } = createFixture()
      await repository.createTag({ id: TAG_IDS.a, name: 'Work', createdAtMs: 10 })
      await repository.createTag({ id: TAG_IDS.b, name: 'work', createdAtMs: 20 })
      await expect(repository.listTags()).resolves.toMatchObject([
        { id: TAG_IDS.b, name: 'work' },
        { id: TAG_IDS.a, name: 'Work' },
      ])
      await expect(
        repository.renameTag({ id: TAG_IDS.a, name: 'Home', updatedAtMs: 30 }),
      ).resolves.toMatchObject({ name: 'Home', updatedAtMs: 30 })
    })

    test('rejects exact duplicate names and maps missing rename safely', async () => {
      const { repository } = createFixture()
      await repository.createTag({ id: TAG_IDS.a, name: 'Work', createdAtMs: 10 })
      await expect(
        repository.createTag({ id: TAG_IDS.b, name: 'Work', createdAtMs: 20 }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await expect(
        repository.renameTag({
          id: TAG_IDS.missing,
          name: 'Missing',
          updatedAtMs: 30,
        }),
      ).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'renameTag' })
    })

    test('fails closed on invalid id and blank or untrimmed names', async () => {
      const { repository } = createFixture()
      for (const name of ['', '   ', ' Work ']) {
        await expect(
          repository.createTag({ id: TAG_IDS.a, name, createdAtMs: 10 }),
        ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      }
      await expect(
        repository.createTag({ id: 'INVALID', name: 'Work', createdAtMs: 10 }),
      ).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
    })
  })
}
