import type {
  Canvas,
  CanvasNode,
  CanvasViewport,
  TextNodeContent,
} from '@/canvas/model'

export interface CreateCanvasInput {
  readonly id: string
  readonly title: string
  readonly viewport: CanvasViewport
  readonly createdAtMs: number
}

export interface RenameCanvasInput {
  readonly id: string
  readonly title: string
  readonly updatedAtMs: number
}

export interface UpdateCanvasViewportInput {
  readonly id: string
  readonly viewport: CanvasViewport
  readonly updatedAtMs: number
}

export interface CreateTextNodeInput {
  readonly id: string
  readonly canvasId: string
  readonly content: TextNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
}

export interface UpdateTextNodeInput {
  readonly id: string
  readonly content: TextNodeContent
  readonly updatedAtMs: number
}

export interface MoveCanvasNodeInput {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly updatedAtMs: number
}

export interface CanvasRepository {
  createCanvas(input: CreateCanvasInput): Promise<Canvas>
  listCanvases(): Promise<readonly Canvas[]>
  renameCanvas(input: RenameCanvasInput): Promise<Canvas>
  getCanvas(id: string): Promise<Canvas>
  updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<Canvas>
  createTextNode(input: CreateTextNodeInput): Promise<CanvasNode>
  listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]>
  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode>
  moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode>
}

export type CanvasRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'PERSISTENCE_FAILED'

export type CanvasRepositoryOperation = keyof CanvasRepository

const SAFE_MESSAGES: Record<CanvasRepositoryErrorCode, string> = {
  NOT_FOUND: 'Canvas resource not found.',
  PERSISTENCE_UNAVAILABLE: 'Canvas persistence is unavailable.',
  PERSISTENCE_FAILED: 'Canvas persistence operation failed.',
}

export class CanvasRepositoryError extends Error {
  readonly code: CanvasRepositoryErrorCode
  readonly operation: CanvasRepositoryOperation

  constructor(
    code: CanvasRepositoryErrorCode,
    operation: CanvasRepositoryOperation,
  ) {
    super(SAFE_MESSAGES[code])
    this.name = 'CanvasRepositoryError'
    this.code = code
    this.operation = operation
  }
}
