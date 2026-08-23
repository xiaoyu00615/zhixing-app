import { openWebTaskRepository } from '@/adapters/web'
import { createTaskService, TaskApplicationError } from '@/task/service'
import type { TaskRuntime } from '@/task/runtime.types'
import { createProjectService } from '@/project/service'
import { createTagService } from '@/tag/service'

export async function openTaskRuntime(): Promise<TaskRuntime> {
  try {
    const opened = await openWebTaskRepository()
    if (!('repository' in opened)) {
      throw new TaskApplicationError('UNAVAILABLE')
    }

    return {
      service: createTaskService({ repository: opened.repository }),
      projectService: createProjectService({
        repository: opened.projectRepository,
      }),
      tagService: createTagService({ repository: opened.tagRepository }),
      dispose: opened.dispose,
    }
  } catch {
    throw new TaskApplicationError('UNAVAILABLE')
  }
}
