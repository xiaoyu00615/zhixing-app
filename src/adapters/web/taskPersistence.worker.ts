/// <reference lib="webworker" />

import sqlite3InitModule, {
  type Database,
  type Sqlite3Static,
} from '@sqlite.org/sqlite-wasm'

import {
  extractRequestId,
  parseTaskWorkerRequest,
  type TaskWorkerResponse,
  type WebPersistenceCapability,
} from '@/adapters/web/taskWorkerProtocol'
import { TaskDatabaseError, WebTaskDatabase } from '@/adapters/web/taskDatabase'
import type { TaskRepositoryErrorCode } from '@/task/repository'

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

async function handleRequest(value: unknown): Promise<void> {
  const request = parseTaskWorkerRequest(value)
  if (request === null) {
    const requestId = extractRequestId(value)
    if (requestId !== null) {
      failure(requestId, 'PERSISTENCE_FAILED')
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
    failure(request.requestId, 'PERSISTENCE_UNAVAILABLE')
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
      case 'canvas.node.createText':
        success(
          request.requestId,
          state.database.createTextNode(request.input),
        )
        return
      case 'canvas.node.list':
        success(
          request.requestId,
          state.database.listCanvasNodes(request.canvasId),
        )
        return
      case 'canvas.node.updateText':
        success(
          request.requestId,
          state.database.updateTextNode(request.input),
        )
        return
      case 'canvas.node.move':
        success(
          request.requestId,
          state.database.moveCanvasNode(request.input),
        )
        return
    }
  } catch (error: unknown) {
    failure(
      request.requestId,
      error instanceof TaskDatabaseError ? error.code : 'PERSISTENCE_FAILED',
    )
  }
}

let requestQueue = Promise.resolve()
workerScope.onmessage = (event: MessageEvent<unknown>) => {
  requestQueue = requestQueue.then(() => handleRequest(event.data))
}

export {}
