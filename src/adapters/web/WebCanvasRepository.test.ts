import { expect, test } from 'vitest'

import { WebCanvasRepository } from './WebCanvasRepository'
import { TaskWorkerClient, type TaskWorkerEndpoint } from './taskWorkerClient'
import { parseTaskWorkerRequest, type TaskWorkerRequest, type TaskWorkerResponse } from './taskWorkerProtocol'
import { CanvasRepositoryError } from '@/canvas/repository'
import { CanvasContractBackend, defineCanvasRepositoryContract } from '@/test/canvasRepositoryContract'

class CanvasWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  constructor(readonly backend: CanvasContractBackend) {}
  postMessage(request: TaskWorkerRequest): void {
    void Promise.resolve().then(() => this.dispatch(request)).then(
      (result) => this.respond({ requestId: request.requestId, ok: true, result }),
      (error: unknown) => {
        if (!(error instanceof CanvasRepositoryError)) throw error
        this.respond({ requestId: request.requestId, ok: false, error: { code: error.code === 'DUPLICATE' ? 'STATUS_CONFLICT' : error.code } })
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
      case 'canvas.node.create': return this.backend.createCanvasNode(request.input)
      case 'canvas.node.list': return this.backend.listCanvasNodes(request.canvasId)
      case 'canvas.node.updateText': return this.backend.updateTextNode(request.input)
      case 'canvas.node.updateContent': return this.backend.updateCanvasNodeContent(request.input)
      case 'canvas.node.rename': return this.backend.renameCanvasNode(request.input)
      case 'canvas.node.move': return this.backend.moveCanvasNode(request.input)
      case 'canvas.nodes.move': return this.backend.moveCanvasNodes(request.input)
      case 'canvas.edge.create': return this.backend.createCanvasEdge(request.input)
      case 'canvas.nodeBox.addMember': return this.backend.addCanvasNodeBoxMember(request.input)
      case 'canvas.edge.list': return this.backend.listCanvasEdges(request.canvasId)
      case 'canvas.edge.setDirection': return this.backend.updateCanvasEdgeDirection(request.input)
      case 'canvas.edge.setLineStyle': return this.backend.updateCanvasEdgeLineStyle(request.input)
      case 'canvas.edge.setRelationType': return this.backend.updateCanvasEdgeRelationType(request.input)
      case 'canvas.edge.delete': return this.backend.deleteCanvasEdge(request.input)
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

test('Canvas Edge Worker messages remain capability-specific and strictly parsed', () => {
  const validCreate = {
    requestId: 1,
    type: 'canvas.edge.create',
    input: {
      id: '00000000-0000-4000-8000-000000000604',
      canvasId: '00000000-0000-4000-8000-000000000601',
      sourceNodeId: '00000000-0000-4000-8000-000000000602',
      targetNodeId: '00000000-0000-4000-8000-000000000603',
      relationType: 'default',
      direction: 'forward',
      lineStyle: 'solid',
      createdAtMs: 10,
    },
  }
  expect(parseTaskWorkerRequest(validCreate)).toEqual(validCreate)
  expect(parseTaskWorkerRequest({ ...validCreate, input: { ...validCreate.input, direction: 'reverse' } })).toBeNull()
  expect(parseTaskWorkerRequest({
    ...validCreate,
    input: { ...validCreate.input, relationType: 'ordered_box_member' },
  })).toBeNull()
  expect(parseTaskWorkerRequest({ requestId: 2, type: 'canvas.edge.execute', sql: 'DELETE' })).toBeNull()

  const validMembership = {
    requestId: 3,
    type: 'canvas.nodeBox.addMember',
    input: {
      id: '00000000-0000-4000-8000-000000000607',
      canvasId: validCreate.input.canvasId,
      sourceNodeId: validCreate.input.sourceNodeId,
      targetNodeId: validCreate.input.targetNodeId,
      relationType: 'ordered_box_member',
      createdAtMs: 11,
    },
  }
  expect(parseTaskWorkerRequest(validMembership)).toEqual(validMembership)
  expect(parseTaskWorkerRequest({
    ...validMembership,
    input: { ...validMembership.input, relationType: 'default' },
  })).toBeNull()
  expect(parseTaskWorkerRequest({
    ...validMembership,
    input: { ...validMembership.input, targetNodeId: validMembership.input.sourceNodeId },
  })).toBeNull()

  const semanticUpdate = {
    requestId: 2,
    type: 'canvas.edge.setRelationType',
    input: {
      id: validCreate.input.id,
      relationType: 'peer',
      direction: 'none',
      lineStyle: 'solid',
      updatedAtMs: 20,
    },
  }
  expect(parseTaskWorkerRequest(semanticUpdate)).toEqual(semanticUpdate)
  expect(parseTaskWorkerRequest({
    ...semanticUpdate,
    input: { ...semanticUpdate.input, relationType: 'ordered_box_member' },
  })).toBeNull()
})

test('Canvas batch move Worker messages are explicit and reject invalid batches', () => {
  const validMove = {
    requestId: 3,
    type: 'canvas.nodes.move',
    input: {
      canvasId: '00000000-0000-4000-8000-000000000601',
      moves: [
        { nodeId: '00000000-0000-4000-8000-000000000602', x: 10, y: 20 },
        { nodeId: '00000000-0000-4000-8000-000000000603', x: 30, y: 40 },
      ],
      updatedAtMs: 50,
    },
  }
  expect(parseTaskWorkerRequest(validMove)).toEqual(validMove)
  expect(parseTaskWorkerRequest({
    ...validMove,
    input: { ...validMove.input, moves: [] },
  })).toBeNull()
  expect(parseTaskWorkerRequest({
    ...validMove,
    input: {
      ...validMove.input,
      moves: [validMove.input.moves[0], validMove.input.moves[0]],
    },
  })).toBeNull()
  expect(parseTaskWorkerRequest({
    ...validMove,
    input: {
      ...validMove.input,
      moves: [{ ...validMove.input.moves[0], x: Number.POSITIVE_INFINITY }],
    },
  })).toBeNull()
})

test('Canvas node rename Worker messages enforce trimmed 120-code-point names', () => {
  const validRename = {
    requestId: 4,
    type: 'canvas.node.rename',
    input: {
      canvasId: '00000000-0000-4000-8000-000000000601',
      id: '00000000-0000-4000-8000-000000000602',
      nodeName: '😀'.repeat(120),
      updatedAtMs: 50,
    },
  }
  expect(parseTaskWorkerRequest(validRename)).toEqual(validRename)
  expect(parseTaskWorkerRequest({
    ...validRename,
    input: { ...validRename.input, nodeName: '😀'.repeat(121) },
  })).toBeNull()
  expect(parseTaskWorkerRequest({
    ...validRename,
    input: { ...validRename.input, nodeName: ' untrimmed ' },
  })).toBeNull()
})
