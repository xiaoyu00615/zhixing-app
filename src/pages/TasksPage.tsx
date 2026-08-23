import {
  CalendarDays,
  CalendarRange,
  FolderKanban,
  LayoutGrid,
  ListTodo,
  Pencil,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  CreateTaskDialog,
  RenameTaskDialog,
} from '@/components/tasks/TaskDialogs'
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel'
import { TaskCalendarView } from '@/components/tasks/TaskCalendarView'
import { TaskDateView } from '@/components/tasks/TaskDateView'
import { TaskList, type TaskStatusAction } from '@/components/tasks/TaskList'
import { TaskQuadrantView } from '@/components/tasks/TaskQuadrantView'
import { ProjectDialog } from '@/components/tasks/ProjectDialogs'
import { Button } from '@/components/ui/button'
import { localDateFromDate, type LocalDate, type Task } from '@/task/model'
import { openTaskRuntime } from '@/task/runtime'
import type { OpenTaskRuntime } from '@/task/runtime.types'
import { TaskApplicationError, type TaskService } from '@/task/service'
import type { Project } from '@/project/model'
import { ProjectApplicationError, type ProjectService } from '@/project/service'

interface TasksPageProps {
  readonly openRuntime?: OpenTaskRuntime
  readonly today?: LocalDate
}

interface RenameState {
  readonly task: Task
  readonly title: string
  readonly error: string | null
}

function LoadingState() {
  return (
    <div
      className="space-y-2.5 rounded-lg border border-border bg-surface-secondary/35 p-4"
      role="status"
      aria-label="正在加载任务"
    >
      <span className="sr-only">正在加载任务</span>
      {[0, 1, 2].map((item) => (
        <div
          className="h-[58px] animate-pulse rounded-md bg-surface-secondary"
          key={item}
        />
      ))}
    </div>
  )
}

function EmptyState({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-secondary/25 px-6 py-12 text-center">
      <div className="mb-4 flex size-14 items-center justify-center rounded-xl bg-primary-softest text-primary">
        <ListTodo className="size-7" aria-hidden="true" />
      </div>
      <h3 className="text-module font-semibold text-foreground">还没有任务</h3>
      <p className="mt-2 max-w-sm text-body text-foreground-secondary">
        创建第一项任务，把接下来要做的事情放进知行。
      </p>
      <Button className="mt-6" onClick={onCreate} type="button">
        <Plus data-icon="inline-start" />
        新建任务
      </Button>
    </div>
  )
}

export function TasksPage({
  openRuntime = openTaskRuntime,
  today = localDateFromDate(new Date()),
}: TasksPageProps) {
  const mountedRef = useRef(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [service, setService] = useState<TaskService | null>(null)
  const [projectService, setProjectService] = useState<ProjectService | null>(
    null,
  )
  const [tasks, setTasks] = useState<readonly Task[]>([])
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [projectFilter, setProjectFilter] = useState<string>('all')
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  const [view, setView] = useState<'list' | 'quadrant' | 'date' | 'calendar'>(
    'list',
  )
  const [feedback, setFeedback] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [createDueDateError, setCreateDueDateError] = useState<string | null>(
    null,
  )
  const [createIsImportant, setCreateIsImportant] = useState(false)
  const [createIsUrgent, setCreateIsUrgent] = useState(false)
  const [createDueDate, setCreateDueDate] = useState<LocalDate | null>(null)
  const [createProjectId, setCreateProjectId] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(
    new Set(),
  )
  const [projectDialog, setProjectDialog] = useState<{
    mode: 'create' | 'rename'
    projectId: string | null
    name: string
    error: string | null
  } | null>(null)
  const [projectPending, setProjectPending] = useState(false)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenTaskRuntime>> | null = null
    let disposed = false

    async function disposeRuntime(): Promise<void> {
      if (runtime === null || disposed) {
        return
      }
      disposed = true
      try {
        await runtime.dispose()
      } catch {
        // Disposal must never replace the user-facing load result.
      }
    }

    void (async () => {
      try {
        runtime = await openRuntime()
        if (!active) {
          await disposeRuntime()
          return
        }
        const [loadedTasks, loadedProjects] = await Promise.all([
          runtime.service.listTasks(),
          runtime.projectService.listProjects(),
        ])
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        setProjectService(runtime.projectService)
        setTasks(loadedTasks)
        setProjects(loadedProjects)
        setPhase('ready')
      } catch {
        await disposeRuntime()
        if (active) {
          setPhase('error')
        }
      }
    })()

    return () => {
      active = false
      void disposeRuntime()
    }
  }, [loadAttempt, openRuntime])

  const reloadTasks = useCallback(async (currentService: TaskService) => {
    const loadedTasks = await currentService.listTasks()
    if (mountedRef.current) {
      setTasks(loadedTasks)
    }
  }, [])

  const reloadProjects = useCallback(async (currentService: ProjectService) => {
    const loadedProjects = await currentService.listProjects()
    if (mountedRef.current) setProjects(loadedProjects)
  }, [])

  const handleOperationError = useCallback(
    async (error: unknown, currentService: TaskService) => {
      if (!mountedRef.current) {
        return
      }
      if (error instanceof TaskApplicationError && error.code === 'NOT_FOUND') {
        setFeedback('任务已不存在，列表已刷新。')
        try {
          await reloadTasks(currentService)
        } catch {
          if (mountedRef.current) {
            setFeedback('任务暂时无法加载，请稍后重试。')
          }
        }
        return
      }
      if (
        error instanceof TaskApplicationError &&
        error.code === 'STATUS_CONFLICT'
      ) {
        setFeedback('任务状态已经发生变化，列表已刷新。')
        try {
          await reloadTasks(currentService)
        } catch {
          if (mountedRef.current) {
            setFeedback('任务暂时无法加载，请稍后重试。')
          }
        }
        return
      }
      setFeedback('操作暂时无法完成，请重试。')
    },
    [reloadTasks],
  )

  function openCreateDialog(): void {
    setCreateTitle('')
    setCreateError(null)
    setCreateDueDateError(null)
    setCreateIsImportant(false)
    setCreateIsUrgent(false)
    setCreateDueDate(null)
    setCreateProjectId(null)
    setCreateOpen(true)
  }

  function retryLoad(): void {
    setPhase('loading')
    setService(null)
    setProjectService(null)
    setTasks([])
    setProjects([])
    setFeedback(null)
    setLoadAttempt((attempt) => attempt + 1)
  }

  async function submitCreate() {
    if (service === null || isCreating) {
      return
    }
    setIsCreating(true)
    setCreateError(null)
    setCreateDueDateError(null)
    setFeedback(null)
    try {
      await service.createTask({
        title: createTitle,
        isImportant: createIsImportant,
        isUrgent: createIsUrgent,
        dueDate: createDueDate,
        projectId: createProjectId,
      })
      if (!mountedRef.current) {
        return
      }
      setCreateOpen(false)
      setCreateTitle('')
      setCreateIsImportant(false)
      setCreateIsUrgent(false)
      setCreateDueDate(null)
      setCreateProjectId(null)
      try {
        await reloadTasks(service)
      } catch {
        if (mountedRef.current) {
          setFeedback('任务已创建，但列表暂时无法刷新，请稍后重试。')
        }
      }
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return
      }
      if (
        error instanceof TaskApplicationError &&
        error.code === 'VALIDATION' &&
        error.field === 'title'
      ) {
        setCreateError('请输入任务标题。')
      } else if (
        error instanceof TaskApplicationError &&
        error.code === 'VALIDATION' &&
        error.field === 'dueDate'
      ) {
        setCreateDueDateError('请选择有效的截止日期。')
      } else {
        await handleOperationError(error, service)
      }
    } finally {
      if (mountedRef.current) {
        setIsCreating(false)
      }
    }
  }

  function openRenameDialog(task: Task): void {
    setRenameState({ task, title: task.title, error: null })
  }

  async function submitRename() {
    if (
      service === null ||
      renameState === null ||
      pendingTaskIds.has(renameState.task.id)
    ) {
      return
    }
    const { task, title } = renameState
    setPendingTaskIds((current) => new Set(current).add(task.id))
    setRenameState({ task, title, error: null })
    setFeedback(null)
    try {
      await service.renameTask({ id: task.id, title })
      if (!mountedRef.current) {
        return
      }
      setRenameState(null)
      try {
        await reloadTasks(service)
      } catch {
        if (mountedRef.current) {
          setFeedback('任务已重命名，但列表暂时无法刷新，请稍后重试。')
        }
      }
    } catch (error: unknown) {
      if (!mountedRef.current) {
        return
      }
      if (
        error instanceof TaskApplicationError &&
        error.code === 'VALIDATION' &&
        error.field === 'title'
      ) {
        setRenameState({ task, title, error: '请输入任务标题。' })
      } else {
        if (
          error instanceof TaskApplicationError &&
          error.code === 'NOT_FOUND'
        ) {
          setRenameState(null)
        }
        await handleOperationError(error, service)
      }
    } finally {
      if (mountedRef.current) {
        setPendingTaskIds((current) => {
          const next = new Set(current)
          next.delete(task.id)
          return next
        })
      }
    }
  }

  async function runStatusAction(task: Task, action: TaskStatusAction) {
    if (service === null || pendingTaskIds.has(task.id)) {
      return
    }
    setPendingTaskIds((current) => new Set(current).add(task.id))
    setFeedback(null)
    try {
      await service[action](task.id)
      try {
        await reloadTasks(service)
      } catch {
        if (mountedRef.current) {
          setFeedback('任务已更新，但列表暂时无法刷新，请稍后重试。')
        }
      }
    } catch (error: unknown) {
      await handleOperationError(error, service)
    } finally {
      if (mountedRef.current) {
        setPendingTaskIds((current) => {
          const next = new Set(current)
          next.delete(task.id)
          return next
        })
      }
    }
  }

  async function runPlanningAction(
    task: Task,
    operation: (currentService: TaskService) => Promise<Task>,
  ) {
    if (service === null || pendingTaskIds.has(task.id)) {
      return
    }
    setPendingTaskIds((current) => new Set(current).add(task.id))
    setFeedback(null)
    try {
      await operation(service)
      try {
        await reloadTasks(service)
      } catch {
        if (mountedRef.current) {
          setFeedback('任务规划已更新，但列表暂时无法刷新，请稍后重试。')
        }
      }
    } catch (error: unknown) {
      await handleOperationError(error, service)
    } finally {
      if (mountedRef.current) {
        setPendingTaskIds((current) => {
          const next = new Set(current)
          next.delete(task.id)
          return next
        })
      }
    }
  }

  async function submitProject(): Promise<void> {
    if (projectService === null || projectDialog === null || projectPending)
      return
    setProjectPending(true)
    setProjectDialog({ ...projectDialog, error: null })
    try {
      if (projectDialog.mode === 'create') {
        await projectService.createProject(projectDialog.name)
      } else if (projectDialog.projectId !== null) {
        await projectService.renameProject(
          projectDialog.projectId,
          projectDialog.name,
        )
      }
      if (!mountedRef.current) return
      setProjectDialog(null)
      await reloadProjects(projectService)
    } catch (error: unknown) {
      if (!mountedRef.current) return
      if (
        error instanceof ProjectApplicationError &&
        error.code === 'VALIDATION' &&
        error.field === 'name'
      ) {
        setProjectDialog({ ...projectDialog, error: '请输入项目名称。' })
      } else {
        setFeedback('项目操作暂时无法完成，请重试。')
      }
    } finally {
      if (mountedRef.current) setProjectPending(false)
    }
  }

  const visibleTasks = tasks.filter((task) => {
    if (projectFilter === 'all') return true
    if (projectFilter === 'none') return task.projectId === null
    return task.projectId === projectFilter
  })

  const detailTask =
    detailTaskId === null
      ? null
      : (tasks.find((task) => task.id === detailTaskId) ?? null)

  return (
    <section className="min-w-0 space-y-5" aria-labelledby="tasks-page-title">
      <h2 className="sr-only" id="tasks-page-title">
        任务
      </h2>

      {phase === 'ready' && (
        <div className="flex min-h-16 flex-wrap items-end justify-between gap-x-6 gap-y-3 border-b border-border">
          <div
            aria-label="任务视图"
            className="flex h-16 items-end gap-8"
            role="tablist"
          >
            <Button
              aria-controls="task-list-panel"
              aria-selected={view === 'list'}
              className={
                view === 'list'
                  ? 'h-16 rounded-none border-x-0 border-t-0 border-b-2 border-b-primary bg-transparent px-0 text-primary hover:bg-transparent'
                  : 'h-16 rounded-none border-0 bg-transparent px-0 text-foreground-secondary hover:bg-transparent hover:text-foreground'
              }
              id="task-list-tab"
              onClick={() => setView('list')}
              role="tab"
              type="button"
              variant="ghost"
            >
              <ListTodo data-icon="inline-start" />
              列表
            </Button>
            <Button
              aria-controls="task-quadrant-panel"
              aria-selected={view === 'quadrant'}
              className={
                view === 'quadrant'
                  ? 'h-16 rounded-none border-x-0 border-t-0 border-b-2 border-b-primary bg-transparent px-0 text-primary hover:bg-transparent'
                  : 'h-16 rounded-none border-0 bg-transparent px-0 text-foreground-secondary hover:bg-transparent hover:text-foreground'
              }
              id="task-quadrant-tab"
              onClick={() => setView('quadrant')}
              role="tab"
              type="button"
              variant="ghost"
            >
              <LayoutGrid data-icon="inline-start" />
              四象限
            </Button>
            <Button
              aria-controls="task-date-panel"
              aria-selected={view === 'date'}
              className={
                view === 'date'
                  ? 'h-16 rounded-none border-x-0 border-t-0 border-b-2 border-b-primary bg-transparent px-0 text-primary hover:bg-transparent'
                  : 'h-16 rounded-none border-0 bg-transparent px-0 text-foreground-secondary hover:bg-transparent hover:text-foreground'
              }
              id="task-date-tab"
              onClick={() => setView('date')}
              role="tab"
              type="button"
              variant="ghost"
            >
              <CalendarDays data-icon="inline-start" />
              日期
            </Button>
            <Button
              aria-controls="task-calendar-panel"
              aria-selected={view === 'calendar'}
              className={
                view === 'calendar'
                  ? 'h-16 rounded-none border-x-0 border-t-0 border-b-2 border-b-primary bg-transparent px-0 text-primary hover:bg-transparent'
                  : 'h-16 rounded-none border-0 bg-transparent px-0 text-foreground-secondary hover:bg-transparent hover:text-foreground'
              }
              id="task-calendar-tab"
              onClick={() => setView('calendar')}
              role="tab"
              type="button"
              variant="ghost"
            >
              <CalendarRange data-icon="inline-start" />
              日历
            </Button>
          </div>

          <div className="flex items-center gap-3 pb-2.5">
            <span className="text-auxiliary text-foreground-secondary">
              {projectFilter === 'all'
                ? `${tasks.length} 项任务`
                : `${visibleTasks.length} / ${tasks.length} 项任务`}
            </span>
            {tasks.length > 0 && (
              <Button onClick={openCreateDialog} type="button">
                <Plus data-icon="inline-start" />
                新建任务
              </Button>
            )}
          </div>
        </div>
      )}

      {phase === 'ready' && (
        <div
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-surface px-3 py-2.5"
          aria-label="项目筛选"
        >
          <div className="flex min-w-0 flex-wrap items-center gap-1.5">
            <span className="mr-1 inline-flex items-center gap-1.5 px-1 text-auxiliary font-medium text-foreground-tertiary">
              <FolderKanban className="size-4" aria-hidden="true" />
              项目
            </span>
            {[
              { id: 'all', name: '全部' },
              { id: 'none', name: '无项目' },
              ...projects,
            ].map((project) => (
              <Button
                key={project.id}
                aria-pressed={projectFilter === project.id}
                className={
                  projectFilter === project.id
                    ? 'bg-primary-softest text-primary hover:bg-primary-softest'
                    : undefined
                }
                size="sm"
                type="button"
                variant="ghost"
                onClick={() => setProjectFilter(project.id)}
              >
                {project.name}
              </Button>
            ))}
          </div>
          <div className="flex items-center gap-1">
            {projects.map((project) => (
              <Button
                key={project.id}
                aria-label={`重命名项目：${project.name}`}
                size="icon-sm"
                title={`重命名 ${project.name}`}
                type="button"
                variant="ghost"
                onClick={() =>
                  setProjectDialog({
                    mode: 'rename',
                    projectId: project.id,
                    name: project.name,
                    error: null,
                  })
                }
              >
                <Pencil aria-hidden="true" />
              </Button>
            ))}
            <Button
              size="sm"
              type="button"
              variant="outline"
              onClick={() =>
                setProjectDialog({
                  mode: 'create',
                  projectId: null,
                  name: '',
                  error: null,
                })
              }
            >
              <Plus data-icon="inline-start" />
              新建项目
            </Button>
          </div>
        </div>
      )}

      {feedback !== null && (
        <div
          className="rounded-sm border border-warning/20 bg-warning-soft px-4 py-3 text-body text-foreground"
          role="status"
        >
          {feedback}
        </div>
      )}

      {phase === 'loading' && <LoadingState />}

      {phase === 'error' && (
        <div
          className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-danger/15 bg-danger-soft/35 px-6 py-12 text-center"
          role="alert"
        >
          <div className="mb-4 flex size-14 items-center justify-center rounded-xl bg-danger-soft text-danger">
            <X className="size-7" aria-hidden="true" />
          </div>
          <h3 className="text-module font-semibold text-foreground">
            无法加载任务
          </h3>
          <p className="mt-2 max-w-md text-body text-foreground-secondary">
            当前本地任务数据暂时不可用。请确认存储环境后重试。
          </p>
          <Button className="mt-6" onClick={retryLoad} type="button">
            <RotateCcw data-icon="inline-start" />
            重试
          </Button>
        </div>
      )}

      {phase === 'ready' && view === 'list' && (
        <div
          aria-labelledby="task-list-tab"
          id="task-list-panel"
          role="tabpanel"
        >
          {visibleTasks.length === 0 ? (
            <EmptyState onCreate={openCreateDialog} />
          ) : (
            <TaskList
              projects={projects}
              onClearDeadline={(task) =>
                void runPlanningAction(task, (currentService) =>
                  currentService.clearTaskDeadline(task.id),
                )
              }
              onOpenDetail={(task) => setDetailTaskId(task.id)}
              onRename={openRenameDialog}
              onSetDeadline={(task, dueDate) =>
                void runPlanningAction(task, (currentService) =>
                  currentService.setTaskDeadline(task.id, dueDate),
                )
              }
              onSetImportance={(task, isImportant) =>
                void runPlanningAction(task, (currentService) =>
                  currentService.setTaskImportance(task.id, isImportant),
                )
              }
              onSetUrgency={(task, isUrgent) =>
                void runPlanningAction(task, (currentService) =>
                  currentService.setTaskUrgency(task.id, isUrgent),
                )
              }
              onStatusAction={(task, action) =>
                void runStatusAction(task, action)
              }
              pendingTaskIds={pendingTaskIds}
              tasks={visibleTasks}
              today={today}
            />
          )}
        </div>
      )}

      {phase === 'ready' && view === 'quadrant' && (
        <div
          aria-labelledby="task-quadrant-tab"
          id="task-quadrant-panel"
          role="tabpanel"
        >
          <TaskQuadrantView
            projects={projects}
            onClearDeadline={(task) =>
              void runPlanningAction(task, (currentService) =>
                currentService.clearTaskDeadline(task.id),
              )
            }
            onCreate={openCreateDialog}
            onOpenDetail={(task) => setDetailTaskId(task.id)}
            onSetDeadline={(task, dueDate) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskDeadline(task.id, dueDate),
              )
            }
            onSetImportance={(task, isImportant) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskImportance(task.id, isImportant),
              )
            }
            onSetUrgency={(task, isUrgent) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskUrgency(task.id, isUrgent),
              )
            }
            onStatusAction={(task, action) =>
              void runStatusAction(task, action)
            }
            pendingTaskIds={pendingTaskIds}
            tasks={visibleTasks}
            today={today}
          />
        </div>
      )}

      {phase === 'ready' && view === 'date' && (
        <div
          aria-labelledby="task-date-tab"
          id="task-date-panel"
          role="tabpanel"
        >
          <TaskDateView
            projects={projects}
            onClearDeadline={(task) =>
              void runPlanningAction(task, (currentService) =>
                currentService.clearTaskDeadline(task.id),
              )
            }
            onCreate={openCreateDialog}
            onOpenDetail={(task) => setDetailTaskId(task.id)}
            onRename={openRenameDialog}
            onSetDeadline={(task, dueDate) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskDeadline(task.id, dueDate),
              )
            }
            onSetImportance={(task, isImportant) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskImportance(task.id, isImportant),
              )
            }
            onSetUrgency={(task, isUrgent) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskUrgency(task.id, isUrgent),
              )
            }
            onStatusAction={(task, action) =>
              void runStatusAction(task, action)
            }
            pendingTaskIds={pendingTaskIds}
            tasks={visibleTasks}
            today={today}
          />
        </div>
      )}

      {phase === 'ready' && view === 'calendar' && (
        <div
          aria-labelledby="task-calendar-tab"
          id="task-calendar-panel"
          role="tabpanel"
        >
          <TaskCalendarView
            projects={projects}
            onClearDeadline={(task) =>
              void runPlanningAction(task, (currentService) =>
                currentService.clearTaskDeadline(task.id),
              )
            }
            onCreate={openCreateDialog}
            onOpenDetail={(task) => setDetailTaskId(task.id)}
            onRename={openRenameDialog}
            onSetDeadline={(task, dueDate) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskDeadline(task.id, dueDate),
              )
            }
            onSetImportance={(task, isImportant) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskImportance(task.id, isImportant),
              )
            }
            onSetUrgency={(task, isUrgent) =>
              void runPlanningAction(task, (currentService) =>
                currentService.setTaskUrgency(task.id, isUrgent),
              )
            }
            onStatusAction={(task, action) =>
              void runStatusAction(task, action)
            }
            pendingTaskIds={pendingTaskIds}
            tasks={visibleTasks}
            today={today}
          />
        </div>
      )}

      <TaskDetailPanel
        projects={projects}
        onClearDeadline={(task) =>
          void runPlanningAction(task, (currentService) =>
            currentService.clearTaskDeadline(task.id),
          )
        }
        onOpenChange={(open) => {
          if (!open) {
            setDetailTaskId(null)
          }
        }}
        onRename={openRenameDialog}
        onSetDeadline={(task, dueDate) =>
          void runPlanningAction(task, (currentService) =>
            currentService.setTaskDeadline(task.id, dueDate),
          )
        }
        onSetImportance={(task, isImportant) =>
          void runPlanningAction(task, (currentService) =>
            currentService.setTaskImportance(task.id, isImportant),
          )
        }
        onSetUrgency={(task, isUrgent) =>
          void runPlanningAction(task, (currentService) =>
            currentService.setTaskUrgency(task.id, isUrgent),
          )
        }
        onSetProject={(task, projectId) =>
          void runPlanningAction(task, (currentService) =>
            currentService.setTaskProject(task.id, projectId),
          )
        }
        onClearProject={(task) =>
          void runPlanningAction(task, (currentService) =>
            currentService.clearTaskProject(task.id),
          )
        }
        onStatusAction={(task, action) => void runStatusAction(task, action)}
        pending={detailTask !== null && pendingTaskIds.has(detailTask.id)}
        task={detailTask}
        today={today}
      />

      <CreateTaskDialog
        projects={projects}
        projectId={createProjectId}
        dueDate={createDueDate}
        dueDateError={createDueDateError}
        error={createError}
        isImportant={createIsImportant}
        isUrgent={createIsUrgent}
        open={createOpen}
        onDueDateChange={(dueDate) => {
          setCreateDueDate(dueDate)
          setCreateDueDateError(null)
        }}
        onImportanceChange={setCreateIsImportant}
        onOpenChange={setCreateOpen}
        onSubmit={() => void submitCreate()}
        onTitleChange={(title) => {
          setCreateTitle(title)
          setCreateError(null)
        }}
        onUrgencyChange={setCreateIsUrgent}
        onProjectChange={setCreateProjectId}
        pending={isCreating}
        title={createTitle}
      />

      <RenameTaskDialog
        error={renameState?.error ?? null}
        onClose={() => setRenameState(null)}
        onSubmit={() => void submitRename()}
        onTitleChange={(title) => {
          if (renameState !== null) {
            setRenameState({ ...renameState, title, error: null })
          }
        }}
        pending={
          renameState !== null && pendingTaskIds.has(renameState.task.id)
        }
        task={renameState?.task ?? null}
        title={renameState?.title ?? ''}
      />

      <ProjectDialog
        mode={projectDialog?.mode ?? 'create'}
        open={projectDialog !== null}
        name={projectDialog?.name ?? ''}
        error={projectDialog?.error ?? null}
        pending={projectPending}
        onOpenChange={(open) => {
          if (!open) setProjectDialog(null)
        }}
        onNameChange={(name) => {
          if (projectDialog !== null)
            setProjectDialog({ ...projectDialog, name, error: null })
        }}
        onSubmit={() => void submitProject()}
      />
    </section>
  )
}
