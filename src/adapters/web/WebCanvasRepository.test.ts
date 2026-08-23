import { WebCanvasRepository } from './WebCanvasRepository'
import { TaskWorkerClient, type TaskWorkerEndpoint } from './taskWorkerClient'
import type { TaskWorkerRequest, TaskWorkerResponse } from './taskWorkerProtocol'
import { CanvasRepositoryError } from '@/canvas/repository'
import { CanvasContractBackend, defineCanvasRepositoryContract } from '@/test/canvasRepositoryContract'

class CanvasWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  constructor(readonly backend: CanvasContractBackend) {}
  postMessage(request: TaskWorkerRequest): void {
    void this.dispatch(request).then(
      (result) => this.respond({ requestId: request.requestId, ok: true, result }),
      (error: unknown) => {
        if (!(error instanceof CanvasRepositoryError)) throw error
        this.respond({ requestId: request.requestId, ok: false, error: { code: error.code } })
      },
    )
  }
  terminate(): void {}
  private dispatch(request: TaskWorkerRequest): Promise<unknown> {
    switch (request.type) {
      case 'canvas.create': return this.backend.createCanvas(request.input)
      case 'canvas.list': return this.backend.listCanvases()
      case 'canvas.get': return this.backend.getCanvas(request.id)
      case 'canvas.rename': return this.backend.renameCanvas(request.input)
      case 'canvas.updateViewport': return this.backend.updateCanvasViewport(request.input)
      case 'canvas.node.createText': return this.backend.createTextNode(request.input)
      case 'canvas.node.list': return this.backend.listCanvasNodes(request.canvasId)
      case 'canvas.node.updateText': return this.backend.updateTextNode(request.input)
      case 'canvas.node.move': return this.backend.moveCanvasNode(request.input)
      default: throw new Error(`Unexpected request ${request.type}`)
    }
  }
  private respond(response: TaskWorkerResponse): void {
    this.onmessage?.(new MessageEvent('message', { data: response }))
  }
}

defineCanvasRepositoryContract('WebCanvasRepository', () => {
  const backend = new CanvasContractBackend()
  return { repository: new WebCanvasRepository(new TaskWorkerClient(new CanvasWorker(backend))), backend }
})
