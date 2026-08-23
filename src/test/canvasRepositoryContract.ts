import { describe, expect, test } from 'vitest'

import type { Canvas, CanvasNode } from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
  type CreateCanvasInput,
  type CreateTextNodeInput,
  type MoveCanvasNodeInput,
  type RenameCanvasInput,
  type UpdateCanvasViewportInput,
  type UpdateTextNodeInput,
} from '@/canvas/repository'

export const CONTRACT_CANVAS_ID = '00000000-0000-4000-8000-000000000611'
export const CONTRACT_NODE_ID = '00000000-0000-4000-8000-000000000612'

export class CanvasContractBackend implements CanvasRepository {
  readonly canvases = new Map<string, Canvas>()
  readonly nodes = new Map<string, CanvasNode>()

  createCanvas(input: CreateCanvasInput): Promise<Canvas> {
    const canvas: Canvas = { ...input, updatedAtMs: input.createdAtMs }
    this.canvases.set(canvas.id, canvas)
    return Promise.resolve(canvas)
  }

  listCanvases(): Promise<readonly Canvas[]> {
    return Promise.resolve([...this.canvases.values()].sort((a, b) => b.updatedAtMs - a.updatedAtMs || a.id.localeCompare(b.id)))
  }

  async renameCanvas(input: RenameCanvasInput): Promise<Canvas> {
    const canvas = await this.getCanvas(input.id)
    const updated = { ...canvas, title: input.title, updatedAtMs: input.updatedAtMs }
    this.canvases.set(input.id, updated)
    return updated
  }

  getCanvas(id: string): Promise<Canvas> {
    const canvas = this.canvases.get(id)
    return canvas === undefined
      ? Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'getCanvas'))
      : Promise.resolve(canvas)
  }

  async updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<Canvas> {
    const canvas = await this.getCanvas(input.id)
    const updated = { ...canvas, viewport: input.viewport, updatedAtMs: input.updatedAtMs }
    this.canvases.set(input.id, updated)
    return updated
  }

  async createTextNode(input: CreateTextNodeInput): Promise<CanvasNode> {
    await this.getCanvas(input.canvasId)
    const node: CanvasNode = { ...input, type: 'text', updatedAtMs: input.createdAtMs }
    this.nodes.set(node.id, node)
    return node
  }

  async listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]> {
    await this.getCanvas(canvasId)
    return [...this.nodes.values()].filter((node) => node.canvasId === canvasId)
  }

  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode> {
    const node = this.nodes.get(input.id)
    if (node === undefined) return Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'updateTextNode'))
    const updated = { ...node, content: input.content, updatedAtMs: input.updatedAtMs }
    this.nodes.set(input.id, updated)
    return Promise.resolve(updated)
  }

  moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode> {
    const node = this.nodes.get(input.id)
    if (node === undefined) return Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'moveCanvasNode'))
    const updated = { ...node, x: input.x, y: input.y, updatedAtMs: input.updatedAtMs }
    this.nodes.set(input.id, updated)
    return Promise.resolve(updated)
  }
}

export function defineCanvasRepositoryContract(
  name: string,
  createFixture: () => { repository: CanvasRepository; backend: CanvasContractBackend },
): void {
  describe(`${name} CanvasRepository contract`, () => {
    test('creates, lists, renames, opens, and persists viewport', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await expect(repository.listCanvases()).resolves.toHaveLength(1)
      await expect(repository.renameCanvas({ id: CONTRACT_CANVAS_ID, title: 'Roadmap', updatedAtMs: 20 })).resolves.toMatchObject({ title: 'Roadmap' })
      await expect(repository.updateCanvasViewport({ id: CONTRACT_CANVAS_ID, viewport: { x: 80, y: -20, zoom: 1.4 }, updatedAtMs: 30 })).resolves.toMatchObject({ viewport: { x: 80, y: -20, zoom: 1.4 } })
      await expect(repository.getCanvas(CONTRACT_CANVAS_ID)).resolves.toMatchObject({ title: 'Roadmap' })
    })

    test('creates, edits, moves, and lists text nodes', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'One' }, x: 1, y: 2, createdAtMs: 20 })
      await expect(repository.updateTextNode({ id: CONTRACT_NODE_ID, content: { type: 'text', text: 'Two' }, updatedAtMs: 30 })).resolves.toMatchObject({ content: { type: 'text', text: 'Two' } })
      await expect(repository.moveCanvasNode({ id: CONTRACT_NODE_ID, x: -10, y: 45, updatedAtMs: 40 })).resolves.toMatchObject({ x: -10, y: 45 })
      await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual([expect.objectContaining({ id: CONTRACT_NODE_ID })])
    })

    test('reports missing Canvas and node through the safe contract', async () => {
      const { repository } = createFixture()
      await expect(repository.getCanvas(CONTRACT_CANVAS_ID)).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'getCanvas' })
      await expect(repository.moveCanvasNode({ id: CONTRACT_NODE_ID, x: 0, y: 0, updatedAtMs: 10 })).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'moveCanvasNode' })
    })
  })
}
