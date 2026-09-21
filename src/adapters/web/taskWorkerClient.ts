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
import { isTaskRepositoryErrorCode } from '@/task/repository'
import type {
  CreateProjectInput,
  RenameProjectInput,
} from '@/project/repository'
import type { CreateTagInput, RenameTagInput } from '@/tag/repository'
import type {
  CreateNoteInput,
  NoteRepositoryErrorCode,
  RestoreNoteInput,
  SoftDeleteNoteInput,
  UpdateNoteInput,
} from '@/note/repository'
import { isNoteRepositoryErrorCode } from '@/note/repository'
import type {
  ChangeDiaryDateInput,
  CreateDiaryEntryInput,
  DiaryRepositoryErrorCode,
  RestoreDiaryEntryInput,
  SoftDeleteDiaryEntryInput,
  UpdateDiaryEntryInput,
} from '@/diary/repository'
import { isDiaryRepositoryErrorCode } from '@/diary/repository'
import { isSearchRepositoryErrorCode, type SearchRepositoryErrorCode } from '@/search/model'
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
  extractRequestId,
  parseDiaryWorkerResponse,
  parseNoteWorkerResponse,
  parseSearchWorkerResponse,
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

export class TaskWorkerClientError extends Error {
  readonly code: TaskRepositoryErrorCode

  constructor(code: TaskRepositoryErrorCode) {
    super('Task persistence worker request failed.')
    this.name = 'TaskWorkerClientError'
    this.code = code
  }
}

export class NoteWorkerClientError extends Error {
  readonly code: NoteRepositoryErrorCode

  constructor(code: NoteRepositoryErrorCode) {
    super('Note persistence worker request failed.')
    this.name = 'NoteWorkerClientError'
    this.code = code
  }
}

export class DiaryWorkerClientError extends Error {
  readonly code: DiaryRepositoryErrorCode

  constructor(code: DiaryRepositoryErrorCode) {
    super('Diary persistence worker request failed.')
    this.name = 'DiaryWorkerClientError'
    this.code = code
  }
}

export class SearchWorkerClientError extends Error {
  readonly code: SearchRepositoryErrorCode

  constructor(code: SearchRepositoryErrorCode) {
    super('Search persistence worker request failed.')
    this.name = 'SearchWorkerClientError'
    this.code = code
  }
}

type WorkerTransportFailure = 'UNAVAILABLE' | 'FAILED'

type ClientRequestError =
  | TaskWorkerClientError
  | NoteWorkerClientError
  | DiaryWorkerClientError
  | SearchWorkerClientError

type ParsedClientResponse =
  | { readonly ok: true; readonly result: unknown }
  | { readonly ok: false; readonly error: ClientRequestError }

interface RequestOptions {
  readonly parseResponse: (value: unknown) => ParsedClientResponse | null
  readonly mapTransportFailure: (failure: WorkerTransportFailure) => ClientRequestError
}

const TASK_REQUEST_OPTIONS: RequestOptions = {
  parseResponse: (value) => {
    const response = parseTaskWorkerResponse(value)
    if (response === null) {
      return null
    }
    if (response.ok) {
      return { ok: true, result: response.result }
    }
    const code = response.error.code
    if (!isTaskRepositoryErrorCode(code)) {
      return null
    }
    return { ok: false, error: new TaskWorkerClientError(code) }
  },
  mapTransportFailure: (failure) =>
    new TaskWorkerClientError(
      failure === 'UNAVAILABLE' ? 'PERSISTENCE_UNAVAILABLE' : 'PERSISTENCE_FAILED',
    ),
}

const NOTE_REQUEST_OPTIONS: RequestOptions = {
  parseResponse: (value) => {
    const response = parseNoteWorkerResponse(value)
    if (response === null) {
      return null
    }
    if (response.ok) {
      return { ok: true, result: response.result }
    }
    const code = response.error.code
    if (!isNoteRepositoryErrorCode(code)) {
      return null
    }
    return { ok: false, error: new NoteWorkerClientError(code) }
  },
  mapTransportFailure: () => new NoteWorkerClientError('PERSISTENCE_ERROR'),
}

const DIARY_REQUEST_OPTIONS: RequestOptions = {
  parseResponse: (value) => {
    const response = parseDiaryWorkerResponse(value)
    if (response === null) {
      return null
    }
    if (response.ok) {
      return { ok: true, result: response.result }
    }
    const code = response.error.code
    if (!isDiaryRepositoryErrorCode(code)) {
      return null
    }
    return { ok: false, error: new DiaryWorkerClientError(code) }
  },
  mapTransportFailure: () => new DiaryWorkerClientError('PERSISTENCE_ERROR'),
}

const SEARCH_REQUEST_OPTIONS: RequestOptions = {
  parseResponse: (value) => {
    const response = parseSearchWorkerResponse(value)
    if (response === null) {
      return null
    }
    if (response.ok) {
      return { ok: true, result: response.result }
    }
    const code = response.error.code
    if (!isSearchRepositoryErrorCode(code)) {
      return null
    }
    return { ok: false, error: new SearchWorkerClientError(code) }
  },
  mapTransportFailure: () => new SearchWorkerClientError('PERSISTENCE_ERROR'),
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: ClientRequestError) => void
  readonly options: RequestOptions
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
      this.failAll('UNAVAILABLE')
    }
    worker.onmessageerror = () => {
      this.failAll('UNAVAILABLE')
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

  createCanvasSubgraph(input: import('@/canvas/repository').CreateCanvasSubgraphInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.subgraph.create',
      input,
    }))
  }

  applyCanvasMutationBatch(input: import('@/canvas/repository').ApplyCanvasMutationBatchInput): Promise<unknown> {
    return this.send((requestId) => ({
      requestId,
      type: 'canvas.mutation.applyBatch',
      input,
    }))
  }

  createNote(input: CreateNoteInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'note.create',
        input,
      }),
      NOTE_REQUEST_OPTIONS,
    )
  }

  getActiveNoteById(id: string): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'note.getActiveById',
        id,
      }),
      NOTE_REQUEST_OPTIONS,
    )
  }

  listActiveNotes(): Promise<unknown> {
    return this.send(
      (requestId) => ({ requestId, type: 'note.listActive' }),
      NOTE_REQUEST_OPTIONS,
    )
  }

  updateNote(input: UpdateNoteInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'note.updateNote',
        input,
      }),
      NOTE_REQUEST_OPTIONS,
    )
  }

  softDeleteNote(input: SoftDeleteNoteInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'note.softDelete',
        input,
      }),
      NOTE_REQUEST_OPTIONS,
    )
  }

  restoreNote(input: RestoreNoteInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'note.restore',
        input,
      }),
      NOTE_REQUEST_OPTIONS,
    )
  }

  createDiaryEntry(input: CreateDiaryEntryInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.create',
        input,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  getActiveDiaryEntryById(id: string): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.getActiveById',
        id,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  getActiveDiaryEntryByDate(diaryDate: string): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.getActiveByDiaryDate',
        diaryDate,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  listActiveDiaryEntries(): Promise<unknown> {
    return this.send(
      (requestId) => ({ requestId, type: 'diary.listActive' }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  updateDiaryEntry(input: UpdateDiaryEntryInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.updateDiaryEntry',
        input,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  changeDiaryDate(input: ChangeDiaryDateInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.changeDiaryDate',
        input,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  softDeleteDiaryEntry(input: SoftDeleteDiaryEntryInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.softDelete',
        input,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  restoreDiaryEntry(input: RestoreDiaryEntryInput): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'diary.restore',
        input,
      }),
      DIARY_REQUEST_OPTIONS,
    )
  }

  searchQuery(input: {
    readonly query: string
    readonly limit: number
  }): Promise<unknown> {
    return this.send(
      (requestId) => ({
        requestId,
        type: 'search.query',
        input,
      }),
      SEARCH_REQUEST_OPTIONS,
    )
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
    this.rejectPending('UNAVAILABLE')
  }

  private send(
    createRequest: (requestId: number) => TaskWorkerRequest,
    options: RequestOptions = TASK_REQUEST_OPTIONS,
  ): Promise<unknown> {
    if (this.#terminated) {
      return Promise.reject(options.mapTransportFailure('UNAVAILABLE'))
    }

    const requestId = this.#nextRequestId
    this.#nextRequestId += 1
    return new Promise((resolve, reject) => {
      this.#pending.set(requestId, { resolve, reject, options })
      try {
        this.#worker.postMessage(createRequest(requestId))
      } catch {
        this.#pending.delete(requestId)
        reject(options.mapTransportFailure('UNAVAILABLE'))
      }
    })
  }

  private handleMessage(value: unknown): void {
    const requestId = extractRequestId(value)
    if (requestId === null) {
      this.failAll('FAILED')
      return
    }

    const pending = this.#pending.get(requestId)
    if (pending === undefined) {
      this.failAll('FAILED')
      return
    }

    // Stage 1: shape-only parse. null means the response envelope is malformed
    // for ANY domain (bad shape, wrong code field shape, etc.), which is the
    // same class of failure as an unknown requestId — fail the whole client.
    // Keep the pending in the map so rejectPending covers it.
    if (!this.parseResponseShape(value)) {
    this.failAll('FAILED')
    return
  }

    this.#pending.delete(requestId)

    // Stage 2: domain-specific parse. null here means the response envelope
    // shape is valid but the error code belongs to a different domain. Reject
    // only this pending request; do not terminate the worker.
    const parsed = pending.options.parseResponse(value)
    if (parsed === null) {
      pending.reject(pending.options.mapTransportFailure('FAILED'))
      return
    }

    if (parsed.ok) {
      pending.resolve(parsed.result)
    } else {
      pending.reject(parsed.error)
    }
  }

  private parseResponseShape(value: unknown): boolean {
    if (parseTaskWorkerResponse(value) !== null) {
      return true
    }
    if (parseNoteWorkerResponse(value) !== null) {
      return true
    }
    if (parseDiaryWorkerResponse(value) !== null) {
      return true
    }
    if (parseSearchWorkerResponse(value) !== null) {
      return true
    }
    return false
  }

  private failAll(failure: WorkerTransportFailure): void {
    this.rejectPending(failure)
    this.#initializePromise = null
    if (!this.#terminated) {
      this.#terminated = true
      this.#worker.terminate()
    }
  }

  private rejectPending(failure: WorkerTransportFailure): void {
    for (const pending of this.#pending.values()) {
      pending.reject(pending.options.mapTransportFailure(failure))
    }
    this.#pending.clear()
  }
}
