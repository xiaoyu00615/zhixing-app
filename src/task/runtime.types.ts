import type { TaskService } from '@/task/service'
import type { ProjectService } from '@/project/service'
import type { TagService } from '@/tag/service'

export interface TaskRuntime {
  readonly service: TaskService
  readonly projectService: ProjectService
  readonly tagService: TagService
  dispose(): Promise<void> | void
}

export type OpenTaskRuntime = () => Promise<TaskRuntime>
