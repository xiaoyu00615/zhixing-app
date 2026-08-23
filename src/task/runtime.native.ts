import {
  NativeProjectRepository,
  NativeTagRepository,
  NativeTaskRepository,
} from '@/adapters/native'
import { createProjectService } from '@/project/service'
import { createTagService } from '@/tag/service'
import { createTaskService } from '@/task/service'
import type { TaskRuntime } from '@/task/runtime.types'

export function openTaskRuntime(): Promise<TaskRuntime> {
  const repository = new NativeTaskRepository()
  return Promise.resolve({
    service: createTaskService({ repository }),
    projectService: createProjectService({
      repository: new NativeProjectRepository(),
    }),
    tagService: createTagService({ repository: new NativeTagRepository() }),
    dispose() {},
  })
}
