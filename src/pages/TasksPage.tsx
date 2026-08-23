import { ListTodo, Plus, RotateCcw, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import {
  CreateTaskDialog,
  RenameTaskDialog,
} from '@/components/tasks/TaskDialogs'
import { TaskList, type TaskStatusAction } from '@/components/tasks/TaskList'
import { Button } from '@/components/ui/button'
import type { Task } from '@/task/model'
import { openTaskRuntime } from '@/task/runtime'
import type { OpenTaskRuntime } from '@/task/runtime.types'
import { TaskApplicationError, type TaskService } from '@/task/service'

interface TasksPageProps {
  readonly openRuntime?: OpenTaskRuntime
}

interface RenameState {
  readonly task: Task
  readonly title: string
  readonly error: string | null
}

function LoadingState() {
  return (
    <div
      className="space-y-3 rounded-lg border border-border bg-surface p-5 shadow-card"
      role="status"
      aria-label="正在加载任务"
    >
      <span className="sr-only">正在加载任务</span>
      {[0, 1, 2].map((item) => (
        <div
          className="h-[50px] animate-pulse rounded-sm bg-surface-secondary"
          key={item}
        />
      ))}
    </div>
  )
}

function EmptyState({ onCreate }: { readonly onCreate: () => void }) {
  return (
    <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-border bg-surface px-6 py-12 text-center shadow-card">
      <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-primary-softest text-primary">
        <ListTodo className="size-8" aria-hidden="true" />
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

export function TasksPage({ openRuntime = openTaskRuntime }: TasksPageProps) {
  const mountedRef = useRef(false)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [service, setService] = useState<TaskService | null>(null)
  const [tasks, setTasks] = useState<readonly Task[]>([])
  const [feedback, setFeedback] = useState<string | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [createTitle, setCreateTitle] = useState('')
  const [createError, setCreateError] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [renameState, setRenameState] = useState<RenameState | null>(null)
  const [pendingTaskIds, setPendingTaskIds] = useState<ReadonlySet<string>>(
    new Set(),
  )

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
        const loadedTasks = await runtime.service.listTasks()
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        setTasks(loadedTasks)
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
    setCreateOpen(true)
  }

  function retryLoad(): void {
    setPhase('loading')
    setService(null)
    setTasks([])
    setFeedback(null)
    setLoadAttempt((attempt) => attempt + 1)
  }

  async function submitCreate() {
    if (service === null || isCreating) {
      return
    }
    setIsCreating(true)
    setCreateError(null)
    setFeedback(null)
    try {
      await service.createTask({ title: createTitle })
      if (!mountedRef.current) {
        return
      }
      setCreateOpen(false)
      setCreateTitle('')
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

  return (
    <section className="space-y-6" aria-labelledby="tasks-page-title">
      <div className="flex items-start justify-between gap-6">
        <div>
          <h2
            className="text-title font-semibold text-foreground"
            id="tasks-page-title"
          >
            任务
          </h2>
          <p className="mt-1 text-body text-foreground-secondary">
            管理当前任务及其执行状态。
          </p>
        </div>
        {phase === 'ready' && tasks.length > 0 && (
          <Button onClick={openCreateDialog} type="button">
            <Plus data-icon="inline-start" />
            新建任务
          </Button>
        )}
      </div>

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
          className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-border bg-surface px-6 py-12 text-center shadow-card"
          role="alert"
        >
          <div className="mb-4 flex size-16 items-center justify-center rounded-2xl bg-danger-soft text-danger">
            <X className="size-8" aria-hidden="true" />
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

      {phase === 'ready' && tasks.length === 0 && (
        <EmptyState onCreate={openCreateDialog} />
      )}

      {phase === 'ready' && tasks.length > 0 && (
        <TaskList
          onRename={openRenameDialog}
          onStatusAction={(task, action) => void runStatusAction(task, action)}
          pendingTaskIds={pendingTaskIds}
          tasks={tasks}
        />
      )}

      <CreateTaskDialog
        error={createError}
        open={createOpen}
        onOpenChange={setCreateOpen}
        onSubmit={() => void submitCreate()}
        onTitleChange={(title) => {
          setCreateTitle(title)
          setCreateError(null)
        }}
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
    </section>
  )
}
