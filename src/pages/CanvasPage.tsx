import { ArrowRight, LayoutGrid, PenLine, Plus, RotateCcw, Search, X } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useNavigate } from 'react-router'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { Canvas } from '@/canvas/model'
import { openCanvasRuntime } from '@/canvas/runtime'
import type { OpenCanvasRuntime } from '@/canvas/runtime.types'
import type { CanvasService } from '@/canvas/service'
import { canvasEditorPath } from '@/routes/paths'

interface CanvasPageProps {
  readonly openRuntime?: OpenCanvasRuntime
}

function formatUpdatedAt(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }).format(new Date(timestamp))
}

export function CanvasPage({ openRuntime = openCanvasRuntime }: CanvasPageProps) {
  const navigate = useNavigate()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [service, setService] = useState<CanvasService | null>(null)
  const [canvases, setCanvases] = useState<readonly Canvas[]>([])
  const [dialog, setDialog] = useState<
    | { readonly mode: 'create'; readonly canvas: null }
    | { readonly mode: 'rename'; readonly canvas: Canvas }
    | null
  >(null)
  const [title, setTitle] = useState('')
  const [dialogError, setDialogError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [searchQuery, setSearchQuery] = useState('')

  const normalizedSearchQuery = searchQuery.trim().toLocaleLowerCase()
  const visibleCanvases = useMemo(
    () => normalizedSearchQuery.length === 0
      ? canvases
      : canvases.filter((canvas) =>
          canvas.title.toLocaleLowerCase().includes(normalizedSearchQuery),
        ),
    [canvases, normalizedSearchQuery],
  )

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenCanvasRuntime>> | null = null
    void (async () => {
      try {
        runtime = await openRuntime()
        const loaded = await runtime.service.listCanvases()
        if (!active) { await runtime.dispose(); return }
        setService(runtime.service)
        setCanvases(loaded)
        setPhase('ready')
      } catch {
        if (active) setPhase('error')
        await runtime?.dispose()
      }
    })()
    return () => { active = false; void runtime?.dispose() }
  }, [attempt, openRuntime])

  function openCreate(): void {
    setTitle('')
    setDialogError(null)
    setDialog({ mode: 'create', canvas: null })
  }

  function openRename(canvas: Canvas): void {
    setTitle(canvas.title)
    setDialogError(null)
    setDialog({ mode: 'rename', canvas })
  }

  async function submit(): Promise<void> {
    if (service === null || dialog === null || submitting) return
    setSubmitting(true)
    setDialogError(null)
    try {
      const saved = dialog.mode === 'create'
        ? await service.createCanvas(title)
        : await service.renameCanvas(dialog.canvas.id, title)
      setCanvases(await service.listCanvases())
      setDialog(null)
      if (dialog.mode === 'create') void navigate(canvasEditorPath(saved.id))
    } catch {
      setDialogError('请输入有效的画布名称后重试。')
    } finally {
      setSubmitting(false)
    }
  }

  if (phase === 'loading') {
    return <div className="space-y-4" role="status" aria-label="正在加载画布"><div className="h-10 w-52 animate-pulse rounded-lg bg-surface-secondary" /><div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">{[0, 1, 2].map((item) => <div key={item} className="h-48 animate-pulse rounded-xl bg-surface-secondary" />)}</div></div>
  }

  if (phase === 'error') {
    return <div className="flex min-h-80 flex-col items-center justify-center text-center"><LayoutGrid className="mb-4 size-9 text-foreground-tertiary" /><h2 className="text-module font-semibold">画布暂时无法加载</h2><p className="mt-2 text-body text-foreground-secondary">请确认本地存储可用后重试。</p><Button className="mt-5" variant="outline" onClick={() => setAttempt((value) => value + 1)}><RotateCcw />重试</Button></div>
  }

  const toolbar = (
    <div className="grid w-full grid-cols-[auto_minmax(12rem,30rem)_auto] items-center gap-5">
      <h1 className="text-subtitle font-semibold text-foreground">所有画布</h1>
      <div className="relative w-full justify-self-center">
        <Search aria-hidden="true" className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-foreground-tertiary" />
        <Input
          aria-label="搜索画布"
          className="h-9 rounded-lg bg-background pl-9 pr-9 [&::-webkit-search-cancel-button]:appearance-none"
          onChange={(event) => setSearchQuery(event.target.value)}
          placeholder="搜索画布"
          type="search"
          value={searchQuery}
        />
        {searchQuery.length > 0 && (
          <button
            aria-label="清空画布搜索"
            className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-foreground-tertiary transition hover:bg-surface-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
            onClick={() => setSearchQuery('')}
            type="button"
          >
            <X className="size-3.5" />
          </button>
        )}
      </div>
      <Button className="w-fit justify-self-end" onClick={openCreate}><Plus />新建画布</Button>
    </div>
  )
  const toolbarTarget = document.getElementById('page-toolbar-root')

  return (
    <>
      {toolbarTarget === null ? toolbar : createPortal(toolbar, toolbarTarget)}
      <div className="mx-auto w-full max-w-[1320px] pb-10 pt-1">
      {canvases.length === 0 ? (
        <section className="flex min-h-[360px] flex-col items-center justify-center rounded-2xl border border-dashed border-border bg-surface-secondary/20 text-center"><div className="mb-5 flex size-14 items-center justify-center rounded-2xl bg-primary-softest text-primary"><LayoutGrid className="size-7" /></div><h3 className="text-lg font-semibold">还没有画布</h3><p className="mt-2 max-w-sm text-body text-foreground-secondary">使用右上角的新建画布，开始整理你的想法。</p></section>
      ) : visibleCanvases.length === 0 ? (
        <section className="flex min-h-[300px] flex-col items-center justify-center text-center" aria-label="画布搜索无结果"><Search className="mb-4 size-7 text-foreground-tertiary" /><h3 className="text-base font-semibold">没有找到匹配的画布</h3><p className="mt-2 text-sm text-foreground-secondary">尝试其他标题关键词，或清空当前搜索。</p><Button className="mt-4" variant="ghost" onClick={() => setSearchQuery('')}>清空搜索</Button></section>
      ) : (
        <section className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-label="画布列表">
          {visibleCanvases.map((canvas, index) => (
            <article key={canvas.id} className="group relative min-h-52 overflow-hidden rounded-2xl border border-border bg-surface p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-primary/25 hover:shadow-md">
              <div className={`absolute inset-x-0 top-0 h-1 ${['bg-primary', 'bg-amber-500', 'bg-sky-500'][index % 3]}`} />
              <div className="flex items-start justify-between gap-3"><div className="flex size-10 items-center justify-center rounded-xl bg-surface-secondary text-primary"><LayoutGrid className="size-5" /></div><Button size="icon-sm" variant="ghost" aria-label={`重命名 ${canvas.title}`} onClick={() => openRename(canvas)}><PenLine /></Button></div>
              <button className="mt-7 block w-full text-left focus-visible:outline-none" onClick={() => void navigate(canvasEditorPath(canvas.id))} type="button"><h3 className="truncate text-lg font-semibold text-foreground">{canvas.title}</h3><p className="mt-2 text-xs text-foreground-tertiary">更新于 {formatUpdatedAt(canvas.updatedAtMs)}</p><span className="mt-7 inline-flex items-center gap-1 text-sm font-medium text-primary">打开画布 <ArrowRight className="size-4 transition group-hover:translate-x-0.5" /></span></button>
            </article>
          ))}
        </section>
      )}
      <Dialog open={dialog !== null} onOpenChange={(open) => !open && setDialog(null)}>
        <DialogContent><DialogHeader><DialogTitle>{dialog?.mode === 'rename' ? '重命名画布' : '新建画布'}</DialogTitle><DialogDescription>名称会显示在画布列表和编辑器顶部。</DialogDescription></DialogHeader><form onSubmit={(event) => { event.preventDefault(); void submit() }}><Input autoFocus aria-label="画布名称" value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：产品构思" />{dialogError !== null && <p className="mt-2 text-sm text-destructive" role="alert">{dialogError}</p>}<DialogFooter className="mt-5"><Button type="button" variant="ghost" onClick={() => setDialog(null)}>取消</Button><Button type="submit" disabled={submitting}>{submitting ? '保存中…' : '保存'}</Button></DialogFooter></form></DialogContent>
      </Dialog>
      </div>
    </>
  )
}
