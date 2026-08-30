import {
  Background,
  Controls,
  MarkerType,
  ReactFlow,
  ReactFlowProvider,
  SelectionMode,
  applyNodeChanges,
  useReactFlow,
  type Connection,
  type Edge,
  type NodeChange,
  type OnNodeDrag,
  type NodeTypes,
  type Viewport,
} from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import { ArrowLeft, Plus, RotateCcw } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { CanvasEdgeToolbar } from '@/components/canvas/CanvasEdgeToolbar'
import { Button } from '@/components/ui/button'
import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
import type { RegisteredCanvasNodeType } from '@/canvas/model'
import { canvasNodeRegistry, toCanvasFlowNode, type CanvasFlowNode } from '@/canvas/nodeRegistry'
import { openCanvasRuntime } from '@/canvas/runtime'
import type { OpenCanvasRuntime } from '@/canvas/runtime.types'
import type { CanvasService } from '@/canvas/service'
import { PATHS } from '@/routes/paths'

const NODE_TYPES: NodeTypes = canvasNodeRegistry.nodeTypes
const CAMERA_PAN_SPEED_PX_PER_SECOND = 600
const CAMERA_PAN_KEYS = new Set(['w', 'a', 's', 'd'])

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable ||
    target.closest('input, textarea, select, [contenteditable="true"]') !== null
}

function edgeStrokeDasharray(edge: CanvasEdge): string | undefined {
  if (edge.lineStyle === 'dashed') return '8 6'
  if (edge.lineStyle === 'dotted') return '2 6'
  return undefined
}

function toFlowEdge(edge: CanvasEdge, selected: boolean): Edge {
  const marker = { type: MarkerType.ArrowClosed, width: 16, height: 16 }
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    selected,
    markerStart: edge.direction === 'bidirectional' ? marker : undefined,
    markerEnd: edge.direction === 'none' ? undefined : marker,
    style: {
      stroke: selected ? 'var(--color-primary)' : '#7b8495',
      strokeWidth: selected ? 2.2 : 1.8,
      strokeDasharray: edgeStrokeDasharray(edge),
    },
  }
}

interface CanvasEditorPageProps {
  readonly openRuntime?: OpenCanvasRuntime
}

function Editor({ openRuntime }: { readonly openRuntime: OpenCanvasRuntime }) {
  const { canvasId = '' } = useParams()
  const navigate = useNavigate()
  const {
    getViewport,
    screenToFlowPosition,
    setViewport,
  } = useReactFlow<CanvasFlowNode>()
  const [phase, setPhase] = useState<'loading' | 'ready' | 'error'>('loading')
  const [attempt, setAttempt] = useState(0)
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [flowNodes, setFlowNodes] = useState<CanvasFlowNode[]>([])
  const [canvasEdges, setCanvasEdges] = useState<CanvasEdge[]>([])
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null)
  const [edgeBusy, setEdgeBusy] = useState(false)
  const [service, setService] = useState<CanvasService | null>(null)
  const serviceRef = useRef<CanvasService | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const latestViewport = useRef<Viewport | null>(null)
  const persistedViewport = useRef<Viewport | null>(null)
  const dragStartPositions = useRef<
    ReadonlyMap<string, { readonly x: number; readonly y: number }> | null
  >(null)
  const keyboardPanActive = useRef(false)

  const commitNodeContent = useCallback(async (id: string, type: RegisteredCanvasNodeType, text: string) => {
    const currentService = serviceRef.current
    if (currentService === null) return
    try {
      const content = type === 'text'
        ? { type: 'text' as const, text }
        : { type: 'sticky' as const, text }
      const updated = await currentService.updateCanvasNodeContent(id, type, content)
      setFlowNodes((nodes) => nodes.map((node) => node.id === id
        ? { ...node, data: { ...node.data, text: updated.type === 'unknown' ? text : updated.content.text } }
        : node))
      setFeedback('文字已保存')
    } catch {
      setFeedback('文字保存失败，请重试。')
    }
  }, [])

  useEffect(() => {
    let active = true
    let runtime: Awaited<ReturnType<OpenCanvasRuntime>> | null = null
    void (async () => {
      try {
        runtime = await openRuntime()
        const workspace = await runtime.service.openCanvas(canvasId)
        if (!active) { await runtime.dispose(); return }
        latestViewport.current = workspace.canvas.viewport
        persistedViewport.current = workspace.canvas.viewport
        serviceRef.current = runtime.service
        setService(runtime.service)
        setCanvas(workspace.canvas)
        setFlowNodes(workspace.nodes.map((node: CanvasNode) =>
          toCanvasFlowNode(node, (id, type, text) => void commitNodeContent(id, type, text)),
        ))
        setCanvasEdges([...workspace.edges])
        setPhase('ready')
      } catch {
        if (active) setPhase('error')
        await runtime?.dispose()
      }
    })()
    return () => { active = false; void runtime?.dispose() }
  }, [attempt, canvasId, commitNodeContent, openRuntime])

  const persistViewport = useCallback(async (viewport: Viewport) => {
    latestViewport.current = viewport
    const currentService = serviceRef.current
    if (currentService === null || canvasId === '') return
    const previous = persistedViewport.current
    if (previous?.x === viewport.x && previous.y === viewport.y && previous.zoom === viewport.zoom) return
    try {
      const updated = await currentService.updateViewport(canvasId, viewport)
      persistedViewport.current = updated.viewport
      setCanvas(updated)
    } catch {
      setFeedback('视图位置暂时无法保存。')
    }
  }, [canvasId])

  useEffect(() => {
    const heldKeys = new Set<string>()
    let animationFrame: number | null = null
    let previousFrameTime: number | null = null
    let lastPressedHorizontal: 'a' | 'd' | null = null
    let lastPressedVertical: 'w' | 's' | null = null

    const finishKeyboardPan = () => {
      if (animationFrame !== null) {
        window.cancelAnimationFrame(animationFrame)
        animationFrame = null
      }
      previousFrameTime = null
      if (!keyboardPanActive.current) return
      keyboardPanActive.current = false
      if (latestViewport.current !== null) {
        void persistViewport(latestViewport.current)
      }
    }

    const clearKeyboardPan = () => {
      heldKeys.clear()
      lastPressedHorizontal = null
      lastPressedVertical = null
      finishKeyboardPan()
    }

    const axisDirection = (
      negativeKey: string,
      positiveKey: string,
      lastPressed: string | null,
    ) => {
      const negativeHeld = heldKeys.has(negativeKey)
      const positiveHeld = heldKeys.has(positiveKey)
      if (negativeHeld && positiveHeld) {
        return lastPressed === positiveKey ? 1 : -1
      }
      return Number(positiveHeld) - Number(negativeHeld)
    }

    const moveCamera = (frameTime: number) => {
      if (heldKeys.size === 0) {
        finishKeyboardPan()
        return
      }
      const rawElapsedSeconds = (frameTime - previousFrameTime!) / 1000
      const elapsedSeconds = Math.min(
        rawElapsedSeconds > 0 ? rawElapsedSeconds : 1 / 60,
        0.05,
      )
      previousFrameTime = frameTime
      const horizontal = axisDirection('a', 'd', lastPressedHorizontal)
      const vertical = axisDirection('w', 's', lastPressedVertical)
      const length = Math.hypot(horizontal, vertical)
      if (length > 0) {
        const distance = CAMERA_PAN_SPEED_PX_PER_SECOND * elapsedSeconds
        const current = getViewport()
        const next = {
          x: current.x - (horizontal / length) * distance,
          y: current.y - (vertical / length) * distance,
          zoom: current.zoom,
        }
        latestViewport.current = next
        void setViewport(next, { duration: 0 })
      }
      animationFrame = window.requestAnimationFrame(moveCamera)
    }

    const startKeyboardPan = () => {
      if (animationFrame !== null) return
      keyboardPanActive.current = true
      previousFrameTime = performance.now()
      animationFrame = window.requestAnimationFrame(moveCamera)
    }

    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!CAMERA_PAN_KEYS.has(key)) return
      if (event.ctrlKey || event.metaKey || event.altKey || isEditableTarget(event.target)) {
        clearKeyboardPan()
        return
      }
      event.preventDefault()
      const wasHeld = heldKeys.has(key)
      heldKeys.add(key)
      if (!wasHeld) {
        if (key === 'a' || key === 'd') lastPressedHorizontal = key
        if (key === 'w' || key === 's') lastPressedVertical = key
      }
      startKeyboardPan()
    }

    const onKeyUp = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase()
      if (!CAMERA_PAN_KEYS.has(key)) return
      heldKeys.delete(key)
      if (key === 'a' || key === 'd') {
        const fallback = key === 'a' ? 'd' : 'a'
        if (lastPressedHorizontal === key) {
          lastPressedHorizontal = heldKeys.has(fallback) ? fallback : null
        } else if (!heldKeys.has('a') && !heldKeys.has('d')) {
          lastPressedHorizontal = null
        }
      }
      if (key === 'w' || key === 's') {
        const fallback = key === 'w' ? 's' : 'w'
        if (lastPressedVertical === key) {
          lastPressedVertical = heldKeys.has(fallback) ? fallback : null
        } else if (!heldKeys.has('w') && !heldKeys.has('s')) {
          lastPressedVertical = null
        }
      }
      if (heldKeys.size === 0) finishKeyboardPan()
    }

    const onVisibilityChange = () => {
      if (document.visibilityState === 'hidden') clearKeyboardPan()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    window.addEventListener('blur', clearKeyboardPan)
    document.addEventListener('visibilitychange', onVisibilityChange)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      window.removeEventListener('blur', clearKeyboardPan)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      heldKeys.clear()
      if (animationFrame !== null) window.cancelAnimationFrame(animationFrame)
      keyboardPanActive.current = false
    }
  }, [getViewport, persistViewport, setViewport])

  async function leaveCanvas(): Promise<void> {
    if (latestViewport.current !== null) await persistViewport(latestViewport.current)
    void navigate(PATHS.CANVAS)
  }

  async function addNode(type: RegisteredCanvasNodeType): Promise<void> {
    if (service === null || canvas === null) return
    const position = screenToFlowPosition({ x: window.innerWidth / 2, y: window.innerHeight / 2 })
    try {
      const entry = canvasNodeRegistry.byType.get(type)!
      const created = await service.createCanvasNode(canvas.id, type, entry.createDefaultData(), position)
      setFlowNodes((nodes) => [...nodes, toCanvasFlowNode(created, (id, nodeType, text) => void commitNodeContent(id, nodeType, text))])
      setFeedback(`已添加${entry.displayName}`)
    } catch {
      setFeedback('节点创建失败，请重试。')
    }
  }

  const beginNodeDrag: OnNodeDrag<CanvasFlowNode> = useCallback(
    (_event, node, draggedNodes) => {
      const gestureNodes = draggedNodes.length > 0 ? draggedNodes : [node]
      dragStartPositions.current = new Map(
        gestureNodes.map((item) => [item.id, { ...item.position }]),
      )
    },
    [],
  )

  const finishNodeDrag: OnNodeDrag<CanvasFlowNode> = useCallback((
    _event,
    node,
    draggedNodes,
  ) => {
    if (service === null || canvas === null) return
    const gestureNodes = draggedNodes.length > 0 ? draggedNodes : [node]
    const snapshot = dragStartPositions.current
    dragStartPositions.current = null
    const movedNodes = gestureNodes.filter((item) => {
      const previous = snapshot?.get(item.id)
      return previous === undefined ||
        previous.x !== item.position.x ||
        previous.y !== item.position.y
    })
    if (movedNodes.length === 0) return
    void (async () => {
      try {
        if (movedNodes.length === 1) {
          const moved = movedNodes[0]!
          await service.moveCanvasNode(
            moved.id,
            moved.position.x,
            moved.position.y,
          )
        } else {
          await service.moveCanvasNodes(
            canvas.id,
            movedNodes.map((item) => ({
              nodeId: item.id,
              x: item.position.x,
              y: item.position.y,
            })),
          )
        }
        setFeedback(
          movedNodes.length === 1
            ? '节点位置已保存'
            : `已移动 ${movedNodes.length} 个节点`,
        )
      } catch {
        if (snapshot !== null) {
          setFlowNodes((nodes) =>
            nodes.map((item) => {
              const previous = snapshot.get(item.id)
              return previous === undefined
                ? item
                : { ...item, position: previous }
            }),
          )
        }
        setFeedback('节点位置保存失败，已恢复移动前位置。')
      }
    })()
  }, [canvas, service])

  async function connectNodes(connection: Connection): Promise<void> {
    if (
      service === null ||
      canvas === null ||
      connection.source === null ||
      connection.target === null
    ) {
      return
    }
    try {
      const created = await service.createCanvasEdge(
        canvas.id,
        connection.source,
        connection.target,
      )
      setCanvasEdges((edges) => [...edges, created])
      setSelectedEdgeId(created.id)
      setFeedback('已创建普通关系')
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error && 'code' in error && error.code === 'CONFLICT'
          ? '这条关系已经存在。'
          : '连线创建失败，请重试。',
      )
    }
  }

  async function changeEdgeDirection(
    edge: CanvasEdge,
    direction: CanvasEdge['direction'],
  ): Promise<void> {
    if (service === null || direction === edge.direction) return
    setEdgeBusy(true)
    try {
      const updated = await service.updateCanvasEdgeDirection(edge.id, direction)
      setCanvasEdges((edges) =>
        edges.map((item) => (item.id === updated.id ? updated : item)),
      )
      setFeedback('连线方向已保存')
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error && 'code' in error && error.code === 'CONFLICT'
          ? '该方向会产生重复关系。'
          : '连线方向保存失败，请重试。',
      )
    } finally {
      setEdgeBusy(false)
    }
  }

  async function changeEdgeLineStyle(
    edge: CanvasEdge,
    lineStyle: CanvasEdge['lineStyle'],
  ): Promise<void> {
    if (service === null || lineStyle === edge.lineStyle) return
    setEdgeBusy(true)
    try {
      const updated = await service.updateCanvasEdgeLineStyle(edge.id, lineStyle)
      setCanvasEdges((edges) =>
        edges.map((item) => (item.id === updated.id ? updated : item)),
      )
      setFeedback('连线样式已保存')
    } catch {
      setFeedback('连线样式保存失败，请重试。')
    } finally {
      setEdgeBusy(false)
    }
  }

  async function removeEdge(edge: CanvasEdge): Promise<void> {
    if (service === null) return
    setEdgeBusy(true)
    try {
      await service.deleteCanvasEdge(edge.id)
      setCanvasEdges((edges) => edges.filter((item) => item.id !== edge.id))
      setSelectedEdgeId(null)
      setFeedback('连线已删除')
    } catch {
      setFeedback('连线删除失败，请重试。')
    } finally {
      setEdgeBusy(false)
    }
  }

  if (phase === 'loading') return <div className="flex h-[calc(100vh-7rem)] items-center justify-center text-body text-foreground-secondary" role="status">正在打开画布…</div>
  if (phase === 'error' || canvas === null) {
    return <div className="flex h-[calc(100vh-7rem)] flex-col items-center justify-center text-center"><h2 className="text-xl font-semibold">画布无法打开</h2><p className="mt-2 text-body text-foreground-secondary">画布可能已不存在，或本地存储暂时不可用。</p><div className="mt-5 flex gap-2"><Button variant="outline" onClick={() => void leaveCanvas()}><ArrowLeft />返回画布</Button><Button onClick={() => { setPhase('loading'); setAttempt((value) => value + 1) }}><RotateCcw />重试</Button></div></div>
  }

  return (
    <div className="relative -m-6 h-[calc(100vh-3.5rem)] min-h-[620px] overflow-hidden bg-[#f6f5f1]">
      <div className="absolute inset-x-0 top-0 z-10 flex h-16 items-center justify-between border-b border-border/75 bg-surface/92 px-5 shadow-sm backdrop-blur-sm">
        <div className="flex min-w-0 items-center gap-3"><Button size="icon-sm" variant="ghost" aria-label="返回画布列表" onClick={() => void leaveCanvas()}><ArrowLeft /></Button><div className="min-w-0"><h2 className="truncate text-base font-semibold">{canvas.title}</h2><p className="text-[11px] text-foreground-tertiary">文字画布 · 自动保存</p></div></div>
        <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => void addNode('text')}><Plus />文字节点</Button><Button size="sm" onClick={() => void addNode('sticky')}><Plus />便签节点</Button></div>
      </div>
      <ReactFlow<CanvasFlowNode>
        className="pt-16"
        nodes={flowNodes}
        edges={canvasEdges.map((edge) =>
          toFlowEdge(edge, edge.id === selectedEdgeId),
        )}
        nodeTypes={NODE_TYPES}
        onNodesChange={(changes: NodeChange<CanvasFlowNode>[]) => setFlowNodes((nodes) => applyNodeChanges(changes, nodes))}
        onNodeDragStart={beginNodeDrag}
        onNodeDragStop={finishNodeDrag}
        onConnect={(connection) => void connectNodes(connection)}
        onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
        onPaneClick={() => setSelectedEdgeId(null)}
        onMove={(_, viewport) => { latestViewport.current = viewport }}
        onMoveEnd={(_, viewport) => {
          if (!keyboardPanActive.current) void persistViewport(viewport)
        }}
        defaultViewport={canvas.viewport}
        minZoom={0.35}
        maxZoom={2.2}
        panOnDrag={[1]}
        panOnScroll={false}
        zoomOnScroll
        deleteKeyCode={null}
        multiSelectionKeyCode={['Control', 'Meta']}
        selectionKeyCode={null}
        selectionMode={SelectionMode.Partial}
        selectionOnDrag
        nodesConnectable
        edgesReconnectable={false}
        fitView={false}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="#d4d1c8" gap={24} size={1} />
        <Controls position="bottom-right" showInteractive={false} />
      </ReactFlow>
      {selectedEdgeId !== null && (() => {
        const selectedEdge = canvasEdges.find((edge) => edge.id === selectedEdgeId)
        return selectedEdge === undefined ? null : (
          <CanvasEdgeToolbar
            busy={edgeBusy}
            edge={selectedEdge}
            onDelete={() => void removeEdge(selectedEdge)}
            onDirectionChange={(direction) =>
              void changeEdgeDirection(selectedEdge, direction)
            }
            onLineStyleChange={(lineStyle) =>
              void changeEdgeLineStyle(selectedEdge, lineStyle)
            }
          />
        )
      })()}
      {flowNodes.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-16"><div className="rounded-2xl border border-border/80 bg-surface/90 px-8 py-6 text-center shadow-sm"><p className="font-medium">这张画布还是空的</p><p className="mt-1 text-sm text-foreground-secondary">点击右上角添加第一个节点</p></div></div>}
      {feedback !== null && <div className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-xs text-background shadow-lg" role="status">{feedback}</div>}
    </div>
  )
}

export function CanvasEditorPage({ openRuntime = openCanvasRuntime }: CanvasEditorPageProps) {
  return <ReactFlowProvider><Editor openRuntime={openRuntime} /></ReactFlowProvider>
}
