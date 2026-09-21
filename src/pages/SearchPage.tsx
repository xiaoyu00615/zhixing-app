import { RotateCcw, Search } from 'lucide-react'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Link } from 'react-router'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { SearchEntityType, SearchResult } from '@/search/model'
import { buildSearchResultTarget } from '@/search/navigation'
import { openSearchRuntime } from '@/search/runtime'
import type { OpenSearchRuntime } from '@/search/runtime.types'
import {
  SearchApplicationError,
  type SearchApplicationErrorCode,
  type SearchService,
} from '@/search/service'

interface SearchPageProps {
  readonly openRuntime?: OpenSearchRuntime
}

type RuntimePhase = 'loading' | 'ready' | 'error'

type SearchView =
  | { readonly kind: 'empty' }
  | { readonly kind: 'loading'; readonly query: string }
  | {
      readonly kind: 'results'
      readonly query: string
      readonly results: readonly SearchResult[]
    }
  | { readonly kind: 'no-results'; readonly query: string }
  | {
      readonly kind: 'error'
      readonly query: string
      readonly code: SearchApplicationErrorCode
    }

const ENTITY_LABELS: Record<SearchEntityType, string> = {
  task: '任务',
  note: '笔记',
  diary: '日记',
  canvas: '画布',
}

function formatResultDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp))
}

function displayTitle(result: SearchResult): string {
  if (result.title.trim().length > 0) {
    return result.title
  }
  if (result.entityType === 'note') {
    return '未命名笔记'
  }
  if (result.entityType === 'diary') {
    return '未命名日记'
  }
  return result.title
}

function ResultRow({ result }: { readonly result: SearchResult }) {
  const label = ENTITY_LABELS[result.entityType]
  const title = displayTitle(result)
  const snippet = result.snippet.trim()

  return (
    <li className="rounded-lg border border-border bg-surface p-4 shadow-xs">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <span className="inline-flex items-center rounded-sm bg-surface-secondary px-2 py-0.5 text-xs text-foreground-secondary">
            {label}
          </span>
          <h3 className="truncate text-module font-semibold text-foreground">
            {title}
          </h3>
          <p className="text-body text-foreground-secondary">
            {snippet.length > 0 ? snippet : '暂无摘要'}
          </p>
          <p className="text-xs text-foreground-tertiary">
            {formatResultDate(result.updatedAtMs)}
          </p>
        </div>
        <Link
          aria-label={`打开${label}：${title}`}
          className="shrink-0 rounded-sm border border-border px-3 py-1.5 text-body text-foreground transition-colors hover:bg-hover"
          to={buildSearchResultTarget(result)}
        >
          查看
        </Link>
      </div>
    </li>
  )
}

export function SearchPage({
  openRuntime = openSearchRuntime,
}: SearchPageProps) {
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [runtimePhase, setRuntimePhase] = useState<RuntimePhase>('loading')
  const [service, setService] = useState<SearchService | null>(null)
  const [draft, setDraft] = useState('')
  const [view, setView] = useState<SearchView>({ kind: 'empty' })

  const mountedRef = useRef(false)
  const requestIdRef = useRef(0)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenSearchRuntime>> | null = null
    let disposed = false

    async function disposeRuntime(): Promise<void> {
      if (runtime === null || disposed) {
        return
      }
      disposed = true
      try {
        await runtime.dispose()
      } catch {
        // Disposal must never replace the user-facing runtime result.
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
          setRuntimePhase('error')
        }
      }
    })()

    return () => {
      active = false
      void disposeRuntime()
    }
  }, [loadAttempt, openRuntime])

  function runSearch(rawQuery: string): void {
    const query = rawQuery.trim()
    const currentService = service

    requestIdRef.current += 1
    const requestId = requestIdRef.current

    if (query === '') {
      setView({ kind: 'empty' })
      return
    }
    if (currentService === null) {
      return
    }

    setView({ kind: 'loading', query })

    void (async () => {
      try {
        const results = await currentService.search(query)
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        setView(
          results.length === 0
            ? { kind: 'no-results', query }
            : { kind: 'results', query, results },
        )
      } catch (error: unknown) {
        if (!mountedRef.current || requestId !== requestIdRef.current) {
          return
        }
        const code =
          error instanceof SearchApplicationError ? error.code : 'UNAVAILABLE'
        setView({ kind: 'error', query, code })
      }
    })()
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    runSearch(draft)
  }

  function retryLoad(): void {
    setRuntimePhase('loading')
    setService(null)
    setView({ kind: 'empty' })
    setLoadAttempt((attempt) => attempt + 1)
  }

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-6 pb-8">
      <header className="space-y-2">
        <h2 className="text-hero font-semibold tracking-tight text-foreground">
          搜索
        </h2>
        <p className="text-body text-foreground-secondary">
          在一个结果流中检索任务、笔记、日记和画布。
        </p>
      </header>

      <form
        className="flex flex-wrap items-center gap-3"
        onSubmit={handleSubmit}
        role="search"
      >
        <Input
          aria-label="搜索关键词"
          className="min-w-64 flex-1"
          onChange={(event) => setDraft(event.target.value)}
          placeholder="输入关键词搜索任务、笔记、日记和画布"
          value={draft}
        />
        <Button type="submit">
          <Search data-icon="inline-start" />
          搜索
        </Button>
      </form>

      {runtimePhase === 'loading' && (
        <div
          aria-label="正在加载搜索"
          className="rounded-lg border border-border bg-surface p-8 text-center"
          role="status"
        >
          <span className="sr-only">正在加载搜索</span>
          <p className="text-body text-foreground-secondary">正在加载搜索…</p>
        </div>
      )}

      {runtimePhase === 'error' && (
        <div
          className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-danger/15 bg-danger-soft/30 p-8 text-center"
          role="alert"
        >
          <h3 className="text-module font-semibold">无法使用搜索</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            本地搜索暂时不可用，请稍后重试。
          </p>
          <Button className="mt-5" onClick={retryLoad} type="button">
            <RotateCcw data-icon="inline-start" />
            重试
          </Button>
        </div>
      )}

      {runtimePhase === 'ready' && (
        <div className="space-y-4">
          {view.kind === 'empty' && (
            <div
              className="rounded-lg border border-border bg-surface p-8 text-center"
              role="status"
            >
              <p className="text-body text-foreground-secondary">
                输入关键词搜索任务、笔记、日记和画布
              </p>
            </div>
          )}

          {view.kind === 'loading' && (
            <div
              aria-label="正在搜索"
              className="rounded-lg border border-border bg-surface p-8 text-center"
              role="status"
            >
              <span className="sr-only">正在搜索</span>
              <p className="text-body text-foreground-secondary">
                正在搜索“{view.query}”…
              </p>
            </div>
          )}

          {view.kind === 'error' && (
            <div
              className="flex min-h-64 flex-col items-center justify-center rounded-lg border border-danger/15 bg-danger-soft/30 p-8 text-center"
              role="alert"
            >
              <h3 className="text-module font-semibold">
                {view.code === 'VALIDATION'
                  ? '搜索关键词无效'
                  : '搜索暂时不可用'}
              </h3>
              <p className="mt-2 text-body text-foreground-secondary">
                {view.code === 'VALIDATION'
                  ? '请调整关键词后重新搜索。'
                  : '本地搜索数据暂时不可用，请稍后重试。'}
              </p>
              {view.code === 'UNAVAILABLE' && (
                <Button
                  className="mt-5"
                  onClick={() => runSearch(view.query)}
                  type="button"
                >
                  <RotateCcw data-icon="inline-start" />
                  重试
                </Button>
              )}
            </div>
          )}

          {view.kind === 'no-results' && (
            <div
              className="rounded-lg border border-border bg-surface p-8 text-center"
              role="status"
            >
              <p className="text-body text-foreground-secondary">
                没有找到与“{view.query}”匹配的结果
              </p>
            </div>
          )}

          {view.kind === 'results' && (
            <ul aria-label="搜索结果" className="space-y-3">
              {view.results.map((result) => (
                <ResultRow
                  key={`${result.entityType}:${result.entityId}`}
                  result={result}
                />
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  )
}
