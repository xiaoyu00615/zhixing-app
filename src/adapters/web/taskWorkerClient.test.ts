import { describe, expect, test } from 'vitest'

import {
  NoteWorkerClientError,
  TaskWorkerClient,
  TaskWorkerClientError,
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
