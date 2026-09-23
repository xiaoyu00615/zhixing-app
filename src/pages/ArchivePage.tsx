import { Archive, Clock3, Inbox, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import type { ArchiveEntityType, ArchiveItem } from '@/archive/model'
import { openArchiveRuntime } from '@/archive/runtime'
import type { OpenArchiveRuntime } from '@/archive/runtime.types'
import type { ArchiveService } from '@/archive/service'

interface ArchivePageProps {
  readonly openRuntime?: OpenArchiveRuntime
}

/** Exhaustive entity labels: adding a V2 entity type becomes a compile error. */
const ENTITY_LABELS: Record<ArchiveEntityType, string> = {
  task: '任务',
  note: '笔记',
}

/** UI-owned title fallback. Persistence still returns the canonical title. */
const EMPTY_TITLE_FALLBACK: Record<ArchiveEntityType, string> = {
  task: '未命名任务',
  note: '未命名笔记',
}

const UNARCHIVE_FAILURE_MESSAGE = '取消归档失败，请重试'
const MOVE_TO_TRASH_FAILURE_MESSAGE = '移入回收站失败，请重试'

type RuntimePhase = 'loading' | 'ready' | 'error'
type ListPhase = 'loading' | 'ready' | 'error'

interface Feedback {
  readonly tone: 'info' | 'error'
  readonly message: string
}

function displayTitle(item: ArchiveItem): string {
  return item.title.trim() === ''
    ? EMPTY_TITLE_FALLBACK[item.entityType]
    : item.title
}

function rowKey(item: ArchiveItem): string {
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

export function ArchivePage({ openRuntime = openArchiveRuntime }: ArchivePageProps) {
  const mountedRef = useRef(false)
  const [attempt, setAttempt] = useState(0)
  const [runtimePhase, setRuntimePhase] = useState<RuntimePhase>('loading')
  const [service, setService] = useState<ArchiveService | null>(null)
  const [listAttempt, setListAttempt] = useState(0)
  const [listPhase, setListPhase] = useState<ListPhase>('loading')
  const [items, setItems] = useState<readonly ArchiveItem[]>([])
  const [pending, setPending] = useState<ReadonlySet<string>>(new Set())
  const [confirmingKey, setConfirmingKey] = useState<string | null>(null)
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenArchiveRuntime>> | null = null
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

  const unarchiveItem = useCallback(
    async (item: ArchiveItem) => {
      const key = rowKey(item)
      if (service === null || pending.has(key)) return
      setPending((current) => new Set(current).add(key))
      setConfirmingKey(null)
      setFeedback(null)
      try {
        await service.unarchive({
          entityType: item.entityType,
          entityId: item.entityId,
        })
        if (!mountedRef.current) return
        // The row disappears only after the canonical unarchive succeeded.
        setItems((current) => current.filter((row) => rowKey(row) !== key))
        setFeedback({
          tone: 'info',
          message: `“${displayTitle(item)}”已取消归档。`,
        })
      } catch {
        if (mountedRef.current) {
          setFeedback({ tone: 'error', message: UNARCHIVE_FAILURE_MESSAGE })
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

  const moveToTrashItem = useCallback(
    async (item: ArchiveItem) => {
      const key = rowKey(item)
      if (service === null || pending.has(key)) return
      setPending((current) => new Set(current).add(key))
      setFeedback(null)
      try {
        await service.moveToTrash({
          entityType: item.entityType,
          entityId: item.entityId,
        })
        if (!mountedRef.current) return
        // The row disappears only after the canonical move-to-trash succeeded.
        setItems((current) => current.filter((row) => rowKey(row) !== key))
        setConfirmingKey(null)
        setFeedback({
          tone: 'info',
          message: `“${displayTitle(item)}”已移入回收站。`,
        })
      } catch {
        if (mountedRef.current) {
          setFeedback({ tone: 'error', message: MOVE_TO_TRASH_FAILURE_MESSAGE })
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
            归档
          </h2>
          <p className="mt-2 text-body text-foreground-secondary">
            已归档的任务和笔记会保留原有信息，可取消归档或移入回收站。
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
        <div className="space-y-3" role="status" aria-label="正在加载归档">
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
          <Archive className="size-9 text-danger" aria-hidden="true" />
          <h3 className="mt-4 text-module font-semibold">无法加载归档</h3>
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
            <Inbox className="size-7" aria-hidden="true" />
          </div>
          <h3 className="mt-4 text-module font-semibold">归档是空的</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            已归档的任务和笔记会显示在这里。
          </p>
        </div>
      )}

      {ready && items.length > 0 && (
        <ul aria-label="归档条目" className="grid gap-3">
          {items.map((item) => {
            const key = rowKey(item)
            const busy = pending.has(key)
            const confirming = confirmingKey === key
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
                      归档于 {formatDateTime(item.archivedAtMs)}
                    </p>
                  </div>

                  {confirming ? (
                    <div className="rounded-sm border border-danger/20 bg-danger-soft/40 p-3 lg:max-w-sm">
                      <p className="text-sm text-foreground">
                        将“{displayTitle(item)}”移入回收站？
                      </p>
                      <p className="mt-1 text-xs text-foreground-secondary">
                        之后仍可从回收站恢复。
                      </p>
                      <div className="mt-3 flex items-center justify-end gap-2">
                        <Button
                          disabled={busy}
                          onClick={() => setConfirmingKey(null)}
                          size="sm"
                          type="button"
                          variant="ghost"
                        >
                          取消
                        </Button>
                        <Button
                          className="bg-danger text-white hover:bg-danger/90"
                          disabled={busy}
                          onClick={() => void moveToTrashItem(item)}
                          size="sm"
                          type="button"
                        >
                          {busy ? '移入中…' : '确认移入回收站'}
                        </Button>
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={busy}
                        onClick={() => void unarchiveItem(item)}
                        size="sm"
                        type="button"
                        variant="outline"
                      >
                        <Archive data-icon="inline-start" />
                        {busy ? '处理中…' : '取消归档'}
                      </Button>
                      <Button
                        disabled={busy}
                        onClick={() => setConfirmingKey(key)}
                        size="sm"
                        type="button"
                        variant="ghost"
                      >
                        <Trash2 data-icon="inline-start" />
                        移入回收站
                      </Button>
                    </div>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
