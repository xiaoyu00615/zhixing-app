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
  type CreateCanvasSubgraphInput,
  type CreateTextNodeInput,
  type DeleteCanvasEdgeInput,
  type DeleteCanvasNodeInput,
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
  readonly deletedNodes = new Map<string, CanvasNode>()
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

  deleteCanvasNode(input: DeleteCanvasNodeInput): Promise<void> {
    const node = this.nodes.get(input.id)
    if (node === undefined || node.canvasId !== input.canvasId) {
      return Promise.reject(
        new CanvasRepositoryError('NOT_FOUND', 'deleteCanvasNode'),
      )
    }
    this.nodes.delete(input.id)
    this.deletedNodes.set(input.id, {
      ...node,
      updatedAtMs: input.updatedAtMs,
    })
    for (const edge of this.edges.values()) {
      if (
        edge.deletedAtMs === null &&
        edge.canvasId === input.canvasId &&
        (edge.sourceNodeId === input.id || edge.targetNodeId === input.id)
      ) {
        this.edges.set(edge.id, {
          ...edge,
          deletedAtMs: input.deletedAtMs,
          updatedAtMs: input.updatedAtMs,
        })
      }
    }
    return Promise.resolve()
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

  async createCanvasSubgraph(
    input: CreateCanvasSubgraphInput,
  ): Promise<{ readonly nodes: readonly CanvasNode[]; readonly edges: readonly CanvasEdge[] }> {
    await this.getCanvas(input.canvasId)
    const resultNodes: CanvasNode[] = []
    const resultEdges: CanvasEdge[] = []
    const rollBack = (): void => {
      for (const edge of resultEdges) this.edges.delete(edge.id)
      for (const node of resultNodes) this.nodes.delete(node.id)
    }
    for (const nodeInput of input.nodes) {
      if (nodeInput.canvasId !== input.canvasId) {
        throw new CanvasRepositoryError('NOT_FOUND', 'createCanvasSubgraph')
      }
      const node: CanvasNode = {
        ...nodeInput,
        type: nodeInput.type as CanvasNode['type'],
        updatedAtMs: nodeInput.createdAtMs,
      } as CanvasNode
      this.nodes.set(node.id, node)
      resultNodes.push(node)
    }
    const batchNodeIds = new Set(resultNodes.map((node) => node.id))
    for (const edgeInput of input.edges) {
      if (edgeInput.canvasId !== input.canvasId) {
        rollBack()
        throw new CanvasRepositoryError('NOT_FOUND', 'createCanvasSubgraph')
      }
      const source = this.nodes.get(edgeInput.sourceNodeId)
      const target = this.nodes.get(edgeInput.targetNodeId)
      if (source === undefined || target === undefined) {
        rollBack()
        throw new CanvasRepositoryError('NOT_FOUND', 'createCanvasSubgraph')
      }
      const edge: CanvasEdge = {
        ...edgeInput,
        membershipPosition: null,
        updatedAtMs: edgeInput.createdAtMs,
        deletedAtMs: null,
      }
      this.edges.set(edge.id, edge)
      resultEdges.push(edge)
    }
    const membershipPairs = new Set<string>()
    const membershipGroups = new Map<string, number[]>()
    for (const membershipInput of input.memberships) {
      if (membershipInput.canvasId !== input.canvasId) {
        rollBack()
        throw new CanvasRepositoryError('NOT_FOUND', 'createCanvasSubgraph')
      }
      if (
        !batchNodeIds.has(membershipInput.sourceNodeId) ||
        !batchNodeIds.has(membershipInput.targetNodeId)
      ) {
        rollBack()
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'createCanvasSubgraph')
      }
      const source = this.nodes.get(membershipInput.sourceNodeId)
      const target = this.nodes.get(membershipInput.targetNodeId)
      if (source === undefined || target === undefined) {
        rollBack()
        throw new CanvasRepositoryError('NOT_FOUND', 'createCanvasSubgraph')
      }
      if (source.type === 'node_box' || target.type !== 'node_box') {
        rollBack()
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'createCanvasSubgraph')
      }
      if (!Number.isSafeInteger(membershipInput.membershipPosition) || membershipInput.membershipPosition < 0) {
        rollBack()
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'createCanvasSubgraph')
      }
      const pairKey = `${membershipInput.sourceNodeId} ${membershipInput.targetNodeId}`
      if (membershipPairs.has(pairKey)) {
        rollBack()
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'createCanvasSubgraph')
      }
      membershipPairs.add(pairKey)
      const groupKey = `${membershipInput.targetNodeId}|${membershipInput.relationType}`
      const group = membershipGroups.get(groupKey)
      if (group === undefined) {
        membershipGroups.set(groupKey, [membershipInput.membershipPosition])
      } else {
        group.push(membershipInput.membershipPosition)
      }
    }
    for (const positions of membershipGroups.values()) {
      const sorted = [...positions].sort((left, right) => left - right)
      if (sorted.some((position, expected) => position !== expected)) {
        rollBack()
        throw new CanvasRepositoryError('PERSISTENCE_FAILED', 'createCanvasSubgraph')
      }
    }
    for (const membershipInput of input.memberships) {
      const edge: CanvasEdge = {
        id: membershipInput.id,
        canvasId: membershipInput.canvasId,
        sourceNodeId: membershipInput.sourceNodeId,
        targetNodeId: membershipInput.targetNodeId,
        relationType: membershipInput.relationType,
        direction: 'forward',
        lineStyle: 'solid',
        membershipPosition: membershipInput.membershipPosition,
        createdAtMs: membershipInput.createdAtMs,
        updatedAtMs: membershipInput.createdAtMs,
        deletedAtMs: null,
      }
      this.edges.set(edge.id, edge)
      resultEdges.push(edge)
    }
    return { nodes: resultNodes, edges: resultEdges }
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

    test('soft-deletes a node and every incident Edge while preserving other nodes', async () => {
      const { repository, backend } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      await repository.createTextNode({ id: CONTRACT_NODE_ID, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'Source' }, x: 1, y: 2, createdAtMs: 20 })
      await repository.createCanvasNode({ id: CONTRACT_TARGET_NODE_ID, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'Target' }, x: 3, y: 4, createdAtMs: 21 })
      await repository.createCanvasNode({ id: CONTRACT_BOX_ID, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 5, y: 6, createdAtMs: 22 })
      await repository.createCanvasEdge({ id: CONTRACT_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_TARGET_NODE_ID, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 30 })
      await repository.addCanvasNodeBoxMember({ id: CONTRACT_REVERSE_EDGE_ID, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: CONTRACT_NODE_ID, targetNodeId: CONTRACT_BOX_ID, relationType: 'ordered_box_member', createdAtMs: 31 })

      await repository.deleteCanvasNode({
        canvasId: CONTRACT_CANVAS_ID,
        id: CONTRACT_NODE_ID,
        deletedAtMs: 40,
        updatedAtMs: 40,
      })

      await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual([
        expect.objectContaining({ id: CONTRACT_TARGET_NODE_ID }),
        expect.objectContaining({ id: CONTRACT_BOX_ID }),
      ])
      await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual([])
      expect(backend.deletedNodes.get(CONTRACT_NODE_ID)).toMatchObject({
        id: CONTRACT_NODE_ID,
        updatedAtMs: 40,
      })
      expect(backend.edges.get(CONTRACT_EDGE_ID)).toMatchObject({ deletedAtMs: 40, updatedAtMs: 40 })
      expect(backend.edges.get(CONTRACT_REVERSE_EDGE_ID)).toMatchObject({ deletedAtMs: 40, updatedAtMs: 40 })
      await expect(repository.deleteCanvasNode({
        canvasId: CONTRACT_CANVAS_ID,
        id: CONTRACT_NODE_ID,
        deletedAtMs: 50,
        updatedAtMs: 50,
      })).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'deleteCanvasNode' })
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

    test('creates a subgraph atomically with new IDs and preserved edge semantics', async () => {
      const { repository } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      const aId = '00000000-0000-4000-8000-000000000701'
      const bId = '00000000-0000-4000-8000-000000000702'
      const edgeId = '00000000-0000-4000-8000-000000000703'
      await repository.createTextNode({ id: aId, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'A' }, x: 10, y: 10, createdAtMs: 20 })
      await repository.createCanvasNode({ id: bId, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', content: { type: 'sticky', text: 'B' }, x: 50, y: 50, createdAtMs: 21 })
      await repository.createCanvasEdge({ id: edgeId, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: aId, targetNodeId: bId, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed', createdAtMs: 30 })

      const batchIdA = '00000000-0000-4000-8000-000000000711'
      const batchIdB = '00000000-0000-4000-8000-000000000712'
      const batchEdgeId = '00000000-0000-4000-8000-000000000713'
      const result = await repository.createCanvasSubgraph({
        canvasId: CONTRACT_CANVAS_ID,
        nodes: [
          { id: batchIdA, canvasId: CONTRACT_CANVAS_ID, type: 'text', nodeName: '章节 A', content: { type: 'text', text: 'A' }, x: 10, y: 10, createdAtMs: 100 },
          { id: batchIdB, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', nodeName: '章节 B', content: { type: 'sticky', text: 'B' }, x: 50, y: 50, createdAtMs: 101 },
        ],
        edges: [
          { id: batchEdgeId, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: batchIdA, targetNodeId: batchIdB, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed', createdAtMs: 102 },
        ],
        memberships: [],
        createdAtMs: 100,
      })

      expect(result.nodes).toHaveLength(2)
      expect(result.nodes.map((n) => n.id)).toEqual([batchIdA, batchIdB])
      expect(result.nodes[0]).toMatchObject({ type: 'text', nodeName: '章节 A', content: { type: 'text', text: 'A' }, x: 10, y: 10 })
      expect(result.nodes[1]).toMatchObject({ type: 'sticky', nodeName: '章节 B', content: { type: 'sticky', text: 'B' }, x: 50, y: 50 })
      expect(result.edges).toHaveLength(1)
      expect(result.edges[0]).toMatchObject({ id: batchEdgeId, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed' })

      // Source records untouched.
      await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: aId }),
          expect.objectContaining({ id: bId }),
          expect.objectContaining({ id: batchIdA }),
          expect.objectContaining({ id: batchIdB }),
        ]),
      )
    })

    test('rolls back entire subgraph when an edge references a missing node', async () => {
      const { repository, backend } = createFixture()
      await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
      const goodNodeId = '00000000-0000-4000-8000-000000000721'
      const badNodeId = '00000000-0000-4000-8000-000000000722'
      await repository.createTextNode({ id: goodNodeId, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'Good' }, x: 0, y: 0, createdAtMs: 20 })

      const nodeA = '00000000-0000-4000-8000-000000000731'
      const nodeB = '00000000-0000-4000-8000-000000000732'
      const edgeAB = '00000000-0000-4000-8000-000000000733'
      await expect(repository.createCanvasSubgraph({
        canvasId: CONTRACT_CANVAS_ID,
        nodes: [
          { id: nodeA, canvasId: CONTRACT_CANVAS_ID, type: 'text', nodeName: 'A', content: { type: 'text', text: 'A' }, x: 0, y: 0, createdAtMs: 50 },
          { id: nodeB, canvasId: CONTRACT_CANVAS_ID, type: 'sticky', nodeName: 'B', content: { type: 'sticky', text: 'B' }, x: 10, y: 10, createdAtMs: 51 },
        ],
        edges: [
          { id: edgeAB, canvasId: CONTRACT_CANVAS_ID, sourceNodeId: nodeA, targetNodeId: badNodeId, relationType: 'default', direction: 'forward', lineStyle: 'solid', createdAtMs: 52 },
        ],
        memberships: [],
        createdAtMs: 50,
      })).rejects.toMatchObject({ code: 'NOT_FOUND', operation: 'createCanvasSubgraph' })

      // All rolled back: only the original node remains.
      await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual([
        expect.objectContaining({ id: goodNodeId }),
      ])
      expect(backend.nodes.get(nodeA)).toBeUndefined()
      expect(backend.nodes.get(nodeB)).toBeUndefined()
      expect(backend.edges.get(edgeAB)).toBeUndefined()
    })

    describe('Slice 10B Node Box membership subgraphs', () => {
      type SubgraphNode = CreateCanvasSubgraphInput['nodes'][number]
      type SubgraphEdge = CreateCanvasSubgraphInput['edges'][number]
      type SubgraphMembership = CreateCanvasSubgraphInput['memberships'][number]
      const textNode = (id: string, x = 0, y = 0): SubgraphNode => ({
        id, canvasId: CONTRACT_CANVAS_ID, type: 'text', nodeName: '',
        content: { type: 'text', text: id }, x, y, createdAtMs: 100,
      })
      const boxNode = (id: string, x = 0, y = 0): SubgraphNode => ({
        id, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', nodeName: '',
        content: { type: 'node_box' }, x, y, createdAtMs: 100,
      })
      const ordinaryEdge = (id: string, sourceNodeId: string, targetNodeId: string): SubgraphEdge => ({
        id, canvasId: CONTRACT_CANVAS_ID, sourceNodeId, targetNodeId,
        relationType: 'hierarchy', direction: 'forward', lineStyle: 'solid', createdAtMs: 200,
      })
      const membership = (
        id: string,
        sourceNodeId: string,
        targetNodeId: string,
        relationType: SubgraphMembership['relationType'],
        membershipPosition: number,
      ): SubgraphMembership => ({
        id, canvasId: CONTRACT_CANVAS_ID, sourceNodeId, targetNodeId,
        relationType, membershipPosition, createdAtMs: 200,
      })

      test('pastes an empty Node Box without memberships', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-000000000801'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId)],
          edges: [],
          memberships: [],
          createdAtMs: 100,
        })
        expect(result.nodes).toEqual([expect.objectContaining({ id: boxId, type: 'node_box' })])
        expect(result.edges).toEqual([])
      })

      test('pastes a Node Box with ordered members and canonical fields', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-000000000811'
        const memberA = '00000000-0000-4000-8000-000000000812'
        const memberB = '00000000-0000-4000-8000-000000000813'
        const edgeA = '00000000-0000-4000-8000-000000000814'
        const edgeB = '00000000-0000-4000-8000-000000000815'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberA), textNode(memberB)],
          edges: [],
          memberships: [
            membership(edgeA, memberA, boxId, 'ordered_box_member', 0),
            membership(edgeB, memberB, boxId, 'ordered_box_member', 1),
          ],
          createdAtMs: 100,
        })
        expect(result.edges).toHaveLength(2)
        expect(result.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: edgeA, relationType: 'ordered_box_member', direction: 'forward', lineStyle: 'solid', membershipPosition: 0 }),
          expect.objectContaining({ id: edgeB, relationType: 'ordered_box_member', membershipPosition: 1 }),
        ]))
      })

      test('pastes a Node Box with unordered members', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-000000000821'
        const memberA = '00000000-0000-4000-8000-000000000822'
        const edgeA = '00000000-0000-4000-8000-000000000823'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberA)],
          edges: [],
          memberships: [membership(edgeA, memberA, boxId, 'unordered_box_member', 0)],
          createdAtMs: 100,
        })
        expect(result.edges).toEqual([
          expect.objectContaining({ id: edgeA, relationType: 'unordered_box_member', membershipPosition: 0 }),
        ])
      })

      test('pastes mixed ordered and unordered sections in one batch', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-000000000831'
        const orderedId = '00000000-0000-4000-8000-000000000832'
        const unorderedId = '00000000-0000-4000-8000-000000000833'
        const orderedEdgeId = '00000000-0000-4000-8000-000000000834'
        const unorderedEdgeId = '00000000-0000-4000-8000-000000000835'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(orderedId), textNode(unorderedId)],
          edges: [],
          memberships: [
            membership(orderedEdgeId, orderedId, boxId, 'ordered_box_member', 0),
            membership(unorderedEdgeId, unorderedId, boxId, 'unordered_box_member', 0),
          ],
          createdAtMs: 100,
        })
        expect(result.edges).toHaveLength(2)
        expect(result.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: orderedEdgeId, relationType: 'ordered_box_member', membershipPosition: 0 }),
          expect.objectContaining({ id: unorderedEdgeId, relationType: 'unordered_box_member', membershipPosition: 0 }),
        ]))
      })

      test('keeps ordinary Edges to a Node Box alongside the membership', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-000000000841'
        const memberId = '00000000-0000-4000-8000-000000000842'
        const ordinaryEdgeId = '00000000-0000-4000-8000-000000000843'
        const membershipEdgeId = '00000000-0000-4000-8000-000000000844'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberId)],
          edges: [ordinaryEdge(ordinaryEdgeId, memberId, boxId)],
          memberships: [membership(membershipEdgeId, memberId, boxId, 'ordered_box_member', 0)],
          createdAtMs: 100,
        })
        expect(result.edges).toHaveLength(2)
        expect(result.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: ordinaryEdgeId, relationType: 'hierarchy' }),
          expect.objectContaining({ id: membershipEdgeId, relationType: 'ordered_box_member', membershipPosition: 0 }),
        ]))
      })

      test('normalizes membership positions independently for multiple Boxes', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxX = '00000000-0000-4000-8000-000000000851'
        const boxY = '00000000-0000-4000-8000-000000000852'
        const memberA = '00000000-0000-4000-8000-000000000853'
        const memberB = '00000000-0000-4000-8000-000000000854'
        const edgeA = '00000000-0000-4000-8000-000000000855'
        const edgeB = '00000000-0000-4000-8000-000000000856'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxX), boxNode(boxY), textNode(memberA), textNode(memberB)],
          edges: [],
          memberships: [
            membership(edgeA, memberA, boxX, 'ordered_box_member', 0),
            membership(edgeB, memberB, boxY, 'ordered_box_member', 0),
          ],
          createdAtMs: 100,
        })
        expect(result.edges).toEqual(expect.arrayContaining([
          expect.objectContaining({ id: edgeA, targetNodeId: boxX, membershipPosition: 0 }),
          expect.objectContaining({ id: edgeB, targetNodeId: boxY, membershipPosition: 0 }),
        ]))
      })

      test('allows one member to belong to two different Boxes', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxX = '00000000-0000-4000-8000-000000000861'
        const boxY = '00000000-0000-4000-8000-000000000862'
        const memberA = '00000000-0000-4000-8000-000000000863'
        const edgeX = '00000000-0000-4000-8000-000000000864'
        const edgeY = '00000000-0000-4000-8000-000000000865'
        const result = await repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxX), boxNode(boxY), textNode(memberA)],
          edges: [],
          memberships: [
            membership(edgeX, memberA, boxX, 'ordered_box_member', 0),
            membership(edgeY, memberA, boxY, 'ordered_box_member', 0),
          ],
          createdAtMs: 100,
        })
        expect(result.edges).toHaveLength(2)
      })

      test('rejects a membership whose target is not a Node Box', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const memberA = '00000000-0000-4000-8000-000000000871'
        const memberB = '00000000-0000-4000-8000-000000000872'
        const edgeId = '00000000-0000-4000-8000-000000000873'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [textNode(memberA), textNode(memberB)],
          edges: [],
          memberships: [membership(edgeId, memberA, memberB, 'ordered_box_member', 0)],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      })

      test('rejects Node Box nesting memberships', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxX = '00000000-0000-4000-8000-000000000881'
        const boxY = '00000000-0000-4000-8000-000000000882'
        const edgeId = '00000000-0000-4000-8000-000000000883'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxX), boxNode(boxY)],
          edges: [],
          memberships: [membership(edgeId, boxX, boxY, 'ordered_box_member', 0)],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      })

      test('rejects duplicate member+box memberships', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-000000000891'
        const memberId = '00000000-0000-4000-8000-000000000892'
        const edgeA = '00000000-0000-4000-8000-000000000893'
        const edgeB = '00000000-0000-4000-8000-000000000894'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberId)],
          edges: [],
          memberships: [
            membership(edgeA, memberId, boxId, 'ordered_box_member', 0),
            membership(edgeB, memberId, boxId, 'unordered_box_member', 0),
          ],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      })

      test('rejects duplicate membership positions within a Box section', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-0000000008a1'
        const memberA = '00000000-0000-4000-8000-0000000008a2'
        const memberB = '00000000-0000-4000-8000-0000000008a3'
        const edgeA = '00000000-0000-4000-8000-0000000008a4'
        const edgeB = '00000000-0000-4000-8000-0000000008a5'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberA), textNode(memberB)],
          edges: [],
          memberships: [
            membership(edgeA, memberA, boxId, 'ordered_box_member', 0),
            membership(edgeB, memberB, boxId, 'ordered_box_member', 0),
          ],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      })

      test('rejects non-contiguous batch membership positions', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const boxId = '00000000-0000-4000-8000-0000000008b1'
        const memberA = '00000000-0000-4000-8000-0000000008b2'
        const memberB = '00000000-0000-4000-8000-0000000008b3'
        const edgeA = '00000000-0000-4000-8000-0000000008b4'
        const edgeB = '00000000-0000-4000-8000-0000000008b5'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberA), textNode(memberB)],
          edges: [],
          memberships: [
            membership(edgeA, memberA, boxId, 'ordered_box_member', 0),
            membership(edgeB, memberB, boxId, 'ordered_box_member', 2),
          ],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
      })

      test('rejects memberships referencing nodes outside the batch', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const existingBox = '00000000-0000-4000-8000-0000000008c1'
        await repository.createCanvasNode({ id: existingBox, canvasId: CONTRACT_CANVAS_ID, type: 'node_box', content: { type: 'node_box' }, x: 0, y: 0, createdAtMs: 20 })
        const memberId = '00000000-0000-4000-8000-0000000008c2'
        const edgeId = '00000000-0000-4000-8000-0000000008c3'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [textNode(memberId)],
          edges: [],
          memberships: [membership(edgeId, memberId, existingBox, 'ordered_box_member', 0)],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
        await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual([])
      })

      test('rolls back all nodes and edges when a membership is invalid', async () => {
        const { repository } = createFixture()
        await repository.createCanvas({ id: CONTRACT_CANVAS_ID, title: 'Ideas', viewport: { x: 0, y: 0, zoom: 1 }, createdAtMs: 10 })
        const survivingId = '00000000-0000-4000-8000-0000000008d0'
        await repository.createTextNode({ id: survivingId, canvasId: CONTRACT_CANVAS_ID, content: { type: 'text', text: 'Keep' }, x: 0, y: 0, createdAtMs: 20 })
        const boxId = '00000000-0000-4000-8000-0000000008d1'
        const memberId = '00000000-0000-4000-8000-0000000008d2'
        const ordinaryEdgeId = '00000000-0000-4000-8000-0000000008d3'
        const membershipEdgeA = '00000000-0000-4000-8000-0000000008d4'
        const membershipEdgeB = '00000000-0000-4000-8000-0000000008d5'
        await expect(repository.createCanvasSubgraph({
          canvasId: CONTRACT_CANVAS_ID,
          nodes: [boxNode(boxId), textNode(memberId)],
          edges: [ordinaryEdge(ordinaryEdgeId, memberId, boxId)],
          memberships: [
            membership(membershipEdgeA, memberId, boxId, 'ordered_box_member', 0),
            membership(membershipEdgeB, memberId, boxId, 'unordered_box_member', 0),
          ],
          createdAtMs: 100,
        })).rejects.toMatchObject({ code: 'PERSISTENCE_FAILED' })
        await expect(repository.listCanvasNodes(CONTRACT_CANVAS_ID)).resolves.toEqual([
          expect.objectContaining({ id: survivingId }),
        ])
        await expect(repository.listCanvasEdges(CONTRACT_CANVAS_ID)).resolves.toEqual([])
      })
    })
  })
}
