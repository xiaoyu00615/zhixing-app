import { openWebTaskRepository } from '@/adapters/web'
import { createTaskService, TaskApplicationError } from '@/task/service'
import type { TaskRuntime } from '@/task/runtime.types'

export async function openTaskRuntime(): Promise<TaskRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('repository' in opened)) {
      throw new TaskApplicationError('UNAVAILABLE')
    }

    return {
      service: createTaskService({ repository: opened.repository }),
      dispose: opened.dispose,
    }
  } catch {
    throw new TaskApplicationError('UNAVAILABLE')
  }
}
