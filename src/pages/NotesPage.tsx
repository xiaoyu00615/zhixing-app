import { Archive, NotebookPen, Plus, RotateCcw, Trash2 } from 'lucide-react'
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
import type { Note } from '@/note/model'
import { openNoteRuntime } from '@/note/runtime'
import type { OpenNoteRuntime } from '@/note/runtime.types'
import { NoteApplicationError, type NoteService } from '@/note/service'
import { cn } from '@/lib/utils'
import { useOptionalMaintenanceCoordinator } from '@/maintenance/context'
import type { EditorRegistration } from '@/maintenance/model'

interface NotesPageProps {
  readonly openRuntime?: OpenNoteRuntime
  /** P5 S4: the `?id=` deep-link value supplied by the route. */
  readonly requestedNoteId?: string | null
}

type NotesPhase = 'loading' | 'ready' | 'error'
type EmptyReason = 'unavailable' | 'no-notes'
type SaveStatus = 'saved' | 'saving' | 'error'

interface SelectionState {
  id: string | null
  draftTitle: string
  draftContent: string
}

function emptySelection(): SelectionState {
  return { id: null, draftTitle: '', draftContent: '' }
}

function selectionFromNote(note: Note): SelectionState {
  return {
    id: note.id,
    draftTitle: note.title,
    draftContent: note.content,
  }
}

function formatNoteDate(timestamp: number): string {
  return new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(timestamp))
}

function previewFromNote(note: Note): string {
  const preview = note.content.trim().replace(/\s+/g, ' ')
  return preview.length > 0 ? preview : '暂无正文'
}

/** Stable editor participant id for the Note page-local dirty draft. */
const NOTE_EDITOR_PARTICIPANT_ID = 'note-editor'

function LoadingState() {
  return (
    <div
      className="grid min-h-96 gap-4 lg:grid-cols-[minmax(300px,360px)_minmax(0,1fr)]"
      role="status"
      aria-label="正在加载笔记"
    >
      <span className="sr-only">正在加载笔记</span>
      {[0, 1, 2].map((item) => (
        <div
          className="h-24 animate-pulse rounded-lg border border-border bg-surface-secondary/40"
          key={item}
        />
      ))}
    </div>
  )
}

export function NotesPage({
  openRuntime = openNoteRuntime,
  requestedNoteId = null,
}: NotesPageProps) {
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [phase, setPhase] = useState<NotesPhase>('loading')
  const [service, setService] = useState<NoteService | null>(null)
  const [notes, setNotes] = useState<readonly Note[]>([])
  const [selection, setSelection] = useState<SelectionState>(emptySelection())
  const [feedback, setFeedback] = useState<string | null>(null)
  const [isCreating, setIsCreating] = useState(false)
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('saved')
  const [showDeleteDialog, setShowDeleteDialog] = useState(false)
  const [archiving, setArchiving] = useState(false)
  const archiveIntentRef = useRef<string | null>(null)

  // Autosave state
  const localDraftRef = useRef<SelectionState>(emptySelection())
  const draftRevisionRef = useRef(0)
  const savedRevisionRef = useRef(0)
  const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const saveLoopPromiseRef = useRef<Promise<void> | null>(null)
  const deleteIntentRef = useRef<string | null>(null)

  // P6-S2 maintenance coordination (editor quiesce). The coordinator lives at the
  // App level; this page only registers its dirty-draft flush as a participant.
  const maintenance = useOptionalMaintenanceCoordinator()
  const flushCurrentDraftRef = useRef<() => Promise<void>>(async () => {})
  const registrationRef = useRef<EditorRegistration | null>(null)

  // Runtime lifecycle
  const mountedRef = useRef(false)
  const runtimeRef = useRef<Awaited<ReturnType<OpenNoteRuntime>> | null>(null)

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
    }
  }, [])

  // Keep the registered participant's flush pointing at the latest
  // flushCurrentDraft implementation (it closes over the current `service`).
  useEffect(() => {
    flushCurrentDraftRef.current = flushCurrentDraft
  })

  // P5 S4: apply the ?id= deep-link value through the existing selection
  // mechanism (no second editor, no autosave bypass). Absent, malformed or
  // unknown ids are ignored. Only a *changed* requested id is applied.
  const appliedRequestedIdRef = useRef<string | null>(null)

  useEffect(() => {
    if (requestedNoteId === null || requestedNoteId === '') {
      return
    }
    if (appliedRequestedIdRef.current === requestedNoteId) {
      return
    }
    const match = notes.find((note) => note.id === requestedNoteId)
    if (match === undefined) {
      return
    }
    appliedRequestedIdRef.current = requestedNoteId
    void handleSwitchToNote(match)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestedNoteId, notes])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenNoteRuntime>> | null = null
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
        const loadedNotes = await runtime.service.listActive()
        if (!active) {
          await disposeRuntime()
          return
        }
        setService(runtime.service)
        runtimeRef.current = runtime
        const firstNote = loadedNotes[0] ?? null
        setNotes(loadedNotes)
        const initialSelection =
          firstNote === null ? emptySelection() : selectionFromNote(firstNote)
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
      // Hand the unmount flush + dispose completion to the coordinator as
      // RETIRING so a concurrent maintenance preparation can await it. Falls back
      // to fire-and-forget only when no coordinator is available (e.g. unit
      // tests that render the page directly).
      const isDirty =
        localDraftRef.current.id !== null &&
        draftRevisionRef.current > savedRevisionRef.current
      const completion = (async () => {
        try {
          if (isDirty) {
            // A flush failure MUST reject the retirement completion: the
            // coordinator caches that failure and the next maintenance
            // preparation fails. Swallowing it here would let a later
            // preparation treat an unpersisted draft as safe.
            await flushCurrentDraftRef.current()
          }
        } finally {
          await disposeRuntime()
        }
      })()
      const registration = registrationRef.current
      if (registration !== null) {
        registration.retire(completion)
      } else {
        // No coordinator available (e.g. unit tests rendering the page directly):
        // still perform the flush + dispose so behavior is unchanged. Nothing can
        // observe a failure here, so attach a no-op catch to avoid unhandled
        // promise rejections.
        void completion.catch(() => {})
      }
    }
  }, [loadAttempt, openRuntime])

  // P6-S2R: register this editor as an ACTIVE participant once a runtime/service
  // is available. `register()` returns a handle scoped to THIS mount instance: on
  // unmount the runtime-effect cleanup hands the flush+dispose completion promise
  // to that handle (RETIRING). StrictMode-safe: a remount gets a NEW registration
  // token, so it never cancels or clears a still-pending retirement of the same
  // logical editor — both are awaited by maintenance preparation.
  useEffect(() => {
    if (maintenance === null || service === null) {
      return
    }
    const registration = maintenance.register({
      id: NOTE_EDITOR_PARTICIPANT_ID,
      flush: () => flushCurrentDraftRef.current(),
    })
    registrationRef.current = registration
    return () => {
      registrationRef.current = null
    }
  }, [maintenance, service])

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

  async function refreshCanonicalList(): Promise<readonly Note[]> {
    const currentService = service
    if (currentService === null) return notes
    try {
      const refreshed = await currentService.listActive()
      if (mountedRef.current) {
        setNotes(refreshed)
      }
      return refreshed
    } catch {
      if (mountedRef.current) {
        setFeedback('列表暂时无法刷新。')
      }
      return notes
    }
  }

  async function flushCurrentDraft(): Promise<void> {
    const currentService = service
    if (currentService === null) return
    if (deleteIntentRef.current !== null) return

    const currentId = localDraftRef.current.id
    if (currentId === null) return

    const currentDraftRevision = draftRevisionRef.current
    const currentSavedRevision = savedRevisionRef.current

    if (currentDraftRevision <= currentSavedRevision) {
      return
    }

    // If a save loop is already running, wait for it to settle BEFORE deciding
    // whether the latest draft still needs persistence. We must NOT return after
    // an in-flight save: a newer revision may have been created while it ran, and
    // that newer revision must also be persisted before this flush resolves.
    if (saveLoopPromiseRef.current !== null) {
      await saveLoopPromiseRef.current
      if (draftRevisionRef.current <= savedRevisionRef.current) {
        return
      }
      // Fall through: a newer revision exists and must be persisted now.
    }

    async function runSaveLoop(): Promise<void> {
      if (currentService === null) return
      if (deleteIntentRef.current !== null) return
      // Capture fresh snapshot each loop iteration so newer edits are included.
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
        await currentService.updateNote({
          id: snapshot.id,
          title: snapshot.title,
          content: snapshot.content,
        })
        // Persistence bookkeeping MUST happen regardless of mount state: the
        // draft is persisted even while the editor is unmounting / retiring, so
        // `await flushCurrentDraft()` can only resolve once the NEWEST known
        // revision has been written.
        savedRevisionRef.current = snapshot.revision
        if (mountedRef.current) {
          setSaveStatus('saved')
          setFeedback(null)
          await refreshCanonicalList()
        }
      } catch (error: unknown) {
        const isNotFound =
          error instanceof NoteApplicationError && error.code === 'NOT_FOUND'
        if (isNotFound) {
          // Persistence bookkeeping is NEVER gated on mount state: the entity no
          // longer exists, so this revision is settled even while the editor is
          // unmounting / retiring.
          savedRevisionRef.current = snapshot.revision
          if (!mountedRef.current) {
            return
          }
          setSaveStatus('saved')
          setFeedback(null)
          const refreshed = await refreshCanonicalList()
          const nextNote = refreshed[0] ?? null
          setSelection(
            nextNote === null ? emptySelection() : selectionFromNote(nextNote),
          )
          localDraftRef.current =
            nextNote === null ? emptySelection() : selectionFromNote(nextNote)
          setFeedback('这条笔记已不存在。')
          return
        }
        if (
          error instanceof NoteApplicationError &&
          error.code === 'VALIDATION'
        ) {
          if (mountedRef.current) {
            setSaveStatus('error')
            setFeedback('输入有误，请检查内容。')
            return
          }
          throw error
        }
        // UNAVAILABLE or unknown safe error
        if (mountedRef.current) {
          setSaveStatus('error')
          setFeedback('保存暂时失败，请重试。')
        }
        throw error
      }

      // Check if there's a newer revision to save. This must NOT be gated on
      // mount: an unmounting / retiring editor must still flush the newest known
      // draft before maintenance preparation is allowed to succeed.
      if (draftRevisionRef.current > savedRevisionRef.current) {
        await runSaveLoop()
      }
    }

    const savePromise = runSaveLoop()
    saveLoopPromiseRef.current = savePromise
    if (mountedRef.current) {
      setSaveStatus('saving')
    }
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
    if (
      localDraftRef.current.id !== null &&
      draftRevisionRef.current > savedRevisionRef.current
    ) {
      void flushCurrentDraft().catch(() => {})
    }
  }

  function handleContentBlur(): void {
    if (
      localDraftRef.current.id !== null &&
      draftRevisionRef.current > savedRevisionRef.current
    ) {
      void flushCurrentDraft().catch(() => {})
    }
  }

  const reloadNotes = useCallback(async (currentService: NoteService) => {
    const loadedNotes = await currentService.listActive()
    if (mountedRef.current) {
      setNotes(loadedNotes)
    }
    return loadedNotes
  }, [])

  async function startCreateNote() {
    if (service === null || isCreating) {
      return
    }
    // If dirty, flush first
    if (
      localDraftRef.current.id !== null &&
      draftRevisionRef.current > savedRevisionRef.current
    ) {
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
      const createdNote = await service.createNote({
        title: '',
        content: '',
      })
      const loadedNotes = await reloadNotes(service)
      const foundNote =
        loadedNotes.find((n) => n.id === createdNote.id) ?? createdNote
      if (mountedRef.current) {
        setSelection(selectionFromNote(foundNote))
        localDraftRef.current = selectionFromNote(foundNote)
        draftRevisionRef.current = 0
        savedRevisionRef.current = 0
        setSaveStatus('saved')
      }
    } catch (error: unknown) {
      if (
        error instanceof NoteApplicationError &&
        error.code === 'UNAVAILABLE'
      ) {
        if (mountedRef.current) {
          setFeedback('笔记暂时无法创建，请重试。')
        }
      } else {
        if (mountedRef.current) {
          setFeedback('笔记创建失败，请重试。')
        }
      }
    } finally {
      if (mountedRef.current) {
        setIsCreating(false)
      }
    }
  }

  async function handleSwitchToNote(note: Note): Promise<void> {
    // If dirty, flush first
    if (
      localDraftRef.current.id !== null &&
      draftRevisionRef.current > savedRevisionRef.current
    ) {
      try {
        await flushCurrentDraft()
      } catch {
        setFeedback('保存暂时失败，请重试。')
        return
      }
    }
    const targetSelection = selectionFromNote(note)
    if (mountedRef.current) {
      setSelection(targetSelection)
      localDraftRef.current = targetSelection
      draftRevisionRef.current = 0
      savedRevisionRef.current = 0
      setSaveStatus('saved')
      setFeedback(null)
    }
  }

  function handleRequestDelete(): void {
    clearDebounceTimer()
    setShowDeleteDialog(true)
  }

  async function handleConfirmDelete() {
    setShowDeleteDialog(false)
    if (service === null) return

    const currentId = localDraftRef.current.id
    if (currentId === null) return

    // Record delete intent and cancel debounce
    deleteIntentRef.current = currentId
    clearDebounceTimer()

    // Wait for any in-flight save to settle
    if (saveLoopPromiseRef.current !== null) {
      try {
        await saveLoopPromiseRef.current
      } catch {
        // If save failed (e.g. UNAVAILABLE), still proceed with delete
      }
    }

    // After in-flight settles, check if a newer revision was created during the wait
    // Delete intent means we should NOT start new saves
    if (
      localDraftRef.current.id !== null &&
      draftRevisionRef.current > savedRevisionRef.current &&
      deleteIntentRef.current === currentId
    ) {
      // There's a newer revision but delete intent is set - don't save it
      // Just proceed with delete
    }

    try {
      await service.softDelete(currentId)
      const loadedNotes = await reloadNotes(service)
      const originalIndex = notes.findIndex((n) => n.id === currentId)
      let nextSelection: SelectionState
      if (loadedNotes[originalIndex] !== undefined) {
        nextSelection = selectionFromNote(loadedNotes[originalIndex])
      } else if (loadedNotes[originalIndex - 1] !== undefined) {
        nextSelection = selectionFromNote(loadedNotes[originalIndex - 1]!)
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
        error instanceof NoteApplicationError &&
        error.code === 'NOT_FOUND'
      ) {
        const loadedNotes = await reloadNotes(service)
        const nextNote =
          loadedNotes.find((n) => n.id !== currentId) ?? loadedNotes[0] ?? null
        if (mountedRef.current) {
          setSelection(
            nextNote === null ? emptySelection() : selectionFromNote(nextNote),
          )
          localDraftRef.current =
            nextNote === null ? emptySelection() : selectionFromNote(nextNote)
        }
        setFeedback('这条笔记已不存在。')
      } else if (
        error instanceof NoteApplicationError &&
        error.code === 'UNAVAILABLE'
      ) {
        if (mountedRef.current) {
          setFeedback('删除暂时失败，请重试。')
        }
      } else {
        if (mountedRef.current) {
          setFeedback('笔记删除失败，请稍后重试。')
        }
      }
    } finally {
      deleteIntentRef.current = null
    }
  }

  function handleCancelDelete() {
    setShowDeleteDialog(false)
    deleteIntentRef.current = null
  }

  /**
   * Archive V1 (UI): move the ACTIVE note into the archived state.
   *
   * Safety contract (P5C S3):
   *   1. enter `archiving` pending state and lock editor + conflicting actions
   *   2. clear the debounce timer so no late autosave can race the archive
   *   3. await any in-flight save loop, then flush the latest draft if dirty
   *   4. ONLY after the draft is persisted do we call `service.archive(id)`
   *   5. if the save fails, we do NOT archive and surface safe feedback
   *
   * We never touch the repository, the Worker, Tauri or SQL directly: the
   * canonical NoteService owns the state transition.
   */
  async function handleArchive(): Promise<void> {
    if (service === null || archiving) return
    const currentId = localDraftRef.current.id
    if (currentId === null) return

    setArchiving(true)
    archiveIntentRef.current = currentId
    clearDebounceTimer()

    try {
      // Wait for any in-flight save loop to settle before touching the note.
      if (saveLoopPromiseRef.current !== null) {
        try {
          await saveLoopPromiseRef.current
        } catch {
          // The in-flight failure already reported feedback; fall through and
          // let the flush below re-attempt the latest draft.
        }
      }

      // Persist the latest draft (if any) BEFORE archiving. A throw here means
      // the save failed: we must not archive a note we could not save.
      try {
        await flushCurrentDraft()
      } catch {
        if (mountedRef.current) {
          setFeedback('保存暂时失败，未归档')
        }
        return
      }

      await service.archive(currentId)

      const loadedNotes = await reloadNotes(service)
      // Safe selection move (mirrors the delete flow): same index, else
      // previous, else empty. The archived note is excluded from listActive.
      const originalIndex = notes.findIndex((note) => note.id === currentId)
      let nextSelection: SelectionState
      if (loadedNotes[originalIndex] !== undefined) {
        nextSelection = selectionFromNote(loadedNotes[originalIndex])
      } else if (loadedNotes[originalIndex - 1] !== undefined) {
        nextSelection = selectionFromNote(loadedNotes[originalIndex - 1]!)
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
      if (mountedRef.current) {
        if (
          error instanceof NoteApplicationError &&
          error.code === 'NOT_FOUND'
        ) {
          const loadedNotes = await reloadNotes(service)
          const nextNote =
            loadedNotes.find((note) => note.id !== currentId) ??
            loadedNotes[0] ??
            null
          if (mountedRef.current) {
            setSelection(
              nextNote === null ? emptySelection() : selectionFromNote(nextNote),
            )
            localDraftRef.current =
              nextNote === null ? emptySelection() : selectionFromNote(nextNote)
            draftRevisionRef.current = 0
            savedRevisionRef.current = 0
            setSaveStatus('saved')
          }
          setFeedback('这条笔记已不存在。')
        } else if (
          error instanceof NoteApplicationError &&
          error.code === 'UNAVAILABLE'
        ) {
          setFeedback('归档暂时失败，请重试。')
        } else {
          setFeedback('笔记归档失败，请稍后重试。')
        }
      }
    } finally {
      if (mountedRef.current) {
        setArchiving(false)
      }
      archiveIntentRef.current = null
    }
  }

  function retryLoad() {
    setPhase('loading')
    setService(null)
    setNotes([])
    setSelection(emptySelection())
    setFeedback(null)
    setIsCreating(false)
    setSaveStatus('saved')
    deleteIntentRef.current = null
    clearDebounceTimer()
    setLoadAttempt((attempt) => attempt + 1)
  }

  const emptyReason: EmptyReason | null =
    phase !== 'ready'
      ? null
      : notes.length === 0
        ? 'no-notes'
        : null

  const selectedNote = useMemo(
    () => notes.find((note) => note.id === selection.id) ?? null,
    [notes, selection.id],
  )

  return (
    <section className="mx-auto w-full max-w-[1440px] space-y-6 pb-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h2 className="text-hero font-semibold tracking-tight text-foreground">
            笔记
          </h2>
          <p className="mt-2 text-body text-foreground-secondary">
            保存零散知识与长文本，列表和编辑器保持本地优先。
          </p>
        </div>
        {phase === 'ready' && (
            <Button
              disabled={isCreating || archiving}
              onClick={() => void startCreateNote()}
              type="button"
            >
              <Plus data-icon="inline-start" />
              {isCreating ? '创建中…' : '新建笔记'}
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
          <NotebookPen className="size-9 text-danger" aria-hidden="true" />
          <h3 className="mt-4 text-module font-semibold">无法加载笔记</h3>
          <p className="mt-2 text-body text-foreground-secondary">
            本地笔记数据暂时不可用，请稍后重试。
          </p>
          <Button
            className="mt-5"
            onClick={retryLoad}
            type="button"
          >
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
                {notes.length} 篇笔记
              </p>
            </div>

            {emptyReason === 'no-notes' ? (
              <div className="flex min-h-64 flex-col items-center justify-center px-6 py-10 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-primary-softest text-primary">
                  <NotebookPen className="size-6" aria-hidden="true" />
                </div>
                <h3 className="mt-3 text-module font-semibold">还没有笔记</h3>
                <p className="mt-2 text-body text-foreground-secondary">
                  创建第一篇笔记，开始沉淀知识。
                </p>
                  <Button
                    className="mt-4"
                    disabled={isCreating || archiving}
                    onClick={() => void startCreateNote()}
                    type="button"
                  >
                    <Plus data-icon="inline-start" />
                    新建笔记
                  </Button>
              </div>
            ) : (
              <ul aria-label="笔记列表" className="max-h-120 overflow-y-auto p-2">
                {notes.map((note) => (
                  <li key={note.id}>
                    <button
                      aria-current={
                        selection.id === note.id ? 'page' : undefined
                      }
                      className={cn(
                        'w-full rounded-md px-3 py-3 text-left transition-colors hover:bg-hover',
                        selection.id === note.id && 'bg-hover text-foreground',
                      )}
                      disabled={archiving}
                      onClick={() => void handleSwitchToNote(note)}
                      type="button"
                    >
                      <span className="block truncate text-body font-medium text-foreground">
                        {note.title || '无标题'}
                      </span>
                      <span className="mt-1 block truncate text-xs text-foreground-secondary">
                        {previewFromNote(note)}
                      </span>
                      <span className="mt-2 block text-xs text-foreground-tertiary">
                        {formatNoteDate(note.updatedAtMs)}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </aside>

          <article className="flex min-h-104 flex-col rounded-lg border border-border bg-surface shadow-xs">
            {selectedNote === null ? (
              <div className="flex flex-1 flex-col items-center justify-center px-6 py-12 text-center">
                <div className="flex size-12 items-center justify-center rounded-xl bg-surface-secondary text-foreground-tertiary">
                  <NotebookPen className="size-6" aria-hidden="true" />
                </div>
                <h3 className="mt-4 text-module font-semibold">
                  选择或创建一篇笔记
                </h3>
                <p className="mt-2 max-w-sm text-body text-foreground-secondary">
                  从左侧列表选择笔记进行编辑，或新建笔记开始记录。
                </p>
              </div>
            ) : (
              <>
                <div className="border-b border-border p-4">
                  <Input
                    aria-label="笔记标题"
                    className="border-0 bg-transparent px-1 py-1 text-hero font-semibold shadow-none focus-visible:border-transparent"
                    disabled={archiving}
                    onChange={(event) => handleTitleChange(event.target.value)}
                    onBlur={handleTitleBlur}
                    placeholder="无标题"
                    value={selection.draftTitle}
                  />
                </div>
                <textarea
                  aria-label="笔记正文"
                  className="min-h-72 w-full flex-1 resize-none bg-transparent p-4 text-body leading-relaxed text-foreground outline-none placeholder:text-foreground-tertiary"
                  disabled={archiving}
                  onChange={(event) => handleContentChange(event.target.value)}
                  onBlur={handleContentBlur}
                  placeholder="开始写笔记…"
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
                    <span>上次更新：{formatNoteDate(selectedNote.updatedAtMs)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button
                      disabled={archiving || isCreating}
                      onClick={() => void handleArchive()}
                      type="button"
                      variant="outline"
                    >
                      <Archive data-icon="inline-start" />
                      {archiving ? '归档中…' : '归档'}
                    </Button>
                    <Button
                      disabled={archiving || isCreating}
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
          <DialogTitle>删除这条笔记？</DialogTitle>
          <DialogDescription>
            删除后，这条笔记将不再出现在笔记列表中。
          </DialogDescription>
          <DialogFooter>
            <Button variant="outline" onClick={handleCancelDelete}>
              取消
            </Button>
            <Button variant="destructive" onClick={() => void handleConfirmDelete()}>
              确认删除
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
