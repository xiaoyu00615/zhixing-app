import { describe, expect, test, vi } from 'vitest'

import type { Canvas, CanvasEdge, CanvasNode } from '@/canvas/model'
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

function fixture(): {
  repository: CanvasRepository
  canvas: Canvas
  node: CanvasNode
  createCanvasMock: ReturnType<typeof vi.fn>
  createTextNodeMock: ReturnType<typeof vi.fn>
  createCanvasEdgeMock: ReturnType<typeof vi.fn>
  updateCanvasEdgeDirectionMock: ReturnType<typeof vi.fn>
  updateCanvasEdgeLineStyleMock: ReturnType<typeof vi.fn>
  deleteCanvasEdgeMock: ReturnType<typeof vi.fn>
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
    createdAtMs: 50,
    updatedAtMs: 50,
    deletedAtMs: null,
  }
  const createCanvasEdgeMock = vi.fn(() => Promise.resolve(edge))
  const updateCanvasEdgeDirectionMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
  const updateCanvasEdgeLineStyleMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
  const deleteCanvasEdgeMock = vi.fn((input) =>
    Promise.resolve({ ...edge, ...input }),
  )
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
      createCanvasEdge: createCanvasEdgeMock,
      listCanvasEdges: vi.fn(() => Promise.resolve([edge])),
      updateCanvasEdgeDirection: updateCanvasEdgeDirectionMock,
      updateCanvasEdgeLineStyle: updateCanvasEdgeLineStyleMock,
      deleteCanvasEdge: deleteCanvasEdgeMock,
    },
    createCanvasMock,
    createTextNodeMock,
    createCanvasEdgeMock,
    updateCanvasEdgeDirectionMock,
    updateCanvasEdgeLineStyleMock,
    deleteCanvasEdgeMock,
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
})
