import type { TaskService } from '@/task/service'

export interface TaskRuntime {
  readonly service: TaskService
  dispose(): Promise<void> | void
}

export type OpenTaskRuntime = () => Promise<TaskRuntime>
