import {
  CalendarDays,
  CalendarRange,
  Filter,
  LayoutGrid,
  ListTodo,
  Plus,
  RotateCcw,
  X,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import {
  CreateTaskDialog,
  RenameTaskDialog,
} from '@/components/tasks/TaskDialogs'
import { TaskDetailPanel } from '@/components/tasks/TaskDetailPanel'
import { TaskCalendarView } from '@/components/tasks/TaskCalendarView'
import { TaskDateView } from '@/components/tasks/TaskDateView'
import { TaskList, type TaskStatusAction } from '@/components/tasks/TaskList'
import { TaskQuadrantView } from '@/components/tasks/TaskQuadrantView'
import { TaskFilterBar } from '@/components/tasks/TaskFilterBar'
import { ProjectDialog } from '@/components/tasks/ProjectDialogs'
import { TagDialog } from '@/components/tasks/TagDialogs'
import { Button } from '@/components/ui/button'
import {
  DEFAULT_TASK_FILTER,
  filterTasks,
  localDateFromDate,
  type LocalDate,
  type Task,
  type TaskFilter,
} from '@/task/model'
import { openTaskRuntime } from '@/task/runtime'
import type { OpenTaskRuntime } from '@/task/runtime.types'
import { TaskApplicationError, type TaskService } from '@/task/service'
import type { Project } from '@/project/model'
import { ProjectApplicationError, type ProjectService } from '@/project/service'
import type { Tag } from '@/tag/model'
import { TagApplicationError, type TagService } from '@/tag/service'

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
  const [tagService, setTagService] = useState<TagService | null>(null)
  const [tasks, setTasks] = useState<readonly Task[]>([])
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [tags, setTags] = useState<readonly Tag[]>([])
  const [filter, setFilter] = useState<TaskFilter>(DEFAULT_TASK_FILTER)
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
  const [createTagIds, setCreateTagIds] = useState<readonly string[]>([])
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
  const [tagDialog, setTagDialog] = useState<{
    mode: 'create' | 'rename'
    tagId: string | null
    name: string
    error: string | null
  } | null>(null)
  const [tagPending, setTagPending] = useState(false)

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
        const [loadedTasks, loadedProjects, loadedTags] = await Promise.all([
          runtime.service.listTasks(),
          runtime.projectService.listProjects(),
          runtime.tagService.listTags(),
        ])
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        setProjectService(runtime.projectService)
        setTagService(runtime.tagService)
        setTasks(loadedTasks)
        setProjects(loadedProjects)
        setTags(loadedTags)
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

  const reloadTasks = useCallback(
    async (currentService: TaskService) => {
      const loadedTasks = await currentService.listTasks()
      if (mountedRef.current) {
        setTasks(loadedTasks)
        setDetailTaskId((current) =>
          current === null ||
          filterTasks(loadedTasks, filter, today).some(
            (task) => task.id === current,
          )
            ? current
            : null,
        )
      }
    },
    [filter, today],
  )

  const reloadProjects = useCallback(async (currentService: ProjectService) => {
    const loadedProjects = await currentService.listProjects()
    if (mountedRef.current) setProjects(loadedProjects)
  }, [])

  const reloadTags = useCallback(async (currentService: TagService) => {
    const loadedTags = await currentService.listTags()
    if (mountedRef.current) setTags(loadedTags)
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
    setCreateTagIds([])
    setCreateOpen(true)
  }

  function retryLoad(): void {
    setPhase('loading')
    setService(null)
    setProjectService(null)
    setTagService(null)
    setTasks([])
    setProjects([])
    setTags([])
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
        tagIds: createTagIds,
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
      setCreateTagIds([])
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

  async function submitTag(): Promise<void> {
    if (tagService === null || tagDialog === null || tagPending) return
    setTagPending(true)
    setTagDialog({ ...tagDialog, error: null })
    try {
      if (tagDialog.mode === 'create') {
        await tagService.createTag(tagDialog.name)
      } else if (tagDialog.tagId !== null) {
        await tagService.renameTag(tagDialog.tagId, tagDialog.name)
      }
      if (!mountedRef.current) return
      setTagDialog(null)
      await reloadTags(tagService)
    } catch (error: unknown) {
      if (!mountedRef.current) return
      if (
        error instanceof TagApplicationError &&
        error.code === 'VALIDATION' &&
        error.field === 'name'
      ) {
        setTagDialog({ ...tagDialog, error: '请输入标签名称。' })
      } else {
        setFeedback('标签操作暂时无法完成，请检查是否存在同名标签。')
      }
    } finally {
      if (mountedRef.current) setTagPending(false)
    }
  }

  const visibleTasks = useMemo(
    () => filterTasks(tasks, filter, today),
    [filter, tasks, today],
  )
  const hasActiveFilter = Object.values(filter).some((value) => value !== 'all')

  function changeFilter(nextFilter: TaskFilter): void {
    setFilter(nextFilter)
    if (
      detailTaskId !== null &&
      !filterTasks(tasks, nextFilter, today).some(
        (task) => task.id === detailTaskId,
      )
    ) {
      setDetailTaskId(null)
    }
  }

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
              {!hasActiveFilter
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
        <TaskFilterBar
          filter={filter}
          onChange={changeFilter}
          projects={projects}
          tags={tags}
          onCreateProject={() =>
            setProjectDialog({
              mode: 'create',
              projectId: null,
              name: '',
              error: null,
            })
          }
          onRenameProject={(project) =>
            setProjectDialog({
              mode: 'rename',
              projectId: project.id,
              name: project.name,
              error: null,
            })
          }
          onCreateTag={() =>
            setTagDialog({
              mode: 'create',
              tagId: null,
              name: '',
              error: null,
            })
          }
          onRenameTag={(tag) =>
            setTagDialog({
              mode: 'rename',
              tagId: tag.id,
              name: tag.name,
              error: null,
            })
          }
        />
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
            tasks.length === 0 ? (
              <EmptyState onCreate={openCreateDialog} />
            ) : (
              <div className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-secondary/20 px-6 py-10 text-center">
                <Filter
                  aria-hidden="true"
                  className="mb-3 size-6 text-foreground-tertiary"
                />
                <h3 className="text-body font-semibold text-foreground">
                  没有符合条件的任务
                </h3>
                <p className="mt-1 text-sm text-foreground-secondary">
                  调整或清除筛选条件后再查看。
                </p>
                <Button
                  className="mt-4"
                  onClick={() => setFilter(DEFAULT_TASK_FILTER)}
                  size="sm"
                  type="button"
                  variant="outline"
                >
                  清除全部筛选
                </Button>
              </div>
            )
          ) : (
            <TaskList
              projects={projects}
              tags={tags}
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
            tags={tags}
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
            tags={tags}
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
            tags={tags}
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
        tags={tags}
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
        onAddTag={(task, tagId) =>
          void runPlanningAction(task, (currentService) =>
            currentService.addTaskTag(task.id, tagId),
          )
        }
        onRemoveTag={(task, tagId) =>
          void runPlanningAction(task, (currentService) =>
            currentService.removeTaskTag(task.id, tagId),
          )
        }
        onStatusAction={(task, action) => void runStatusAction(task, action)}
        pending={detailTask !== null && pendingTaskIds.has(detailTask.id)}
        task={detailTask}
        today={today}
      />

      <CreateTaskDialog
        projects={projects}
        tags={tags}
        tagIds={createTagIds}
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
        onTagIdsChange={setCreateTagIds}
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

      <TagDialog
        mode={tagDialog?.mode ?? 'create'}
        open={tagDialog !== null}
        name={tagDialog?.name ?? ''}
        error={tagDialog?.error ?? null}
        pending={tagPending}
        onOpenChange={(open) => {
          if (!open) setTagDialog(null)
        }}
        onNameChange={(name) => {
          if (tagDialog !== null)
            setTagDialog({ ...tagDialog, name, error: null })
        }}
        onSubmit={() => void submitTag()}
      />
    </section>
  )
}
