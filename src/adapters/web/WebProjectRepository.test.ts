import { WebProjectRepository } from './WebProjectRepository'
import { TaskWorkerClient, type TaskWorkerEndpoint } from './taskWorkerClient'
import type {
  TaskWorkerRequest,
  TaskWorkerResponse,
} from './taskWorkerProtocol'
import { ProjectRepositoryError } from '@/project/repository'
import {
  defineProjectRepositoryContract,
  ProjectContractBackend,
} from '@/test/projectRepositoryContract'

class ProjectWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  constructor(readonly backend: ProjectContractBackend) {}
  postMessage(request: TaskWorkerRequest): void {
    try {
      let result: unknown
      if (request.type === 'project.create')
        result = this.backend.createProject(request.input)
      else if (request.type === 'project.list')
        result = this.backend.listProjects()
      else if (request.type === 'project.rename')
        result = this.backend.renameProject(request.input)
      else throw new Error(`Unexpected request ${request.type}`)
      this.respond({ requestId: request.requestId, ok: true, result })
    } catch (error: unknown) {
      if (error instanceof ProjectRepositoryError)
        this.respond({
          requestId: request.requestId,
          ok: false,
          error: { code: error.code },
        })
      else throw error
    }
  }
  terminate(): void {}
  private respond(response: TaskWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }
}

defineProjectRepositoryContract('WebProjectRepository', () => {
  const backend = new ProjectContractBackend()
  return {
    repository: new WebProjectRepository(
      new TaskWorkerClient(new ProjectWorker(backend)),
    ),
    backend,
  }
})
