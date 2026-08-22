import { openWebTaskRepository } from '@/adapters/web'
import type { WebPersistenceCapability } from '@/adapters/web'
import type { Task } from '@/task/model'
import type {
  ChangeTaskStatusInput,
  CreateTaskInput,
  RenameTaskInput,
  TaskRepository,
} from '@/task/repository'

interface PersistenceHarness {
  capability(): Promise<WebPersistenceCapability>
  createTask(input: CreateTaskInput): Promise<Task>
  listTasks(): Promise<readonly Task[]>
  renameTask(input: RenameTaskInput): Promise<Task>
  changeTaskStatus(input: ChangeTaskStatusInput): Promise<Task>
  shutdown(): Promise<void>
}

declare global {
  interface Window {
    __taskPersistenceHarness: PersistenceHarness
  }
}

const opened = openWebTaskRepository()

async function requireRepository(): Promise<TaskRepository> {
  const result = await opened
  if (!('repository' in result)) {
    throw new Error('Task persistence is unavailable.')
  }
  return result.repository
}

window.__taskPersistenceHarness = {
  async capability() {
    return (await opened).capability
  },
  async createTask(input) {
    return (await requireRepository()).createTask(input)
  },
  async listTasks() {
    return (await requireRepository()).listTasks()
  },
  async renameTask(input) {
    return (await requireRepository()).renameTask(input)
  },
  async changeTaskStatus(input) {
    return (await requireRepository()).changeTaskStatus(input)
  },
  async shutdown() {
    const result = await opened
    if ('dispose' in result) {
      await result.dispose()
    }
  },
}

void opened.then((result) => {
  const output = document.querySelector('#capability')
  if (output !== null) {
    output.textContent = result.capability.status
  }
})

export {}
