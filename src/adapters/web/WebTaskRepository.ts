import {
  isCanonicalLowercaseUuid,
  isNonEmptyTaskTitle,
  isNonNegativeSafeIntegerMilliseconds,
  isTaskStatus,
  isTaskStatusOperation,
  isValidLocalDate,
  type Task,
} from '@/task/model'
import {
  TaskRepositoryError,
  type ArchiveTaskInput,
  type ChangeTaskStatusInput,
  type ClearTaskDeadlineInput,
  type CreateTaskInput,
  type RenameTaskInput,
  type RestoreTaskInput,
  type SetTaskDeadlineInput,
  type SetTaskImportanceInput,
  type SetTaskUrgencyInput,
  type TaskRepository,
  type TaskRepositoryOperation,
  type TrashTaskInput,
  type UnarchiveTaskInput,
} from '@/task/repository'
import {
  createTaskPersistenceWorker,
  TaskWorkerClient,
  TaskWorkerClientError,
  type TaskWorkerEndpoint,
} from '@/adapters/web/taskWorkerClient'
import {
  isRecord,
  type WebPersistenceCapability,
} from '@/adapters/web/taskWorkerProtocol'
import { WebProjectRepository } from '@/adapters/web/WebProjectRepository'
import { WebTagRepository } from '@/adapters/web/WebTagRepository'
import { WebCanvasRepository } from '@/adapters/web/WebCanvasRepository'
import { WebNoteRepository } from '@/adapters/web/WebNoteRepository'
import { WebDiaryRepository } from '@/adapters/web/WebDiaryRepository'
import { WebSearchRepository } from '@/adapters/web/WebSearchRepository'
import { WebTrashRepository } from '@/adapters/web/WebTrashRepository'
import { WebArchiveRepository } from '@/adapters/web/WebArchiveRepository'
import type { ArchiveRepository } from '@/archive/repository'
import type { SearchRepository } from '@/search/repository'
import type { TrashRepository } from '@/trash/repository'

function parseTask(value: unknown, operation: TaskRepositoryOperation): Task {
  if (!isRecord(value)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }

  const {
    id,
    title,
    status,
    createdAtMs,
    updatedAtMs,
    isImportant,
    isUrgent,
    dueDate,
    projectId,
    tagIds,
    deletedAtMs,
    archivedAtMs,
  } = value
  if (
    !isCanonicalLowercaseUuid(id) ||
    !isNonEmptyTaskTitle(title) ||
    !isTaskStatus(status) ||
    !isNonNegativeSafeIntegerMilliseconds(createdAtMs) ||
    !isNonNegativeSafeIntegerMilliseconds(updatedAtMs) ||
    updatedAtMs < createdAtMs ||
    typeof isImportant !== 'boolean' ||
    typeof isUrgent !== 'boolean' ||
    (dueDate !== null && !isValidLocalDate(dueDate)) ||
    (projectId !== null && !isCanonicalLowercaseUuid(projectId)) ||
    !Array.isArray(tagIds) ||
    tagIds.some((tagId) => !isCanonicalLowercaseUuid(tagId)) ||
    new Set(tagIds).size !== tagIds.length ||
    (deletedAtMs !== null && !isNonNegativeSafeIntegerMilliseconds(deletedAtMs)) ||
    (archivedAtMs !== null &&
      !isNonNegativeSafeIntegerMilliseconds(archivedAtMs))
  ) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return {
    id,
    title,
    status,
    createdAtMs,
    updatedAtMs,
    isImportant,
    isUrgent,
    dueDate,
    projectId,
    tagIds,
    deletedAtMs,
    archivedAtMs,
  }
}

function validateId(id: string, operation: TaskRepositoryOperation): void {
  if (!isCanonicalLowercaseUuid(id)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function validateTitle(
  title: string,
  operation: TaskRepositoryOperation,
): void {
  if (!isNonEmptyTaskTitle(title)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function validateTimestamp(
  timestamp: number,
  operation: TaskRepositoryOperation,
): void {
  if (!isNonNegativeSafeIntegerMilliseconds(timestamp)) {
    throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function mapClientError(
  error: unknown,
  operation: TaskRepositoryOperation,
): TaskRepositoryError {
  if (error instanceof TaskRepositoryError) {
    return error
  }
  if (error instanceof TaskWorkerClientError) {
    return new TaskRepositoryError(error.code, operation)
  }
  return new TaskRepositoryError('PERSISTENCE_FAILED', operation)
}

export class WebTaskRepository implements TaskRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async createTask(input: CreateTaskInput): Promise<Task> {
    const operation = 'createTask'
    validateId(input.id, operation)
    validateTitle(input.title, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (
      (input.isImportant !== undefined &&
        typeof input.isImportant !== 'boolean') ||
      (input.isUrgent !== undefined && typeof input.isUrgent !== 'boolean') ||
      (input.dueDate !== undefined &&
        input.dueDate !== null &&
        !isValidLocalDate(input.dueDate)) ||
      (input.projectId !== undefined &&
        input.projectId !== null &&
        !isCanonicalLowercaseUuid(input.projectId)) ||
      (input.tagIds !== undefined &&
        (!Array.isArray(input.tagIds) ||
          input.tagIds.some((tagId) => !isCanonicalLowercaseUuid(tagId)) ||
          new Set(input.tagIds).size !== input.tagIds.length))
    ) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseTask(
        await this.#client.createTask({
          ...input,
          isImportant: input.isImportant ?? false,
          isUrgent: input.isUrgent ?? false,
          dueDate: input.dueDate ?? null,
          projectId: input.projectId ?? null,
          tagIds: input.tagIds ?? [],
        }),
        operation,
      )
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async listTasks(): Promise<readonly Task[]> {
    const operation = 'listTasks'
    try {
      const value = await this.#client.listTasks()
      if (!Array.isArray(value)) {
        throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((task) => parseTask(task, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async listTrashedTasks(): Promise<readonly Task[]> {
    const operation = 'listTrashedTasks'
    try {
      const value = await this.#client.listTrashedTasks()
      if (!Array.isArray(value)) {
        throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((task) => parseTask(task, operation))
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  trashTask(input: TrashTaskInput): Promise<Task> {
    return this.callLifecycle('trashTask', input, () =>
      this.#client.trashTask(input),
    )
  }

  restoreTask(input: RestoreTaskInput): Promise<Task> {
    return this.callLifecycle('restoreTask', input, () =>
      this.#client.restoreTask(input),
    )
  }

  /**
   * Archive V1 (P5C-S1): Active -> Archived. Shares the lifecycle plumbing with
   * trash / restore because the request shape is identical (id + updatedAtMs).
   */
  archiveTask(input: ArchiveTaskInput): Promise<Task> {
    return this.callLifecycle('archiveTask', input, () =>
      this.#client.archiveTask(input),
    )
  }

  /** Archive V1 (P5C-S1): Archived -> Active. */
  unarchiveTask(input: UnarchiveTaskInput): Promise<Task> {
    return this.callLifecycle('unarchiveTask', input, () =>
      this.#client.unarchiveTask(input),
    )
  }

  async renameTask(input: RenameTaskInput): Promise<Task> {
    const operation = 'renameTask'
    validateId(input.id, operation)
    validateTitle(input.title, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      return parseTask(await this.#client.renameTask(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task> {
    const operation = 'changeTaskStatus'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isTaskStatusOperation(input.operation)) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseTask(await this.#client.changeTaskStatus(input), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  async setTaskImportance(input: SetTaskImportanceInput): Promise<Task> {
    return this.callPlanning(
      'setTaskImportance',
      input,
      () => this.#client.setTaskImportance(input),
      typeof input.isImportant === 'boolean',
    )
  }

  async setTaskUrgency(input: SetTaskUrgencyInput): Promise<Task> {
    return this.callPlanning(
      'setTaskUrgency',
      input,
      () => this.#client.setTaskUrgency(input),
      typeof input.isUrgent === 'boolean',
    )
  }

  async setTaskDeadline(input: SetTaskDeadlineInput): Promise<Task> {
    return this.callPlanning(
      'setTaskDeadline',
      input,
      () => this.#client.setTaskDeadline(input),
      isValidLocalDate(input.dueDate),
    )
  }

  async clearTaskDeadline(input: ClearTaskDeadlineInput): Promise<Task> {
    return this.callPlanning(
      'clearTaskDeadline',
      input,
      () => this.#client.clearTaskDeadline(input),
      true,
    )
  }

  async setTaskProject(
    input: import('@/task/repository').SetTaskProjectInput,
  ): Promise<Task> {
    return this.callPlanning(
      'setTaskProject',
      input,
      () => this.#client.setTaskProject(input),
      isCanonicalLowercaseUuid(input.projectId),
    )
  }

  async clearTaskProject(
    input: import('@/task/repository').ClearTaskProjectInput,
  ): Promise<Task> {
    return this.callPlanning(
      'clearTaskProject',
      input,
      () => this.#client.clearTaskProject(input),
      true,
    )
  }

  async addTaskTag(
    input: import('@/task/repository').AddTaskTagInput,
  ): Promise<Task> {
    return this.callPlanning(
      'addTaskTag',
      input,
      () => this.#client.addTaskTag(input),
      isCanonicalLowercaseUuid(input.tagId),
    )
  }

  async removeTaskTag(
    input: import('@/task/repository').RemoveTaskTagInput,
  ): Promise<Task> {
    return this.callPlanning(
      'removeTaskTag',
      input,
      () => this.#client.removeTaskTag(input),
      isCanonicalLowercaseUuid(input.tagId),
    )
  }

  private async callPlanning(
    operation: Extract<
      TaskRepositoryOperation,
      | 'setTaskImportance'
      | 'setTaskUrgency'
      | 'setTaskDeadline'
      | 'clearTaskDeadline'
      | 'setTaskProject'
      | 'clearTaskProject'
      | 'addTaskTag'
      | 'removeTaskTag'
    >,
    input: { readonly id: string; readonly updatedAtMs: number },
    call: () => Promise<unknown>,
    valueIsValid: boolean,
  ): Promise<Task> {
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!valueIsValid) {
      throw new TaskRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseTask(await call(), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }

  private async callLifecycle(
    operation:
      | 'trashTask'
      | 'restoreTask'
      | 'archiveTask'
      | 'unarchiveTask',
    input: { readonly id: string; readonly updatedAtMs: number },
    call: () => Promise<unknown>,
  ): Promise<Task> {
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      return parseTask(await call(), operation)
    } catch (error: unknown) {
      throw mapClientError(error, operation)
    }
  }
}

export interface OpenWebTaskRepositoryOptions {
  readonly workerSupported?: boolean
  readonly crossOriginIsolated?: boolean
  readonly workerFactory?: () => TaskWorkerEndpoint
}

export type OpenWebTaskRepositoryResult =
  | {
      readonly capability: { readonly status: 'AVAILABLE' }
      readonly repository: WebTaskRepository
      readonly projectRepository: import('@/project/repository').ProjectRepository
      readonly tagRepository: import('@/tag/repository').TagRepository
      readonly canvasRepository: import('@/canvas/repository').CanvasRepository
      readonly noteRepository: import('@/note/repository').NoteRepository
      readonly diaryRepository: import('@/diary/repository').DiaryRepository
      readonly searchRepository: SearchRepository
      readonly trashRepository: TrashRepository
      readonly archiveRepository: ArchiveRepository
      readonly dispose: () => Promise<void>
    }
  | {
      readonly capability: Exclude<
        WebPersistenceCapability,
        { readonly status: 'AVAILABLE' }
      >
    }

interface SharedWebPersistenceRepositories {
  readonly repository: WebTaskRepository
  readonly projectRepository: import('@/project/repository').ProjectRepository
  readonly tagRepository: import('@/tag/repository').TagRepository
  readonly canvasRepository: import('@/canvas/repository').CanvasRepository
  readonly noteRepository: import('@/note/repository').NoteRepository
  readonly diaryRepository: import('@/diary/repository').DiaryRepository
  readonly searchRepository: SearchRepository
  readonly trashRepository: TrashRepository
  readonly archiveRepository: ArchiveRepository
}

type SharedWebPersistenceOutcome =
  | { readonly ok: true; readonly repositories: SharedWebPersistenceRepositories }
  | {
      readonly ok: false
      readonly capability: Exclude<
        WebPersistenceCapability,
        { readonly status: 'AVAILABLE' }
      >
    }

interface SharedWebPersistenceGeneration {
  readonly client: TaskWorkerClient
  readonly opening: Promise<SharedWebPersistenceOutcome>
  /**
   * Mirrors `opening` once it settles (`null` while still OPENING). Retirement
   * needs to tell OPENING from ACTIVE, because `initialize` is an ORDINARY
   * request: a barrier taken before it settles would race the very request the
   * strict close is supposed to drain.
   */
  openingOutcome: SharedWebPersistenceOutcome | null
  refCount: number
  closing: Promise<GenerationCloseOutcome> | null
  /**
   * P6-S4A2B2: this generation was retired (normal close or strict retirement).
   * A retired generation is always unpublished, its client is terminated or
   * terminating, and a stale consumer `dispose()` must leave it alone.
   */
  retired: boolean
}

/**
 * P6-S4A2B2: outcome of the NORMAL close of a shared generation.
 *
 * `closing` used to be a `Promise<void>` whose rejection was swallowed by
 * `.catch(() => undefined)`, which made "the runtime was shut down" and "the
 * database was cleanly closed" indistinguishable. It is still a promise that
 * NEVER rejects — parked opens await it, and a rejection would tear down the
 * whole open chain — but it now RESOLVES to an outcome, so a failed close is
 * observable instead of being silently absorbed.
 */
type GenerationCloseOutcome = { readonly ok: true } | { readonly ok: false }

/**
 * P6-S4A2B2: result of retiring the shared generation. A narrow Web-specific
 * union — deliberately not a generic maintenance framework.
 */
export type SharedWebPersistenceRetirementOutcome =
  | { readonly ok: true; readonly status: 'NO_RUNTIME' | 'RETIRED' }
  | {
      readonly ok: false
      readonly reason:
        | 'NOT_OWNER'
        | 'NORMAL_CLOSE_FAILED'
        | 'BARRIER_UNAVAILABLE'
        | 'CLOSE_INDETERMINATE'
    }

let sharedWebPersistenceGeneration: SharedWebPersistenceGeneration | null = null

/**
 * P6-S4A2A: the shared persistence SLOT reservation.
 *
 * A reservation is deliberately NOT attached to a generation. It gates
 * admission to the shared slot itself, which is the only shape that covers all
 * four lifecycle positions a maintenance handoff can start from: no generation,
 * OPENING, ACTIVE and CLOSING. While it is published:
 *
 *   * `openSharedWebTaskRepository()` waits until it is released instead of
 *     joining an existing generation or creating a new one — a reservation is
 *     temporary admission control, not a persistence failure;
 *   * a final consumer `dispose()` no longer triggers the normal close, so the
 *     slot owner cannot have the generation torn down underneath it.
 *
 * `refCount` stays the truthful consumer count: the reservation only suppresses
 * the *automatic* close. It never fakes, decrements or disposes a consumer
 * lease, so consumer ownership remains real. This is a narrow Web-specific
 * primitive, not a generic lease system, and it does not gate the isolated
 * `openWebTaskRepository(options)` path which never touches the shared slot.
 */
interface SharedSlotReservation {
  readonly reservationId: string
  /** Resolves when the slot stops gating admission. */
  readonly released: Promise<void>
  markReleased(): void
}

export interface SharedWebPersistenceReservation {
  readonly reservationId: string
  /**
   * Owner-scoped and idempotent: releasing a stale handle is a safe no-op that
   * never clears a newer reservation. Resolves once admission is released. A
   * normal close started by the release itself is not awaited — normal close
   * stays best-effort, exactly like a consumer `dispose()`.
   */
  release(): Promise<void>
  /**
   * P6-S4A2B2: owner-scoped STRICT retirement of the shared runtime.
   *
   * `release()` deliberately stays a pure admission release — it never proves
   * anything about the database. Retirement is the primitive that does:
   * resolve the current lifecycle position (NULL / OPENING / ACTIVE / CLOSING),
   * take the worker's strong barrier, acknowledge a real `database.close()`,
   * terminate the transport and unpublish the generation.
   *
   * Only the CURRENT reservation owner may retire; a stale handle fails and
   * never touches the live generation. The reservation itself is NOT released
   * here — not on success and definitely not on failure — so the slot owner
   * keeps admission closed across the whole handoff (Restore / Data Root
   * Migration run against a retired runtime behind a still-held slot).
   */
  retireGeneration(): Promise<SharedWebPersistenceRetirementOutcome>
}

export type SharedPersistenceReservationOutcome =
  | {
      readonly ok: true
      readonly reservation: SharedWebPersistenceReservation
    }
  | { readonly ok: false; readonly reason: 'OVERLAP' }

let sharedWebPersistenceReservation: SharedSlotReservation | null = null
let nextSharedWebPersistenceReservationId = 0

function createSharedRepositories(
  client: TaskWorkerClient,
): SharedWebPersistenceRepositories {
  return {
    repository: new WebTaskRepository(client),
    projectRepository: new WebProjectRepository(client),
    tagRepository: new WebTagRepository(client),
    canvasRepository: new WebCanvasRepository(client),
    noteRepository: new WebNoteRepository(client),
    diaryRepository: new WebDiaryRepository(client),
    searchRepository: new WebSearchRepository(client),
    trashRepository: new WebTrashRepository(client),
    archiveRepository: new WebArchiveRepository(client),
  }
}

async function initializeSharedGeneration(
  client: TaskWorkerClient,
): Promise<SharedWebPersistenceOutcome> {
  try {
    const capability = await client.initialize()
    if (capability.status !== 'AVAILABLE') {
      client.terminate()
      return { ok: false, capability }
    }
    return { ok: true, repositories: createSharedRepositories(client) }
  } catch {
    client.terminate()
    return {
      ok: false,
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    }
  }
}

function createSharedGeneration(
  client: TaskWorkerClient,
): SharedWebPersistenceGeneration {
  const generation: SharedWebPersistenceGeneration = {
    client,
    opening: initializeSharedGeneration(client),
    openingOutcome: null,
    refCount: 0,
    closing: null,
    retired: false,
  }
  // Recorded on a separate reaction so the shared `opening` promise keeps its
  // contract (created once, awaited by every consumer). Registered BEFORE any
  // consumer awaits it, so `openingOutcome` is already set by the time an
  // `await generation.opening` continuation resumes.
  void generation.opening.then((outcome) => {
    generation.openingOutcome = outcome
  })
  return generation
}

function closeSharedGeneration(
  generation: SharedWebPersistenceGeneration,
): Promise<GenerationCloseOutcome> {
  generation.closing ??= generation.client.shutdown().then(
    (): GenerationCloseOutcome => {
      if (sharedWebPersistenceGeneration === generation) {
        sharedWebPersistenceGeneration = null
      }
      return { ok: true }
    },
    (): GenerationCloseOutcome => {
      // P6-S4A2B2 §4: FAIL CLOSED. `shutdown()` terminates the transport whatever
      // happens, so a rejection means "client gone, database close NOT proven".
      // The generation therefore stays PUBLISHED and latches this failed
      // outcome: unpublishing here would let a later open build a second Worker
      // on top of a database that may still be open. The admission gate in
      // `openSharedWebTaskRepository()` turns the latch into a
      // `RUNTIME_CLOSE_FAILED` capability instead.
      return { ok: false }
    },
  )
  return generation.closing
}

/**
 * P6-S4A2B2: identity-safe retirement. Marks the generation retired (so stale
 * consumer handles leave it alone) and unpublishes it only if it is still the
 * current shared generation — a newer generation must never be cleared by an
 * older handoff.
 */
function markGenerationRetired(
  generation: SharedWebPersistenceGeneration,
): void {
  generation.retired = true
  if (sharedWebPersistenceGeneration === generation) {
    sharedWebPersistenceGeneration = null
  }
}

function releaseSharedWebPersistenceReservation(
  state: SharedSlotReservation,
): void {
  // Owner check: a stale handle must never release a newer reservation.
  if (sharedWebPersistenceReservation !== state) {
    return
  }
  const generation = sharedWebPersistenceGeneration
  if (
    generation !== null &&
    generation.refCount === 0 &&
    generation.closing === null
  ) {
    // Publish `closing` synchronously, before admission resumes, so a parked
    // open can never join a generation that is already being torn down. The
    // close itself stays best-effort (normal lifecycle semantics), which is why
    // the release does not await it.
    void closeSharedGeneration(generation)
  }
  sharedWebPersistenceReservation = null
  state.markReleased()
}

/**
 * P6-S4A2B2: the strict retirement handoff.
 *
 * Resolves the generation's lifecycle position and, only for an ACTIVE runtime,
 * performs the owner-validated strict close. Every path is fail closed: the
 * reservation is never released here, a failed close never unpublishes, and a
 * terminated-but-not-provably-closed runtime never gets a successor.
 */
async function retireSharedGeneration(
  state: SharedSlotReservation,
): Promise<SharedWebPersistenceRetirementOutcome> {
  // Owner-scoped: a stale handle must never retire the live generation.
  if (sharedWebPersistenceReservation !== state) {
    return { ok: false, reason: 'NOT_OWNER' }
  }

  const generation = sharedWebPersistenceGeneration
  if (generation === null) {
    // NULL: nothing to retire — and strictly NOTHING to create. Retirement is
    // never an implicit open.
    return { ok: true, status: 'NO_RUNTIME' }
  }

  // CLOSING: a normal close is already in flight, or already failed.
  if (generation.closing !== null) {
    const outcome = await generation.closing
    if (!outcome.ok) {
      // FAIL CLOSED: the transport was terminated but the database close was
      // never proven. Never enter maintenance, never build a new Worker, never
      // unpublish the failed generation.
      return { ok: false, reason: 'NORMAL_CLOSE_FAILED' }
    }
    // The normal close already retired and unpublished the generation.
    return { ok: true, status: 'NO_RUNTIME' }
  }

  // OPENING: `initialize` travels as an ORDINARY request, so the barrier must
  // be taken only AFTER it settles — otherwise the strict close would race the
  // very request it is meant to drain.
  if (generation.openingOutcome === null) {
    const opening = await generation.opening
    if (!opening.ok) {
      // Initialization already terminated the client (existing semantics).
      // Identity-safe cleanup only — the reservation stays with its owner.
      if (sharedWebPersistenceGeneration === generation) {
        sharedWebPersistenceGeneration = null
      }
      return { ok: true, status: 'NO_RUNTIME' }
    }
  }

  // ACTIVE. Barrier acquisition is not a strict close: if it fails, nothing was
  // attempted and the generation is left exactly as it was.
  let leaseId: string
  try {
    leaseId = (await generation.client.enterMaintenance()).leaseId
  } catch {
    return { ok: false, reason: 'BARRIER_UNAVAILABLE' }
  }

  try {
    await generation.client.closeMaintenance(leaseId)
  } catch {
    // CONSERVATIVE INDETERMINATE: a worker-declared failure and a lost
    // acknowledgement are indistinguishable here, and guessing the database
    // state is exactly what must NOT happen. The barrier stays up, the client
    // stays alive, the generation stays published. No `maintenance.exit`, no
    // retry — a future recovery strategy owns this.
    return { ok: false, reason: 'CLOSE_INDETERMINATE' }
  }

  // Proven: prior ordinary work drained, the worker's owner check passed and
  // `database.close()` was acknowledged. Only now is the transport torn down.
  // No `maintenance.exit` is needed — the runtime is closed and about to die.
  generation.client.terminate()
  markGenerationRetired(generation)
  return { ok: true, status: 'RETIRED' }
}

export function reserveSharedWebPersistenceSlot(): SharedPersistenceReservationOutcome {
  if (sharedWebPersistenceReservation !== null) {
    return { ok: false, reason: 'OVERLAP' }
  }
  let markReleased: () => void = () => undefined
  const released = new Promise<void>((resolve) => {
    markReleased = resolve
  })
  nextSharedWebPersistenceReservationId += 1
  const state: SharedSlotReservation = {
    reservationId: `web-reservation-${nextSharedWebPersistenceReservationId}`,
    released,
    markReleased,
  }
  // Claimed synchronously: nothing may await between the overlap check above
  // and this publish, otherwise two callers could both see an empty slot.
  sharedWebPersistenceReservation = state
  return {
    ok: true,
    reservation: {
      reservationId: state.reservationId,
      release: () => {
        releaseSharedWebPersistenceReservation(state)
        return state.released
      },
      retireGeneration: () => retireSharedGeneration(state),
    },
  }
}

function createSharedLeaseDispose(
  generation: SharedWebPersistenceGeneration,
): () => Promise<void> {
  let released = false
  return async () => {
    if (released) {
      return
    }
    released = true
    generation.refCount -= 1
    if (generation.refCount > 0) {
      return
    }
    if (generation.retired) {
      // P6-S4A2B2: this runtime was already retired by a handoff. Its client is
      // terminated or terminating and it is no longer the shared generation.
      // The decrement above is REAL (consumer ownership stays truthful), but a
      // stale handle must not shut anything down and must never clear a NEWER
      // generation.
      return
    }
    if (sharedWebPersistenceReservation !== null) {
      // Pinned by the slot reservation: `refCount` stays truthful (0), the
      // generation stays published and `closing` stays null until the owner
      // releases the slot. The owner then decides whether the normal close
      // starts — never the consumer.
      return
    }
    await closeSharedGeneration(generation)
  }
}

async function openSharedWebTaskRepository(): Promise<OpenWebTaskRepositoryResult> {
  // Core generations are serialized through shutdown, and a slot reservation
  // gates admission during a maintenance handoff: never join or create a
  // generation while either is in effect. Both waits re-read the whole slot
  // afterwards, so a parked caller can never continue from a stale snapshot.
  while (true) {
    const reservation = sharedWebPersistenceReservation
    if (reservation !== null) {
      await reservation.released
      continue
    }

    const current = sharedWebPersistenceGeneration
    if (current === null || current.closing === null) {
      break
    }
    const outcome = await current.closing
    if (!outcome.ok) {
      // P6-S4A2B2 §5: FAIL CLOSED. The previous runtime was terminated but its
      // database was never provably closed, and its generation is deliberately
      // still published. Reporting a normal unavailability reason here would be
      // a lie (`RUNTIME_CLOSE_FAILED` says exactly what happened), and looping
      // would spin forever on an already-settled promise.
      return {
        capability: { status: 'UNAVAILABLE', reason: 'RUNTIME_CLOSE_FAILED' },
      }
    }
  }

  let generation = sharedWebPersistenceGeneration
  if (generation === null) {
    let client: TaskWorkerClient
    try {
      client = new TaskWorkerClient(createTaskPersistenceWorker())
    } catch {
      return {
        capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
      }
    }
    generation = createSharedGeneration(client)
    // Published synchronously, before awaiting initialization, so concurrent
    // default opens join this generation instead of creating a second Worker.
    sharedWebPersistenceGeneration = generation
  }

  generation.refCount += 1
  const outcome = await generation.opening
  if (!outcome.ok) {
    if (sharedWebPersistenceGeneration === generation) {
      sharedWebPersistenceGeneration = null
    }
    return { capability: outcome.capability }
  }

  return {
    capability: { status: 'AVAILABLE' },
    repository: outcome.repositories.repository,
    projectRepository: outcome.repositories.projectRepository,
    tagRepository: outcome.repositories.tagRepository,
    canvasRepository: outcome.repositories.canvasRepository,
    noteRepository: outcome.repositories.noteRepository,
    diaryRepository: outcome.repositories.diaryRepository,
    searchRepository: outcome.repositories.searchRepository,
    trashRepository: outcome.repositories.trashRepository,
    archiveRepository: outcome.repositories.archiveRepository,
    dispose: createSharedLeaseDispose(generation),
  }
}

async function openUnsharedWebTaskRepository(
  options: OpenWebTaskRepositoryOptions,
): Promise<OpenWebTaskRepositoryResult> {
  let client: TaskWorkerClient
  try {
    client = new TaskWorkerClient(
      (options.workerFactory ?? createTaskPersistenceWorker)(),
    )
  } catch {
    return {
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    }
  }

  try {
    const capability = await client.initialize()
    if (capability.status !== 'AVAILABLE') {
      client.terminate()
      return { capability }
    }
    return {
      capability,
      repository: new WebTaskRepository(client),
      projectRepository: new WebProjectRepository(client),
      tagRepository: new WebTagRepository(client),
      canvasRepository: new WebCanvasRepository(client),
      noteRepository: new WebNoteRepository(client),
      diaryRepository: new WebDiaryRepository(client),
      searchRepository: new WebSearchRepository(client),
      trashRepository: new WebTrashRepository(client),
      archiveRepository: new WebArchiveRepository(client),
      dispose: () => client.shutdown(),
    }
  } catch {
    client.terminate()
    return {
      capability: { status: 'UNAVAILABLE', reason: 'INITIALIZATION_FAILED' },
    }
  }
}

export async function openWebTaskRepository(
  options: OpenWebTaskRepositoryOptions = {},
): Promise<OpenWebTaskRepositoryResult> {
  const workerSupported =
    options.workerSupported ?? typeof globalThis.Worker !== 'undefined'
  if (!workerSupported) {
    return {
      capability: { status: 'UNAVAILABLE', reason: 'WORKER_UNSUPPORTED' },
    }
  }

  const isolated =
    options.crossOriginIsolated ?? globalThis.crossOriginIsolated === true
  if (!isolated) {
    return {
      capability: {
        status: 'RESTRICTED',
        reason: 'CROSS_ORIGIN_ISOLATION_REQUIRED',
      },
    }
  }

  const defaultSemanticOptions =
    options.workerSupported === undefined &&
    options.crossOriginIsolated === undefined &&
    options.workerFactory === undefined
  if (!defaultSemanticOptions) {
    return openUnsharedWebTaskRepository(options)
  }

  return openSharedWebTaskRepository()
}
