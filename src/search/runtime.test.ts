import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { SearchResult } from '@/search/model'
import { openSearchRuntime as openWebSearchRuntime } from '@/search/runtime'
import { openSearchRuntime as openNativeSearchRuntime } from '@/search/runtime.native'

const nativeSearchRepository = vi.hoisted(() => vi.fn())
const openWebTaskRepository = vi.hoisted(() => vi.fn())

vi.mock('@/adapters/native', () => ({
  NativeSearchRepository: nativeSearchRepository,
}))

vi.mock('@/adapters/web', () => ({
  openWebTaskRepository,
}))

function webPersistenceResult() {
  const searchRepository = {
    query: vi.fn((): Promise<SearchResult[]> => Promise.resolve([])),
  }
  const dispose = vi.fn(() => Promise.resolve())
  return { searchRepository, dispose }
}

beforeEach(() => {
  nativeSearchRepository.mockClear()
  openWebTaskRepository.mockReset()
})

describe('search runtime', () => {
  test('native runtime builds the service on NativeSearchRepository', async () => {
    const runtime = await openNativeSearchRuntime()

    expect(nativeSearchRepository).toHaveBeenCalledTimes(1)
    expect(openWebTaskRepository).not.toHaveBeenCalled()
    expect(typeof runtime.service.search).toBe('function')
  })

  test('web runtime joins the existing shared web persistence generation', async () => {
    const { searchRepository, dispose } = webPersistenceResult()
    openWebTaskRepository.mockResolvedValue({
      capability: { status: 'AVAILABLE' },
      searchRepository,
      dispose,
    })

    const runtime = await openWebSearchRuntime()

    // Called without options: the default semantic open joins the one shared
    // generation instead of creating a second Web persistence instance.
    expect(openWebTaskRepository).toHaveBeenCalledTimes(1)
    expect(openWebTaskRepository).toHaveBeenCalledWith()
    expect(nativeSearchRepository).not.toHaveBeenCalled()
    await runtime.dispose()
    expect(dispose).toHaveBeenCalledOnce()
  })

  test('web runtime wires the shared search repository into the service', async () => {
    const { searchRepository, dispose } = webPersistenceResult()
    openWebTaskRepository.mockResolvedValue({
      capability: { status: 'AVAILABLE' },
      searchRepository,
      dispose,
    })

    const runtime = await openWebSearchRuntime()
    await runtime.service.search('  任务  ')

    expect(searchRepository.query).toHaveBeenCalledWith({
      query: '任务',
      limit: 50,
    })
  })

  test('web runtime maps an unavailable persistence capability to UNAVAILABLE', async () => {
    openWebTaskRepository.mockResolvedValue({
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    })

    await expect(openWebSearchRuntime()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })

  test('web runtime maps a persistence failure to UNAVAILABLE', async () => {
    openWebTaskRepository.mockRejectedValue(new Error('worker unavailable'))

    await expect(openWebSearchRuntime()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
    })
  })
})
