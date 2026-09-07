import type {
  ChangeTaskStatusInput,
  ClearTaskDeadlineInput,
  CreateTaskInput,
  RenameTaskInput,
  RestoreTaskInput,
  SetTaskDeadlineInput,
  SetTaskImportanceInput,
  SetTaskUrgencyInput,
  TaskRepositoryErrorCode,
  TrashTaskInput,
} from '@/task/repository'
import type {
  CreateProjectInput,
  RenameProjectInput,
} from '@/project/repository'
import type { CreateTagInput, RenameTagInput } from '@/tag/repository'
import type {
  CreateCanvasInput,
  CreateCanvasEdgeInput,
  CreateCanvasNodeInput,
  CreateTextNodeInput,
  DeleteCanvasEdgeInput,
  MoveCanvasNodeInput,
  MoveCanvasNodesInput,
  RenameCanvasInput,
  RenameCanvasNodeInput,
  UpdateCanvasViewportInput,
  UpdateCanvasEdgeDirectionInput,
  UpdateCanvasEdgeLineStyleInput,
  UpdateCanvasEdgeRelationTypeInput,
  UpdateCanvasNodeContentInput,
  UpdateTextNodeInput,
} from '@/canvas/repository'
import {
  parseTaskWorkerResponse,
  parseWebPersistenceCapability,
  type TaskWorkerRequest,
  type WebPersistenceCapability,
} from '@/adapters/web/taskWorkerProtocol'

export interface TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null
  onerror: ((event: ErrorEvent) => void) | null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null
  postMessage(message: TaskWorkerRequest): void
  terminate(): void
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: TaskWorkerClientError) => void
}

export class TaskWorkerClientError extends Error {
  readonly code: TaskRepositoryErrorCode

  constructor(code: TaskRepositoryErrorCode) {
    super('Task persistence worker request failed.')
    this.name = 'TaskWorkerClientError'
    this.code = code
  }
}

export function createTaskPersistenceWorker(): TaskWorkerEndpoint {
  return new Worker(new URL('./taskPersistence.worker.ts', import.meta.url), {
    type: 'module',
    name: 'zhixing-task-persistence',
  })
}

export class TaskWorkerClient {
  readonly #worker: TaskWorkerEndpoint
  readonly #pending = new Map<number, PendingRequest>()
  #nextRequestId = 1
  #initializePromise: Promise<WebPersistenceCapability> | null = null
  #terminated = false

  constructor(worker: TaskWorkerEndpoint) {
    this.#worker = worker
    worker.onmessage = (event) => {
      this.handleMessage(event.data)
    }
    worker.onerror = () => {
      this.failAll('PERSISTENCE_UNAVAILABLE')
    }
    worker.onmessageerror = () => {
      this.failAll('PERSISTENCE_UNAVAILABLE')
    }
  }

  initialize(): Promise<WebPersistenceCapability> {
    this.#initializePromise ??= this.send((requestId) => ({
      requestId,
      type: 'initialize',
    })).then((value) => {
      const capability = parseWebPersistenceCapability(value)
      if (capability === null) {
        throw new TaskWorkerClientError('PERSISTENCE_FAILED')
      }
      return capability
    })
    return this.#initializePromise
  }

  createTask(input: CreateTaskInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.create',
      input,
    }))
  }

  listTasks(): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'task.list' }))
  }

  listTrashedTasks(): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'task.listTrashed' }))
  }

  trashTask(input: TrashTaskInput): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'task.trash', input }))
  }

  restoreTask(input: RestoreTaskInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.restore',
      input,
    }))
  }

  renameTask(input: RenameTaskInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.rename',
      input,
    }))
  }

  changeTaskStatus(input: ChangeTaskStatusInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.changeStatus',
      input,
    }))
  }

  setTaskImportance(input: SetTaskImportanceInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.setImportance',
      input,
    }))
  }

  setTaskUrgency(input: SetTaskUrgencyInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.setUrgency',
      input,
    }))
  }

  setTaskDeadline(input: SetTaskDeadlineInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.setDeadline',
      input,
    }))
  }

  clearTaskDeadline(input: ClearTaskDeadlineInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.clearDeadline',
      input,
    }))
  }

  setTaskProject(
    input: import('@/task/repository').SetTaskProjectInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.setProject',
      input,
    }))
  }

  clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.clearProject',
      input,
    }))
  }

  addTaskTag(
    input: import('@/task/repository').AddTaskTagInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.addTag',
      input,
    }))
  }

  removeTaskTag(
    input: import('@/task/repository').RemoveTaskTagInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'task.removeTag',
      input,
    }))
  }

  createProject(input: CreateProjectInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'project.create',
      input,
    }))
  }

  listProjects(): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'project.list' }))
  }

  renameProject(input: RenameProjectInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'project.rename',
      input,
    }))
  }

  createTag(input: CreateTagInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'tag.create',
      input,
    }))
  }

  listTags(): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'tag.list' }))
  }

  renameTag(input: RenameTagInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'tag.rename',
      input,
    }))
  }

  createCanvas(input: CreateCanvasInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.create',
      input,
    }))
  }

  listCanvases(): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'canvas.list' }))
  }

  getCanvas(id: string): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'canvas.get', id }))
  }

  renameCanvas(input: RenameCanvasInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.rename',
      input,
    }))
  }

  updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.updateViewport',
      input,
    }))
  }

  createCanvasNode(input: CreateCanvasNodeInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.node.create',
      input,
    }))
  }

  createTextNode(input: CreateTextNodeInput): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'canvas.node.createText', input }))
  }

  listCanvasNodes(canvasId: string): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.node.list',
      canvasId,
    }))
  }

  updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.node.updateContent',
      input,
    }))
  }

  renameCanvasNode(input: RenameCanvasNodeInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.node.rename',
      input,
    }))
  }

  deleteCanvasNode(
    input: import('@/canvas/repository').DeleteCanvasNodeInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.node.delete',
      input,
    }))
  }

  updateTextNode(input: UpdateTextNodeInput): Promise<unknown> {
    return this.send((requestId) => ({ requestId, type: 'canvas.node.updateText', input }))
  }

  moveCanvasNode(input: MoveCanvasNodeInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.node.move',
      input,
    }))
  }

  moveCanvasNodes(input: MoveCanvasNodesInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.nodes.move',
      input,
    }))
  }

  createCanvasEdge(input: CreateCanvasEdgeInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.edge.create',
      input,
    }))
  }

  addCanvasNodeBoxMember(
    input: import('@/canvas/repository').AddCanvasNodeBoxMemberInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.nodeBox.addMember',
      input,
    }))
  }

  reorderCanvasNodeBoxMemberships(
    input: import('@/canvas/repository').ReorderCanvasNodeBoxMembershipsInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.nodeBox.reorderMemberships',
      input,
    }))
  }

  listCanvasEdges(canvasId: string): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.edge.list',
      canvasId,
    }))
  }

  updateCanvasEdgeDirection(
    input: UpdateCanvasEdgeDirectionInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.edge.setDirection',
      input,
    }))
  }

  updateCanvasEdgeLineStyle(
    input: UpdateCanvasEdgeLineStyleInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.edge.setLineStyle',
      input,
    }))
  }

  updateCanvasEdgeRelationType(
    input: UpdateCanvasEdgeRelationTypeInput,
  ): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.edge.setRelationType',
      input,
    }))
  }

  deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.edge.delete',
      input,
    }))
  }

  async shutdown(): Promise<void> {
    if (this.#terminated) {
      return
    }
    try {
      await this.send((requestId) => ({ requestId, type: 'shutdown' }))
    } finally {
      this.terminate()
    }
  }

  terminate(): void {
    if (this.#terminated) {
      return
    }
    this.#terminated = true
    this.#worker.terminate()
    this.rejectPending('PERSISTENCE_UNAVAILABLE')
  }

  private send(
    createRequest: (requestId: number) => TaskWorkerRequest,
  ): Promise<unknown> {
    if (this.#terminated) {
      return Promise.reject(
        new TaskWorkerClientError('PERSISTENCE_UNAVAILABLE'),
      )
    }

    const requestId = this.#nextRequestId
    this.#nextRequestId += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject })
      try {
        this.#worker.postMessage(createRequest(requestId))
      } catch {
        this.#pending.delete(requestId)
        reject(new TaskWorkerClientError('PERSISTENCE_UNAVAILABLE'))
      }
    })
  }

  private handleMessage(value: unknown): void {
    const response = parseTaskWorkerResponse(value)
    if (response === null) {
      this.failAll('PERSISTENCE_FAILED')
      return
    }

    const pending = this.#pending.get(response.requestId)
    if (pending === undefined) {
      this.failAll('PERSISTENCE_FAILED')
      return
    }
    this.#pending.delete(response.requestId)

    if (response.ok) {
      pending.resolve(response.result)
    } else {
      pending.reject(new TaskWorkerClientError(response.error.code))
    }
  }

  private failAll(code: TaskRepositoryErrorCode): void {
    this.rejectPending(code)
    this.#initializePromise = null
    if (!this.#terminated) {
      this.#terminated = true
      this.#worker.terminate()
    }
  }

  private rejectPending(code: TaskRepositoryErrorCode): void {
    for (const pending of this.#pending.values()) {
      pending.reject(new TaskWorkerClientError(code))
    }
    this.#pending.clear()
  }
}
