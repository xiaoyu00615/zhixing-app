import { describe, expect, test, vi } from 'vitest'

import type { Canvas, CanvasNode } from '@/canvas/model'
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

function fixture(): {
  repository: CanvasRepository
  canvas: Canvas
  node: CanvasNode
  createCanvasMock: ReturnType<typeof vi.fn>
  createTextNodeMock: ReturnType<typeof vi.fn>
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
    content: { type: 'text', text: 'Text' },
    x: 20,
    y: 30,
    createdAtMs: 10,
    updatedAtMs: 10,
  }
  const createCanvasMock = vi.fn(() => Promise.resolve(canvas))
  const createTextNodeMock = vi.fn(() => Promise.resolve(node))
  return {
    canvas,
    node,
    repository: {
      createCanvas: createCanvasMock,
      listCanvases: vi.fn(() => Promise.resolve([canvas])),
      renameCanvas: vi.fn(() => Promise.resolve(canvas)),
      getCanvas: vi.fn(() => Promise.resolve(canvas)),
      updateCanvasViewport: vi.fn(() => Promise.resolve(canvas)),
      createTextNode: createTextNodeMock,
      listCanvasNodes: vi.fn(() => Promise.resolve([node])),
      updateTextNode: vi.fn(() => Promise.resolve(node)),
      moveCanvasNode: vi.fn(() => Promise.resolve(node)),
    },
    createCanvasMock,
    createTextNodeMock,
  }
}

describe('CanvasService', () => {
  test('owns IDs, timestamps, title trim, viewport, text, and movement inputs', async () => {
    const { repository, createCanvasMock, createTextNodeMock } = fixture()
    const ids = [CANVAS_ID, NODE_ID]
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
  })

  test('loads a workspace from explicit get/list capabilities', async () => {
    const { repository, canvas, node } = fixture()
    const service = createCanvasService({ repository })
    await expect(service.openCanvas(CANVAS_ID)).resolves.toEqual({
      canvas,
      nodes: [node],
    })
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
})
