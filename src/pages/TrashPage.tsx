import { Clock3, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { TrashEntityType, TrashItem } from '@/trash/model'
import { openTrashRuntime } from '@/trash/runtime'
import type { OpenTrashRuntime } from '@/trash/runtime.types'
import type { TrashService } from '@/trash/service'

interface TrashPageProps {
  readonly openRuntime?: OpenTrashRuntime
}

/** Exhaustive entity labels: adding a V2 entity type becomes a compile error. */
const ENTITY_LABELS: Record<TrashEntityType, string> = {
  task: '任务',
  note: '笔记',
  diary: '日记',
}

/** UI-owned title fallback. Persistence still returns the canonical title. */
const EMPTY_TITLE_FALLBACK: Record<TrashEntityType, string> = {
  task: '未命名任务',
  note: '未命名笔记',
  diary: '未命名日记',
}

const RESTORE_FAILURE_MESSAGE = '恢复失败，请重试'

type RuntimePhase = 'loading' | 'ready' | 'error'
type ListPhase = 'loading' | 'ready' | 'error'

interface Feedback {
  readonly tone: 'info' | 'error'
  readonly message: string
}

function displayTitle(item: TrashItem): string {
  return item.title.trim() === ''
    ? EMPTY_TITLE_FALLBACK[item.entityType]
    : item.title
}

function rowKey(item: TrashItem): string {
  return `${item.entityType}:${item.entityId}`
}

function formatDateTime(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(timestamp))
}

export function TrashPage({ openRuntime = openTrashRuntime }: TrashPageProps) {
  const mountedRef = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const [runtimePhase, setRuntimePhase] = useState<RuntimePhase>('loading')
  const [service, setService] = useState<TrashService | null>(null)
  const [listAttempt, setListAttempt] = useState(0)
  const [listPhase, setListPhase] = useState<ListPhase>('loading')
  const [items, setItems] = useState<readonly TrashItem[]>([])
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenTrashRuntime>> | null = null
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
      setRuntimePhase('loading')
      try {
        runtime = await openRuntime()
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        setRuntimePhase('ready')
      } catch {
        await disposeRuntime()
        if (active) {
          setService(null)
          setRuntimePhase('error')
        }
      }
    })()

    return () => {
      active = false
      void disposeRuntime()
    }
  }, [attempt, openRuntime])

  // The list is only loaded once the runtime service exists.
  useEffect(() => {
    if (service === null) return
    let active = true

    void (async () => {
      setListPhase('loading')
      try {
        const loaded = await service.list()
        if (!active) return
        setItems(loaded)
        setListPhase('ready')
      } catch {
        if (active) setListPhase('error')
      }
    })()

    return () => {
      active = false
    }
  }, [service, listAttempt])

  const restoreItem = useCallback(
    async (item: TrashItem) => {
      const key = rowKey(item)
      if (service === null || pending.has(key)) return
      setPending((current) => new Set(current).add(key))
      setFeedback(null)
      try {
        await service.restore({
          entityType: item.entityType,
          entityId: item.entityId,
        })
        if (!mountedRef.current) return
        // The row disappears only after the canonical restore succeeded.
        setItems((current) => current.filter((row) => rowKey(row) !== key))
        setFeedback({
          tone: 'info',
          message: `“${displayTitle(item)}”已恢复。`,
        })
      } catch {
        if (mountedRef.current) {
          setFeedback({ tone: 'error', message: RESTORE_FAILURE_MESSAGE })
        }
      } finally {
        if (mountedRef.current) {
          setPending((current) => {
            const next = new Set(current)
            next.delete(key)
            return next
          })
        }
      }
    },
    [pending, service],
  )

  const loading =
    runtimePhase === 'loading' ||
    (runtimePhase === 'ready' && listPhase === 'loading')
  const failed = runtimePhase === 'error' || listPhase === 'error'
  const ready = runtimePhase === 'ready' && listPhase === 'ready'

  function retry(): void {
    setFeedback(null)
    if (runtimePhase === 'error') {
      setAttempt((value) => value + 1)
      return
    }
    setListAttempt((value) => value + 1)
  }

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-6 pb-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-hero font-semibold tracking-tight text-foreground">
            回收站
          </h2>
          <p className="mt-2 text-body text-foreground-secondary">
            已移入回收站的任务、笔记和日记会保留原有信息，可随时恢复。
          </p>
        </div>
        {ready && items.length > 0 && (
          <Badge variant="outline">{items.length} 项</Badge>
        )}
      </header>

      {feedback !== null && (
        <div
          className={
            feedback.tone === 'error'
              ? 'rounded-sm border border-danger/20 bg-danger-soft/50 px-4 py-3 text-body text-foreground'
              : 'rounded-sm border border-info/20 bg-info-soft/50 px-4 py-3 text-body text-foreground'
          }
          role={feedback.tone === 'error' ? 'alert' : 'status'}
        >
          {feedback.message}
        </div>
      )}

      {loading && (
        <div className="space-y-3" role="status" aria-label="正在加载回收站">
          {[0, 1].map((item) => (
            <div
              className="h-24 animate-pulse rounded-lg border border-border bg-surface-secondary/40"
              key={item}
            />
          ))}
        </div>
      )}

      {failed && (
        <div
          className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-danger/15 bg-danger-soft/30 p-8 text-center"
          role="alert"
        >
          <Trash2 className="size-9 text-danger" aria-hidden="true" />
          <h3 className="mt-4 text-module font-semibold">无法加载回收站</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            本地数据暂时不可用，请稍后重试。
          </p>
          <Button className="mt-5" onClick={retry} type="button">
            <RotateCcw data-icon="inline-start" />
            重试
          </Button>
        </div>
      )}

      {ready && items.length === 0 && (
        <div className="flex min-h-72 flex-col items-center justify-center rounded-lg border border-dashed border-border bg-surface-secondary/20 p-8 text-center">
          <div className="flex size-14 items-center justify-center rounded-xl bg-surface-secondary text-foreground-tertiary">
            <Trash2 className="size-7" aria-hidden="true" />
          </div>
          <h3 className="mt-4 text-module font-semibold">回收站是空的</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            移入回收站的任务、笔记和日记会显示在这里。
          </p>
        </div>
      )}

      {ready && items.length > 0 && (
        <ul aria-label="回收站条目" className="grid gap-3">
          {items.map((item) => {
            const key = rowKey(item)
            const restoring = pending.has(key)
            return (
              <li
                className="rounded-lg border border-border bg-surface px-5 py-4 shadow-xs"
                key={key}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant="outline">
                        {ENTITY_LABELS[item.entityType]}
                      </Badge>
                      <h3 className="min-w-0 break-words text-[15px] leading-6 font-semibold text-foreground">
                        {displayTitle(item)}
                      </h3>
                    </div>
                    <p className="mt-3 flex items-center gap-1.5 text-caption text-foreground-tertiary">
                      <Clock3 className="size-3.5" aria-hidden="true" />
                      删除于 {formatDateTime(item.deletedAtMs)}
                    </p>
                  </div>
                  <Button
                    disabled={restoring}
                    onClick={() => void restoreItem(item)}
                    type="button"
                    variant="outline"
                  >
                    <RotateCcw data-icon="inline-start" />
                    {restoring ? '恢复中…' : '恢复'}
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
