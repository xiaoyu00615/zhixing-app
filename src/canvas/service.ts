import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isTextNodeContent,
  type Canvas,
  type CanvasNode,
  type CanvasViewport,
} from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
} from '@/canvas/repository'

export type CanvasApplicationErrorCode =
  | 'VALIDATION'
  | 'NOT_FOUND'
  | 'UNAVAILABLE'

export type CanvasApplicationErrorField =
  | 'id'
  | 'canvasId'
  | 'title'
  | 'viewport'
  | 'content'
  | 'position'

const SAFE_MESSAGES: Record<CanvasApplicationErrorCode, string> = {
  VALIDATION: 'Canvas input is invalid.',
  NOT_FOUND: 'Canvas resource not found.',
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
}

export interface CanvasService {
  createCanvas(title: string): Promise<Canvas>
  listCanvases(): Promise<readonly Canvas[]>
  renameCanvas(id: string, title: string): Promise<Canvas>
  openCanvas(id: string): Promise<CanvasWorkspace>
  updateViewport(id: string, viewport: CanvasViewport): Promise<Canvas>
  createTextNode(
    canvasId: string,
    text: string,
    position: { readonly x: number; readonly y: number },
  ): Promise<CanvasNode>
  listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]>
  editTextNode(id: string, text: string): Promise<CanvasNode>
  moveCanvasNode(id: string, x: number, y: number): Promise<CanvasNode>
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

function validateId(id: unknown, field: 'id' | 'canvasId'): string {
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
      const [canvas, nodes] = await Promise.all([
        callRepository(() => repository.getCanvas(id)),
        callRepository(() => repository.listCanvasNodes(id)),
      ])
      return { canvas, nodes }
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
    async createTextNode(canvasId, text, position) {
      validateId(canvasId, 'canvasId')
      validatePosition(position.x, position.y)
      const content = { type: 'text' as const, text }
      if (!isTextNodeContent(content)) {
        throw new CanvasApplicationError('VALIDATION', 'content')
      }
      return callRepository(() =>
        repository.createTextNode({
          id: readGeneratedId(generateId),
          canvasId,
          content,
          x: position.x,
          y: position.y,
          createdAtMs: readNowMs(nowMs),
        }),
      )
    },
    async listCanvasNodes(canvasId) {
      validateId(canvasId, 'canvasId')
      return callRepository(() => repository.listCanvasNodes(canvasId))
    },
    async editTextNode(id, text) {
      validateId(id, 'id')
      const content = { type: 'text' as const, text }
      if (!isTextNodeContent(content)) {
        throw new CanvasApplicationError('VALIDATION', 'content')
      }
      return callRepository(() =>
        repository.updateTextNode({
          id,
          content,
          updatedAtMs: readNowMs(nowMs),
        }),
      )
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
  }
}
