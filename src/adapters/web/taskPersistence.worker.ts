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

/**
 * P6-S4A1 + P6-S4A1R: STRONG quiescence state WITH owner identity.
 *
 * Deliberately not a state machine — this slice only needs NORMAL vs QUIESCENT
 * — but it is also deliberately NOT a bare boolean. A boolean made
 * `maintenance.exit` unconditionally clear the barrier, so a stale exit from a
 * previous owner could silently release a newer owner's barrier.
 *
 * `null` = NORMAL. Non-null = QUIESCENT *and* the id of the barrier's owner:
 * only the caller holding that lease id may release it.
 *
 * Non-null also means: the write-admission cutoff has already happened, every
 * ordinary request admitted before `maintenance.enter` has completed (guaranteed
 * by the serial `requestQueue`), and no ordinary request admitted after it may
 * execute DB work.
 *
 * The counter is worker-local, monotonic and never reused for the lifetime of
 * this worker. Lease ids are NOT persisted and are NOT shared across workers: a
 * fresh worker starts again at 1.
 */
let activeMaintenanceLeaseId: string | null = null
let nextMaintenanceLeaseId = 1

/**
 * P6-S4A2B1: minimal STRICT-close state of the already-established runtime.
 *
 * Deliberately not a general state machine — it exists to make three facts
 * authoritative in the WORKER:
 *
 *   * `OPEN`          — the strict-close primitive has never completed here.
 *                       Ordinary traffic and `maintenance.exit` behave exactly
 *                       as before this slice.
 *   * `CLOSED`        — a strict close SUCCEEDED. The database is really gone,
 *                       so ordinary traffic and `maintenance.exit` must keep
 *                       failing: a closed database can never safely return to
 *                       NORMAL traffic. B2 retires the generation instead.
 *   * `INDETERMINATE` — `database.close()` THREW. `close()` is not idempotent
 *                       and the real state of the database is unknown, so this
 *                       is FAIL CLOSED, and it is explicitly NOT retryable:
 *                       nothing here automatically retries the close, resumes
 *                       traffic, terminates the client or unpublishes anything.
 *
 * This state tracks the strict-close primitive ONLY. The normal `shutdown`
 * lifecycle keeps its unchanged best-effort semantics while this state is
 * `OPEN`; in a terminal state it follows the frozen matrix instead —
 * `CLOSED` ⇒ deterministic success without re-closing, `INDETERMINATE` ⇒
 * explicit `PERSISTENCE_FAILED` failure without re-closing.
 */
type MaintenanceCloseState = 'OPEN' | 'CLOSED' | 'INDETERMINATE'

let maintenanceCloseState: MaintenanceCloseState = 'OPEN'

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

  // ---- P6-S4A1 CONTROL: maintenance.enter / maintenance.exit ---------------
  // Both are handled here, inside the SAME serial `requestQueue` as ordinary
  // requests, and with NO await before the state transition. That is what makes
  // `maintenance.enter`'s success response a single atomic event:
  //   * every ordinary request admitted before it has already completed;
  //   * every ordinary request admitted after it is rejected below.
  if (request.type === 'maintenance.enter') {
    // P6-S4A2B1 §13: a terminal close state is not resumable, so no new owner
    // may ever be created on top of it. This is checked BEFORE the overlap rule
    // so the answer never depends on what the previous owner happened to hold.
    if (maintenanceCloseState !== 'OPEN') {
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    if (activeMaintenanceLeaseId !== null) {
      // Deterministic failure, and the existing owner is left untouched: a
      // second caller must never be able to believe it won the quiescence
      // ownership that the first caller still holds.
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    const leaseId = `web-maint-${nextMaintenanceLeaseId}`
    nextMaintenanceLeaseId += 1
    activeMaintenanceLeaseId = leaseId
    // The lease id is the response payload, not a null success: the caller has
    // to learn WHICH barrier it now owns in order to be able to release it.
    success(request.requestId, { leaseId })
    return
  }

  if (request.type === 'maintenance.exit') {
    // P6-S4A2B1 §11/§12: once the strict close reached a terminal state the
    // barrier can no longer be released, because releasing it would re-open the
    // write admission of a database that is either gone or in an unknown state.
    if (maintenanceCloseState !== 'OPEN') {
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    // NO-OP when inactive: safely aborting a barrier that was never (or no
    // longer) established must not fail.
    if (activeMaintenanceLeaseId === null) {
      success(request.requestId, null)
      return
    }
    // Owner validation happens HERE, in the authoritative worker state — not in
    // the client, coordinator or UI. A stale exit carrying a previous owner's
    // lease id therefore fails instead of unlocking the current barrier.
    if (request.leaseId !== activeMaintenanceLeaseId) {
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    activeMaintenanceLeaseId = null
    success(request.requestId, null)
    return
  }

  // ---- P6-S4A2B1 CONTROL: maintenance.close (STRICT close) -----------------
  // Owns ONLY the closing of the already-established runtime. It deliberately
  // does NOT release the lease, terminate the client, unpublish the generation,
  // retire the generation or release the shared slot: none of those lifecycles
  // belong to this primitive (they are P6-S4A2B2 / B2's responsibility).
  if (request.type === 'maintenance.close') {
    // 1. Terminal state first: a CLOSED database must never be closed again
    //    (`WebTaskDatabase.close()` is not idempotent) and an INDETERMINATE one
    //    must never be retried automatically.
    if (maintenanceCloseState !== 'OPEN') {
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    // 2. Owner validation BEFORE anything touches the database. A foreign or
    //    stale lease neither closes the database nor changes the owner.
    if (
      activeMaintenanceLeaseId === null ||
      request.leaseId !== activeMaintenanceLeaseId
    ) {
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    // 3. A strict close may only close a runtime that ALREADY exists. Note that
    //    this reads the memoized `initialization`; it never calls
    //    `getInitialization()`, so a close can never secretly create / open a
    //    database that did not exist.
    const pending = initialization
    if (pending === null) {
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    const state = await pending
    if (state.capability.status !== 'AVAILABLE' || state.database === undefined) {
      // No real database: an optional-chained no-op would report a close that
      // never happened. Explicit failure instead.
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    // 4. Real close, locally contained. The exception must not escape
    //    `handleRequest`: the serial `requestQueue` has no `.catch()`, so an
    //    escaping rejection would silently poison every later request.
    try {
      state.database.close()
    } catch {
      maintenanceCloseState = 'INDETERMINATE'
      failure(request.requestId, 'PERSISTENCE_FAILED')
      return
    }
    maintenanceCloseState = 'CLOSED'
    success(request.requestId, null)
    return
  }

  // CONTROL: `shutdown` stays allowed while quiescent, because strong
  // maintenance (Restore / Data Root Migration) needs to close the runtime
  // AFTER the barrier is established. `shutdown` alone is still NOT a barrier.
  if (request.type === 'shutdown') {
    // Normal lifecycle semantics are unchanged when no strict close happened
    // (no barrier required, always allowed, best-effort, no owner validation).
    if (maintenanceCloseState === 'OPEN') {
      const state = initialization === null ? null : await initialization
      state?.database?.close()
      success(request.requestId, null)
      return
    }
    // P6-S4A2B1 shutdown matrix, terminal states:
    //   * `CLOSED`        — the database is really gone and already closed, so
    //                       shutdown is a deterministic success. `close()` is
    //                       NOT idempotent, so it must not run a second time.
    //   * `INDETERMINATE` — `close()` threw once and the real database state is
    //                       unknown, so a normal shutdown can neither pretend
    //                       to have closed it nor retry the close. This is a
    //                       FAIL CLOSED answer, but it is still a NORMAL failure
    //                       response: it must be emitted from `handleRequest()`
    //                       (not thrown), so the serial `requestQueue` — which
    //                       has no `.catch()` — stays alive.
    if (maintenanceCloseState === 'CLOSED') {
      success(request.requestId, null)
      return
    }
    failure(request.requestId, 'PERSISTENCE_FAILED')
    return
  }

  // ---- P6-S4A1 barrier: ordinary requests are rejected while quiescent ----
  // STRONG quiescence: both reads and mutations are blocked, so the database is
  // not touched by ordinary traffic during maintenance. Each domain keeps its
  // own failure emitter so existing domain error contracts are preserved:
  //   Task -> PERSISTENCE_UNAVAILABLE, Note/Diary/Search/Trash/Archive ->
  //   PERSISTENCE_ERROR, Canvas/Project/Tag -> the same Task mapping they
  //   already use when persistence is not AVAILABLE.
  //
  // P6-S4A2B1: a terminal strict-close state keeps failing closed for the same
  // reason — a database that is CLOSED or in an INDETERMINATE state must never
  // serve ordinary traffic again, and this must hold even after the maintenance
  // lease is (or becomes) inactive.
  if (activeMaintenanceLeaseId !== null || maintenanceCloseState !== 'OPEN') {
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

  if (request.type === 'initialize') {
    const state = await getInitialization()
    success(request.requestId, state.capability)
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
