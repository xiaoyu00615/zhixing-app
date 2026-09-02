import { describe, expect, test } from 'vitest'

import type {
  Canvas,
  CanvasEdge,
  CanvasEdgeDirection,
  CanvasNode,
} from '@/canvas/model'
import {
  CanvasRepositoryError,
  type CanvasRepository,
  type AddCanvasNodeBoxMemberInput,
  type CreateCanvasInput,
  type CreateCanvasEdgeInput,
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
  type UpdateTextNodeInput,
} from '@/canvas/repository'

export const CONTRACT_CANVAS_ID = '00000000-0000-4000-8000-000000000611'
export const CONTRACT_NODE_ID = '00000000-0000-4000-8000-000000000612'
export const CONTRACT_TARGET_NODE_ID = '00000000-0000-4000-8000-000000000613'
export const CONTRACT_EDGE_ID = '00000000-0000-4000-8000-000000000614'
export const CONTRACT_REVERSE_EDGE_ID = '00000000-0000-4000-8000-000000000615'
export const CONTRACT_BOX_ID = '00000000-0000-4000-8000-000000000620'

export class CanvasContractBackend implements CanvasRepository {
  readonly canvases = new Map<string, Canvas>()
  readonly nodes = new Map<string, CanvasNode>()
  readonly edges = new Map<string, CanvasEdge>()

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
    const node: CanvasNode = { ...input, type: 'text', nodeName: '', updatedAtMs: input.createdAtMs }
    this.nodes.set(node.id, node)
    return node
  }

  async createCanvasNode(input: import('@/canvas/repository').CreateCanvasNodeInput): Promise<CanvasNode> {
    await this.getCanvas(input.canvasId)
    const node = { ...input, nodeName: '', updatedAtMs: input.createdAtMs } as CanvasNode
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
    if (node.type !== 'text') return Promise.reject(new CanvasRepositoryError('PERSISTENCE_FAILED', 'updateTextNode'))
    const updated: CanvasNode = { ...node, content: input.content, updatedAtMs: input.updatedAtMs }
    this.nodes.set(input.id, updated)
    return Promise.resolve(updated)
  }

  updateCanvasNodeContent(input: import('@/canvas/repository').UpdateCanvasNodeContentInput): Promise<CanvasNode> {
    const node = this.nodes.get(input.id)
    if (node === undefined) return Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'updateCanvasNodeContent'))
    if (node.type === 'unknown' || node.type !== input.type) return Promise.reject(new CanvasRepositoryError('PERSISTENCE_FAILED', 'updateCanvasNodeContent'))
    const updated = { ...node, content: input.content, updatedAtMs: input.updatedAtMs } as CanvasNode
    this.nodes.set(input.id, updated)
    return Promise.resolve(updated)
  }

  renameCanvasNode(input: RenameCanvasNodeInput): Promise<CanvasNode> {
    const node = this.nodes.get(input.id)
    if (node === undefined || node.canvasId !== input.canvasId || node.type === 'unknown') {
      return Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'renameCanvasNode'))
    }
    const updated = { ...node, nodeName: input.nodeName, updatedAtMs: input.updatedAtMs }
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

  async moveCanvasNodes(
    input: MoveCanvasNodesInput,
  ): Promise<readonly CanvasNode[]> {
    await this.getCanvas(input.canvasId)
    const nodeIds = new Set<string>()
    const current = input.moves.map((move) => {
      if (nodeIds.has(move.nodeId)) {
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'moveCanvasNodes')
      }
      nodeIds.add(move.nodeId)
      const node = this.nodes.get(move.nodeId)
      if (node?.canvasId !== input.canvasId) {
        throw new CanvasRepositoryError('NOT_FOUND', 'moveCanvasNodes')
      }
      return node
    })
    const updated = current.map((node, index) => ({
      ...node,
      x: input.moves[index]!.x,
      y: input.moves[index]!.y,
      updatedAtMs: input.updatedAtMs,
    }))
    for (const node of updated) this.nodes.set(node.id, node)
    return updated
  }

  async createCanvasEdge(input: CreateCanvasEdgeInput): Promise<CanvasEdge> {
    await this.getCanvas(input.canvasId)
    const source = this.nodes.get(input.sourceNodeId)
    const target = this.nodes.get(input.targetNodeId)
    if (
      source?.canvasId !== input.canvasId ||
      target?.canvasId !== input.canvasId
    ) {
      throw new CanvasRepositoryError('NOT_FOUND', 'createCanvasEdge')
    }
    if (input.sourceNodeId === input.targetNodeId) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'createCanvasEdge')
    }
    this.assertNoDuplicate(
      input.canvasId,
      input.sourceNodeId,
      input.targetNodeId,
      input.relationType,
      input.direction,
    )
    const edge: CanvasEdge = {
      ...input,
      membershipPosition: null,
      updatedAtMs: input.createdAtMs,
      deletedAtMs: null,
    }
    this.edges.set(edge.id, edge)
    return edge
  }

  async addCanvasNodeBoxMember(
    input: AddCanvasNodeBoxMemberInput,
  ): Promise<CanvasEdge> {
    await this.getCanvas(input.canvasId)
    const source = this.nodes.get(input.sourceNodeId)
    const target = this.nodes.get(input.targetNodeId)
    if (source?.canvasId !== input.canvasId || target?.canvasId !== input.canvasId) {
      throw new CanvasRepositoryError('NOT_FOUND', 'addCanvasNodeBoxMember')
    }
    if (source.type === 'node_box' || target.type !== 'node_box') {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'addCanvasNodeBoxMember')
    }
    const active = [...this.edges.values()].filter((edge) =>
      edge.deletedAtMs === null && edge.canvasId === input.canvasId,
    )
    if (active.some((edge) =>
      edge.sourceNodeId === input.sourceNodeId &&
      edge.targetNodeId === input.targetNodeId &&
      (edge.relationType === 'ordered_box_member' ||
        edge.relationType === 'unordered_box_member'),
    )) {
      throw new CanvasRepositoryError('DUPLICATE', 'addCanvasNodeBoxMember')
    }
    const positions = active
      .filter((edge) =>
        edge.targetNodeId === input.targetNodeId &&
        edge.relationType === input.relationType,
      )
      .map((edge) => edge.membershipPosition ?? -1)
    const edge: CanvasEdge = {
      ...input,
      direction: 'forward',
      lineStyle: 'solid',
      membershipPosition: Math.max(-1, ...positions) + 1,
      updatedAtMs: input.createdAtMs,
      deletedAtMs: null,
    }
    this.edges.set(edge.id, edge)
    return edge
  }

  async reorderCanvasNodeBoxMemberships(
    input: ReorderCanvasNodeBoxMembershipsInput,
  ): Promise<readonly CanvasEdge[]> {
    await this.getCanvas(input.canvasId)
    const nodeBox = this.nodes.get(input.nodeBoxId)
    if (nodeBox?.canvasId !== input.canvasId) {
      throw new CanvasRepositoryError('NOT_FOUND', 'reorderCanvasNodeBoxMemberships')
    }
    if (nodeBox.type !== 'node_box') {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'reorderCanvasNodeBoxMemberships')
    }
    const suppliedEdgeIds = [
      ...input.orderedMembershipEdgeIds,
      ...input.unorderedMembershipEdgeIds,
    ]
    const uniqueEdgeIds = new Set(suppliedEdgeIds)
    const activeMemberships = [...this.edges.values()].filter((edge) =>
      edge.canvasId === input.canvasId &&
      edge.targetNodeId === input.nodeBoxId &&
      edge.deletedAtMs === null &&
      (edge.relationType === 'ordered_box_member' ||
        edge.relationType === 'unordered_box_member'),
    )
    if (
      uniqueEdgeIds.size !== suppliedEdgeIds.length ||
      activeMemberships.length !== suppliedEdgeIds.length ||
      activeMemberships.some((edge) => !uniqueEdgeIds.has(edge.id))
    ) {
      throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'reorderCanvasNodeBoxMemberships')
    }
    const desired = new Map<
      string,
      { readonly relationType: 'ordered_box_member' | 'unordered_box_member'; readonly position: number }
    >()
    input.orderedMembershipEdgeIds.forEach((edgeId, position) => {
      desired.set(edgeId, { relationType: 'ordered_box_member', position })
    })
    input.unorderedMembershipEdgeIds.forEach((edgeId, position) => {
      desired.set(edgeId, { relationType: 'unordered_box_member', position })
    })
    const updated = activeMemberships.map((edge) => {
      const next = desired.get(edge.id)!
      const changed = edge.relationType !== next.relationType ||
        edge.membershipPosition !== next.position
      return {
        ...edge,
        relationType: next.relationType,
        membershipPosition: next.position,
        updatedAtMs: changed ? input.updatedAtMs : edge.updatedAtMs,
      }
    })
    for (const edge of updated) this.edges.set(edge.id, edge)
    const byId = new Map(updated.map((edge) => [edge.id, edge]))
    return suppliedEdgeIds.map((edgeId) => byId.get(edgeId)!)
  }

  async listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]> {
    await this.getCanvas(canvasId)
    return [...this.edges.values()].filter(
      (edge) => edge.canvasId === canvasId && edge.deletedAtMs === null,
    )
  }

  updateCanvasEdgeDirection(
    input: UpdateCanvasEdgeDirectionInput,
  ): Promise<CanvasEdge> {
    const edge = this.requireActiveEdge(input.id, 'updateCanvasEdgeDirection')
    this.assertNoDuplicate(
      edge.canvasId,
      edge.sourceNodeId,
      edge.targetNodeId,
      edge.relationType,
      input.direction,
      edge.id,
    )
    const updated = { ...edge, ...input }
    this.edges.set(edge.id, updated)
    return Promise.resolve(updated)
  }

  updateCanvasEdgeLineStyle(
    input: UpdateCanvasEdgeLineStyleInput,
  ): Promise<CanvasEdge> {
    const edge = this.requireActiveEdge(input.id, 'updateCanvasEdgeLineStyle')
    const updated = { ...edge, ...input }
    this.edges.set(edge.id, updated)
    return Promise.resolve(updated)
  }

  updateCanvasEdgeRelationType(
    input: UpdateCanvasEdgeRelationTypeInput,
  ): Promise<CanvasEdge> {
    const edge = this.requireActiveEdge(input.id, 'updateCanvasEdgeRelationType')
    this.assertNoDuplicate(
      edge.canvasId,
      edge.sourceNodeId,
      edge.targetNodeId,
      input.relationType,
      input.direction,
      edge.id,
    )
    const updated = { ...edge, ...input }
    this.edges.set(edge.id, updated)
    return Promise.resolve(updated)
  }

  deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<CanvasEdge> {
    const edge = this.requireActiveEdge(input.id, 'deleteCanvasEdge')
    const updated = { ...edge, ...input }
    this.edges.set(edge.id, updated)
    return Promise.resolve(updated)
  }

  private requireActiveEdge(
    id: string,
    operation:
      | 'updateCanvasEdgeDirection'
      | 'updateCanvasEdgeLineStyle'
      | 'updateCanvasEdgeRelationType'
      | 'deleteCanvasEdge',
  ): CanvasEdge {
    const edge = this.edges.get(id)
    if (edge === undefined || edge.deletedAtMs !== null) {
      throw new CanvasRepositoryError('NOT_FOUND', operation)
    }
    return edge
  }

  private assertNoDuplicate(
    canvasId: string,
    sourceNodeId: string,
    targetNodeId: string,
    relationType: string,
    direction: CanvasEdgeDirection,
    excludedId?: string,
  ): void {
    const duplicate = [...this.edges.values()].some((edge) => {
      if (
        edge.id === excludedId ||
        edge.deletedAtMs !== null ||
        edge.canvasId !== canvasId ||
        edge.relationType !== relationType ||
        edge.direction !== direction
      ) {
        return false
      }
      return direction === 'forward'
        ? edge.sourceNodeId === sourceNodeId &&
            edge.targetNodeId === targetNodeId
        : (edge.sourceNodeId === sourceNodeId &&
            edge.targetNodeId === targetNodeId) ||
            (edge.sourceNodeId === targetNodeId &&
              edge.targetNodeId === sourceNodeId)
    })
    if (duplicate) {
      throw new CanvasRepositoryError('DUPLICATE', 'createCanvasEdge')
    }
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

    test('creates, edits, moves, and lists sticky nodes with the same contract', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      const sticky = await repository.createCanvasNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'Remember' }, x: 12, y: 24, createdAtMs: 20 })
      expect(sticky).toMatchObject({ type: 'sticky', content: { type: 'sticky', text: 'Remember' } })
      await expect(repository.updateCanvasNodeContent({ id: CONTRACT_NODE_ID, type: 'sticky', content: { type: 'sticky', text: 'Updated' }, updatedAtMs: 30 })).resolves.toMatchObject({ content: { type: 'sticky', text: 'Updated' } })
      await expect(repository.moveCanvasNode({ id: CONTRACT_NODE_ID, x: -10, y: 45, updatedAtMs: 40 })).resolves.toMatchObject({ type: 'sticky', x: -10, y: 45 })
      await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual([expect.objectContaining({ type: 'sticky' })])
    })

    test('renames Text and Sticky nodes without changing content or position', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Canvas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createCanvasNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'text', content: { type: 'text', text: 'Text body' }, x: 12, y: 24, createdAtMs: 20 })
      await repository.createCanvasNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'Sticky body' }, x: 36, y: 48, createdAtMs: 21 })

      await expect(repository.renameCanvasNode({ canvasId: CONTRACT_CANVAS_ID, id: CONTRACT_NODE_ID, nodeName: '产品构思', updatedAtMs: 30 })).resolves.toMatchObject({ nodeName: '产品构思', content: { type: 'text', text: 'Text body' }, x: 12, y: 24, updatedAtMs: 30 })
      await expect(repository.renameCanvasNode({ canvasId: CONTRACT_CANVAS_ID, id: CONTRACT_TARGET_NODE_ID, nodeName: '', updatedAtMs: 31 })).resolves.toMatchObject({ nodeName: '', content: { type: 'sticky', text: 'Sticky body' }, x: 36, y: 48, updatedAtMs: 31 })
      await expect(repository.renameCanvasNode({ canvasId: '00000000-0000-4000-8000-000000000699', id: CONTRACT_NODE_ID, nodeName: 'Other', updatedAtMs: 32 })).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'renameCanvasNode' })
      await expect(repository.renameCanvasNode({ canvasId: CONTRACT_CANVAS_ID, id: '00000000-0000-4000-8000-000000000699', nodeName: 'Missing', updatedAtMs: 32 })).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'renameCanvasNode' })
    })

    test('moves multiple nodes atomically within one Canvas', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'One' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createTextNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'Two' }, x: 3, y: 4, createdAtMs: 21 })
      await expect(repository.moveCanvasNodes({
        canvasId: CONTRACT_CANVAS_ID,
        moves: [
          { nodeId: CONTRACT_NODE_ID, x: 10, y: 20 },
          { nodeId: CONTRACT_TARGET_NODE_ID, x: 30, y: 40 },
        ],
        updatedAtMs: 50,
      })).resolves.toEqual([
        expect.objectContaining({ id: CONTRACT_NODE_ID, x: 10, y: 20, updatedAtMs: 50 }),
        expect.objectContaining({ id: CONTRACT_TARGET_NODE_ID, x: 30, y: 40, updatedAtMs: 50 }),
      ])
    })

    test('does not partially move nodes when a batch member is missing or cross-Canvas', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'One' }, x: 1, y: 2, createdAtMs: 20 })
      await expect(repository.moveCanvasNodes({
        canvasId: CONTRACT_CANVAS_ID,
        moves: [
          { nodeId: CONTRACT_NODE_ID, x: 10, y: 20 },
          { nodeId: CONTRACT_TARGET_NODE_ID, x: 30, y: 40 },
        ],
        updatedAtMs: 50,
      })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual([
        expect.objectContaining({ id: CONTRACT_NODE_ID, x: 1, y: 2, updatedAtMs: 20 }),
      ])
    })

    test('reports missing Canvas and node through the safe contract', async () => {
      const { repository } = createFixture()
      await expect(repository.getCanvas(CONTRACT_CANVAS_ID)).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'getCanvas' })
      await expect(repository.moveCanvasNode({ id: CONTRACT_NODE_ID, x: 0, y: 0, updatedAtMs: 10 })).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'moveCanvasNode' })
    })

    test('creates, configures, lists, and soft-deletes Canvas Edges', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'Source' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createTextNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'Target' }, x: 3, y: 4, createdAtMs: 21 })
      const created = await repository.createCanvasEdge({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 30 })
      expect(created).toMatchObject({ direction: 'forward', lineStyle: 'solid', deletedAtMs: null })
      await expect(repository.updateCanvasEdgeDirection({ id: CONTRACT_EDGE_ID, direction: 'bidirectional', updatedAtMs: 40 })).resolves.toMatchObject({ direction: 'bidirectional' })
      await expect(repository.updateCanvasEdgeLineStyle({ id: CONTRACT_EDGE_ID, lineStyle: 'dashed', updatedAtMs: 50 })).resolves.toMatchObject({ lineStyle: 'dashed' })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toHaveLength(1)
      await expect(repository.deleteCanvasEdge({ id: CONTRACT_EDGE_ID, deletedAtMs: 60, updatedAtMs: 60 })).resolves.toMatchObject({ deletedAtMs: 60 })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual([])
      await expect(repository.deleteCanvasEdge({ id: CONTRACT_EDGE_ID, deletedAtMs: 70, updatedAtMs: 70 })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(repository.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000615', canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'dotted', createdAtMs: 80 })).resolves.toMatchObject({ lineStyle: 'dotted' })
    })

    test('atomically changes semantic type with explicit presentation defaults', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'A' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createCanvasNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'B' }, x: 3, y: 4, createdAtMs: 21 })
      await repository.createCanvasEdge({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'dashed', createdAtMs: 30 })

      await expect(repository.updateCanvasEdgeRelationType({ id: CONTRACT_EDGE_ID, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', updatedAtMs: 40 })).resolves.toMatchObject({ relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', updatedAtMs: 40 })
      await expect(repository.updateCanvasEdgeRelationType({ id: CONTRACT_EDGE_ID, relationType: 'peer', direction: 'none', lineStyle: 'solid', updatedAtMs: 50 })).resolves.toMatchObject({ relationType: 'peer', direction: 'none', lineStyle: 'solid', updatedAtMs: 50 })
      await expect(repository.updateCanvasEdgeRelationType({ id: CONTRACT_EDGE_ID, relationType: 'default', direction: 'forward', lineStyle: 'solid', updatedAtMs: 60 })).resolves.toMatchObject({ relationType: 'default', direction: 'forward', lineStyle: 'solid', updatedAtMs: 60 })
    })

    test('rolls back every semantic field when a type change conflicts', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'A' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createTextNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'B' }, x: 3, y: 4, createdAtMs: 21 })
      await repository.createCanvasEdge({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', createdAtMs: 30 })
      await repository.createCanvasEdge({ id: CONTRACT_REVERSE_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'dashed', createdAtMs: 31 })

      await expect(repository.updateCanvasEdgeRelationType({ id: CONTRACT_REVERSE_EDGE_ID, relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', updatedAtMs: 40 })).rejects.toMatchObject({ code: 'DUPLICATE' })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: CONTRACT_REVERSE_EDGE_ID, relationType: 'default', direction: 'forward', lineStyle: 'dashed', updatedAtMs: 31 }),
      ]))
    })

    test('preserves unknown relation strings when listing existing data', async () => {
      const { repository, backend } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      backend.edges.set(CONTRACT_EDGE_ID, {
        id: CONTRACT_EDGE_ID,
        canvasId: CONTRACT_CANVAS_ID,
        sourceNodeId: CONTRACT_NODE_ID,
        targetNodeId: CONTRACT_TARGET_NODE_ID,
        relationType: 'future_relation' as CanvasEdge['relationType'],
        direction: 'bidirectional',
        lineStyle: 'dotted',
        membershipPosition: null,
        createdAtMs: 30,
        updatedAtMs: 30,
        deletedAtMs: null,
      })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual([
        expect.objectContaining({ relationType: 'future_relation', direction: 'bidirectional', lineStyle: 'dotted' }),
      ])
    })

    test('connects text and sticky nodes in every supported pairing', async () => {
      const { repository } = createFixture()
      const secondStickyId = '00000000-0000-4000-8000-000000000616'
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createCanvasNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'text', content: { type: 'text', text: 'Text' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createCanvasNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'Sticky A' }, x: 3, y: 4, createdAtMs: 21 })
      await repository.createCanvasNode({ id: secondStickyId, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'Sticky B' }, x: 5, y: 6, createdAtMs: 22 })

      await expect(repository.createCanvasEdge({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 30 })).resolves.toMatchObject({ sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID })
      await expect(repository.createCanvasEdge({ id: CONTRACT_REVERSE_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'dashed', createdAtMs: 31 })).resolves.toMatchObject({ sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_NODE_ID })
      await expect(repository.createCanvasEdge({ id: '00000000-0000-4000-8000-000000000617', canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: secondStickyId, relationType: 'default', direction: 'forward', lineStyle: 'dotted', createdAtMs: 32 })).resolves.toMatchObject({ sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: secondStickyId })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toHaveLength(3)
    })

    test('adds Node Box membership with section ordering and soft removal', async () => {
      const { repository } = createFixture()
      const unorderedNodeId = '00000000-0000-4000-8000-000000000621'
      const unorderedEdgeId = '00000000-0000-4000-8000-000000000622'
      const secondBoxId = '00000000-0000-4000-8000-000000000623'
      const readdedEdgeId = '00000000-0000-4000-8000-000000000624'
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'A' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createCanvasNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'B' }, x: 3, y: 4, createdAtMs: 21 })
      await repository.createCanvasNode({ id: unorderedNodeId, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'C' }, x: 4, y: 5, createdAtMs: 22 })
      await repository.createCanvasNode({ id: CONTRACT_BOX_ID, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 5, y: 6, createdAtMs: 22 })
      await repository.createCanvasNode({ id: secondBoxId, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 7, y: 8, createdAtMs: 23 })

      await expect(repository.addCanvasNodeBoxMember({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'ordered_box_member', createdAtMs: 30 })).resolves.toMatchObject({ relationType: 'ordered_box_member', direction: 'forward', lineStyle: 'solid', membershipPosition: 0 })
      await expect(repository.addCanvasNodeBoxMember({ id: CONTRACT_REVERSE_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'ordered_box_member', createdAtMs: 31 })).resolves.toMatchObject({ membershipPosition: 1 })
      await expect(repository.addCanvasNodeBoxMember({ id: unorderedEdgeId, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: unorderedNodeId, targetNodeId: CONTRACT_BOX_ID, relationType: 'unordered_box_member', createdAtMs: 32 })).resolves.toMatchObject({ membershipPosition: 0 })
      await expect(repository.addCanvasNodeBoxMember({ id: '00000000-0000-4000-8000-000000000625', canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'unordered_box_member', createdAtMs: 33 })).rejects.toMatchObject({ code: 'DUPLICATE' })
      await expect(repository.addCanvasNodeBoxMember({ id: '00000000-0000-4000-8000-000000000626', canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_BOX_ID, targetNodeId: secondBoxId, relationType: 'ordered_box_member', createdAtMs: 34 })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await repository.deleteCanvasEdge({ id: CONTRACT_EDGE_ID, deletedAtMs: 40, updatedAtMs: 40 })
      await expect(repository.addCanvasNodeBoxMember({ id: readdedEdgeId, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'unordered_box_member', createdAtMs: 41 })).resolves.toMatchObject({ membershipPosition: 1 })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual([
        expect.objectContaining({ id: CONTRACT_REVERSE_EDGE_ID, membershipPosition: 1 }),
        expect.objectContaining({ id: unorderedEdgeId, membershipPosition: 0 }),
        expect.objectContaining({ id: readdedEdgeId, membershipPosition: 1 }),
      ])
    })

    test('reorders and moves Node Box memberships with stable identity and timestamps', async () => {
      const { repository } = createFixture()
      const nodeB = '00000000-0000-4000-8000-000000000631'
      const nodeC = '00000000-0000-4000-8000-000000000632'
      const nodeD = '00000000-0000-4000-8000-000000000633'
      const nodeE = '00000000-0000-4000-8000-000000000634'
      const edgeA = '00000000-0000-4000-8000-000000000635'
      const edgeB = '00000000-0000-4000-8000-000000000636'
      const edgeC = '00000000-0000-4000-8000-000000000637'
      const edgeD = '00000000-0000-4000-8000-000000000638'
      const edgeE = '00000000-0000-4000-8000-000000000639'
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      for (const [id, createdAtMs] of [[CONTRACT_NODE_ID, 20], [nodeB, 21], [nodeC, 22], [nodeD, 23], [nodeE, 24]] as const) {
        await repository.createTextNode({ id, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: id }, x: 1, y: 2, createdAtMs })
      }
      await repository.createCanvasNode({ id: CONTRACT_BOX_ID, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 5, y: 6, createdAtMs: 25 })
      for (const [id, sourceNodeId, relationType, createdAtMs] of [
        [edgeA, CONTRACT_NODE_ID, 'ordered_box_member', 30],
        [edgeB, nodeB, 'ordered_box_member', 31],
        [edgeC, nodeC, 'ordered_box_member', 32],
        [edgeD, nodeD, 'unordered_box_member', 33],
        [edgeE, nodeE, 'unordered_box_member', 34],
      ] as const) {
        await repository.addCanvasNodeBoxMember({ id, canvasId: CONTRACT_CANVAS_ID, sourceNodeId, targetNodeId: CONTRACT_BOX_ID, relationType, createdAtMs })
      }

      await expect(repository.reorderCanvasNodeBoxMemberships({
        canvasId: CONTRACT_CANVAS_ID,
        nodeBoxId: CONTRACT_BOX_ID,
        orderedMembershipEdgeIds: [edgeC, edgeA, edgeB],
        unorderedMembershipEdgeIds: [edgeD, edgeE],
        updatedAtMs: 40,
      })).resolves.toEqual([
        expect.objectContaining({ id: edgeC, membershipPosition: 0, createdAtMs: 32, updatedAtMs: 40 }),
        expect.objectContaining({ id: edgeA, membershipPosition: 1, createdAtMs: 30, updatedAtMs: 40 }),
        expect.objectContaining({ id: edgeB, membershipPosition: 2, createdAtMs: 31, updatedAtMs: 40 }),
        expect.objectContaining({ id: edgeD, membershipPosition: 0, updatedAtMs: 33 }),
        expect.objectContaining({ id: edgeE, membershipPosition: 1, updatedAtMs: 34 }),
      ])
      await expect(repository.reorderCanvasNodeBoxMemberships({
        canvasId: CONTRACT_CANVAS_ID,
        nodeBoxId: CONTRACT_BOX_ID,
        orderedMembershipEdgeIds: [edgeC, edgeB],
        unorderedMembershipEdgeIds: [edgeD, edgeA, edgeE],
        updatedAtMs: 50,
      })).resolves.toEqual([
        expect.objectContaining({ id: edgeC, relationType: 'ordered_box_member', membershipPosition: 0 }),
        expect.objectContaining({ id: edgeB, relationType: 'ordered_box_member', membershipPosition: 1, updatedAtMs: 50 }),
        expect.objectContaining({ id: edgeD, relationType: 'unordered_box_member', membershipPosition: 0 }),
        expect.objectContaining({ id: edgeA, relationType: 'unordered_box_member', membershipPosition: 1, createdAtMs: 30, updatedAtMs: 50 }),
        expect.objectContaining({ id: edgeE, relationType: 'unordered_box_member', membershipPosition: 2, updatedAtMs: 50 }),
      ])
      await expect(repository.reorderCanvasNodeBoxMemberships({
        canvasId: CONTRACT_CANVAS_ID,
        nodeBoxId: CONTRACT_BOX_ID,
        orderedMembershipEdgeIds: [edgeC, edgeD, edgeB],
        unorderedMembershipEdgeIds: [edgeA, edgeE],
        updatedAtMs: 60,
      })).resolves.toEqual([
        expect.objectContaining({ id: edgeC, membershipPosition: 0 }),
        expect.objectContaining({ id: edgeD, relationType: 'ordered_box_member', membershipPosition: 1, updatedAtMs: 60 }),
        expect.objectContaining({ id: edgeB, membershipPosition: 2, updatedAtMs: 60 }),
        expect.objectContaining({ id: edgeA, relationType: 'unordered_box_member', membershipPosition: 0, updatedAtMs: 60 }),
        expect.objectContaining({ id: edgeE, membershipPosition: 1, updatedAtMs: 60 }),
      ])
      const beforeNoOp = await repository.listCanvasEdges(CONTRACT_CANVAS_ID)
      await repository.reorderCanvasNodeBoxMemberships({
        canvasId: CONTRACT_CANVAS_ID,
        nodeBoxId: CONTRACT_BOX_ID,
        orderedMembershipEdgeIds: [edgeC, edgeD, edgeB],
        unorderedMembershipEdgeIds: [edgeA, edgeE],
        updatedAtMs: 70,
      })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual(beforeNoOp)
    })

    test('rejects incomplete, duplicate, ordinary, wrong-Box, and wrong-Canvas reorder sets', async () => {
      const { repository } = createFixture()
      const secondCanvasId = '00000000-0000-4000-8000-000000000641'
      const secondBoxId = '00000000-0000-4000-8000-000000000642'
      const edgeB = '00000000-0000-4000-8000-000000000643'
      const ordinaryEdgeId = '00000000-0000-4000-8000-000000000644'
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createCanvas({ id: secondCanvasId, title: 'Other', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 11 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'A' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createTextNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'B' }, x: 3, y: 4, createdAtMs: 21 })
      await repository.createCanvasNode({ id: CONTRACT_BOX_ID, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 5, y: 6, createdAtMs: 22 })
      await repository.createCanvasNode({ id: secondBoxId, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 7, y: 8, createdAtMs: 23 })
      await repository.addCanvasNodeBoxMember({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'ordered_box_member', createdAtMs: 30 })
      await repository.addCanvasNodeBoxMember({ id: edgeB, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'unordered_box_member', createdAtMs: 31 })
      await repository.createCanvasEdge({ id: ordinaryEdgeId, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 32 })

      const base = {
        canvasId: CONTRACT_CANVAS_ID,
        nodeBoxId: CONTRACT_BOX_ID,
        orderedMembershipEdgeIds: [CONTRACT_EDGE_ID],
        unorderedMembershipEdgeIds: [edgeB],
        updatedAtMs: 40,
      }
      await expect(repository.reorderCanvasNodeBoxMemberships({ ...base, unorderedMembershipEdgeIds: [] })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await expect(repository.reorderCanvasNodeBoxMemberships({ ...base, unorderedMembershipEdgeIds: [CONTRACT_EDGE_ID] })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await expect(repository.reorderCanvasNodeBoxMemberships({ ...base, unorderedMembershipEdgeIds: [ordinaryEdgeId] })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await expect(repository.reorderCanvasNodeBoxMemberships({ ...base, nodeBoxId: secondBoxId })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      await expect(repository.reorderCanvasNodeBoxMemberships({ ...base, canvasId: secondCanvasId })).rejects.toMatchObject({ code: 'NOT_FOUND' })
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual(expect.arrayContaining([
        expect.objectContaining({ id: CONTRACT_EDGE_ID, relationType: 'ordered_box_member', membershipPosition: 0, updatedAtMs: 30 }),
        expect.objectContaining({ id: edgeB, relationType: 'unordered_box_member', membershipPosition: 0, updatedAtMs: 31 }),
      ]))
    })

    test('enforces directed and symmetric duplicate semantics', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'A' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createTextNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'B' }, x: 3, y: 4, createdAtMs: 21 })
      const base = { canvasId: CONTRACT_CANVAS_ID, relationType: 'default' as const, lineStyle: 'solid' as const, createdAtMs: 30 }
      await repository.createCanvasEdge({ ...base, id: CONTRACT_EDGE_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, direction: 'forward' })
      await expect(repository.createCanvasEdge({ ...base, id: CONTRACT_REVERSE_EDGE_ID, sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_NODE_ID, direction: 'forward' })).resolves.toMatchObject({ id: CONTRACT_REVERSE_EDGE_ID })
      await expect(repository.createCanvasEdge({ ...base, id: '00000000-0000-4000-8000-000000000616', sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, direction: 'forward', lineStyle: 'dotted' })).rejects.toMatchObject({ code: 'DUPLICATE' })
      await repository.createCanvasEdge({ ...base, id: '00000000-0000-4000-8000-000000000617', sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, direction: 'none' })
      await expect(repository.createCanvasEdge({ ...base, id: '00000000-0000-4000-8000-000000000618', sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_NODE_ID, direction: 'none' })).rejects.toMatchObject({ code: 'DUPLICATE' })
      await expect(repository.createCanvasEdge({ ...base, id: '00000000-0000-4000-8000-000000000619', sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, direction: 'bidirectional' })).resolves.toMatchObject({ direction: 'bidirectional' })
      await expect(repository.createCanvasEdge({ ...base, id: '00000000-0000-4000-8000-000000000620', sourceNodeId: CONTRACT_TARGET_NODE_ID, targetNodeId: CONTRACT_NODE_ID, direction: 'bidirectional' })).rejects.toMatchObject({ code: 'DUPLICATE' })
    })
  })
}
