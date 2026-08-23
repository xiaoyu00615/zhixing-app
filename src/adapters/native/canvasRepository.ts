import { invoke } from '@tauri-apps/api/core'

import {
  isCanonicalCanvasId,
  isCanvasCoordinate,
  isCanvasViewport,
  isNonEmptyCanvasTitle,
  isTextNodeContent,
  type Canvas,
  type CanvasNode,
} from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
  type CanvasRepositoryOperation,
  type CreateCanvasInput,
  type CreateTextNodeInput,
  type MoveCanvasNodeInput,
  type RenameCanvasInput,
  type UpdateCanvasViewportInput,
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

function mapError(
  value: unknown,
  operation: CanvasRepositoryOperation,
): CanvasRepositoryError {
  if (
    isRecord(value) &&
    (value.code === 'NOT_FOUND' ||
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

  async createTextNode(input: CreateTextNodeInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_create_text', 'createTextNode', { input }),
      'createTextNode',
    )
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

  async updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_update_text', 'updateTextNode', { input }),
      'updateTextNode',
    )
  }

  async moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode> {
    return parseNode(
      await invokeCanvas('canvas_node_move', 'moveCanvasNode', { input }),
      'moveCanvasNode',
    )
  }
}
