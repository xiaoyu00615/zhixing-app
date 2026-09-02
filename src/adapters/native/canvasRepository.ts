import { invoke } from '@tauri-apps/api/core'

import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasEdgeDirection,
  isCanvasEdgeLineStyle,
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
  type CanvasRepositoryOperation,
  type CreateCanvasInput,
  type AddCanvasNodeBoxMemberInput,
  type CreateCanvasEdgeInput,
  type CreateCanvasNodeInput,
  type CreateTextNodeInput,
  type DeleteCanvasEdgeInput,
  type MoveCanvasNodeInput,
  type MoveCanvasNodesInput,
  type ReorderCanvasNodeBoxMembershipsInput,
  type RenameCanvasInput,
  type RenameCanvasNodeInput,
  type UpdateCanvasViewportInput,
  type UpdateCanvasEdgeDirectionInput,
  type UpdateCanvasEdgeLineStyleInput,
  type UpdateCanvasEdgeRelationTypeInput,
  type UpdateCanvasNodeContentInput,
  type UpdateTextNodeInput,
} from '@/canvas/repository'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTimestamp(value: unknown): value is number {
  return Number.isSafeInteger(value) && typeof value === 'number' && value >= 0
}

function parseCanvas(
  value: unknown,
  operation: CanvasRepositoryOperation,
): Canvas {
  if (!isRecord(value))
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
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
  if (!isRecord(value))
    throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
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
  value: unknown,
  operation: CanvasRepositoryOperation,
): CanvasRepositoryError {
  if (
    isRecord(value) &&
    (value.code === 'NOT_FOUND' ||
      value.code === 'DUPLICATE' ||
      value.code === 'PERSISTENCE_UNAVAILABLE' ||
      value.code === 'PERSISTENCE_FAILED')
  ) {
    return new CanvasRepositoryError(value.code, operation)
  }
  return new CanvasRepositoryError('PERSISTENCE_UNAVAILABLE', operation)
}

async function invokeCanvas(
  command: string,
  operation: CanvasRepositoryOperation,
  args?: Record<string, unknown>,
): Promise<unknown> {
  try {
    return await invoke(command, args)
  } catch (error: unknown) {
    throw mapError(error, operation)
  }
}

export class NativeCanvasRepository implements CanvasRepository {
  async createCanvas(input: CreateCanvasInput): Promise<Canvas> {
    return parseCanvas(
      await invokeCanvas('canvas_create', 'createCanvas', { input }),
      'createCanvas',
    )
  }

  async listCanvases(): Promise<readonly Canvas[]> {
    const value = await invokeCanvas('canvas_list', 'listCanvases')
    if (!Array.isArray(value))
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'listCanvases')
    return value.map((canvas) => parseCanvas(canvas, 'listCanvases'))
  }

  async renameCanvas(input: RenameCanvasInput): Promise<Canvas> {
    return parseCanvas(
      await invokeCanvas('canvas_rename', 'renameCanvas', { input }),
      'renameCanvas',
    )
  }

  async getCanvas(id: string): Promise<Canvas> {
    return parseCanvas(
      await invokeCanvas('canvas_get', 'getCanvas', { input: { id } }),
      'getCanvas',
    )
  }

  async updateCanvasViewport(
    input: UpdateCanvasViewportInput,
  ): Promise<Canvas> {
    return parseCanvas(
      await invokeCanvas('canvas_update_viewport', 'updateCanvasViewport', {
        input,
      }),
      'updateCanvasViewport',
    )
  }

  async createCanvasNode(input: CreateCanvasNodeInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_create', 'createCanvasNode', { input }),
      'createCanvasNode',
    )
  }

  createTextNode(input: CreateTextNodeInput): Promise<CanvasNode> {
    return this.createCanvasNode({ ...input, type: 'text' })
  }

  async listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]> {
    const value = await invokeCanvas('canvas_node_list', 'listCanvasNodes', {
      input: { id: canvasId },
    })
    if (!Array.isArray(value)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'listCanvasNodes')
    }
    return value.map((node) => parseNode(node, 'listCanvasNodes'))
  }

  async updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_update_content', 'updateCanvasNodeContent', { input }),
      'updateCanvasNodeContent',
    )
  }

  async renameCanvasNode(input: RenameCanvasNodeInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_rename', 'renameCanvasNode', { input }),
      'renameCanvasNode',
    )
  }


  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode> {
    return this.updateCanvasNodeContent({ ...input, type: 'text' })
  }

  async moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_move', 'moveCanvasNode', { input }),
      'moveCanvasNode',
    )
  }

  async moveCanvasNodes(
    input: MoveCanvasNodesInput,
  ): Promise<readonly CanvasNode[]> {
    const operation = 'moveCanvasNodes'
    const value = await invokeCanvas('canvas_nodes_move', operation, { input })
    if (!Array.isArray(value)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    return value.map((node) => parseNode(node, operation))
  }

  async createCanvasEdge(input: CreateCanvasEdgeInput): Promise<CanvasEdge> {
    return parseEdge(
      await invokeCanvas('canvas_edge_create', 'createCanvasEdge', { input }),
      'createCanvasEdge',
    )
  }

  async addCanvasNodeBoxMember(
    input: AddCanvasNodeBoxMemberInput,
  ): Promise<CanvasEdge> {
    return parseEdge(
      await invokeCanvas(
        'canvas_node_box_add_member',
        'addCanvasNodeBoxMember',
        { input },
      ),
      'addCanvasNodeBoxMember',
    )
  }

  async reorderCanvasNodeBoxMemberships(
    input: ReorderCanvasNodeBoxMembershipsInput,
  ): Promise<readonly CanvasEdge[]> {
    const operation = 'reorderCanvasNodeBoxMemberships'
    const value = await invokeCanvas(
      'canvas_node_box_reorder_memberships',
      operation,
      { input },
    )
    if (!Array.isArray(value)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', operation)
    }
    return value.map((edge) => parseEdge(edge, operation))
  }

  async listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]> {
    const value = await invokeCanvas('canvas_edge_list', 'listCanvasEdges', {
      input: { id: canvasId },
    })
    if (!Array.isArray(value)) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'listCanvasEdges')
    }
    return value.map((edge) => parseEdge(edge, 'listCanvasEdges'))
  }

  async updateCanvasEdgeDirection(
    input: UpdateCanvasEdgeDirectionInput,
  ): Promise<CanvasEdge> {
    return parseEdge(
      await invokeCanvas(
        'canvas_edge_set_direction',
        'updateCanvasEdgeDirection',
        { input },
      ),
      'updateCanvasEdgeDirection',
    )
  }

  async updateCanvasEdgeLineStyle(
    input: UpdateCanvasEdgeLineStyleInput,
  ): Promise<CanvasEdge> {
    return parseEdge(
      await invokeCanvas(
        'canvas_edge_set_line_style',
        'updateCanvasEdgeLineStyle',
        { input },
      ),
      'updateCanvasEdgeLineStyle',
    )
  }

  async updateCanvasEdgeRelationType(
    input: UpdateCanvasEdgeRelationTypeInput,
  ): Promise<CanvasEdge> {
    return parseEdge(
      await invokeCanvas(
        'canvas_edge_set_relation_type',
        'updateCanvasEdgeRelationType',
        { input },
      ),
      'updateCanvasEdgeRelationType',
    )
  }

  async deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<CanvasEdge> {
    return parseEdge(
      await invokeCanvas('canvas_edge_delete', 'deleteCanvasEdge', { input }),
      'deleteCanvasEdge',
    )
  }
}
