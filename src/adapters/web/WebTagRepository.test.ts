import { WebTagRepository } from './WebTagRepository'
import { TaskWorkerClient, type TaskWorkerEndpoint } from './taskWorkerClient'
import type { TaskWorkerRequest, TaskWorkerResponse } from './taskWorkerProtocol'
import { TagRepositoryError } from '@/tag/repository'
import {
  defineTagRepositoryContract,
  TagContractBackend,
} from '@/test/tagRepositoryContract'

class TagWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  constructor(readonly backend: TagContractBackend) {}
  postMessage(request: TaskWorkerRequest): void {
    try {
      let result: unknown
      if (request.type === 'tag.create')
        result = this.backend.createTag(request.input)
      else if (request.type === 'tag.list') result = this.backend.listTags()
      else if (request.type === 'tag.rename')
        result = this.backend.renameTag(request.input)
      else throw new Error(`Unexpected request ${request.type}`)
      this.onmessage?.(
        new MessageEvent('message', {
          data: { requestId: request.requestId, ok: true, result } satisfies TaskWorkerResponse,
        }),
      )
    } catch (error: unknown) {
      if (!(error instanceof TagRepositoryError)) throw error
      this.onmessage?.(
        new MessageEvent('message', {
          data: {
            requestId: request.requestId,
            ok: false,
            error: { code: error.code },
          } satisfies TaskWorkerResponse,
        }),
      )
    }
  }
  terminate(): void {}
}

defineTagRepositoryContract('WebTagRepository', () => {
  const backend = new TagContractBackend()
  return {
    repository: new WebTagRepository(new TaskWorkerClient(new TagWorker(backend))),
    backend,
  }
})
