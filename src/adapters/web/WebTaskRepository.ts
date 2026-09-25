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
  refCount: number
  closing: Promise<void> | null
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
  return {
    client,
    opening: initializeSharedGeneration(client),
    refCount: 0,
    closing: null,
  }
}

function closeSharedGeneration(
  generation: SharedWebPersistenceGeneration,
): Promise<void> {
  generation.closing ??= generation.client
    .shutdown()
    .catch(() => undefined)
    .then(() => {
      if (sharedWebPersistenceGeneration === generation) {
        sharedWebPersistenceGeneration = null
      }
    })
  return generation.closing
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
    await current.closing
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
