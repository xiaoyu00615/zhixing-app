/// <reference lib="webworker" />

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import {
  extractRequestId,
  isRecord,
  parseTaskWorkerRequest,
  type TaskWorkerResponse,
  type WebPersistenceCapability,
} from '@/adapters/web/taskWorkerProtocol'
import { TaskDatabaseError, WebTaskDatabase } from '@/adapters/web/taskDatabase'
import type { TaskRepositoryErrorCode } from '@/task/repository'
import { isTaskRepositoryErrorCode } from '@/task/repository'
import type { NoteRepositoryErrorCode } from '@/note/repository'
import { isNoteRepositoryErrorCode } from '@/note/repository'
import type { DiaryRepositoryErrorCode } from '@/diary/repository'
import { isDiaryRepositoryErrorCode } from '@/diary/repository'
import { isSearchRepositoryErrorCode, type SearchRepositoryErrorCode } from '@/search/model'
import { isArchiveRepositoryErrorCode, type ArchiveRepositoryErrorCode } from '@/archive/model'
import { isTrashRepositoryErrorCode, type TrashRepositoryErrorCode } from '@/trash/model'

type DiaryOperationType =
  | 'diary.create'
  | 'diary.getActiveById'
  | 'diary.getActiveByDiaryDate'
  | 'diary.listActive'
  | 'diary.updateDiaryEntry'
  | 'diary.changeDiaryDate'
  | 'diary.softDelete'
  | 'diary.restore'

const DIARY_OPERATION_TYPES = new Set<DiaryOperationType>([
  'diary.create',
  'diary.getActiveById',
  'diary.getActiveByDiaryDate',
  'diary.listActive',
  'diary.updateDiaryEntry',
  'diary.changeDiaryDate',
  'diary.softDelete',
  'diary.restore',
])

function isDiaryOperation(type: string): boolean {
  return DIARY_OPERATION_TYPES.has(type as DiaryOperationType)
}

/**
 * True when the raw request envelope looks like a diary-domain request even
 * though it failed domain parsing (malformed input or unknown diary op).
 * Used so malformed / unknown diary.* requests fail through the Diary
 * failure emitter instead of the Task failure emitter.
 */
function isDiaryRequestType(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    value.type.startsWith('diary.')
  )
}

type NoteOperationType =
  | 'note.create'
  | 'note.getActiveById'
  | 'note.listActive'
  | 'note.updateNote'
  | 'note.softDelete'
  | 'note.restore'
  | 'note.archive'
  | 'note.unarchive'

const NOTE_OPERATION_TYPES = new Set<NoteOperationType>([
  'note.create',
  'note.getActiveById',
  'note.listActive',
  'note.updateNote',
  'note.softDelete',
  'note.restore',
  'note.archive',
  'note.unarchive',
])

function isNoteOperation(type: string): boolean {
  return NOTE_OPERATION_TYPES.has(type as NoteOperationType)
}

/**
 * True when the raw request envelope looks like a note-domain request even
 * though it failed domain parsing (malformed input or unknown note op).
 * Used so malformed / unknown note.* requests fail through the Note
 * failure emitter instead of the Task failure emitter.
 */
function isNoteRequestType(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    value.type.startsWith('note.')
  )
}

type SearchOperationType = 'search.query'

const SEARCH_OPERATION_TYPES = new Set<SearchOperationType>(['search.query'])

function isSearchOperation(type: string): boolean {
  return SEARCH_OPERATION_TYPES.has(type as SearchOperationType)
}

function isSearchRequestType(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    value.type.startsWith('search.')
  )
}

type TrashOperationType = 'trash.list'

const TRASH_OPERATION_TYPES = new Set<TrashOperationType>(['trash.list'])

function isTrashOperation(type: string): boolean {
  return TRASH_OPERATION_TYPES.has(type as TrashOperationType)
}

function isTrashRequestType(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    value.type.startsWith('trash.')
  )
}

// Cross-domain READ (P5C S2). `archive.list` reads the unified archive view
// across tasks + notes. The canonical WRITE ops `task.archive` /
// `note.archive` keep their existing `task.*` / `note.*` prefixes and are
// routed by their own operation sets, so the two never collide.
type ArchiveOperationType = 'archive.list'

const ARCHIVE_OPERATION_TYPES = new Set<ArchiveOperationType>(['archive.list'])

function isArchiveOperation(type: string): boolean {
  return ARCHIVE_OPERATION_TYPES.has(type as ArchiveOperationType)
}

function isArchiveRequestType(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value.type === 'string' &&
    value.type.startsWith('archive.')
  )
}

const DATABASE_FILENAME = '/zhixing.db'
const workerScope = self as DedicatedWorkerGlobalScope

interface InitializedDatabase {
  readonly capability: WebPersistenceCapability
  readonly database?: WebTaskDatabase
}

let initialization: Promise<InitializedDatabase> | null = null

function isSecurityRestriction(error: unknown): boolean {
  return (
    error instanceof DOMException &&
    (error.name === 'SecurityError' || error.name === 'NotAllowedError')
  )
}

async function initializeDatabase(): Promise<InitializedDatabase> {
  if (globalThis.crossOriginIsolated !== true) {
    return {
      capability: {
        status: 'RESTRICTED',
        reason: 'CROSS_ORIGIN_ISOLATION_REQUIRED',
      },
    }
  }
  if (
    !('storage' in navigator) ||
    typeof navigator.storage.getDirectory !== 'function'
  ) {
    return {
      capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
    }
  }

  let rawDatabase: Database | null = null
  try {
    await navigator.storage.getDirectory()
    const sqlite3: Sqlite3Static = await sqlite3InitModule()
    if (!sqlite3.capi.sqlite3_vfs_find('opfs')) {
      return {
        capability: { status: 'UNAVAILABLE', reason: 'OPFS_UNSUPPORTED' },
      }
    }

    rawDatabase = new sqlite3.oo1.OpfsDb(DATABASE_FILENAME, 'c')
    const database = await WebTaskDatabase.initialize(rawDatabase)
    return { capability: { status: 'AVAILABLE' }, database }
  } catch (error: unknown) {
    rawDatabase?.close()
    return isSecurityRestriction(error)
      ? {
          capability: { status: 'RESTRICTED', reason: 'SECURITY_POLICY' },
        }
      : {
          capability: {
            status: 'UNAVAILABLE',
            reason: 'INITIALIZATION_FAILED',
          },
        }
  }
}

function getInitialization(): Promise<InitializedDatabase> {
  initialization ??= initializeDatabase()
  return initialization
}

function success(requestId: number, result: unknown): void {
  const response: TaskWorkerResponse = { requestId, ok: true, result }
  workerScope.postMessage(response)
}

function failure(requestId: number, code: TaskRepositoryErrorCode): void {
  const response: TaskWorkerResponse = {
    requestId,
    ok: false,
    error: { code },
  }
  workerScope.postMessage(response)
}

function noteFailure(requestId: number, code: NoteRepositoryErrorCode): void {
  const response: TaskWorkerResponse = {
    requestId,
    ok: false,
    error: { code },
  }
  workerScope.postMessage(response)
}

function diaryFailure(requestId: number, code: DiaryRepositoryErrorCode): void {
  const response: TaskWorkerResponse = {
    requestId,
    ok: false,
    error: { code },
  }
  workerScope.postMessage(response)
}

function searchFailure(requestId: number, code: SearchRepositoryErrorCode): void {
  const response: TaskWorkerResponse = {
    requestId,
    ok: false,
    error: { code },
  }
  workerScope.postMessage(response)
}

function trashFailure(requestId: number, code: TrashRepositoryErrorCode): void {
  const response: TaskWorkerResponse = {
    requestId,
    ok: false,
    error: { code },
  }
  workerScope.postMessage(response)
}

function archiveFailure(
  requestId: number,
  code: ArchiveRepositoryErrorCode,
): void {
  const response: TaskWorkerResponse = {
    requestId,
    ok: false,
    error: { code },
  }
  workerScope.postMessage(response)
}

async function handleRequest(value: unknown): Promise<void> {
  const request = parseTaskWorkerRequest(value)
  if (request === null) {
    const requestId = extractRequestId(value)
    if (requestId !== null) {
      if (isNoteRequestType(value)) {
        noteFailure(requestId, 'PERSISTENCE_ERROR')
      } else if (isDiaryRequestType(value)) {
        diaryFailure(requestId, 'PERSISTENCE_ERROR')
      } else if (isSearchRequestType(value)) {
        searchFailure(requestId, 'PERSISTENCE_ERROR')
      } else if (isTrashRequestType(value)) {
        trashFailure(requestId, 'PERSISTENCE_ERROR')
      } else if (isArchiveRequestType(value)) {
        archiveFailure(requestId, 'PERSISTENCE_ERROR')
      } else {
        failure(requestId, 'PERSISTENCE_FAILED')
      }
    }
    return
  }

  if (request.type === 'initialize') {
    const state = await getInitialization()
    success(request.requestId, state.capability)
    return
  }

  if (request.type === 'shutdown') {
    const state = initialization === null ? null : await initialization
    state?.database?.close()
    success(request.requestId, null)
    return
  }

  const state = await getInitialization()
  if (state.capability.status !== 'AVAILABLE' || state.database === undefined) {
    if (isNoteOperation(request.type)) {
      noteFailure(request.requestId, 'PERSISTENCE_ERROR')
    } else if (isDiaryOperation(request.type)) {
      diaryFailure(request.requestId, 'PERSISTENCE_ERROR')
    } else if (isSearchOperation(request.type)) {
      searchFailure(request.requestId, 'PERSISTENCE_ERROR')
    } else if (isTrashOperation(request.type)) {
      trashFailure(request.requestId, 'PERSISTENCE_ERROR')
    } else if (isArchiveOperation(request.type)) {
      archiveFailure(request.requestId, 'PERSISTENCE_ERROR')
    } else {
      failure(request.requestId, 'PERSISTENCE_UNAVAILABLE')
    }
    return
  }

  if (isSearchOperation(request.type)) {
    try {
      switch (request.type) {
        case 'search.query':
          success(
            request.requestId,
            state.database.searchQuery(request.input),
          )
          return
      }
    } catch (error: unknown) {
      const code: SearchRepositoryErrorCode =
        error instanceof TaskDatabaseError &&
        isSearchRepositoryErrorCode(error.code)
          ? error.code
          : 'PERSISTENCE_ERROR'
      searchFailure(request.requestId, code)
    }
    return
  }

  if (isTrashOperation(request.type)) {
    try {
      switch (request.type) {
        case 'trash.list':
          success(request.requestId, state.database.listTrash())
          return
      }
    } catch (error: unknown) {
      const code: TrashRepositoryErrorCode =
        error instanceof TaskDatabaseError &&
        isTrashRepositoryErrorCode(error.code)
          ? error.code
          : 'PERSISTENCE_ERROR'
      trashFailure(request.requestId, code)
    }
    return
  }

  if (isArchiveOperation(request.type)) {
    try {
      switch (request.type) {
        case 'archive.list':
          success(request.requestId, state.database.listArchive())
          return
      }
    } catch (error: unknown) {
      const code: ArchiveRepositoryErrorCode =
        error instanceof TaskDatabaseError &&
        isArchiveRepositoryErrorCode(error.code)
          ? error.code
          : 'PERSISTENCE_ERROR'
      archiveFailure(request.requestId, code)
    }
    return
  }

  if (isDiaryOperation(request.type)) {
    try {
      switch (request.type) {
        case 'diary.create':
          success(
            request.requestId,
            state.database.createDiaryEntry(request.input),
          )
          return
        case 'diary.getActiveById':
          success(
            request.requestId,
            state.database.getActiveDiaryEntry(request.id),
          )
          return
        case 'diary.getActiveByDiaryDate':
          success(
            request.requestId,
            state.database.getActiveDiaryEntryByDate(request.diaryDate),
          )
          return
        case 'diary.listActive':
          success(request.requestId, state.database.listActiveDiaryEntries())
          return
        case 'diary.updateDiaryEntry':
          success(
            request.requestId,
            state.database.updateDiaryEntry(request.input),
          )
          return
        case 'diary.changeDiaryDate':
          success(
            request.requestId,
            state.database.changeDiaryDate(request.input),
          )
          return
        case 'diary.softDelete':
          state.database.softDeleteDiaryEntry(request.input)
          success(request.requestId, null)
          return
        case 'diary.restore':
          state.database.restoreDiaryEntry(request.input)
          success(request.requestId, null)
          return
      }
    } catch (error: unknown) {
      const code: DiaryRepositoryErrorCode =
        error instanceof TaskDatabaseError &&
        isDiaryRepositoryErrorCode(error.code)
          ? error.code
          : 'PERSISTENCE_ERROR'
      diaryFailure(request.requestId, code)
    }
    return
  }

  if (isNoteOperation(request.type)) {
    try {
      switch (request.type) {
        case 'note.create':
          success(request.requestId, state.database.createNote(request.input))
          return
        case 'note.getActiveById':
          success(request.requestId, state.database.getActiveNote(request.id))
          return
        case 'note.listActive':
          success(request.requestId, state.database.listActiveNotes())
          return
        case 'note.updateNote':
          success(request.requestId, state.database.updateNote(request.input))
          return
        case 'note.softDelete':
          success(request.requestId, state.database.softDeleteNote(request.input))
          return
        case 'note.restore':
          success(request.requestId, state.database.restoreNote(request.input))
          return
        case 'note.archive':
          success(request.requestId, state.database.archiveNote(request.input))
          return
        case 'note.unarchive':
          success(request.requestId, state.database.unarchiveNote(request.input))
          return
      }
    } catch (error: unknown) {
      const code: NoteRepositoryErrorCode =
        error instanceof TaskDatabaseError &&
        isNoteRepositoryErrorCode(error.code)
          ? error.code
          : 'PERSISTENCE_ERROR'
      noteFailure(request.requestId, code)
    }
    return
  }

  try {
    switch (request.type) {
      case 'task.create':
        success(request.requestId, state.database.createTask(request.input))
        return
      case 'task.list':
        success(request.requestId, state.database.listTasks())
        return
      case 'task.listTrashed':
        success(request.requestId, state.database.listTrashedTasks())
        return
      case 'task.trash':
        success(request.requestId, state.database.trashTask(request.input))
        return
      case 'task.restore':
        success(request.requestId, state.database.restoreTask(request.input))
        return
      case 'task.archive':
        success(request.requestId, state.database.archiveTask(request.input))
        return
      case 'task.unarchive':
        success(request.requestId, state.database.unarchiveTask(request.input))
        return
      case 'task.rename':
        success(request.requestId, state.database.renameTask(request.input))
        return
      case 'task.changeStatus':
        success(
          request.requestId,
          state.database.changeTaskStatus(request.input),
        )
        return
      case 'task.setImportance':
        success(
          request.requestId,
          state.database.setTaskImportance(request.input),
        )
        return
      case 'task.setUrgency':
        success(request.requestId, state.database.setTaskUrgency(request.input))
        return
      case 'task.setDeadline':
        success(
          request.requestId,
          state.database.setTaskDeadline(request.input),
        )
        return
      case 'task.clearDeadline':
        success(
          request.requestId,
          state.database.clearTaskDeadline(request.input),
        )
        return
      case 'task.setProject':
        success(request.requestId, state.database.setTaskProject(request.input))
        return
      case 'task.clearProject':
        success(
          request.requestId,
          state.database.clearTaskProject(request.input),
        )
        return
      case 'task.addTag':
        success(request.requestId, state.database.addTaskTag(request.input))
        return
      case 'task.removeTag':
        success(request.requestId, state.database.removeTaskTag(request.input))
        return
      case 'project.create':
        success(request.requestId, state.database.createProject(request.input))
        return
      case 'project.list':
        success(request.requestId, state.database.listProjects())
        return
      case 'project.rename':
        success(request.requestId, state.database.renameProject(request.input))
        return
      case 'tag.create':
        success(request.requestId, state.database.createTag(request.input))
        return
      case 'tag.list':
        success(request.requestId, state.database.listTags())
        return
      case 'tag.rename':
        success(request.requestId, state.database.renameTag(request.input))
        return
      case 'canvas.create':
        success(request.requestId, state.database.createCanvas(request.input))
        return
      case 'canvas.list':
        success(request.requestId, state.database.listCanvases())
        return
      case 'canvas.get':
        success(request.requestId, state.database.getCanvas(request.id))
        return
      case 'canvas.rename':
        success(request.requestId, state.database.renameCanvas(request.input))
        return
      case 'canvas.updateViewport':
        success(
          request.requestId,
          state.database.updateCanvasViewport(request.input),
        )
        return
      case 'canvas.node.create':
        success(
          request.requestId,
          state.database.createCanvasNode(request.input),
        )
        return
      case 'canvas.node.createText':
        success(request.requestId, state.database.createTextNode(request.input))
        return
      case 'canvas.node.list':
        success(
          request.requestId,
          state.database.listCanvasNodes(request.canvasId),
        )
        return
      case 'canvas.node.updateContent':
        success(
          request.requestId,
          state.database.updateCanvasNodeContent(request.input),
        )
        return
      case 'canvas.node.rename':
        success(
          request.requestId,
          state.database.renameCanvasNode(request.input),
        )
        return
      case 'canvas.node.delete':
        success(
          request.requestId,
          state.database.deleteCanvasNode(request.input),
        )
        return
      case 'canvas.node.updateText':
        success(request.requestId, state.database.updateTextNode(request.input))
        return
      case 'canvas.node.move':
        success(
          request.requestId,
          state.database.moveCanvasNode(request.input),
        )
        return
      case 'canvas.nodes.move':
        success(
          request.requestId,
          state.database.moveCanvasNodes(request.input),
        )
        return
      case 'canvas.edge.create':
        success(
          request.requestId,
          state.database.createCanvasEdge(request.input),
        )
        return
      case 'canvas.subgraph.create':
        success(
          request.requestId,
          state.database.createCanvasSubgraph(request.input),
        )
        return
      case 'canvas.mutation.applyBatch':
        success(
          request.requestId,
          state.database.applyCanvasMutationBatch(request.input),
        )
        return
      case 'canvas.nodeBox.addMember':
        success(
          request.requestId,
          state.database.addCanvasNodeBoxMember(request.input),
        )
        return
      case 'canvas.nodeBox.reorderMemberships':
        success(
          request.requestId,
          state.database.reorderCanvasNodeBoxMemberships(request.input),
        )
        return
      case 'canvas.edge.list':
        success(
          request.requestId,
          state.database.listCanvasEdges(request.canvasId),
        )
        return
      case 'canvas.edge.setDirection':
        success(
          request.requestId,
          state.database.updateCanvasEdgeDirection(request.input),
        )
        return
      case 'canvas.edge.setLineStyle':
        success(
          request.requestId,
          state.database.updateCanvasEdgeLineStyle(request.input),
        )
        return
      case 'canvas.edge.setRelationType':
        success(
          request.requestId,
          state.database.updateCanvasEdgeRelationType(request.input),
        )
        return
      case 'canvas.edge.delete':
        success(
          request.requestId,
          state.database.deleteCanvasEdge(request.input),
        )
        return
    }
  } catch (error: unknown) {
    failure(
      request.requestId,
      error instanceof TaskDatabaseError &&
        isTaskRepositoryErrorCode(error.code)
        ? error.code
        : 'PERSISTENCE_FAILED',
    )
  }
}

let requestQueue = Promise.resolve()
workerScope.onmessage = (event: MessageEvent<unknown>) => {
  requestQueue = requestQueue.then(() => handleRequest(event.data))
}

export {}
