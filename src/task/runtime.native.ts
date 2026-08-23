import {
  NativeProjectRepository,
  NativeTaskRepository,
} from '@/adapters/native'
import { createProjectService } from '@/project/service'
import { createTaskService } from '@/task/service'
import type { TaskRuntime } from '@/task/runtime.types'

export function openTaskRuntime(): Promise<TaskRuntime> {
  const repository = new NativeTaskRepository()
  return Promise.resolve({
    service: createTaskService({ repository }),
    projectService: createProjectService({
      repository: new NativeProjectRepository(),
    }),
    dispose() {},
  })
}
