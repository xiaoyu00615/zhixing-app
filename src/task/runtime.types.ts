import type { TaskService } from '@/task/service'
import type { ProjectService } from '@/project/service'

export interface TaskRuntime {
  readonly service: TaskService
  readonly projectService: ProjectService
  dispose(): Promise<void> | void
}

export type OpenTaskRuntime = () => Promise<TaskRuntime>
