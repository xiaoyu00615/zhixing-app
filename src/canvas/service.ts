import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasEdgeDirection,
  isCanvasEdgeLineStyle,
  isCanvasEdgeRelationType,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isRegisteredCanvasNodeContent,
  type Canvas,
  type CanvasEdge,
  type CanvasEdgeDirection,
  type CanvasEdgeLineStyle,
  type CanvasNode,
  type CanvasViewport,
  type RegisteredCanvasNodeContent,
  type RegisteredCanvasNodeType,
} from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
} from '@/canvas/repository'

export type CanvasApplicationErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAVAILABLE'

export type CanvasApplicationErrorField =
  | 'id'
  | 'canvasId'
  | 'title'
  | 'viewport'
  | 'content'
  | 'position'
  | 'sourceNodeId'
  | 'targetNodeId'
  | 'relationType'
  | 'direction'
  | 'lineStyle'

const SAFE_MESSAGES: Record<CanvasApplicationErrorCode, string> = {
  VALIDATION: 'Canvas input is invalid.',
  NOT_FOUND: 'Canvas resource not found.',
  CONFLICT: 'Canvas relation conflicts with an existing relation.',
  UNAVAILABLE: 'Canvas service is unavailable.',
}

export class CanvasApplicationError extends Error {
  readonly code: CanvasApplicationErrorCode
  readonly field?: CanvasApplicationErrorField

  constructor(
    code: CanvasApplicationErrorCode,
    field?: CanvasApplicationErrorField,
  ) {
    super(SAFE_MESSAGES[code])
    this.name = 'CanvasApplicationError'
    this.code = code
    this.field = field
  }
}

export interface CanvasWorkspace {
  readonly canvas: Canvas
  readonly nodes: readonly CanvasNode[]
  readonly edges: readonly CanvasEdge[]
}

export interface CanvasService {
  createCanvas(title: string): Promise<Canvas>
  listCanvases(): Promise<readonly Canvas[]>
  renameCanvas(id: string, title: string): Promise<Canvas>
  openCanvas(id: string): Promise<CanvasWorkspace>
  updateViewport(id: string, viewport: CanvasViewport): Promise<Canvas>
  createCanvasNode(
    canvasId: string,
    type: RegisteredCanvasNodeType,
    content: RegisteredCanvasNodeContent,
    position: { readonly x: number; readonly y: number },
  ): Promise<CanvasNode>
  createTextNode(canvasId: string, text: string, position: { readonly x: number; readonly y: number }): Promise<CanvasNode>
  listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]>
  updateCanvasNodeContent(
    id: string,
    type: RegisteredCanvasNodeType,
    content: RegisteredCanvasNodeContent,
  ): Promise<CanvasNode>
  editTextNode(id: string, text: string): Promise<CanvasNode>
  moveCanvasNode(id: string, x: number, y: number): Promise<CanvasNode>
  moveCanvasNodes(
    canvasId: string,
    moves: readonly {
      readonly nodeId: string
      readonly x: number
      readonly y: number
    }[],
  ): Promise<readonly CanvasNode[]>
  createCanvasEdge(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string,
  ): Promise<CanvasEdge>
  listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]>
  updateCanvasEdgeDirection(
    id: string,
    direction: CanvasEdgeDirection,
  ): Promise<CanvasEdge>
  updateCanvasEdgeLineStyle(
    id: string,
    lineStyle: CanvasEdgeLineStyle,
  ): Promise<CanvasEdge>
  deleteCanvasEdge(id: string): Promise<CanvasEdge>
}

interface CreateCanvasServiceOptions {
  readonly repository: CanvasRepository
  readonly generateId?: () => string
  readonly nowMs?: () => number
}

function normalizeTitle(title: unknown): string {
  if (!isNonEmptyCanvasTitle(title)) {
    throw new CanvasApplicationError('VALIDATION', 'title')
  }
  return title.trim()
}

function validateId(
  id: unknown,
  field: 'id' | 'canvasId' | 'sourceNodeId' | 'targetNodeId',
): string {
  if (!isCanonicalCanvasId(id)) {
    throw new CanvasApplicationError('VALIDATION', field)
  }
  return id
}

function validatePosition(x: unknown, y: unknown): void {
  if (!isCanvasCoordinate(x) || !isCanvasCoordinate(y)) {
    throw new CanvasApplicationError('VALIDATION', 'position')
  }
}

function readNowMs(nowMs: () => number): number {
  const value = nowMs()
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new CanvasApplicationError('UNAVAILABLE')
  }
  return value
}

function readGeneratedId(generateId: () => string): string {
  try {
    return validateId(generateId(), 'id')
  } catch (error: unknown) {
    if (error instanceof CanvasApplicationError && error.code === 'VALIDATION') {
      throw new CanvasApplicationError('UNAVAILABLE')
    }
    throw error
  }
}

async function callRepository<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation()
  } catch (error: unknown) {
    if (error instanceof CanvasRepositoryError && error.code === 'NOT_FOUND') {
      throw new CanvasApplicationError('NOT_FOUND')
    }
    if (error instanceof CanvasRepositoryError && error.code === 'DUPLICATE') {
      throw new CanvasApplicationError('CONFLICT')
    }
    throw new CanvasApplicationError('UNAVAILABLE')
  }
}

export function createCanvasService({
  repository,
  generateId = () => globalThis.crypto.randomUUID(),
  nowMs = () => Date.now(),
}: CreateCanvasServiceOptions): CanvasService {
  return {
    async createCanvas(title) {
      const createdAtMs = readNowMs(nowMs)
      const normalizedTitle = normalizeTitle(title)
      const id = readGeneratedId(generateId)
      return callRepository(() =>
        repository.createCanvas({
          id,
          title: normalizedTitle,
          viewport: { x: 0, y: 0, zoom: 1 },
          createdAtMs,
        }),
      )
    },
    listCanvases() {
      return callRepository(() => repository.listCanvases())
    },
    async renameCanvas(id, title) {
      validateId(id, 'id')
      const normalizedTitle = normalizeTitle(title)
      return callRepository(() =>
        repository.renameCanvas({
          id,
          title: normalizedTitle,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    async openCanvas(id) {
      validateId(id, 'id')
      const [canvas, nodes, edges] = await Promise.all([
        callRepository(() => repository.getCanvas(id)),
        callRepository(() => repository.listCanvasNodes(id)),
        callRepository(() => repository.listCanvasEdges(id)),
      ])
      return { canvas, nodes, edges }
    },
    async updateViewport(id, viewport) {
      validateId(id, 'id')
      if (!isCanvasViewport(viewport)) {
        throw new CanvasApplicationError('VALIDATION', 'viewport')
      }
      return callRepository(() =>
        repository.updateCanvasViewport({
          id,
          viewport,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    async createCanvasNode(canvasId, type, content, position) {
      validateId(canvasId, 'canvasId')
      validatePosition(position.x, position.y)
      if (!isRegisteredCanvasNodeContent(content) || content.type !== type) {
        throw new CanvasApplicationError('VALIDATION', 'content')
      }
      return callRepository(() =>
        repository.createCanvasNode({
          id: readGeneratedId(generateId),
          canvasId,
          type,
          content,
          x: position.x,
          y: position.y,
          createdAtMs: readNowMs(nowMs),
        }),
      )
    },
    async createTextNode(canvasId, text, position) {
      validateId(canvasId, 'canvasId')
      validatePosition(position.x, position.y)
      return callRepository(() => repository.createTextNode({ id: readGeneratedId(generateId), canvasId, content: { type: 'text', text }, x: position.x, y: position.y, createdAtMs: readNowMs(nowMs) }))
    },
    async listCanvasNodes(canvasId) {
      validateId(canvasId, 'canvasId')
      return callRepository(() => repository.listCanvasNodes(canvasId))
    },
    async updateCanvasNodeContent(id, type, content) {
      validateId(id, 'id')
      if (!isRegisteredCanvasNodeContent(content) || content.type !== type) {
        throw new CanvasApplicationError('VALIDATION', 'content')
      }
      return callRepository(() =>
        repository.updateCanvasNodeContent({
          id,
          type,
          content,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    async editTextNode(id, text) {
      validateId(id, 'id')
      return callRepository(() => repository.updateTextNode({ id, content: { type: 'text', text }, updatedAtMs: readNowMs(nowMs) }))
    },
    async moveCanvasNode(id, x, y) {
      validateId(id, 'id')
      validatePosition(x, y)
      return callRepository(() =>
        repository.moveCanvasNode({
          id,
          x,
          y,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    async moveCanvasNodes(canvasId, moves) {
      validateId(canvasId, 'canvasId')
      if (moves.length === 0) {
        throw new CanvasApplicationError('VALIDATION', 'position')
      }
      const nodeIds = new Set<string>()
      const validatedMoves = moves.map((move) => {
        const nodeId = validateId(move.nodeId, 'id')
        if (nodeIds.has(nodeId)) {
          throw new CanvasApplicationError('VALIDATION', 'id')
        }
        nodeIds.add(nodeId)
        validatePosition(move.x, move.y)
        return { nodeId, x: move.x, y: move.y }
      })
      return callRepository(() =>
        repository.moveCanvasNodes({
          canvasId,
          moves: validatedMoves,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    async createCanvasEdge(canvasId, sourceNodeId, targetNodeId) {
      validateId(canvasId, 'canvasId')
      validateId(sourceNodeId, 'sourceNodeId')
      validateId(targetNodeId, 'targetNodeId')
      if (sourceNodeId === targetNodeId) {
        throw new CanvasApplicationError('VALIDATION', 'targetNodeId')
      }
      const relationType = 'default' as const
      const direction = 'forward' as const
      const lineStyle = 'solid' as const
      if (!isCanvasEdgeRelationType(relationType)) {
        throw new CanvasApplicationError('VALIDATION', 'relationType')
      }
      return callRepository(() =>
        repository.createCanvasEdge({
          id: readGeneratedId(generateId),
          canvasId,
          sourceNodeId,
          targetNodeId,
          relationType,
          direction,
          lineStyle,
          createdAtMs: readNowMs(nowMs),
        }),
      )
    },
    listCanvasEdges(canvasId) {
      validateId(canvasId, 'canvasId')
      return callRepository(() => repository.listCanvasEdges(canvasId))
    },
    updateCanvasEdgeDirection(id, direction) {
      validateId(id, 'id')
      if (!isCanvasEdgeDirection(direction)) {
        throw new CanvasApplicationError('VALIDATION', 'direction')
      }
      return callRepository(() =>
        repository.updateCanvasEdgeDirection({
          id,
          direction,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    updateCanvasEdgeLineStyle(id, lineStyle) {
      validateId(id, 'id')
      if (!isCanvasEdgeLineStyle(lineStyle)) {
        throw new CanvasApplicationError('VALIDATION', 'lineStyle')
      }
      return callRepository(() =>
        repository.updateCanvasEdgeLineStyle({
          id,
          lineStyle,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
    },
    deleteCanvasEdge(id) {
      validateId(id, 'id')
      const deletedAtMs = readNowMs(nowMs)
      return callRepository(() =>
        repository.deleteCanvasEdge({
          id,
          deletedAtMs,
          updatedAtMs: deletedAtMs,
        }),
      )
    },
  }
}
