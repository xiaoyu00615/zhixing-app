import { describe, expect, test } from 'vitest'

import {
  ArchiveWorkerClientError,
  NoteWorkerClientError,
  TaskWorkerClient,
  TaskWorkerClientError,
  TrashWorkerClientError,
  type TaskWorkerEndpoint,
} from '@/adapters/web/taskWorkerClient'
import type { TaskWorkerRequest } from '@/adapters/web/taskWorkerProtocol'

class CapturingWorker implements TaskWorkerEndpoint {
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  onmessageerror: ((event: MessageEvent<unknown>) => void) | null = null
  readonly messages: TaskWorkerRequest[] = []
  terminated = false

  constructor(private readonly postMessageImpl?: (m: TaskWorkerRequest) => void) {}

  postMessage(message: TaskWorkerRequest): void {
    this.messages.push(message)
    this.postMessageImpl?.(message)
  }

  terminate(): void {
    this.terminated = true
  }

  send(data: unknown): void {
    this.onmessage?.(new MessageEvent('message', { data }))
  }

  emitError(): void {
    this.onerror?.(new ErrorEvent('error'))
  }
}

function expectTaskError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(TaskWorkerClientError)
  expect((error as TaskWorkerClientError).code).toBe(code)
}

function expectNoteError(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(NoteWorkerClientError)
  expect((error as NoteWorkerClientError).code).toBe(code)
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}

describe('TaskWorkerClient error isolation', () => {
  test('mixed pending transport FAILED routes Task to TaskWorkerClientError and Note to NoteWorkerClientError', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const taskPromise = client.listTasks()
    const notePromise = client.listActiveNotes()
    await flush()
    expect(worker.messages).toHaveLength(2)

    worker.emitError()
    await flush()

    await expect(taskPromise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_UNAVAILABLE')
      return true
    })
    await expect(notePromise).rejects.toSatisfy((error) => {
      expectNoteError(error, 'PERSISTENCE_ERROR')
      return true
    })
  })

  test('mixed pending malformed response routes Task to PERSISTENCE_FAILED and Note to PERSISTENCE_ERROR', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const taskPromise = client.listTasks()
    const notePromise = client.listActiveNotes()
    await flush()

    // Reply to the first pending (Task) with an unknown requestId to force transport FAILED.
    worker.send({ requestId: 999, ok: true, result: 'unknown' })
    await flush()

    await expect(taskPromise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })
    await expect(notePromise).rejects.toSatisfy((error) => {
      expectNoteError(error, 'PERSISTENCE_ERROR')
      return true
    })
  })

  test('postMessage throw on Task request rejects with TaskWorkerClientError(PERSISTENCE_UNAVAILABLE)', async () => {
    const worker = new CapturingWorker(() => {
      throw new Error('postMessage failed')
    })
    const client = new TaskWorkerClient(worker)

    await expect(client.listTasks()).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_UNAVAILABLE')
      return true
    })
  })

  test('postMessage throw on Note request rejects with NoteWorkerClientError(PERSISTENCE_ERROR)', async () => {
    const worker = new CapturingWorker(() => {
      throw new Error('postMessage failed')
    })
    const client = new TaskWorkerClient(worker)

    await expect(client.listActiveNotes()).rejects.toSatisfy((error) => {
      expectNoteError(error, 'PERSISTENCE_ERROR')
      return true
    })
  })

  test('Task send after terminated rejects with TaskWorkerClientError(PERSISTENCE_UNAVAILABLE)', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)
    client.terminate()

    await expect(client.listTasks()).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_UNAVAILABLE')
      return true
    })
  })

  test('Note send after terminated rejects with NoteWorkerClientError(PERSISTENCE_ERROR)', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)
    client.terminate()

    await expect(client.listActiveNotes()).rejects.toSatisfy((error) => {
      expectNoteError(error, 'PERSISTENCE_ERROR')
      return true
    })
  })

  test('Note pending receiving Task-only error code resolves to NoteWorkerClientError(PERSISTENCE_ERROR)', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const notePromise = client.listActiveNotes()
    await flush()
    expect(worker.messages).toHaveLength(1)

    // Worker sends a Task-only error code for the Note pending request.
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    })
    await flush()

    await expect(notePromise).rejects.toSatisfy((error) => {
      expectNoteError(error, 'PERSISTENCE_ERROR')
      return true
    })
  })

  test('Task pending receiving Note-only error code resolves to TaskWorkerClientError(PERSISTENCE_FAILED)', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const taskPromise = client.listTasks()
    await flush()
    expect(worker.messages).toHaveLength(1)

    // Worker sends a Note-only error code for the Task pending request.
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'INVALID_TITLE' },
    })
    await flush()

    await expect(taskPromise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })
  })
})

describe('TaskWorkerClient archive lifecycle envelopes', () => {
  const ID = '00000000-0000-4000-8000-000000000001'

  test('sends the exact task.archive / task.unarchive envelopes', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.archiveTask({ id: ID, updatedAtMs: 200 })
    await flush()
    void client.unarchiveTask({ id: ID, updatedAtMs: 300 })
    await flush()

    expect(worker.messages).toEqual([
      { requestId: 1, type: 'task.archive', input: { id: ID, updatedAtMs: 200 } },
      {
        requestId: 2,
        type: 'task.unarchive',
        input: { id: ID, updatedAtMs: 300 },
      },
    ])
  })

  test('sends the exact note.archive / note.unarchive envelopes', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.archiveNote({ id: ID, updatedAtMs: 200 })
    await flush()
    void client.unarchiveNote({ id: ID, updatedAtMs: 300 })
    await flush()

    expect(worker.messages).toEqual([
      { requestId: 1, type: 'note.archive', input: { id: ID, updatedAtMs: 200 } },
      {
        requestId: 2,
        type: 'note.unarchive',
        input: { id: ID, updatedAtMs: 300 },
      },
    ])
  })

  test('note.archive failure routes to NoteWorkerClientError, never the Task emitter', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.archiveNote({ id: ID, updatedAtMs: 200 })
    await flush()
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expectNoteError(error, 'NOT_FOUND')
      return true
    })
  })

  test('task.archive failure routes to TaskWorkerClientError', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.archiveTask({ id: ID, updatedAtMs: 200 })
    await flush()
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'NOT_FOUND')
      return true
    })
  })
})

describe('TaskWorkerClient archive.list cross-domain read (P5C S2)', () => {
  const ARCHIVE_ENTITY_ID = '00000000-0000-4000-8000-000000000001'

  test('sends the exact archive.list envelope', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.listArchive()
    await flush()

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toMatchObject({ requestId: 1, type: 'archive.list' })
  })

  test('returns the archive result on success', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)
    const items = [
      {
        entityType: 'note',
        entityId: ARCHIVE_ENTITY_ID,
        title: 'N',
        archivedAtMs: 200,
      },
      {
        entityType: 'task',
        entityId: ARCHIVE_ENTITY_ID,
        title: 'T',
        archivedAtMs: 100,
      },
    ]

    const promise = client.listArchive()
    await flush()
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: true,
      result: items,
    })
    await flush()

    await expect(promise).resolves.toEqual(items)
  })

  test('archive.list failure routes to ArchiveWorkerClientError', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.listArchive()
    await flush()
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(ArchiveWorkerClientError)
      expect((error as ArchiveWorkerClientError).code).toBe('PERSISTENCE_ERROR')
      return true
    })
  })

  test('malformed archive.list response still rejects as ArchiveWorkerClientError', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.listArchive()
    await flush()
    // A foreign error code is not an Archive code: the pending request is
    // rejected with the Archive transport failure, not leaked as-is.
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(ArchiveWorkerClientError)
      expect((error as ArchiveWorkerClientError).code).toBe('PERSISTENCE_ERROR')
      return true
    })
  })
})

describe('TaskWorkerClient trash.list cross-domain read', () => {
  test('sends the exact trash.list envelope', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.listTrash()
    await flush()

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toMatchObject({ requestId: 1, type: 'trash.list' })
  })

  test('trash.list failure routes to TrashWorkerClientError', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.listTrash()
    await flush()
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'PERSISTENCE_ERROR' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(TrashWorkerClientError)
      expect((error as TrashWorkerClientError).code).toBe('PERSISTENCE_ERROR')
      return true
    })
  })

  test('malformed trash.list response still rejects as TrashWorkerClientError', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.listTrash()
    await flush()
    worker.send({
      requestId: worker.messages[0]?.requestId ?? 1,
      ok: false,
      error: { code: 'NOT_FOUND' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expect(error).toBeInstanceOf(TrashWorkerClientError)
      expect((error as TrashWorkerClientError).code).toBe('PERSISTENCE_ERROR')
      return true
    })
  })
})

describe('TaskWorkerClient maintenance control (P6-S4A1)', () => {
  test('enterMaintenance sends the exact maintenance.enter envelope', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.enterMaintenance()
    await flush()

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toEqual({
      requestId: 1,
      type: 'maintenance.enter',
    })
  })

  test('exitMaintenance sends the exact maintenance.exit envelope with the lease id', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.exitMaintenance('web-maint-1')
    await flush()

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toEqual({
      requestId: 1,
      type: 'maintenance.exit',
      leaseId: 'web-maint-1',
    })
  })

  test('enterMaintenance resolves with the worker-allocated lease handle', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.enterMaintenance()
    await flush()
    worker.send({ requestId: 1, ok: true, result: { leaseId: 'web-maint-1' } })
    await flush()

    const lease = await promise
    expect(lease.leaseId).toBe('web-maint-1')
  })

  test('enterMaintenance rejects when the success envelope carries no usable lease id', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.enterMaintenance()
    await flush()
    // A null success is NOT acceptable for enter: the caller would end up
    // holding a barrier it cannot identify, and therefore cannot release.
    worker.send({ requestId: 1, ok: true, result: null })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })
  })

  test('enterMaintenance rejects deterministically when quiescence is already active', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.enterMaintenance()
    await flush()
    // The worker answers with the Task-domain safe failure; no new cross-domain
    // error code is introduced.
    worker.send({
      requestId: 1,
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })
  })

  test('lease.release() sends the owner lease id and is idempotent on the client', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.enterMaintenance()
    await flush()
    worker.send({ requestId: 1, ok: true, result: { leaseId: 'web-maint-3' } })
    await flush()
    const lease = await promise

    const releasePromise = lease.release()
    await flush()
    worker.send({ requestId: 2, ok: true, result: null })
    await flush()
    await releasePromise

    // Second release is a client-side NO-OP: no further request is emitted.
    await lease.release()

    // Client-side idempotence is convenience only: it prevents a duplicate
    // send, it is NOT the ownership check (which lives in the worker).
    expect(worker.messages).toHaveLength(2)
    expect(worker.messages[1]).toEqual({
      requestId: 2,
      type: 'maintenance.exit',
      leaseId: 'web-maint-3',
    })
  })

  test('lease.release() rejects when the worker refuses the owner', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.enterMaintenance()
    await flush()
    worker.send({ requestId: 1, ok: true, result: { leaseId: 'web-maint-4' } })
    await flush()
    const lease = await promise

    const releasePromise = lease.release()
    await flush()
    worker.send({
      requestId: 2,
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    })
    await flush()

    // The caller must learn that it did NOT release persistence.
    await expect(releasePromise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })
  })

  test('control requests are sent through the ordinary send path (no side channel)', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.enterMaintenance()
    await flush()
    void client.exitMaintenance('web-maint-1')
    await flush()

    // Sequential requestIds prove both went through `send()` like any other
    // request: same protocol union, same postMessage, same worker queue.
    expect(worker.messages.map((message) => message.type)).toEqual([
      'maintenance.enter',
      'maintenance.exit',
    ])
    expect(worker.messages.map((message) => message.requestId)).toEqual([1, 2])
  })
})

describe('TaskWorkerClient strict close + release retry (P6-S4A2B1)', () => {
  test('closeMaintenance sends the exact maintenance.close envelope', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    void client.closeMaintenance('web-maint-1')
    await flush()

    expect(worker.messages).toHaveLength(1)
    expect(worker.messages[0]).toEqual({
      requestId: 1,
      type: 'maintenance.close',
      leaseId: 'web-maint-1',
    })
  })

  test('closeMaintenance propagates the worker refusal and never terminates the transport', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.closeMaintenance('web-maint-foreign')
    await flush()
    worker.send({
      requestId: 1,
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    })
    await flush()

    await expect(promise).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })
    // A strict close may not swallow the failure by tearing the transport down:
    // `terminate()` would make the outcome unobservable.
    expect(worker.terminated).toBe(false)
  })

  test('closeMaintenance resolving proves only the worker acknowledgement', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const promise = client.closeMaintenance('web-maint-1')
    await flush()
    worker.send({ requestId: 1, ok: true, result: null })
    await flush()

    await expect(promise).resolves.toBeUndefined()
    // No side effect on the transport: the client is still usable / not
    // terminated, and no exit was emitted on the caller's behalf.
    expect(worker.terminated).toBe(false)
    expect(worker.messages.map((message) => message.type)).toEqual([
      'maintenance.close',
    ])
  })

  test('lease.release() stays retry-capable after a control failure', async () => {
    const worker = new CapturingWorker()
    const client = new TaskWorkerClient(worker)

    const entered = client.enterMaintenance()
    await flush()
    worker.send({ requestId: 1, ok: true, result: { leaseId: 'web-maint-7' } })
    await flush()
    const lease = await entered

    // Attempt 1: the control response fails, so ownership was NOT released.
    const firstAttempt = lease.release()
    await flush()
    worker.send({
      requestId: 2,
      ok: false,
      error: { code: 'PERSISTENCE_FAILED' },
    })
    await flush()
    await expect(firstAttempt).rejects.toSatisfy((error) => {
      expectTaskError(error, 'PERSISTENCE_FAILED')
      return true
    })

    // Attempt 2 with the SAME handle must really be sent again — the previous
    // failure must not have consumed the handle.
    const secondAttempt = lease.release()
    await flush()
    expect(worker.messages).toHaveLength(3)
    expect(worker.messages[2]).toEqual({
      requestId: 3,
      type: 'maintenance.exit',
      leaseId: 'web-maint-7',
    })
    worker.send({ requestId: 3, ok: true, result: null })
    await flush()
    await expect(secondAttempt).resolves.toBeUndefined()

    // Attempt 3: only now is the handle locally consumed, so no request leaves.
    await lease.release()
    expect(worker.messages).toHaveLength(3)
  })
})
