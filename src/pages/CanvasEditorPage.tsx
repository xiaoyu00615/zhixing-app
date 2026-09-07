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
import { ArrowLeft, ListOrdered, Plus, RotateCcw, Rows3 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router'

import { CanvasEdgeToolbar } from '@/components/canvas/CanvasEdgeToolbar'
import { CanvasEdgeContextMenu } from '@/components/canvas/CanvasEdgeContextMenu'
import { CanvasNodeContextMenu } from '@/components/canvas/CanvasNodeContextMenu'
import { Button } from '@/components/ui/button'
import type { Canvas, CanvasEdge, CanvasMembershipRelationType, CanvasNode } from '@/canvas/model'
import type { RegisteredCanvasNodeType } from '@/canvas/model'
import {
  executeCanvasEdgeCommand,
  executeCanvasNodeCommand,
  type CanvasEdgeCommand,
  type CanvasNodeCommand,
  type CanvasNodeCommandTarget,
} from '@/canvas/commandRegistry'
import {
  createCanvasContextMenuModel,
  createCanvasNodeContextMenuModel,
} from '@/canvas/contextMenuRegistry'
import { getCanvasEdgeTypeDefinition, UNKNOWN_CANVAS_EDGE_RENDER } from '@/canvas/edgeRegistry'
import { canvasNodeRegistry, orderedMembershipDisplayNumbers, toCanvasFlowNode, withCanvasNodeRuntimeData, type CanvasFlowNode } from '@/canvas/nodeRegistry'
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
    target.closest('input, textarea, select, [contenteditable="true"], [role="menu"]') !== null
}

function edgeStrokeDasharray(edge: CanvasEdge): string | undefined {
  if (edge.lineStyle === 'dashed') return '8 6'
  if (edge.lineStyle === 'dotted') return '2 6'
  return undefined
}

function toFlowEdge(
  edge: CanvasEdge,
  selected: boolean,
  orderedDisplayNumber?: number,
): Edge {
  const render = getCanvasEdgeTypeDefinition(edge.relationType)?.render ?? UNKNOWN_CANVAS_EDGE_RENDER
  const marker = { type: MarkerType.ArrowClosed, width: render.markerSize, height: render.markerSize }
  return {
    id: edge.id,
    source: edge.sourceNodeId,
    target: edge.targetNodeId,
    selected,
    markerStart: edge.direction === 'bidirectional' ? marker : undefined,
    markerEnd: edge.direction === 'none' ? undefined : marker,
    label: edge.relationType === 'ordered_box_member'
      ? String(orderedDisplayNumber ?? 1)
      : edge.relationType === 'unordered_box_member'
        ? '−'
        : undefined,
    style: {
      stroke: selected ? render.selectedStroke : render.stroke,
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
  const [edgeContextMenu, setEdgeContextMenu] = useState<{
    readonly edgeId: string
    readonly x: number
    readonly y: number
  } | null>(null)
  const [nodeContextMenu, setNodeContextMenu] = useState<{
    readonly nodeId: string
    readonly nodeName: string
    readonly nodeType: CanvasNodeCommandTarget['type']
    readonly x: number
    readonly y: number
  } | null>(null)
  const [edgeBusy, setEdgeBusy] = useState(false)
  const [nodeBusy, setNodeBusy] = useState(false)
  const [service, setService] = useState<CanvasService | null>(null)
  const serviceRef = useRef<CanvasService | null>(null)
  const [feedback, setFeedback] = useState<string | null>(null)
  const latestViewport = useRef<Viewport | null>(null)
  const persistedViewport = useRef<Viewport | null>(null)
  const dragStartPositions = useRef<
    ReadonlyMap<string, { readonly x: number; readonly y: number }> | null
  >(null)
  const keyboardPanActive = useRef(false)
  const nodeTargets = useRef(new Map<string, CanvasNodeCommandTarget>())
  const canvasEdgesRef = useRef<CanvasEdge[]>([])

  useEffect(() => {
    canvasEdgesRef.current = canvasEdges
  }, [canvasEdges])

  const runNodeCommand = useCallback(async (
    command: CanvasNodeCommand,
  ): Promise<boolean> => {
    const currentService = serviceRef.current
    const node = nodeTargets.current.get(command.nodeId)
    if (currentService === null || canvasId === '' || node === undefined) {
      return false
    }
    setNodeBusy(true)
    try {
      const result = await executeCanvasNodeCommand(command, {
        canvasId,
        node,
        edges: canvasEdgesRef.current,
        service: currentService,
      })
      if (result.updatedNode !== null) {
        setFlowNodes((nodes) => nodes.map((flowNode) =>
          flowNode.id === result.updatedNode?.id
            ? {
                ...flowNode,
                data: {
                  ...flowNode.data,
                  nodeName: result.updatedNode.nodeName,
                },
              }
            : flowNode,
        ))
      }
      if (result.removedNodeId !== null) {
        const removedEdges = new Set(result.removedEdgeIds)
        nodeTargets.current.delete(result.removedNodeId)
        setFlowNodes((nodes) =>
          nodes.filter((flowNode) => flowNode.id !== result.removedNodeId),
        )
        setCanvasEdges((edges) => {
          const remaining = edges.filter((edge) => !removedEdges.has(edge.id))
          canvasEdgesRef.current = remaining
          return remaining
        })
        setSelectedEdgeId((edgeId) =>
          edgeId !== null && removedEdges.has(edgeId) ? null : edgeId,
        )
        setEdgeContextMenu((menu) =>
          menu !== null && removedEdges.has(menu.edgeId) ? null : menu,
        )
      }
      if (result.feedback !== '') setFeedback(result.feedback)
      return true
    } catch {
      setFeedback(command.id === 'rename_node'
        ? '节点名称保存失败，已恢复原名称。'
        : '节点删除失败，请重试。')
      return false
    } finally {
      setNodeBusy(false)
    }
  }, [canvasId])

  const commitNodeContent = useCallback(async (id: string, type: RegisteredCanvasNodeType, text: string) => {
    const currentService = serviceRef.current
    if (currentService === null) return
    if (type === 'node_box') return
    try {
      const content = type === 'text'
        ? { type: 'text' as const, text }
        : { type: 'sticky' as const, text }
      const updated = await currentService.updateCanvasNodeContent(id, type, content)
      setFlowNodes((nodes) => nodes.map((node) => node.id === id
        ? { ...node, data: { ...node.data, text: updated.type === 'text' || updated.type === 'sticky' ? updated.content.text : text } }
        : node))
      setFeedback('文字已保存')
    } catch {
      setFeedback('文字保存失败，请重试。')
    }
  }, [])

  const commitNodeName = useCallback(async (id: string, nodeName: string): Promise<boolean> => {
    return runNodeCommand({ id: 'rename_node', nodeId: id, nodeName })
  }, [runNodeCommand])

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
        nodeTargets.current = new Map(
          workspace.nodes.map((node) => [
            node.id,
            { id: node.id, type: node.type },
          ]),
        )
        setFlowNodes(workspace.nodes.map((node: CanvasNode) =>
          toCanvasFlowNode(
            node,
            (id, type, text) => void commitNodeContent(id, type, text),
            commitNodeName,
          ),
        ))
        canvasEdgesRef.current = [...workspace.edges]
        setCanvasEdges([...workspace.edges])
        setPhase('ready')
      } catch {
        if (active) setPhase('error')
        await runtime?.dispose()
      }
    })()
    return () => { active = false; void runtime?.dispose() }
  }, [attempt, canvasId, commitNodeContent, commitNodeName, openRuntime])

  useEffect(() => {
    const onRenameKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'F2' || isEditableTarget(event.target)) return
      const selectedNodes = flowNodes.filter((node) => node.selected)
      if (selectedNodes.length !== 1 || selectedNodes[0]?.type === 'unsupportedCanvas') return
      event.preventDefault()
      const selectedId = selectedNodes[0]!.id
      setFlowNodes((nodes) => nodes.map((node) => {
        if (node.id !== selectedId) return node
        const currentRequest = typeof node.data.renameRequest === 'number'
          ? node.data.renameRequest
          : 0
        return {
          ...node,
          data: { ...node.data, renameRequest: currentRequest + 1 },
        }
      }))
    }
    window.addEventListener('keydown', onRenameKeyDown)
    return () => window.removeEventListener('keydown', onRenameKeyDown)
  }, [flowNodes])

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
      nodeTargets.current.set(created.id, { id: created.id, type: created.type })
      setFlowNodes((nodes) => [...nodes, toCanvasFlowNode(
        created,
        (id, nodeType, text) => void commitNodeContent(id, nodeType, text),
        commitNodeName,
      )])
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
      canvasEdgesRef.current = [...canvasEdgesRef.current, created]
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

  const runEdgeCommand = useCallback(async (
    command: CanvasEdgeCommand,
  ): Promise<boolean> => {
    if (service === null || canvas === null || edgeBusy) return false
    setEdgeBusy(true)
    try {
      const result = await executeCanvasEdgeCommand(command, {
        canvasId: canvas.id,
        edges: canvasEdges,
        service,
      })
      if (result.updatedEdges.length > 0) {
        const updatedById = new Map(
          result.updatedEdges.map((edge) => [edge.id, edge]),
        )
        setCanvasEdges((edges) => {
          const updated = edges.map((edge) => updatedById.get(edge.id) ?? edge)
          canvasEdgesRef.current = updated
          return updated
        })
      }
      if (result.removedEdgeId !== null) {
        setCanvasEdges((edges) => {
          const remaining = edges.filter(
            (edge) => edge.id !== result.removedEdgeId,
          )
          canvasEdgesRef.current = remaining
          return remaining
        })
        setSelectedEdgeId((edgeId) =>
          edgeId === result.removedEdgeId ? null : edgeId,
        )
        setEdgeContextMenu((menu) =>
          menu?.edgeId === result.removedEdgeId ? null : menu,
        )
      }
      if (result.feedback !== '') setFeedback(result.feedback)
      return true
    } catch (error: unknown) {
      const conflict = error instanceof Error &&
        'code' in error &&
        error.code === 'CONFLICT'
      if (command.id === 'update_edge_relation_type') {
        setFeedback(conflict
          ? '该关系类型会产生重复关系，已保留原配置。'
          : '关系类型保存失败，已保留原配置。')
      } else if (command.id === 'update_edge_direction') {
        setFeedback(conflict
          ? '该方向会产生重复关系。'
          : '连线方向保存失败，请重试。')
      } else if (command.id === 'update_edge_line_style') {
        setFeedback('连线样式保存失败，请重试。')
      } else if (command.id === 'delete_edge') {
        setFeedback('连线删除失败，请重试。')
      } else if (command.id === 'remove_membership') {
        setFeedback('成员移除失败，请重试。')
      } else {
        setFeedback('成员分区保存失败，已保留原顺序。')
      }
      return false
    } finally {
      setEdgeBusy(false)
    }
  }, [canvas, canvasEdges, edgeBusy, service])

  const removeMembership = useCallback((edgeId: string) => {
    const edge = canvasEdges.find((item) => item.id === edgeId)
    if (edge !== undefined) {
      void runEdgeCommand({ id: 'remove_membership', edgeId: edge.id })
    }
  }, [canvasEdges, runEdgeCommand])

  const reorderMemberships = useCallback((
    nodeBoxId: string,
    orderedMembershipEdgeIds: readonly string[],
    unorderedMembershipEdgeIds: readonly string[],
  ) => {
    if (service === null || canvas === null || edgeBusy) return
    const snapshot = canvasEdges
    const orderedPositions = new Map(
      orderedMembershipEdgeIds.map((edgeId, position) => [edgeId, position]),
    )
    const unorderedPositions = new Map(
      unorderedMembershipEdgeIds.map((edgeId, position) => [edgeId, position]),
    )
    const optimistic = snapshot.map((edge) => {
      if (edge.targetNodeId !== nodeBoxId) return edge
      const orderedPosition = orderedPositions.get(edge.id)
      if (orderedPosition !== undefined) {
        return {
          ...edge,
          relationType: 'ordered_box_member' as const,
          membershipPosition: orderedPosition,
        }
      }
      const unorderedPosition = unorderedPositions.get(edge.id)
      return unorderedPosition === undefined
        ? edge
        : {
            ...edge,
            relationType: 'unordered_box_member' as const,
            membershipPosition: unorderedPosition,
          }
    })
    setEdgeBusy(true)
    setCanvasEdges(optimistic)
    void service.reorderNodeBoxMemberships(
      canvas.id,
      nodeBoxId,
      orderedMembershipEdgeIds,
      unorderedMembershipEdgeIds,
    ).then((updatedMemberships) => {
      const updatedById = new Map(
        updatedMemberships.map((edge) => [edge.id, edge]),
      )
      setCanvasEdges((edges) =>
        edges.map((edge) => updatedById.get(edge.id) ?? edge),
      )
      setFeedback('节点盒成员顺序已保存')
    }).catch(() => {
      setCanvasEdges(snapshot)
      setFeedback('成员顺序保存失败，已恢复原顺序。')
    }).finally(() => {
      setEdgeBusy(false)
    })
  }, [canvas, canvasEdges, edgeBusy, service])

  const displayNodes = useMemo(
    () => withCanvasNodeRuntimeData(
      flowNodes,
      canvasEdges,
      removeMembership,
      reorderMemberships,
      edgeBusy,
    ),
    [canvasEdges, edgeBusy, flowNodes, removeMembership, reorderMemberships],
  )

  const orderedEdgeNumbers = useMemo(
    () => orderedMembershipDisplayNumbers(canvasEdges),
    [canvasEdges],
  )

  const membershipPair = useMemo(() => {
    const selected = flowNodes.filter((node) => node.selected)
    if (selected.length !== 2) return null
    const box = selected.find((node) => node.type === 'nodeBoxCanvas')
    const member = selected.find((node) => node.type !== 'nodeBoxCanvas')
    if (box === undefined || member === undefined || member.type === 'unsupportedCanvas') {
      return null
    }
    return { memberId: member.id, boxId: box.id }
  }, [flowNodes])

  async function addMembership(
    relationType: CanvasMembershipRelationType,
  ): Promise<void> {
    if (service === null || canvas === null || membershipPair === null) return
    setEdgeBusy(true)
    try {
      const created = await service.addNodeBoxMember(
        canvas.id,
        membershipPair.memberId,
        membershipPair.boxId,
        relationType,
      )
      setCanvasEdges((edges) => [...edges, created])
      setFeedback(relationType === 'ordered_box_member' ? '已加入有序成员' : '已加入无序成员')
    } catch (error: unknown) {
      setFeedback(
        error instanceof Error && 'code' in error && error.code === 'CONFLICT'
          ? '该节点已经属于此节点盒。'
          : '成员添加失败，请重试。',
      )
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
        <div className="flex items-center gap-2"><Button size="sm" variant="outline" onClick={() => void addNode('text')}><Plus />文字节点</Button><Button size="sm" variant="outline" onClick={() => void addNode('sticky')}><Plus />便签节点</Button><Button size="sm" onClick={() => void addNode('node_box')}><Plus />节点盒</Button></div>
      </div>
      <ReactFlow<CanvasFlowNode>
        className="pt-16"
        nodes={displayNodes}
        edges={canvasEdges.map((edge) =>
          toFlowEdge(
            edge,
            edge.id === selectedEdgeId || edge.id === edgeContextMenu?.edgeId,
            orderedEdgeNumbers.get(edge.id),
          ),
        )}
        nodeTypes={NODE_TYPES}
        onNodesChange={(changes: NodeChange<CanvasFlowNode>[]) => setFlowNodes((nodes) => applyNodeChanges(changes, nodes))}
        onNodeDragStart={beginNodeDrag}
        onNodeDragStop={finishNodeDrag}
        onConnect={(connection) => void connectNodes(connection)}
        onEdgeClick={(_, edge) => setSelectedEdgeId(edge.id)}
        onEdgeContextMenu={(event, edge) => {
          event.preventDefault()
          event.stopPropagation()
          setEdgeContextMenu({
            edgeId: edge.id,
            x: event.clientX,
            y: event.clientY,
          })
          setNodeContextMenu(null)
        }}
        onNodeContextMenu={(event, node) => {
          event.preventDefault()
          event.stopPropagation()
          const target = nodeTargets.current.get(node.id)
          if (target === undefined) return
          setNodeContextMenu({
            nodeId: node.id,
            nodeName: typeof node.data.nodeName === 'string'
              ? node.data.nodeName
              : '',
            nodeType: target.type,
            x: event.clientX,
            y: event.clientY,
          })
          setEdgeContextMenu(null)
        }}
        onPaneClick={() => {
          setSelectedEdgeId(null)
          setEdgeContextMenu(null)
          setNodeContextMenu(null)
        }}
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
      {membershipPair !== null && (
        <div className="absolute left-1/2 top-20 z-20 flex -translate-x-1/2 items-center gap-2 rounded-xl border border-border/80 bg-surface/95 p-2 shadow-lg backdrop-blur-sm" aria-label="节点盒成员操作">
          <span className="px-1 text-xs text-foreground-secondary">将所选节点加入节点盒</span>
          <Button disabled={edgeBusy} size="sm" variant="outline" onClick={() => void addMembership('ordered_box_member')}><ListOrdered />有序</Button>
          <Button disabled={edgeBusy} size="sm" variant="outline" onClick={() => void addMembership('unordered_box_member')}><Rows3 />无序</Button>
        </div>
      )}
      {selectedEdgeId !== null && (() => {
        const selectedEdge = canvasEdges.find((edge) => edge.id === selectedEdgeId)
        return selectedEdge === undefined ? null : (
          <CanvasEdgeToolbar
            busy={edgeBusy}
            edge={selectedEdge}
            onCommand={(command) => void runEdgeCommand(command)}
          />
        )
      })()}
      {edgeContextMenu !== null && (() => {
        const targetEdge = canvasEdges.find(
          (edge) => edge.id === edgeContextMenu.edgeId,
        )
        return targetEdge === undefined ? null : (
          <CanvasEdgeContextMenu
            busy={edgeBusy}
            model={createCanvasContextMenuModel({
              type: 'edge',
              edge: targetEdge,
            })}
            onClose={() => setEdgeContextMenu(null)}
            onCommand={runEdgeCommand}
            x={edgeContextMenu.x}
            y={edgeContextMenu.y}
          />
        )
      })()}
      {nodeContextMenu !== null && (
        <CanvasNodeContextMenu
          busy={nodeBusy}
          model={createCanvasNodeContextMenuModel({
            id: nodeContextMenu.nodeId,
            type: nodeContextMenu.nodeType,
            nodeName: nodeContextMenu.nodeName,
          })}
          onClose={() => setNodeContextMenu(null)}
          onCommand={runNodeCommand}
          x={nodeContextMenu.x}
          y={nodeContextMenu.y}
        />
      )}
      {flowNodes.length === 0 && <div className="pointer-events-none absolute inset-0 flex items-center justify-center pt-16"><div className="rounded-2xl border border-border/80 bg-surface/90 px-8 py-6 text-center shadow-sm"><p className="font-medium">这张画布还是空的</p><p className="mt-1 text-sm text-foreground-secondary">点击右上角添加第一个节点</p></div></div>}
      {feedback !== null && <div className="absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full bg-foreground px-4 py-2 text-xs text-background shadow-lg" role="status">{feedback}</div>}
    </div>
  )
}

export function CanvasEditorPage({ openRuntime = openCanvasRuntime }: CanvasEditorPageProps) {
  return <ReactFlowProvider><Editor openRuntime={openRuntime} /></ReactFlowProvider>
}
