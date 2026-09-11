import { describe, expect, test, vi } from 'vitest'

import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
import type { CanvasClipboardSnapshot } from '@/canvas/clipboard'
import {
  CanvasRepositoryError,
  type CanvasRepository,
} from '@/canvas/repository'
import {
  CanvasApplicationError,
  createCanvasService,
} from '@/canvas/service'

const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const NODE_ID = '00000000-0000-4000-8000-000000000602'
const TARGET_NODE_ID = '00000000-0000-4000-8000-000000000603'
const EDGE_ID = '00000000-0000-4000-8000-000000000604'
const SECOND_BOX_ID = '00000000-0000-4000-8000-000000000605'
const SECOND_EDGE_ID = '00000000-0000-4000-8000-000000000606'

function fixture(): {
  repository: CanvasRepository
  canvas: Canvas
  node: CanvasNode
  createCanvasMock: ReturnType<typeof vi.fn>
  createTextNodeMock: ReturnType<typeof vi.fn>
  createCanvasEdgeMock: ReturnType<typeof vi.fn>
  addCanvasNodeBoxMemberMock: ReturnType<typeof vi.fn>
  reorderCanvasNodeBoxMembershipsMock: ReturnType<typeof vi.fn>
  updateCanvasEdgeDirectionMock: ReturnType<typeof vi.fn>
  updateCanvasEdgeLineStyleMock: ReturnType<typeof vi.fn>
  updateCanvasEdgeRelationTypeMock: ReturnType<typeof vi.fn>
  deleteCanvasEdgeMock: ReturnType<typeof vi.fn>
  deleteCanvasNodeMock: ReturnType<typeof vi.fn>
  moveCanvasNodesMock: ReturnType<typeof vi.fn>
  renameCanvasNodeMock: ReturnType<typeof vi.fn>
} {
  const canvas: Canvas = {
    id: CANVAS_ID,
    title: 'Canvas',
    viewport: { x: 0, y: 0, zoom: 1 },
    createdAtMs: 10,
    updatedAtMs: 10,
  }
  const node: CanvasNode = {
    id: NODE_ID,
    canvasId: CANVAS_ID,
    type: 'text',
    nodeName: '',
    content: { type: 'text', text: 'Text' },
    x: 20,
    y: 30,
    createdAtMs: 10,
    updatedAtMs: 10,
  }
  const createCanvasMock = vi.fn(() => Promise.resolve(canvas))
  const createTextNodeMock = vi.fn(() => Promise.resolve(node))
  const edge: CanvasEdge = {
    id: EDGE_ID,
    canvasId: CANVAS_ID,
    sourceNodeId: NODE_ID,
    targetNodeId: TARGET_NODE_ID,
    relationType: 'default',
    direction: 'forward',
    lineStyle: 'solid',
    membershipPosition: null,
    createdAtMs: 50,
    updatedAtMs: 50,
    deletedAtMs: null,
  }
  const createCanvasEdgeMock = vi.fn(() => Promise.resolve(edge))
  const addCanvasNodeBoxMemberMock = vi.fn(() => Promise.resolve({
    ...edge,
    relationType: 'ordered_box_member' as const,
    membershipPosition: 0,
  }))
  const reorderCanvasNodeBoxMembershipsMock = vi.fn(() => Promise.resolve([
    {
      ...edge,
      relationType: 'ordered_box_member' as const,
      membershipPosition: 0,
    },
  ]))
  const updateCanvasEdgeDirectionMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
  const updateCanvasEdgeLineStyleMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
  const updateCanvasEdgeRelationTypeMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
  const deleteCanvasEdgeMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
  const deleteCanvasNodeMock = vi.fn(() => Promise.resolve())
  const moveCanvasNodesMock = vi.fn(() => Promise.resolve([node]))
  const renameCanvasNodeMock = vi.fn((input) => Promise.resolve({ ...node, ...input }))
  return {
    canvas,
    node,
    repository: {
      createCanvas: createCanvasMock,
      listCanvases: vi.fn(() => Promise.resolve([canvas])),
      renameCanvas: vi.fn(() => Promise.resolve(canvas)),
      getCanvas: vi.fn(() => Promise.resolve(canvas)),
      updateCanvasViewport: vi.fn(() => Promise.resolve(canvas)),
      createCanvasNode: vi.fn(() => Promise.resolve(node)),
      createTextNode: createTextNodeMock,
      listCanvasNodes: vi.fn(() => Promise.resolve([node])),
      updateTextNode: vi.fn(() => Promise.resolve(node)),
      updateCanvasNodeContent: vi.fn(() => Promise.resolve(node)),
      renameCanvasNode: renameCanvasNodeMock,
      moveCanvasNode: vi.fn(() => Promise.resolve(node)),
      moveCanvasNodes: moveCanvasNodesMock,
      deleteCanvasNode: deleteCanvasNodeMock,
      createCanvasEdge: createCanvasEdgeMock,
      createCanvasSubgraph: vi.fn(() => Promise.resolve({ nodes: [], edges: [] })),
      addCanvasNodeBoxMember: addCanvasNodeBoxMemberMock,
      reorderCanvasNodeBoxMemberships: reorderCanvasNodeBoxMembershipsMock,
      listCanvasEdges: vi.fn(() => Promise.resolve([edge])),
      updateCanvasEdgeDirection: updateCanvasEdgeDirectionMock,
      updateCanvasEdgeLineStyle: updateCanvasEdgeLineStyleMock,
      updateCanvasEdgeRelationType: updateCanvasEdgeRelationTypeMock,
      deleteCanvasEdge: deleteCanvasEdgeMock,
    },
    createCanvasMock,
    createTextNodeMock,
    createCanvasEdgeMock,
    addCanvasNodeBoxMemberMock,
    reorderCanvasNodeBoxMembershipsMock,
    updateCanvasEdgeDirectionMock,
    updateCanvasEdgeLineStyleMock,
    updateCanvasEdgeRelationTypeMock,
    deleteCanvasEdgeMock,
    deleteCanvasNodeMock,
    moveCanvasNodesMock,
    renameCanvasNodeMock,
  }
}

describe('CanvasService', () => {
  test('owns IDs, timestamps, title trim, viewport, text, and movement inputs', async () => {
    const {
      repository,
      createCanvasMock,
      createTextNodeMock,
      createCanvasEdgeMock,
    } = fixture()
    const ids = [CANVAS_ID, NODE_ID, EDGE_ID]
    const service = createCanvasService({
      repository,
      generateId: () => ids.shift()!,
      nowMs: () => 50,
    })

    await service.createCanvas('  Plan  ')
    expect(createCanvasMock).toHaveBeenCalledWith({
      id: CANVAS_ID,
      title: 'Plan',
      viewport: { x: 0, y: 0, zoom: 1 },
      createdAtMs: 50,
    })
    await service.createTextNode(CANVAS_ID, 'Hello', { x: -5, y: 12 })
    expect(createTextNodeMock).toHaveBeenCalledWith({
      id: NODE_ID,
      canvasId: CANVAS_ID,
      content: { type: 'text', text: 'Hello' },
      x: -5,
      y: 12,
      createdAtMs: 50,
    })
    await service.updateViewport(CANVAS_ID, { x: 4, y: -8, zoom: 1.2 })
    await service.moveCanvasNode(NODE_ID, 80, 90)
    await service.editTextNode(NODE_ID, 'Updated')
    await service.createCanvasEdge(CANVAS_ID, NODE_ID, TARGET_NODE_ID)
    expect(createCanvasEdgeMock).toHaveBeenCalledWith({
      id: EDGE_ID,
      canvasId: CANVAS_ID,
      sourceNodeId: NODE_ID,
      targetNodeId: TARGET_NODE_ID,
      relationType: 'default',
      direction: 'forward',
      lineStyle: 'solid',
      createdAtMs: 50,
    })
  })

  test('loads a workspace from explicit get/list capabilities', async () => {
    const { repository, canvas, node } = fixture()
    const service = createCanvasService({ repository })
    await expect(service.openCanvas(CANVAS_ID)).resolves.toEqual({
      canvas,
      nodes: [node],
      edges: [expect.objectContaining({ id: EDGE_ID })],
    })
  })

  test('normalizes node names and enforces a 120 Unicode code point boundary', async () => {
    const { repository, renameCanvasNodeMock } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 75 })

    for (const name of ['', 'A', '中'.repeat(119), '中'.repeat(120), '😀'.repeat(120)]) {
      await expect(service.renameCanvasNode(CANVAS_ID, NODE_ID, `  ${name}  `)).resolves.toMatchObject({ nodeName: name })
    }
    expect(renameCanvasNodeMock).toHaveBeenLastCalledWith({
      canvasId: CANVAS_ID,
      id: NODE_ID,
      nodeName: '😀'.repeat(120),
      updatedAtMs: 75,
    })
    await expect(service.renameCanvasNode(CANVAS_ID, NODE_ID, '中'.repeat(121))).rejects.toMatchObject({ code: 'VALIDATION', field: 'nodeName' })
    await expect(service.renameCanvasNode(CANVAS_ID, NODE_ID, '😀'.repeat(121))).rejects.toMatchObject({ code: 'VALIDATION', field: 'nodeName' })
    await expect(service.renameCanvasNode(CANVAS_ID, NODE_ID, null as never)).rejects.toMatchObject({ code: 'VALIDATION', field: 'nodeName' })
  })

  test('maps node rename failures to safe application errors', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })
    repository.renameCanvasNode = vi.fn(() => Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'renameCanvasNode')))
    await expect(service.renameCanvasNode(CANVAS_ID, NODE_ID, 'Name')).rejects.toMatchObject({ code: 'NOT_FOUND', message: 'Canvas resource not found.' })
    repository.renameCanvasNode = vi.fn(() => Promise.reject(new Error('private SQL')))
    await expect(service.renameCanvasNode(CANVAS_ID, NODE_ID, 'Name')).rejects.toMatchObject({ code: 'UNAVAILABLE', message: 'Canvas service is unavailable.' })
  })

  test('validates and timestamps one atomic multi-node move operation', async () => {
    const { repository, moveCanvasNodesMock } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 75 })
    await service.moveCanvasNodes(CANVAS_ID, [
      { nodeId: NODE_ID, x: 10, y: 20 },
      { nodeId: TARGET_NODE_ID, x: 30, y: 40 },
    ])
    expect(moveCanvasNodesMock).toHaveBeenCalledWith({
      canvasId: CANVAS_ID,
      moves: [
        { nodeId: NODE_ID, x: 10, y: 20 },
        { nodeId: TARGET_NODE_ID, x: 30, y: 40 },
      ],
      updatedAtMs: 75,
    })
  })

  test('rejects empty, duplicate, invalid, and unavailable multi-node moves', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })
    await expect(service.moveCanvasNodes(CANVAS_ID, [])).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'position',
    })
    await expect(
      service.moveCanvasNodes(CANVAS_ID, [
        { nodeId: NODE_ID, x: 1, y: 2 },
        { nodeId: NODE_ID, x: 3, y: 4 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'id' })
    await expect(
      service.moveCanvasNodes(CANVAS_ID, [
        { nodeId: NODE_ID, x: Number.POSITIVE_INFINITY, y: 2 },
      ]),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'position' })
    repository.moveCanvasNodes = vi.fn(() =>
      Promise.reject(
        new CanvasRepositoryError('PERSISTENCE_FAILED', 'moveCanvasNodes'),
      ),
    )
    await expect(
      service.moveCanvasNodes(CANVAS_ID, [{ nodeId: NODE_ID, x: 1, y: 2 }]),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('rejects invalid title, viewport, content position, and IDs', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })
    await expect(service.createCanvas('   ')).rejects.toMatchObject({
      code: 'VALIDATION',
      field: 'title',
    })
    await expect(
      service.updateViewport(CANVAS_ID, { x: 0, y: 0, zoom: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'viewport' })
    await expect(
      service.createTextNode(CANVAS_ID, 'Text', { x: Number.NaN, y: 0 }),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'position' })
    await expect(service.openCanvas('bad')).rejects.toBeInstanceOf(
      CanvasApplicationError,
    )
  })

  test('maps missing and unknown persistence failures safely', async () => {
    const { repository } = fixture()
    repository.getCanvas = vi.fn(() =>
      Promise.reject(new CanvasRepositoryError('NOT_FOUND', 'getCanvas')),
    )
    const service = createCanvasService({ repository })
    await expect(service.openCanvas(CANVAS_ID)).rejects.toMatchObject({
      code: 'NOT_FOUND',
      message: 'Canvas resource not found.',
    })
    repository.listCanvases = vi.fn(() =>
      Promise.reject(new Error('private SQL')),
    )
    await expect(service.listCanvases()).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      message: 'Canvas service is unavailable.',
    })
  })

  test('validates Edge inputs and maps duplicate conflicts safely', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })
    await expect(
      service.createCanvasEdge(CANVAS_ID, NODE_ID, NODE_ID),
    ).rejects.toMatchObject({ code: 'VALIDATION', field: 'targetNodeId' })
    expect(() =>
      service.updateCanvasEdgeDirection(EDGE_ID, 'reverse' as never),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION', field: 'direction' }))
    expect(() =>
      service.updateCanvasEdgeLineStyle(EDGE_ID, 'animated' as never),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION', field: 'lineStyle' }))

    repository.createCanvasEdge = vi.fn(() =>
      Promise.reject(
        new CanvasRepositoryError('DUPLICATE', 'createCanvasEdge'),
      ),
    )
    await expect(
      service.createCanvasEdge(CANVAS_ID, NODE_ID, TARGET_NODE_ID),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
  })

  test('owns Edge direction, style, and soft-delete timestamps', async () => {
    const {
      repository,
      updateCanvasEdgeDirectionMock,
      updateCanvasEdgeLineStyleMock,
      deleteCanvasEdgeMock,
    } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 75 })
    await service.updateCanvasEdgeDirection(EDGE_ID, 'bidirectional')
    expect(updateCanvasEdgeDirectionMock).toHaveBeenCalledWith({
      id: EDGE_ID,
      direction: 'bidirectional',
      updatedAtMs: 75,
    })
    await service.updateCanvasEdgeLineStyle(EDGE_ID, 'dashed')
    expect(updateCanvasEdgeLineStyleMock).toHaveBeenCalledWith({
      id: EDGE_ID,
      lineStyle: 'dashed',
      updatedAtMs: 75,
    })
    await service.deleteCanvasEdge(EDGE_ID)
    expect(deleteCanvasEdgeMock).toHaveBeenCalledWith({
      id: EDGE_ID,
      deletedAtMs: 75,
      updatedAtMs: 75,
    })
  })

  test('uses registry defaults when semantic relation type changes', async () => {
    const { repository, updateCanvasEdgeRelationTypeMock } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 80 })

    await service.updateCanvasEdgeRelationType(EDGE_ID, 'hierarchy')
    expect(updateCanvasEdgeRelationTypeMock).toHaveBeenLastCalledWith({
      id: EDGE_ID,
      relationType: 'hierarchy',
      direction: 'forward',
      lineStyle: 'solid',
      updatedAtMs: 80,
    })
    await service.updateCanvasEdgeRelationType(EDGE_ID, 'peer')
    expect(updateCanvasEdgeRelationTypeMock).toHaveBeenLastCalledWith({
      id: EDGE_ID,
      relationType: 'peer',
      direction: 'none',
      lineStyle: 'solid',
      updatedAtMs: 80,
    })
    await service.updateCanvasEdgeRelationType(EDGE_ID, 'default')
    expect(updateCanvasEdgeRelationTypeMock).toHaveBeenLastCalledWith({
      id: EDGE_ID,
      relationType: 'default',
      direction: 'forward',
      lineStyle: 'solid',
      updatedAtMs: 80,
    })
  })

  test('maps semantic type conflicts and repository failures safely', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 80 })
    repository.updateCanvasEdgeRelationType = vi.fn(() =>
      Promise.reject(
        new CanvasRepositoryError('DUPLICATE', 'updateCanvasEdgeRelationType'),
      ),
    )
    await expect(
      service.updateCanvasEdgeRelationType(EDGE_ID, 'hierarchy'),
    ).rejects.toMatchObject({ code: 'CONFLICT' })
    repository.updateCanvasEdgeRelationType = vi.fn(() =>
      Promise.reject(new Error('private SQL')),
    )
    await expect(
      service.updateCanvasEdgeRelationType(EDGE_ID, 'peer'),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
    expect(() =>
      service.updateCanvasEdgeRelationType(
        EDGE_ID,
        'ordered_box_member' as never,
      ),
    ).toThrowError(
      expect.objectContaining({ code: 'VALIDATION', field: 'relationType' }),
    )
  })

  test('validates Node Box membership and delegates one narrow atomic capability', async () => {
    const { repository, node, addCanvasNodeBoxMemberMock } = fixture()
    const box: CanvasNode = {
      ...node,
      id: TARGET_NODE_ID,
      type: 'node_box',
      nodeName: 'Planning',
      content: { type: 'node_box' },
    }
    const secondBox: CanvasNode = { ...box, id: SECOND_BOX_ID }
    repository.listCanvasNodes = vi.fn(() => Promise.resolve([node, box, secondBox]))
    const service = createCanvasService({
      repository,
      generateId: () => EDGE_ID,
      nowMs: () => 90,
    })

    await service.addNodeBoxMember(
      CANVAS_ID,
      NODE_ID,
      TARGET_NODE_ID,
      'ordered_box_member',
    )
    expect(addCanvasNodeBoxMemberMock).toHaveBeenCalledWith({
      id: EDGE_ID,
      canvasId: CANVAS_ID,
      sourceNodeId: NODE_ID,
      targetNodeId: TARGET_NODE_ID,
      relationType: 'ordered_box_member',
      createdAtMs: 90,
    })
    await expect(
      service.addNodeBoxMember(
        CANVAS_ID,
        TARGET_NODE_ID,
        TARGET_NODE_ID,
        'ordered_box_member',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      service.addNodeBoxMember(
        CANVAS_ID,
        TARGET_NODE_ID,
        SECOND_BOX_ID,
        'unordered_box_member',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
    await expect(
      service.addNodeBoxMember(
        CANVAS_ID,
        TARGET_NODE_ID,
        NODE_ID,
        'unordered_box_member',
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION' })
  })

  test('validates and timestamps one complete Node Box membership reorder', async () => {
    const { repository, reorderCanvasNodeBoxMembershipsMock } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 95 })

    await service.reorderNodeBoxMemberships(
      CANVAS_ID,
      TARGET_NODE_ID,
      [SECOND_EDGE_ID, EDGE_ID],
      [],
    )
    expect(reorderCanvasNodeBoxMembershipsMock).toHaveBeenCalledWith({
      canvasId: CANVAS_ID,
      nodeBoxId: TARGET_NODE_ID,
      orderedMembershipEdgeIds: [SECOND_EDGE_ID, EDGE_ID],
      unorderedMembershipEdgeIds: [],
      updatedAtMs: 95,
    })
  })

  test('validates and timestamps the narrow Node soft-delete capability', async () => {
    const { repository, deleteCanvasNodeMock } = fixture()
    const service = createCanvasService({ repository, nowMs: () => 96 })

    await service.deleteCanvasNode(CANVAS_ID, NODE_ID)
    expect(deleteCanvasNodeMock).toHaveBeenCalledWith({
      canvasId: CANVAS_ID,
      id: NODE_ID,
      deletedAtMs: 96,
      updatedAtMs: 96,
    })
    await expect(service.deleteCanvasNode('bad', NODE_ID)).rejects.toEqual(
      expect.objectContaining({ code: 'VALIDATION', field: 'canvasId' }),
    )
    await expect(service.deleteCanvasNode(CANVAS_ID, 'bad')).rejects.toEqual(
      expect.objectContaining({ code: 'VALIDATION', field: 'id' }),
    )
  })

  test('rejects invalid or duplicate membership reorder IDs and maps repository failure', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })

    expect(() =>
      service.reorderNodeBoxMemberships(
        CANVAS_ID,
        TARGET_NODE_ID,
        [EDGE_ID],
        [EDGE_ID],
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION', field: 'id' }))
    expect(() =>
      service.reorderNodeBoxMemberships(
        CANVAS_ID,
        TARGET_NODE_ID,
        ['bad'],
        [],
      ),
    ).toThrowError(expect.objectContaining({ code: 'VALIDATION', field: 'id' }))
    repository.reorderCanvasNodeBoxMemberships = vi.fn(() =>
      Promise.reject(
        new CanvasRepositoryError(
          'PERSISTENCE_FAILED',
          'reorderCanvasNodeBoxMemberships',
        ),
      ),
    )
    await expect(
      service.reorderNodeBoxMemberships(
        CANVAS_ID,
        TARGET_NODE_ID,
        [EDGE_ID],
        [],
      ),
    ).rejects.toMatchObject({ code: 'UNAVAILABLE' })
  })

  test('pastes a subgraph atomically with new IDs and preserved edge semantics', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })
    const pastedNodeA = {
      id: '00000000-0000-4000-8000-000000000701',
      canvasId: CANVAS_ID,
      type: 'text' as const,
      nodeName: 'A',
      content: { type: 'text', text: 'A' },
      x: 32, y: 32,
      createdAtMs: 200, updatedAtMs: 200,
    }
    const pastedNodeB = {
      id: '00000000-0000-4000-8000-000000000702',
      canvasId: CANVAS_ID,
      type: 'sticky' as const,
      nodeName: 'B',
      content: { type: 'sticky', text: 'B' },
      x: 42, y: 42,
      createdAtMs: 201, updatedAtMs: 201,
    }
    const pastedEdge = {
      id: '00000000-0000-4000-8000-000000000703',
      canvasId: CANVAS_ID,
      sourceNodeId: pastedNodeA.id,
      targetNodeId: pastedNodeB.id,
      relationType: 'hierarchy' as const,
      direction: 'bidirectional' as const,
      lineStyle: 'dashed' as const,
      membershipPosition: null,
      createdAtMs: 202, updatedAtMs: 202, deletedAtMs: null,
    }
    repository.createCanvasSubgraph = vi.fn(() =>
      Promise.resolve({ nodes: [pastedNodeA, pastedNodeB] as CanvasNode[], edges: [pastedEdge] as CanvasEdge[] }),
    )
    const snapshot: CanvasClipboardSnapshot = {
      sourceCanvasId: CANVAS_ID,
      nodes: [
        { id: NODE_ID, type: 'text', nodeName: 'A', content: { type: 'text', text: 'A' }, x: 0, y: 0 },
        { id: TARGET_NODE_ID, type: 'sticky', nodeName: 'B', content: { type: 'sticky', text: 'B' }, x: 10, y: 10 },
      ],
      edges: [
        { id: EDGE_ID, sourceNodeId: NODE_ID, targetNodeId: TARGET_NODE_ID, relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed' },
      ],
      memberships: [],
    }
    const result = await service.pasteCanvasSubgraph(CANVAS_ID, snapshot, 32)
    expect(result.nodes).toHaveLength(2)
    expect(result.nodes[0]).toMatchObject({ type: 'text', nodeName: 'A', content: { type: 'text', text: 'A' }, x: 32, y: 32 })
    expect(result.nodes[1]).toMatchObject({ type: 'sticky', nodeName: 'B', content: { type: 'sticky', text: 'B' }, x: 42, y: 42 })
    expect(result.edges).toHaveLength(1)
    expect(result.edges[0]).toMatchObject({ relationType: 'hierarchy', direction: 'bidirectional', lineStyle: 'dashed' })
    expect(result.oldToNewNodeId.get(NODE_ID)).toBeDefined()
    expect(result.oldToNewNodeId.get(TARGET_NODE_ID)).toBeDefined()
    expect(result.oldToNewNodeId.get(NODE_ID)).not.toBe(NODE_ID)
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(repository.createCanvasSubgraph).toHaveBeenCalledOnce()
  })

  test('rejects paste across different canvases', async () => {
    const { repository } = fixture()
    const service = createCanvasService({ repository })
    const snapshot = {
      sourceCanvasId: '00000000-0000-4000-8000-000000009999',
      nodes: [],
      edges: [],
      memberships: [],
    }
    await expect(service.pasteCanvasSubgraph(CANVAS_ID, snapshot, 0)).rejects.toMatchObject({ code: 'CONFLICT', field: 'canvasId' })
  })

  describe('Slice 10B Node Box paste', () => {
    type SubgraphInput = Parameters<CanvasRepository['createCanvasSubgraph']>[0]
    const echoSubgraph = (repository: CanvasRepository) => {
      const mock = vi.fn((input: SubgraphInput) => {
        const nodes: CanvasNode[] = input.nodes.map((node) => ({
          ...node,
          updatedAtMs: node.createdAtMs,
        }) as CanvasNode)
        const edges: CanvasEdge[] = [
          ...input.edges.map((edge) => ({
            ...edge,
            membershipPosition: null,
            updatedAtMs: edge.createdAtMs,
            deletedAtMs: null,
          })),
          ...input.memberships.map((membership) => ({
            id: membership.id,
            canvasId: membership.canvasId,
            sourceNodeId: membership.sourceNodeId,
            targetNodeId: membership.targetNodeId,
            relationType: membership.relationType,
            direction: 'forward' as const,
            lineStyle: 'solid' as const,
            membershipPosition: membership.membershipPosition,
            createdAtMs: membership.createdAtMs,
            updatedAtMs: membership.createdAtMs,
            deletedAtMs: null,
          })),
        ]
        return Promise.resolve({ nodes, edges })
      })
      repository.createCanvasSubgraph = mock
      return mock
    }

    test('pastes an empty Node Box with an empty memberships batch', async () => {
      const { repository } = fixture()
      const service = createCanvasService({
        repository,
        nowMs: () => 200,
        generateId: () => '00000000-0000-4000-8000-000000000a01',
      })
      const createSubgraph = echoSubgraph(repository)
      const snapshot: CanvasClipboardSnapshot = {
        sourceCanvasId: CANVAS_ID,
        nodes: [
          { id: SECOND_BOX_ID, type: 'node_box', nodeName: '盒子', content: { type: 'node_box' }, x: 10, y: 20 },
        ],
        edges: [],
        memberships: [],
      }
      const result = await service.pasteCanvasSubgraph(CANVAS_ID, snapshot, 32)
      expect(result.nodes).toEqual([
        expect.objectContaining({ type: 'node_box', nodeName: '盒子', content: { type: 'node_box' }, x: 42, y: 52 }),
      ])
      expect(result.edges).toEqual([])
      const batch = createSubgraph.mock.calls[0]![0]
      expect(batch.memberships).toEqual([])
    })

    test('remaps memberships to new nodes and normalizes gapped positions to 0..N-1', async () => {
      const { repository } = fixture()
      const ids = [
        '00000000-0000-4000-8000-000000000a11', // new box
        '00000000-0000-4000-8000-000000000a12', // new member A
        '00000000-0000-4000-8000-000000000a13', // new member C
        '00000000-0000-4000-8000-000000000a14', // new membership A
        '00000000-0000-4000-8000-000000000a15', // new membership C
      ]
      const service = createCanvasService({
        repository,
        nowMs: () => 200,
        generateId: () => ids.shift()!,
      })
      const createSubgraph = echoSubgraph(repository)
      const boxId = '00000000-0000-4000-8000-000000000a21'
      const memberA = '00000000-0000-4000-8000-000000000a22'
      const memberC = '00000000-0000-4000-8000-000000000a23'
      const edgeA = '00000000-0000-4000-8000-000000000a24'
      const edgeC = '00000000-0000-4000-8000-000000000a25'
      const snapshot: CanvasClipboardSnapshot = {
        sourceCanvasId: CANVAS_ID,
        nodes: [
          { id: boxId, type: 'node_box', nodeName: '', content: { type: 'node_box' }, x: 0, y: 0 },
          { id: memberA, type: 'text', nodeName: 'A', content: { type: 'text', text: 'A' }, x: 10, y: 10 },
          { id: memberC, type: 'sticky', nodeName: 'C', content: { type: 'sticky', text: 'C' }, x: 20, y: 20 },
        ],
        edges: [],
        memberships: [
          { id: edgeA, sourceNodeId: memberA, targetNodeId: boxId, relationType: 'ordered_box_member', membershipPosition: 0 },
          { id: edgeC, sourceNodeId: memberC, targetNodeId: boxId, relationType: 'ordered_box_member', membershipPosition: 5 },
        ],
      }
      const result = await service.pasteCanvasSubgraph(CANVAS_ID, snapshot, 0)
      const batch = createSubgraph.mock.calls[0]![0]
      expect(batch.memberships).toHaveLength(2)
      expect(batch.memberships).toEqual([
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000a14',
          sourceNodeId: '00000000-0000-4000-8000-000000000a12',
          targetNodeId: '00000000-0000-4000-8000-000000000a11',
          relationType: 'ordered_box_member',
          membershipPosition: 0,
        }),
        expect.objectContaining({
          id: '00000000-0000-4000-8000-000000000a15',
          sourceNodeId: '00000000-0000-4000-8000-000000000a13',
          targetNodeId: '00000000-0000-4000-8000-000000000a11',
          membershipPosition: 1,
        }),
      ])
      // Membership endpoints never reference the original nodes.
      for (const membership of batch.memberships) {
        expect(membership.sourceNodeId).not.toBe(memberA)
        expect(membership.sourceNodeId).not.toBe(memberC)
        expect(membership.targetNodeId).not.toBe(boxId)
        expect(new Set(batch.nodes.map((node) => node.id)).has(membership.sourceNodeId)).toBe(true)
        expect(new Set(batch.nodes.map((node) => node.id)).has(membership.targetNodeId)).toBe(true)
      }
      expect(result.edges).toHaveLength(2)
      expect(result.edges.map((edge) => edge.membershipPosition).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([0, 1])
      expect(createSubgraph).toHaveBeenCalledOnce()
      // Source snapshot keeps its original gapped positions.
      expect(snapshot.memberships.map((membership) => membership.membershipPosition)).toEqual([0, 5])
    })

    test('normalizes membership positions independently for multiple target Boxes', async () => {
      const { repository } = fixture()
      const ids = [
        '00000000-0000-4000-8000-000000000a31', // box X
        '00000000-0000-4000-8000-000000000a32', // box Y
        '00000000-0000-4000-8000-000000000a33', // member A
        '00000000-0000-4000-8000-000000000a34', // membership A->X
        '00000000-0000-4000-8000-000000000a35', // membership A->Y
      ]
      const service = createCanvasService({
        repository,
        nowMs: () => 200,
        generateId: () => ids.shift()!,
      })
      const createSubgraph = echoSubgraph(repository)
      const boxX = '00000000-0000-4000-8000-000000000a41'
      const boxY = '00000000-0000-4000-8000-000000000a42'
      const memberA = '00000000-0000-4000-8000-000000000a43'
      const snapshot: CanvasClipboardSnapshot = {
        sourceCanvasId: CANVAS_ID,
        nodes: [
          { id: boxX, type: 'node_box', nodeName: 'X', content: { type: 'node_box' }, x: 0, y: 0 },
          { id: boxY, type: 'node_box', nodeName: 'Y', content: { type: 'node_box' }, x: 100, y: 0 },
          { id: memberA, type: 'text', nodeName: 'A', content: { type: 'text', text: 'A' }, x: 0, y: 100 },
        ],
        edges: [],
        memberships: [
          { id: '00000000-0000-4000-8000-000000000a44', sourceNodeId: memberA, targetNodeId: boxX, relationType: 'ordered_box_member', membershipPosition: 2 },
          { id: '00000000-0000-4000-8000-000000000a45', sourceNodeId: memberA, targetNodeId: boxY, relationType: 'ordered_box_member', membershipPosition: 4 },
        ],
      }
      await service.pasteCanvasSubgraph(CANVAS_ID, snapshot, 0)
      const batch = createSubgraph.mock.calls[0]![0]
      expect(batch.memberships).toEqual(expect.arrayContaining([
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000a34', targetNodeId: '00000000-0000-4000-8000-000000000a31', membershipPosition: 0 }),
        expect.objectContaining({ id: '00000000-0000-4000-8000-000000000a35', targetNodeId: '00000000-0000-4000-8000-000000000a32', membershipPosition: 0 }),
      ]))
    })
  })
})
