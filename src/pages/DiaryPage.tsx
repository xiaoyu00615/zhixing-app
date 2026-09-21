/**
 * 日记工作区（Diary V1 Workspace）
 *
 * 桌面优先两栏布局：
 *  - 左栏：日记列表（按仓库顺序：diary_date DESC, updated_at_ms DESC, id ASC）
 *  - 右栏：选中日记的编辑器
 *
 * 运行时注入模式、运行时生命周期与自动保存均参考 NotesPage 已被接受的实现。
 * 本页只使用 DiaryService 作为唯一业务 API；不检测平台、不实例化仓库、不创建 Worker、
 * 不调用 Tauri、不访问数据库。
 */

import { BookOpen, CalendarDays, Plus, RotateCcw, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import type { DiaryDate, DiaryEntry } from '@/diary/model'
import { openDiaryRuntime } from '@/diary/runtime'
import type { OpenDiaryRuntime } from '@/diary/runtime.types'
import { DiaryApplicationError, type DiaryService } from '@/diary/service'
import { cn } from '@/lib/utils'
import { isValidLocalDate, localDateFromDate } from '@/shared/validation'

interface DiaryPageProps {
  readonly openRuntime?: OpenDiaryRuntime
  /** P5 S4: the `?id=` deep-link value supplied by the route. */
  readonly requestedDiaryId?: string | null
}

type DiaryPhase = 'loading' | 'ready' | 'error'
type SaveStatus = 'saved' | 'saving' | 'error'

interface SelectionState {
  id: string | null
  diaryDate: DiaryDate | null
  draftTitle: string
  draftContent: string
}

function emptySelection(): SelectionState {
  return { id: null, diaryDate: null, draftTitle: '', draftContent: '' }
}

function selectionFromEntry(entry: DiaryEntry): SelectionState {
  return {
    id: entry.id,
    diaryDate: entry.diaryDate,
    draftTitle: entry.title,
    draftContent: entry.content,
  }
}

function formatDiaryDate(date: DiaryDate): string {
  const parts = date.split('-')
  const year = Number(parts[0])
  const month = Number(parts[1])
  const day = Number(parts[2])
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(year, month - 1, day))
}

function formatTimestamp(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp))
}

function previewFromEntry(entry: DiaryEntry): string {
  const preview = entry.content.trim().replace(/\s+/g, ' ')
  return preview.length > 0 ? preview : '暂无正文'
}

/** Native date input used by both the create-date picker and the change-date dialog. */
function DiaryDateInput({
  value,
  max,
  onChange,
  label,
}: {
  value: string
  max: string
  onChange: (value: string) => void
  label: string
}) {
  return (
    <Input
      aria-label={label}
      max={max}
      type="date"
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
  )
}

function LoadingState() {
  return (
    <div
      className="grid min-h-96 gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]"
      role="status"
      aria-label="正在加载日记"
    >
      <span className="sr-only">正在加载日记</span>
      {[0, 1, 2].map((item) => (
        <div
          className="h-24 animate-pulse rounded-lg border border-border bg-surface-secondary/40"
          key={item}
        />
      ))}
    </div>
  )
}

export function DiaryPage({
  openRuntime = openDiaryRuntime,
  requestedDiaryId = null,
}: DiaryPageProps) {
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [phase, setPhase] = useState<DiaryPhase>('loading')
  const [service, setService] = useState<DiaryService | null>(null)
  const [entries, setEntries] = useState<readonly DiaryEntry[]>([])
  const [selection, setSelection] = useState<SelectionState>(emptySelection())
  const [feedback, setFeedback] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [isCreateOpen, setIsCreateOpen] = useState(false)
  const [createDateValue, setCreateDateValue] = useState<string>('')
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [showChangeDateDialog, setShowChangeDateDialog] = useState(false)
  const [changeDateValue, setChangeDateValue] = useState<string>('')
  const [changeDateError, setChangeDateError] = useState<string | null>(null)
  const justCreatedRef = useRef(false)

  // Autosave state (title/content only)
  const localDraftRef = useRef<SelectionState>(emptySelection())
  const draftRevisionRef = useRef(0)
  const savedRevisionRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveLoopPromiseRef = useRef<Promise<void> | null>(null)
  const deleteIntentRef = useRef<string | null>(null)
  const dateChangeIntentRef = useRef<string | null>(null)

  // Runtime lifecycle
  const mountedRef = useRef(false)
  const runtimeRef = useRef<Awaited<ReturnType<OpenDiaryRuntime>> | null>(null)

  const today = localDateFromDate(new Date())

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // P5 S4: apply the ?id= deep-link value through the existing selection
  // mechanism. Diary stays date-oriented internally; the id is resolved to an
  // already-loaded active entry. Absent, malformed or unknown ids are ignored.
  // Only a *changed* requested id is applied.
  const appliedRequestedIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (requestedDiaryId === null || requestedDiaryId === '') {
      return
    }
    if (appliedRequestedIdRef.current === requestedDiaryId) {
      return
    }
    const match = entries.find((entry) => entry.id === requestedDiaryId)
    if (match === undefined) {
      return
    }
    appliedRequestedIdRef.current = requestedDiaryId
    void handleSwitchToEntry(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedDiaryId, entries])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenDiaryRuntime>> | null = null
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
      setPhase('loading')
      try {
        runtime = await openRuntime()
        if (!active) {
          await disposeRuntime()
          return
        }
        const loadedEntries = await runtime.service.listActive()
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        runtimeRef.current = runtime
        const todayEntry =
          loadedEntries.find((entry) => entry.diaryDate === today) ?? null
        const firstEntry = loadedEntries[0]
        const initialSelection =
          todayEntry !== null
            ? selectionFromEntry(todayEntry)
            : firstEntry !== undefined
              ? selectionFromEntry(firstEntry)
              : emptySelection()
        setEntries(loadedEntries)
        setSelection(initialSelection)
        localDraftRef.current = initialSelection
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
      clearDebounceTimer()
      // Best-effort flush before dispose (consistent with NotesPage behavior).
      const isDirty =
        localDraftRef.current.id !== null &&
        draftRevisionRef.current > savedRevisionRef.current
      void (async () => {
        if (isDirty) {
          try {
            await flushCurrentDraft()
          } catch {
            // Ignore flush errors on unmount
          }
        }
        await disposeRuntime()
      })()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadAttempt, openRuntime])

  // Focus the editor after an explicit create (where appropriate).
  useEffect(() => {
    if (!justCreatedRef.current) return
    justCreatedRef.current = false
    const el = document.querySelector<HTMLInputElement>('[aria-label="日记标题"]')
    el?.focus()
  }, [selection.id])

  function clearDebounceTimer(): void {
    if (debounceTimerRef.current !== null) {
      clearTimeout(debounceTimerRef.current)
      debounceTimerRef.current = null
    }
  }

  function scheduleDebounceFlush(): void {
    clearDebounceTimer()
    debounceTimerRef.current = setTimeout(() => {
      void flushCurrentDraft().catch(() => {})
    }, 800)
  }

  const isDirty = (): boolean =>
    localDraftRef.current.id !== null &&
    draftRevisionRef.current > savedRevisionRef.current

  async function refreshCanonicalList(): Promise<readonly DiaryEntry[]> {
    const currentService = service
    if (currentService === null) return entries
    try {
      const refreshed = await currentService.listActive()
      if (mountedRef.current) {
        setEntries(refreshed)
      }
      return refreshed
    } catch {
      if (mountedRef.current) {
        setFeedback('列表暂时无法刷新。')
      }
      return entries
    }
  }

  async function flushCurrentDraft(): Promise<void> {
    const currentService = service
    if (currentService === null) return
    if (deleteIntentRef.current !== null) return
    if (dateChangeIntentRef.current !== null) return

    const currentId = localDraftRef.current.id
    if (currentId === null) return

    const currentDraftRevision = draftRevisionRef.current
    const currentSavedRevision = savedRevisionRef.current

    if (currentDraftRevision <= currentSavedRevision) {
      return
    }

    if (saveLoopPromiseRef.current !== null) {
      await saveLoopPromiseRef.current
      return
    }

    async function runSaveLoop(): Promise<void> {
      if (currentService === null) return
      if (deleteIntentRef.current !== null) return
      if (dateChangeIntentRef.current !== null) return
      const currentDraft = localDraftRef.current
      const currentId = currentDraft.id
      if (currentId === null) return
      const currentDraftRevision = draftRevisionRef.current
      const currentSavedRevision = savedRevisionRef.current
      if (currentDraftRevision <= currentSavedRevision) return
      const snapshot = {
        id: currentId,
        title: currentDraft.draftTitle,
        content: currentDraft.draftContent,
        revision: currentDraftRevision,
      }

      try {
        await currentService.updateDiaryEntry({
          id: snapshot.id,
          title: snapshot.title,
          content: snapshot.content,
        })
        if (mountedRef.current) {
          savedRevisionRef.current = snapshot.revision
          setSaveStatus('saved')
          setFeedback(null)
          await refreshCanonicalList()
        }
      } catch (error: unknown) {
        if (mountedRef.current) {
          if (
            error instanceof DiaryApplicationError &&
            error.code === 'NOT_FOUND'
          ) {
            savedRevisionRef.current = snapshot.revision
            setSaveStatus('saved')
            setFeedback(null)
            const refreshed = await refreshCanonicalList()
            const nextEntry = refreshed[0] ?? null
            if (mountedRef.current) {
              setSelection(
                nextEntry === null ? emptySelection() : selectionFromEntry(nextEntry),
              )
              localDraftRef.current =
                nextEntry === null ? emptySelection() : selectionFromEntry(nextEntry)
            }
            setFeedback('这条日记已不存在。')
            return
          }
          if (
            error instanceof DiaryApplicationError &&
            error.code === 'VALIDATION'
          ) {
            setSaveStatus('error')
            setFeedback('输入有误，请检查内容。')
            return
          }
          // UNAVAILABLE or unknown safe error
          setSaveStatus('error')
          setFeedback('保存暂时失败，请重试。')
          throw error
        }
        throw error
      }

      if (
        mountedRef.current &&
        draftRevisionRef.current > savedRevisionRef.current
      ) {
        await runSaveLoop()
      }
    }

    const savePromise = runSaveLoop()
    saveLoopPromiseRef.current = savePromise
    setSaveStatus('saving')
    try {
      await saveLoopPromiseRef.current
    } finally {
      if (saveLoopPromiseRef.current === savePromise) {
        saveLoopPromiseRef.current = null
      }
    }
  }

  function handleTitleChange(value: string): void {
    const newDraft = {
      ...localDraftRef.current,
      draftTitle: value,
    }
    localDraftRef.current = newDraft
    setSelection(newDraft)
    draftRevisionRef.current += 1
    setSaveStatus('saving')
    scheduleDebounceFlush()
  }

  function handleContentChange(value: string): void {
    const newDraft = {
      ...localDraftRef.current,
      draftContent: value,
    }
    localDraftRef.current = newDraft
    setSelection(newDraft)
    draftRevisionRef.current += 1
    setSaveStatus('saving')
    scheduleDebounceFlush()
  }

  function handleTitleBlur(): void {
    if (isDirty()) {
      void flushCurrentDraft().catch(() => {})
    }
  }

  function handleContentBlur(): void {
    if (isDirty()) {
      void flushCurrentDraft().catch(() => {})
    }
  }

  const reloadEntries = useCallback(async (currentService: DiaryService) => {
    const loadedEntries = await currentService.listActive()
    if (mountedRef.current) {
      setEntries(loadedEntries)
    }
    return loadedEntries
  }, [])

  async function handleSwitchToEntry(entry: DiaryEntry): Promise<void> {
    if (isDirty()) {
      try {
        await flushCurrentDraft()
      } catch {
        setFeedback('保存暂时失败，请重试。')
        return
      }
    }
    const targetSelection = selectionFromEntry(entry)
    if (mountedRef.current) {
      setSelection(targetSelection)
      localDraftRef.current = targetSelection
      draftRevisionRef.current = 0
      savedRevisionRef.current = 0
      setSaveStatus('saved')
      setFeedback(null)
    }
  }

  function openCreate(): void {
    if (phase !== 'ready') return
    setCreateDateValue(today)
    setIsCreateOpen(true)
    setFeedback(null)
  }

  function cancelCreate(): void {
    setIsCreateOpen(false)
    setCreateDateValue('')
  }

  async function confirmCreate(): Promise<void> {
    if (service === null || isCreating) return
    const date = createDateValue
    if (!isValidLocalDate(date) || date > today) {
      setFeedback('不能选择未来日期。')
      return
    }
    if (isDirty()) {
      try {
        await flushCurrentDraft()
      } catch {
        setFeedback('保存暂时失败，请重试。')
        return
      }
    }
    setIsCreating(true)
    setFeedback(null)
    try {
      const existing = await service.getActiveByDiaryDate(date)
      if (existing !== null) {
        await handleSwitchToEntry(existing)
        setIsCreateOpen(false)
        setIsCreating(false)
        setCreateDateValue('')
        return
      }
      const created = await service.createDiaryEntry({
        diaryDate: date,
        title: '',
        content: '',
      })
      const loaded = await reloadEntries(service)
      const found = loaded.find((entry) => entry.id === created.id) ?? created
      if (mountedRef.current) {
        setSelection(selectionFromEntry(found))
        localDraftRef.current = selectionFromEntry(found)
        draftRevisionRef.current = 0
        savedRevisionRef.current = 0
        setSaveStatus('saved')
        setIsCreateOpen(false)
        setCreateDateValue('')
        justCreatedRef.current = true
      }
    } catch (error: unknown) {
      if (
        error instanceof DiaryApplicationError &&
        error.code === 'CONFLICT'
      ) {
        if (mountedRef.current) {
          setFeedback('该日期已有日记。')
          const loaded = await reloadEntries(service)
          const existing =
            loaded.find((entry) => entry.diaryDate === date) ??
            (await service.getActiveByDiaryDate(date))
          if (existing !== null) {
            await handleSwitchToEntry(existing)
          }
          setIsCreateOpen(false)
          setCreateDateValue('')
        }
      } else if (
        error instanceof DiaryApplicationError &&
        error.code === 'UNAVAILABLE'
      ) {
        if (mountedRef.current) {
          setFeedback('日记暂时不可用，请稍后重试。')
        }
      } else {
        if (mountedRef.current) {
          setFeedback('日记创建失败，请重试。')
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsCreating(false)
      }
    }
  }

  function openChangeDate(): void {
    if (selection.id === null) return
    clearDebounceTimer()
    setChangeDateValue(selection.diaryDate ?? today)
    setChangeDateError(null)
    setShowChangeDateDialog(true)
  }

  function cancelChangeDate(): void {
    setShowChangeDateDialog(false)
    setChangeDateError(null)
  }

  async function confirmChangeDate(): Promise<void> {
    if (service === null || selection.id === null) return
    const newDate = changeDateValue
    if (!isValidLocalDate(newDate) || newDate > today) {
      setChangeDateError('不能选择未来日期。')
      return
    }
    if (isDirty()) {
      try {
        await flushCurrentDraft()
      } catch {
        setFeedback('保存暂时失败，请重试。')
        return
      }
    }
    const currentId = selection.id
    dateChangeIntentRef.current = currentId
    clearDebounceTimer()
    setChangeDateError(null)
    setFeedback(null)
    try {
      const updated = await service.changeDiaryDate({
        id: currentId,
        diaryDate: newDate,
      })
      if (mountedRef.current) {
        // Keep id/title/content; adopt the new diaryDate.
        setSelection((prev) => ({ ...prev, diaryDate: updated.diaryDate }))
        await reloadEntries(service)
        setShowChangeDateDialog(false)
      }
    } catch (error: unknown) {
      if (
        error instanceof DiaryApplicationError &&
        error.code === 'CONFLICT'
      ) {
        // Keep original diaryDate, title/content, and current selection.
        if (mountedRef.current) {
          setFeedback('该日期已有日记，无法移动到此日期。')
          setShowChangeDateDialog(false)
        }
      } else if (
        error instanceof DiaryApplicationError &&
        error.code === 'NOT_FOUND'
      ) {
        if (mountedRef.current) {
          setFeedback('这条日记已不存在。')
          setShowChangeDateDialog(false)
          const loaded = await reloadEntries(service)
          const next = loaded[0] ?? null
          if (mountedRef.current) {
            setSelection(
              next === null ? emptySelection() : selectionFromEntry(next),
            )
            localDraftRef.current =
              next === null ? emptySelection() : selectionFromEntry(next)
          }
        }
      } else if (
        error instanceof DiaryApplicationError &&
        error.code === 'VALIDATION'
      ) {
        setChangeDateError('不能选择未来日期。')
        return
      } else if (
        error instanceof DiaryApplicationError &&
        error.code === 'UNAVAILABLE'
      ) {
        if (mountedRef.current) {
          setFeedback('日记暂时不可用，请稍后重试。')
          setShowChangeDateDialog(false)
        }
      } else {
        if (mountedRef.current) {
          setFeedback('日记暂时不可用，请稍后重试。')
          setShowChangeDateDialog(false)
        }
      }
    } finally {
      dateChangeIntentRef.current = null
    }
  }

  function handleRequestDelete(): void {
    if (selection.id === null) return
    clearDebounceTimer()
    setShowDeleteDialog(true)
  }

  async function handleConfirmDelete(): Promise<void> {
    setShowDeleteDialog(false)
    if (service === null) return

    const currentId = localDraftRef.current.id
    if (currentId === null) return

    deleteIntentRef.current = currentId
    clearDebounceTimer()

    if (saveLoopPromiseRef.current !== null) {
      try {
        await saveLoopPromiseRef.current
      } catch {
        // If save failed, still proceed with delete.
      }
    }

    try {
      await service.softDelete(currentId)
      const loaded = await reloadEntries(service)
      const originalIndex = entries.findIndex((entry) => entry.id === currentId)
      let nextSelection: SelectionState
      const currentEntry = loaded[originalIndex]
      const prevEntry = loaded[originalIndex - 1]
      if (currentEntry !== undefined) {
        nextSelection = selectionFromEntry(currentEntry)
      } else if (prevEntry !== undefined) {
        nextSelection = selectionFromEntry(prevEntry)
      } else {
        nextSelection = emptySelection()
      }
      if (mountedRef.current) {
        setSelection(nextSelection)
        localDraftRef.current = nextSelection
        draftRevisionRef.current = 0
        savedRevisionRef.current = 0
        setSaveStatus('saved')
        setFeedback(null)
      }
    } catch (error: unknown) {
      if (
        error instanceof DiaryApplicationError &&
        error.code === 'NOT_FOUND'
      ) {
        const loaded = await reloadEntries(service)
        const next = loaded.find((entry) => entry.id !== currentId) ?? null
        if (mountedRef.current) {
          setSelection(next === null ? emptySelection() : selectionFromEntry(next))
          localDraftRef.current =
            next === null ? emptySelection() : selectionFromEntry(next)
        }
        setFeedback('这条日记已不存在。')
      } else if (
        error instanceof DiaryApplicationError &&
        error.code === 'UNAVAILABLE'
      ) {
        if (mountedRef.current) {
          setFeedback('删除暂时失败，请重试。')
        }
      } else {
        if (mountedRef.current) {
          setFeedback('日记删除失败，请稍后重试。')
        }
      }
    } finally {
      deleteIntentRef.current = null
    }
  }

  function handleCancelDelete(): void {
    setShowDeleteDialog(false)
    deleteIntentRef.current = null
  }

  function retryLoad(): void {
    setPhase('loading')
    setService(null)
    setEntries([])
    setSelection(emptySelection())
    setFeedback(null)
    setIsCreating(false)
    setIsCreateOpen(false)
    setCreateDateValue('')
    setSaveStatus('saved')
    setShowDeleteDialog(false)
    setShowChangeDateDialog(false)
    setChangeDateError(null)
    deleteIntentRef.current = null
    dateChangeIntentRef.current = null
    clearDebounceTimer()
    setLoadAttempt((attempt) => attempt + 1)
  }

  const emptyReason: 'no-entries' | null =
    phase !== 'ready' ? null : entries.length === 0 ? 'no-entries' : null

  const selectedEntry = useMemo(
    () => entries.find((entry) => entry.id === selection.id) ?? null,
    [entries, selection.id],
  )

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-6 pb-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-hero font-semibold tracking-tight text-foreground">
            日记
          </h2>
          <p className="mt-2 text-body text-foreground-secondary">
            按日期记录每一天，列表与编辑器保持本地优先。
          </p>
        </div>
        {phase === 'ready' && !isCreateOpen && (
          <Button
            disabled={isCreating}
            onClick={openCreate}
            type="button"
          >
            <Plus data-icon="inline-start" />
            {isCreating ? '创建中…' : '新建日记'}
          </Button>
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

      {phase === 'loading' && <LoadingState />}

      {phase === 'error' && (
        <div
          className="flex min-h-80 flex-col items-center justify-center rounded-lg border border-danger/15 bg-danger-soft/30 p-8 text-center"
          role="alert"
        >
          <BookOpen className="size-9 text-danger" aria-hidden="true" />
          <h3 className="mt-4 text-module font-semibold">无法加载日记</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            本地日记数据暂时不可用，请稍后重试。
          </p>
          <Button className="mt-5" onClick={retryLoad} type="button">
            <RotateCcw data-icon="inline-start" />
            重试
          </Button>
        </div>
      )}

      {phase === 'ready' && (
        <div className="grid min-h-104 gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]">
          <aside className="rounded-lg border border-border bg-surface shadow-xs">
            <div className="border-b border-border p-4">
              <p className="text-body text-foreground-secondary">
                {entries.length} 篇日记
              </p>
            </div>

            {isCreateOpen && (
              <div className="space-y-3 border-b border-border p-4">
                <label className="text-body font-medium text-foreground">
                  选择日记日期
                </label>
                <DiaryDateInput
                  label="选择日记日期"
                  max={today}
                  onChange={setCreateDateValue}
                  value={createDateValue}
                />
                <div className="flex items-center gap-2">
                  <Button
                    disabled={isCreating}
                    onClick={() => void confirmCreate()}
                    type="button"
                  >
                    {isCreating ? '创建中…' : '创建'}
                  </Button>
                  <Button
                    onClick={cancelCreate}
                    type="button"
                    variant="outline"
                  >
                    取消
                  </Button>
                </div>
              </div>
            )}

            {emptyReason === 'no-entries' ? (
              <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-primary-softest text-primary">
                  <BookOpen className="size-6" aria-hidden="true" />
                </div>
                <h3 className="mt-3 text-module font-semibold">还没有日记</h3>
                <p className="mt-2 text-body text-foreground-secondary">
                  从今天开始，记录每一天发生的故事与想法。
                </p>
                <Button
                  className="mt-4"
                  disabled={isCreating}
                  onClick={openCreate}
                  type="button"
                >
                  <Plus data-icon="inline-start" />
                  新建今日日记
                </Button>
              </div>
            ) : (
              <ul aria-label="日记列表" className="max-h-120 overflow-y-auto p-2">
                {entries.map((entry) => (
                  <li key={entry.id}>
                    <button
                      aria-current={
                        selection.id === entry.id ? 'page' : undefined
                      }
                      className={cn(
                        'w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-hover',
                        selection.id === entry.id && 'bg-hover text-foreground',
                      )}
                      onClick={() => void handleSwitchToEntry(entry)}
                      type="button"
                    >
                      <span className="block truncate text-body font-semibold text-foreground">
                        {formatDiaryDate(entry.diaryDate)}
                      </span>
                      <span className="mt-1 block truncate text-sm text-foreground-secondary">
                        {entry.title || '无标题'}
                      </span>
                      <span className="mt-1 block truncate text-xs text-foreground-tertiary">
                        {previewFromEntry(entry)}
                      </span>
                      <span className="mt-2 block text-xs text-foreground-tertiary">
                        {formatTimestamp(entry.updatedAtMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <article className="flex min-h-104 flex-col rounded-lg border border-border bg-surface shadow-xs">
            {selectedEntry === null ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-surface-secondary text-foreground-tertiary">
                  <BookOpen className="size-6" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-module font-semibold">
                  选择或创建一篇日记
                </h3>
                <p className="mt-2 max-w-sm text-body text-foreground-secondary">
                  从左侧列表选择日记进行编辑，或新建日记开始记录。
                </p>
              </div>
            ) : (
              <>
                <div className="flex items-center justify-between gap-3 border-b border-border p-4">
                  <span
                    aria-label="当前日记日期"
                    className="text-module font-semibold text-foreground"
                  >
                    {selection.diaryDate !== null
                      ? formatDiaryDate(selection.diaryDate)
                      : ''}
                  </span>
                  <Button
                    onClick={openChangeDate}
                    type="button"
                    variant="outline"
                    size="sm"
                  >
                    <CalendarDays data-icon="inline-start" />
                    更改日期
                  </Button>
                </div>
                <div className="border-b border-border px-4 py-3">
                  <Input
                    aria-label="日记标题"
                    className="border-0 bg-transparent px-1 py-1 text-hero font-semibold shadow-none focus-visible:border-transparent"
                    onChange={(event) => handleTitleChange(event.target.value)}
                    onBlur={handleTitleBlur}
                    placeholder="无标题"
                    value={selection.draftTitle}
                  />
                </div>
                <textarea
                  aria-label="日记正文"
                  className="min-h-72 w-full flex-1 resize-none bg-transparent p-4 text-body leading-relaxed text-foreground outline-none placeholder:text-foreground-tertiary"
                  onChange={(event) => handleContentChange(event.target.value)}
                  onBlur={handleContentBlur}
                  placeholder="开始写日记…"
                  value={selection.draftContent}
                />
                <div className="flex items-center justify-between gap-3 border-t border-border p-4">
                  <div className="flex items-center gap-2 text-xs text-foreground-secondary">
                    <span>
                      {saveStatus === 'saved'
                        ? '已保存'
                        : saveStatus === 'saving'
                          ? '正在保存…'
                          : '保存暂时失败，请重试。'}
                    </span>
                    <span>·</span>
                    <span>
                      上次更新：{formatTimestamp(selectedEntry.updatedAtMs)}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      disabled={isCreating}
                      onClick={handleRequestDelete}
                      type="button"
                      variant="destructive"
                    >
                      <Trash2 data-icon="inline-start" />
                      删除
                    </Button>
                  </div>
                </div>
              </>
            )}
          </article>
        </div>
      )}

      <Dialog open={showDeleteDialog} onOpenChange={setShowDeleteDialog}>
        <DialogContent>
          <DialogTitle>删除这篇日记？</DialogTitle>
          <DialogDescription>
            删除后，这篇日记将从日记列表中移除。
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelDelete}>
              取消
            </Button>
            <Button
              variant="destructive"
              onClick={() => void handleConfirmDelete()}
            >
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={showChangeDateDialog} onOpenChange={setShowChangeDateDialog}>
        <DialogContent>
          <DialogTitle>更改日期</DialogTitle>
          <DialogDescription>
            选择新的日记日期，不能晚于今天。
          </DialogDescription>
          <DiaryDateInput
            label="日记日期"
            max={today}
            onChange={setChangeDateValue}
            value={changeDateValue}
          />
          {changeDateError !== null && (
            <p className="text-sm text-destructive">{changeDateError}</p>
          )}
          <DialogFooter>
            <Button variant="outline" onClick={cancelChangeDate}>
              取消
            </Button>
            <Button onClick={() => void confirmChangeDate()}>确认更改</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
