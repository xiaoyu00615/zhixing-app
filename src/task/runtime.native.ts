import { NativeTaskRepository } from '@/adapters/native'
import { createTaskService } from '@/task/service'
import type { TaskRuntime } from '@/task/runtime.types'

export function openTaskRuntime(): Promise<TaskRuntime> {
  const repository = new NativeTaskRepository()
  return Promise.resolve({
    service: createTaskService({ repository }),
    dispose() {},
  })
}
