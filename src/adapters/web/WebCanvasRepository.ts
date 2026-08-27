import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasEdgeDirection,
  isCanvasEdgeLineStyle,
  isCanvasEdgeRelationType,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isTextNodeContent,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
  type CanvasRepositoryOperation,
  type CreateCanvasEdgeInput,
  type CreateCanvasInput,
  type CreateTextNodeInput,
  type MoveCanvasNodeInput,
  type DeleteCanvasEdgeInput,
  type RenameCanvasInput,
  type UpdateCanvasViewportInput,
  type UpdateCanvasEdgeDirectionInput,
  type UpdateCanvasEdgeLineStyleInput,
  type UpdateTextNodeInput,
} from '@/canvas/repository'
import { TaskWorkerClient, TaskWorkerClientError } from './taskWorkerClient'
import { isRecord } from './taskWorkerProtocol'

function isTimestamp(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function parseCanvas(
  value: unknown,
  operation: CanvasRepositoryOperation,
): Canvas {
  if (!isRecord(value)) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  const { id, title, viewport, createdAtMs, updatedAtMs } = value
  if (
    !isCanonicalCanvasId(id) ||
    !isNonEmptyCanvasTitle(title) ||
    !isCanvasViewport(viewport) ||
    !isTimestamp(createdAtMs) ||
    !isTimestamp(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return { id, title, viewport, createdAtMs, updatedAtMs }
}

function parseNode(
  value: unknown,
  operation: CanvasRepositoryOperation,
): CanvasNode {
  if (!isRecord(value)) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  const { id, canvasId, type, content, x, y, createdAtMs, updatedAtMs } = value
  if (
    !isCanonicalCanvasId(id) ||
    !isCanonicalCanvasId(canvasId) ||
    type !== 'text' ||
    !isTextNodeContent(content) ||
    !isCanvasCoordinate(x) ||
    !isCanvasCoordinate(y) ||
    !isTimestamp(createdAtMs) ||
    !isTimestamp(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return { id, canvasId, type, content, x, y, createdAtMs, updatedAtMs }
}

function parseEdge(
  value: unknown,
  operation: CanvasRepositoryOperation,
): CanvasEdge {
  if (!isRecord(value)) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  const {
    id,
    canvasId,
    sourceNodeId,
    targetNodeId,
    relationType,
    direction,
    lineStyle,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
  } = value
  if (
    !isCanonicalCanvasId(id) ||
    !isCanonicalCanvasId(canvasId) ||
    !isCanonicalCanvasId(sourceNodeId) ||
    !isCanonicalCanvasId(targetNodeId) ||
    sourceNodeId === targetNodeId ||
    !isCanvasEdgeRelationType(relationType) ||
    !isCanvasEdgeDirection(direction) ||
    !isCanvasEdgeLineStyle(lineStyle) ||
    !isTimestamp(createdAtMs) ||
    !isTimestamp(updatedAtMs) ||
    updatedAtMs < createdAtMs ||
    (deletedAtMs !== null && !isTimestamp(deletedAtMs))
  ) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  return {
    id,
    canvasId,
    sourceNodeId,
    targetNodeId,
    relationType,
    direction,
    lineStyle,
    createdAtMs,
    updatedAtMs,
    deletedAtMs,
  }
}

function mapError(
  error: unknown,
  operation: CanvasRepositoryOperation,
): CanvasRepositoryError {
  if (error instanceof CanvasRepositoryError) return error
  if (error instanceof TaskWorkerClientError) {
    return new CanvasRepositoryError(
      error.code === 'STATUS_CONFLICT' ? 'DUPLICATE' : error.code,
      operation,
    )
  }
  return new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
}

function validateId(id: string, operation: CanvasRepositoryOperation): void {
  if (!isCanonicalCanvasId(id)) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

function validateTimestamp(
  value: number,
  operation: CanvasRepositoryOperation,
): void {
  if (!isTimestamp(value)) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
}

export class WebCanvasRepository implements CanvasRepository {
  readonly #client: TaskWorkerClient

  constructor(client: TaskWorkerClient) {
    this.#client = client
  }

  async createCanvas(input: CreateCanvasInput): Promise<Canvas> {
    const operation = 'createCanvas'
    validateId(input.id, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (!isNonEmptyCanvasTitle(input.title) || !isCanvasViewport(input.viewport)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseCanvas(await this.#client.createCanvas(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async listCanvases(): Promise<readonly Canvas[]> {
    const operation = 'listCanvases'
    try {
      const value = await this.#client.listCanvases()
      if (!Array.isArray(value)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((canvas) => parseCanvas(canvas, operation))
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async getCanvas(id: string): Promise<Canvas> {
    const operation = 'getCanvas'
    validateId(id, operation)
    try {
      return parseCanvas(await this.#client.getCanvas(id), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async renameCanvas(input: RenameCanvasInput): Promise<Canvas> {
    return this.callCanvasUpdate('renameCanvas', input, () =>
      this.#client.renameCanvas(input),
    )
  }

  async updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<Canvas> {
    if (!isCanvasViewport(input.viewport)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'updateCanvasViewport')
    }
    return this.callCanvasUpdate('updateCanvasViewport', input, () =>
      this.#client.updateCanvasViewport(input),
    )
  }

  async createTextNode(input: CreateTextNodeInput): Promise<CanvasNode> {
    const operation = 'createTextNode'
    validateId(input.id, operation)
    validateId(input.canvasId, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (
      !isTextNodeContent(input.content) ||
      !isCanvasCoordinate(input.x) ||
      !isCanvasCoordinate(input.y)
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseNode(await this.#client.createTextNode(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]> {
    const operation = 'listCanvasNodes'
    validateId(canvasId, operation)
    try {
      const value = await this.#client.listCanvasNodes(canvasId)
      if (!Array.isArray(value)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((node) => parseNode(node, operation))
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode> {
    const operation = 'updateTextNode'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isTextNodeContent(input.content)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseNode(await this.#client.updateTextNode(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode> {
    const operation = 'moveCanvasNode'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isCanvasCoordinate(input.x) || !isCanvasCoordinate(input.y)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseNode(await this.#client.moveCanvasNode(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async createCanvasEdge(input: CreateCanvasEdgeInput): Promise<CanvasEdge> {
    const operation = 'createCanvasEdge'
    validateId(input.id, operation)
    validateId(input.canvasId, operation)
    validateId(input.sourceNodeId, operation)
    validateId(input.targetNodeId, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (
      input.sourceNodeId === input.targetNodeId ||
      !isCanvasEdgeRelationType(input.relationType) ||
      !isCanvasEdgeDirection(input.direction) ||
      !isCanvasEdgeLineStyle(input.lineStyle)
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseEdge(await this.#client.createCanvasEdge(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]> {
    const operation = 'listCanvasEdges'
    validateId(canvasId, operation)
    try {
      const value = await this.#client.listCanvasEdges(canvasId)
      if (!Array.isArray(value)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((edge) => parseEdge(edge, operation))
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async updateCanvasEdgeDirection(
    input: UpdateCanvasEdgeDirectionInput,
  ): Promise<CanvasEdge> {
    const operation = 'updateCanvasEdgeDirection'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isCanvasEdgeDirection(input.direction)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseEdge(
        await this.#client.updateCanvasEdgeDirection(input),
        operation,
      )
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async updateCanvasEdgeLineStyle(
    input: UpdateCanvasEdgeLineStyleInput,
  ): Promise<CanvasEdge> {
    const operation = 'updateCanvasEdgeLineStyle'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isCanvasEdgeLineStyle(input.lineStyle)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseEdge(
        await this.#client.updateCanvasEdgeLineStyle(input),
        operation,
      )
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<CanvasEdge> {
    const operation = 'deleteCanvasEdge'
    validateId(input.id, operation)
    validateTimestamp(input.deletedAtMs, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      return parseEdge(await this.#client.deleteCanvasEdge(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  private async callCanvasUpdate(
    operation: 'renameCanvas' | 'updateCanvasViewport',
    input: { readonly id: string; readonly updatedAtMs: number },
    call: () => Promise<unknown>,
  ): Promise<Canvas> {
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (operation === 'renameCanvas' && !isNonEmptyCanvasTitle((input as RenameCanvasInput).title)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseCanvas(await call(), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }
}
