import {
  CalendarDays,
  Clock3,
  RotateCcw,
  Star,
  Tags,
  Trash2,
  Zap,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { ProjectChip } from '@/components/tasks/ProjectChip'
import { TagChip } from '@/components/tasks/TagChip'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { Project } from '@/project/model'
import type { Tag } from '@/tag/model'
import type { Task } from '@/task/model'
import { openTaskRuntime } from '@/task/runtime'
import type { OpenTaskRuntime } from '@/task/runtime.types'
import type { TaskService } from '@/task/service'

interface TrashPageProps {
  readonly openRuntime?: OpenTaskRuntime
}

const STATUS_LABELS: Record<Task['status'], string> = {
  todo: '待开始',
  doing: '进行中',
  completed: '已完成',
  cancelled: '已取消',
}

function formatDateTime(timestamp: number | null): string {
  if (timestamp === null) return '时间未知'
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

export function TrashPage({ openRuntime = openTaskRuntime }: TrashPageProps) {
  const mountedRef = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [service, setService] = useState<TaskService | null>(null)
  const [tasks, setTasks] = useState<readonly Task[]>([])
  const [projects, setProjects] = useState<readonly Project[]>([])
  const [tags, setTags] = useState<readonly Tag[]>([])
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [feedback, setFeedback] = useState<string | null>(null)

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
      if (runtime === null || disposed) return
      disposed = true
      try {
        await runtime.dispose()
      } catch {
        // Disposal does not replace the visible load state.
      }
    }

    void (async () => {
      setPhase('loading')
      try {
        runtime = await openRuntime()
        if (!active) {
          await disposeRuntime()
          return
        }
        const [loadedTasks, loadedProjects, loadedTags] = await Promise.all([
          runtime.service.listTrashedTasks(),
          runtime.projectService.listProjects(),
          runtime.tagService.listTags(),
        ])
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        setTasks(loadedTasks)
        setProjects(loadedProjects)
        setTags(loadedTags)
        setPhase('ready')
      } catch {
        await disposeRuntime()
        if (active) setPhase('error')
      }
    })()

    return () => {
      active = false
      void disposeRuntime()
    }
  }, [attempt, openRuntime])

  const restoreTask = useCallback(
    async (task: Task) => {
      if (service === null || pending.has(task.id)) return
      setPending((current) => new Set(current).add(task.id))
      setFeedback(null)
      try {
        await service.restoreTask(task.id)
        const loadedTasks = await service.listTrashedTasks()
        if (mountedRef.current) {
          setTasks(loadedTasks)
          setFeedback(`“${task.title}”已恢复到任务列表。`)
        }
      } catch {
        if (mountedRef.current) setFeedback('恢复失败，请稍后重试。')
      } finally {
        if (mountedRef.current) {
          setPending((current) => {
            const next = new Set(current)
            next.delete(task.id)
            return next
          })
        }
      }
    },
    [pending, service],
  )

  const projectsById = new Map(projects.map((project) => [project.id, project]))
  const tagsById = new Map(tags.map((tag) => [tag.id, tag]))

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-6 pb-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-caption font-semibold tracking-[0.18em] text-foreground-tertiary uppercase">
            Task archive
          </p>
          <h2 className="mt-1 text-hero font-semibold tracking-tight text-foreground">
            回收站
          </h2>
          <p className="mt-2 text-body text-foreground-secondary">
            已移入回收站的任务会保留原有信息，可随时恢复。
          </p>
        </div>
        {phase === 'ready' && tasks.length > 0 && (
          <Badge variant="outline">{tasks.length} 项任务</Badge>
        )}
      </header>

      {feedback !== null && (
        <div
          className="rounded-sm border border-info/20 bg-info-soft/50 px-4 py-3 text-body text-foreground"
          role="status"
        >
          {feedback}
        </div>
      )}

      {phase === 'loading' && (
        <div className="space-y-3" role="status" aria-label="正在加载回收站">
          {[0, 1].map((item) => (
            <div
              className="h-32 animate-pulse rounded-lg border border-border bg-surface-secondary/40"
              key={item}
            />
          ))}
        </div>
      )}

      {phase === 'error' && (
        <div
          className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-danger/15 bg-danger-soft/30 p-8 text-center"
          role="alert"
        >
          <Trash2 className="size-9 text-danger" aria-hidden="true" />
          <h3 className="mt-4 text-module font-semibold">无法加载回收站</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            本地任务数据暂时不可用，请稍后重试。
          </p>
          <Button
            className="mt-5"
            onClick={() => setAttempt((value) => value + 1)}
            type="button"
          >
            <RotateCcw data-icon="inline-start" />
            重试
          </Button>
        </div>
      )}

      {phase === 'ready' && tasks.length === 0 && (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-secondary/20 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-xl bg-surface-secondary text-foreground-tertiary">
            <Trash2 className="size-7" aria-hidden="true" />
          </div>
          <h3 className="mt-4 text-module font-semibold">回收站是空的</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            移入回收站的任务会显示在这里。
          </p>
        </div>
      )}

      {phase === 'ready' && tasks.length > 0 && (
        <ul aria-label="回收站任务" className="grid gap-3">
          {tasks.map((task) => {
            const project =
              task.projectId === null
                ? undefined
                : projectsById.get(task.projectId)
            return (
              <li
                className="rounded-lg border border-border bg-surface px-5 py-4 shadow-xs"
                key={task.id}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="min-w-0 break-words text-[15px] leading-6 font-semibold text-foreground">
                        {task.title}
                      </h3>
                      <Badge variant="outline">
                        {STATUS_LABELS[task.status]}
                      </Badge>
                      {task.isImportant && (
                        <Badge variant="destructive">重要</Badge>
                      )}
                      {task.isUrgent && (
                        <Badge
                          className="border-warning/20 bg-warning-soft text-warning"
                          variant="outline"
                        >
                          基础紧急
                        </Badge>
                      )}
                    </div>
                    <div className="mt-3 flex flex-wrap items-center gap-2 text-caption text-foreground-secondary">
                      {project !== undefined && (
                        <ProjectChip project={project} />
                      )}
                      {task.tagIds.map((tagId) => {
                        const tag = tagsById.get(tagId)
                        return tag === undefined ? null : (
                          <TagChip key={tag.id} tag={tag} />
                        )
                      })}
                      {task.tagIds.length === 0 && (
                        <span className="inline-flex items-center gap-1">
                          <Tags className="size-3.5" aria-hidden="true" />
                          无标签
                        </span>
                      )}
                      <span className="inline-flex items-center gap-1">
                        <CalendarDays className="size-3.5" aria-hidden="true" />
                        {task.dueDate ?? '无截止日期'}
                      </span>
                      {task.isImportant && (
                        <Star
                          className="size-3.5 text-danger"
                          aria-label="重要"
                        />
                      )}
                      {task.isUrgent && (
                        <Zap
                          className="size-3.5 text-warning"
                          aria-label="基础紧急"
                        />
                      )}
                    </div>
                    <p className="mt-3 flex items-center gap-1.5 text-caption text-foreground-tertiary">
                      <Clock3 className="size-3.5" aria-hidden="true" />
                      删除于 {formatDateTime(task.deletedAtMs)}
                    </p>
                  </div>
                  <Button
                    disabled={pending.has(task.id)}
                    onClick={() => void restoreTask(task)}
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw data-icon="inline-start" />
                    {pending.has(task.id) ? '恢复中…' : '恢复任务'}
                  </Button>
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
