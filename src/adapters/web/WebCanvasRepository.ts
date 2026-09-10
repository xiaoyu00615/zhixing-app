import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasEdgeDirection,
  isCanvasEdgeLineStyle,
  isCanvasOrdinaryEdgeRelationType,
  isCanvasMembershipRelationType,
  isCanvasMembershipPosition,
  isNodeBoxContent,
  isPersistedCanvasEdgeRelationType,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isPersistedCanvasNodeName,
  isStickyNodeContent,
  isTextNodeContent,
  type Canvas,
  type CanvasEdge,
  type CanvasNode,
} from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
  type AddCanvasNodeBoxMemberInput,
  type CanvasRepositoryOperation,
  type CreateCanvasEdgeInput,
  type CreateCanvasInput,
  type CreateCanvasNodeInput,
  type CreateCanvasSubgraphInput,
  type CreateTextNodeInput,
  type MoveCanvasNodeInput,
  type MoveCanvasNodesInput,
  type ReorderCanvasNodeBoxMembershipsInput,
  type DeleteCanvasEdgeInput,
  type DeleteCanvasNodeInput,
  type RenameCanvasInput,
  type RenameCanvasNodeInput,
  type UpdateCanvasViewportInput,
  type UpdateCanvasEdgeDirectionInput,
  type UpdateCanvasEdgeLineStyleInput,
  type UpdateCanvasEdgeRelationTypeInput,
  type UpdateCanvasNodeContentInput,
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
  const { id, canvasId, type, nodeName, content, x, y, createdAtMs, updatedAtMs } = value
  if (
    !isCanonicalCanvasId(id) ||
    !isCanonicalCanvasId(canvasId) ||
    !isPersistedCanvasNodeName(nodeName) ||
    ((type === 'text' && !isTextNodeContent(content)) ||
      (type === 'sticky' && !isStickyNodeContent(content)) ||
      (type === 'node_box' && !isNodeBoxContent(content)) ||
      (type !== 'text' && type !== 'sticky' && type !== 'node_box' && typeof type !== 'string')) ||
    !isCanvasCoordinate(x) ||
    !isCanvasCoordinate(y) ||
    !isTimestamp(createdAtMs) ||
    !isTimestamp(updatedAtMs) ||
    updatedAtMs < createdAtMs
  ) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  if (type === 'text' || type === 'sticky' || type === 'node_box') {
    return { id, canvasId, type, nodeName, content, x, y, createdAtMs, updatedAtMs } as CanvasNode
  }
  return { id, canvasId, type: 'unknown', originalType: type, nodeName, content: { type: 'unknown', raw: content }, x, y, createdAtMs, updatedAtMs }
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
    membershipPosition,
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
    !isPersistedCanvasEdgeRelationType(relationType) ||
    !isCanvasEdgeDirection(direction) ||
    !isCanvasEdgeLineStyle(lineStyle) ||
    !isCanvasMembershipPosition(membershipPosition) ||
    (isCanvasMembershipRelationType(relationType)
      ? membershipPosition === null
      : membershipPosition !== null) ||
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
    membershipPosition,
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

function validateMoveCanvasNodesInput(
  input: MoveCanvasNodesInput,
  operation: CanvasRepositoryOperation,
): void {
  validateId(input.canvasId, operation)
  validateTimestamp(input.updatedAtMs, operation)
  if (input.moves.length === 0) {
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
  }
  const nodeIds = new Set<string>()
  for (const move of input.moves) {
    validateId(move.nodeId, operation)
    if (
      !isCanvasCoordinate(move.x) ||
      !isCanvasCoordinate(move.y) ||
      nodeIds.has(move.nodeId)
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    nodeIds.add(move.nodeId)
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

  async createCanvasNode(input: CreateCanvasNodeInput): Promise<CanvasNode> {
    const operation = 'createCanvasNode'
    validateId(input.id, operation)
    validateId(input.canvasId, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (
      input.content.type !== input.type ||
      !isCanvasCoordinate(input.x) ||
      !isCanvasCoordinate(input.y)
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseNode(await this.#client.createCanvasNode(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  createTextNode(input: CreateTextNodeInput): Promise<CanvasNode> {
    const operation = 'createTextNode'
    return this.#client.createTextNode(input).then((value) => parseNode(value, operation)).catch((error: unknown) => { throw mapError(error, operation) })
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

  async updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): Promise<CanvasNode> {
    const operation = 'updateCanvasNodeContent'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (input.content.type !== input.type) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseNode(await this.#client.updateCanvasNodeContent(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async renameCanvasNode(input: RenameCanvasNodeInput): Promise<CanvasNode> {
    const operation = 'renameCanvasNode'
    validateId(input.canvasId, operation)
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (!isPersistedCanvasNodeName(input.nodeName)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseNode(await this.#client.renameCanvasNode(input), operation)
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode> {
    const operation = 'updateTextNode'
    return this.#client.updateTextNode(input).then((value) => parseNode(value, operation)).catch((error: unknown) => { throw mapError(error, operation) })
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


  async moveCanvasNodes(
    input: MoveCanvasNodesInput,
  ): Promise<readonly CanvasNode[]> {
    const operation = 'moveCanvasNodes'
    validateMoveCanvasNodesInput(input, operation)
    try {
      const value = await this.#client.moveCanvasNodes(input)
      if (!Array.isArray(value)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((node) => parseNode(node, operation))
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async deleteCanvasNode(input: DeleteCanvasNodeInput): Promise<void> {
    const operation = 'deleteCanvasNode'
    validateId(input.canvasId, operation)
    validateId(input.id, operation)
    validateTimestamp(input.deletedAtMs, operation)
    validateTimestamp(input.updatedAtMs, operation)
    try {
      await this.#client.deleteCanvasNode(input)
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
      !isCanvasOrdinaryEdgeRelationType(input.relationType) ||
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

  async createCanvasSubgraph(
    input: CreateCanvasSubgraphInput,
  ): Promise<{ readonly nodes: readonly CanvasNode[]; readonly edges: readonly CanvasEdge[] }> {
    const operation = 'createCanvasSubgraph'
    validateId(input.canvasId, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (input.nodes.length === 0) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    for (const node of input.nodes) {
      validateId(node.id, operation)
      validateId(node.canvasId, operation)
      validateTimestamp(node.createdAtMs, operation)
      if (!isCanvasCoordinate(node.x) || !isCanvasCoordinate(node.y)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
    }
    for (const edge of input.edges) {
      validateId(edge.id, operation)
      validateId(edge.canvasId, operation)
      validateId(edge.sourceNodeId, operation)
      validateId(edge.targetNodeId, operation)
      validateTimestamp(edge.createdAtMs, operation)
      if (edge.sourceNodeId === edge.targetNodeId) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
    }
    try {
      const result = await this.#client.createCanvasSubgraph(input)
      if (!isRecord(result)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      const rawNodes = result.nodes
      const rawEdges = result.edges
      if (!Array.isArray(rawNodes) || !Array.isArray(rawEdges)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      const nodes: CanvasNode[] = rawNodes.map((item) => parseNode(item, operation))
      const edges: CanvasEdge[] = rawEdges.map((item) => parseEdge(item, operation))
      return { nodes, edges }
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async addCanvasNodeBoxMember(
    input: AddCanvasNodeBoxMemberInput,
  ): Promise<CanvasEdge> {
    const operation = 'addCanvasNodeBoxMember'
    validateId(input.id, operation)
    validateId(input.canvasId, operation)
    validateId(input.sourceNodeId, operation)
    validateId(input.targetNodeId, operation)
    validateTimestamp(input.createdAtMs, operation)
    if (
      input.sourceNodeId === input.targetNodeId ||
      !isCanvasMembershipRelationType(input.relationType)
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseEdge(
        await this.#client.addCanvasNodeBoxMember(input),
        operation,
      )
    } catch (error: unknown) {
      throw mapError(error, operation)
    }
  }

  async reorderCanvasNodeBoxMemberships(
    input: ReorderCanvasNodeBoxMembershipsInput,
  ): Promise<readonly CanvasEdge[]> {
    const operation = 'reorderCanvasNodeBoxMemberships'
    validateId(input.canvasId, operation)
    validateId(input.nodeBoxId, operation)
    validateTimestamp(input.updatedAtMs, operation)
    const edgeIds = new Set<string>()
    for (const edgeId of [
      ...input.orderedMembershipEdgeIds,
      ...input.unorderedMembershipEdgeIds,
    ]) {
      validateId(edgeId, operation)
      if (edgeIds.has(edgeId)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      edgeIds.add(edgeId)
    }
    try {
      const value = await this.#client.reorderCanvasNodeBoxMemberships(input)
      if (!Array.isArray(value)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
      }
      return value.map((edge) => parseEdge(edge, operation))
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

  async updateCanvasEdgeRelationType(
    input: UpdateCanvasEdgeRelationTypeInput,
  ): Promise<CanvasEdge> {
    const operation = 'updateCanvasEdgeRelationType'
    validateId(input.id, operation)
    validateTimestamp(input.updatedAtMs, operation)
    if (
      !isCanvasOrdinaryEdgeRelationType(input.relationType) ||
      !isCanvasEdgeDirection(input.direction) ||
      !isCanvasEdgeLineStyle(input.lineStyle)
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    try {
      return parseEdge(
        await this.#client.updateCanvasEdgeRelationType(input),
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
