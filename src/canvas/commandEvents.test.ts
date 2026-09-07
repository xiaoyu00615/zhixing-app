import { afterEach, describe, expect, test, vi } from 'vitest'

import {
  subscribeCanvasCommandEvents,
  type CanvasCommandEvent,
} from '@/canvas/commandEvents'
import {
  executeCanvasEdgeCommand,
  executeCanvasNodeCommand,
} from '@/canvas/commandRegistry'
import type { CanvasEdge } from '@/canvas/model'
import type { CanvasService } from '@/canvas/service'

const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const EDGE_ID = '00000000-0000-4000-8000-000000000604'

const edge: CanvasEdge = {
  id: EDGE_ID,
  canvasId: CANVAS_ID,
  sourceNodeId: '00000000-0000-4000-8000-000000000602',
  targetNodeId: '00000000-0000-4000-8000-000000000603',
  relationType: 'default',
  direction: 'forward',
  lineStyle: 'solid',
  membershipPosition: null,
  createdAtMs: 10,
  updatedAtMs: 10,
  deletedAtMs: null,
}

const unsubscribers: (() => void)[] = []

afterEach(() => {
  while (unsubscribers.length > 0) unsubscribers.pop()?.()
  vi.restoreAllMocks()
})

function context(service: Partial<CanvasService>) {
  return {
    canvasId: CANVAS_ID,
    edges: [edge],
    service: service as CanvasService,
  }
}

function listen(): CanvasCommandEvent[] {
  const events: CanvasCommandEvent[] = []
  unsubscribers.push(subscribeCanvasCommandEvents((event) => events.push(event)))
  return events
}

describe('Canvas command events', () => {
  test('emits the successful command id and Edge target exactly once', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_000)
    const events = listen()
    const updateCanvasEdgeDirection = vi.fn(() => Promise.resolve({
      ...edge,
      direction: 'bidirectional' as const,
      updatedAtMs: 20,
    }))

    await executeCanvasEdgeCommand({
      id: 'update_edge_direction',
      edgeId: EDGE_ID,
      direction: 'bidirectional',
    }, context({ updateCanvasEdgeDirection }))

    expect(events).toEqual([{
      commandId: 'update_edge_direction',
      targetType: 'edge',
      targetId: EDGE_ID,
      timestamp: 1_000,
      result: 'success',
    }])
  })

  test('emits failure and preserves the original command rejection', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(2_000)
    const events = listen()
    const failure = new Error('persistence unavailable')
    const updateCanvasEdgeLineStyle = vi.fn(() => Promise.reject(failure))

    await expect(executeCanvasEdgeCommand({
      id: 'update_edge_line_style',
      edgeId: EDGE_ID,
      lineStyle: 'dashed',
    }, context({ updateCanvasEdgeLineStyle }))).rejects.toBe(failure)

    expect(events).toEqual([{
      commandId: 'update_edge_line_style',
      targetType: 'edge',
      targetId: EDGE_ID,
      timestamp: 2_000,
      result: 'failure',
    }])
  })

  test('emits canExecute failures without invoking persistence', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(3_000)
    const events = listen()
    const updateCanvasEdgeDirection = vi.fn()
    const membership = {
      ...edge,
      relationType: 'ordered_box_member' as const,
      membershipPosition: 0,
    }

    await expect(executeCanvasEdgeCommand({
      id: 'update_edge_direction',
      edgeId: EDGE_ID,
      direction: 'none',
    }, {
      canvasId: CANVAS_ID,
      edges: [membership],
      service: { updateCanvasEdgeDirection } as unknown as CanvasService,
    })).rejects.toThrow('cannot execute')

    expect(updateCanvasEdgeDirection).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({
      commandId: 'update_edge_direction',
      targetType: 'edge',
      targetId: EDGE_ID,
      timestamp: 3_000,
      result: 'failure',
    })])
  })

  test('keeps optional listener failures isolated from command success', async () => {
    const events = listen()
    unsubscribers.push(subscribeCanvasCommandEvents(() => {
      throw new Error('observer failed')
    }))
    const deleteCanvasEdge = vi.fn(() => Promise.resolve({
      ...edge,
      deletedAtMs: 20,
      updatedAtMs: 20,
    }))

    await expect(executeCanvasEdgeCommand({
      id: 'delete_edge',
      edgeId: EDGE_ID,
    }, context({ deleteCanvasEdge }))).resolves.toEqual(expect.objectContaining({
      removedEdgeId: EDGE_ID,
    }))
    expect(events).toHaveLength(1)
    expect(events[0]?.result).toBe('success')
  })

  test('emits Node command success and failure through the shared event layer', async () => {
    vi.spyOn(Date, 'now')
      .mockReturnValueOnce(4_000)
      .mockReturnValueOnce(5_000)
      .mockReturnValueOnce(6_000)
    const events = listen()
    const renameCanvasNode = vi.fn(() => Promise.resolve({
      id: edge.sourceNodeId,
      canvasId: CANVAS_ID,
      type: 'text' as const,
      nodeName: '新名称',
      content: { type: 'text' as const, text: 'Body' },
      x: 10,
      y: 20,
      createdAtMs: 10,
      updatedAtMs: 20,
    }))
    const failure = new Error('delete failed')
    const deleteCanvasNode = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(failure)
    const nodeContext = {
      canvasId: CANVAS_ID,
      node: { id: edge.sourceNodeId, type: 'text' as const },
      edges: [edge],
      service: { renameCanvasNode, deleteCanvasNode } as unknown as CanvasService,
    }

    await executeCanvasNodeCommand({
      id: 'rename_node',
      nodeId: edge.sourceNodeId,
      nodeName: '新名称',
    }, nodeContext)
    await executeCanvasNodeCommand({
      id: 'delete_node',
      nodeId: edge.sourceNodeId,
    }, nodeContext)
    await expect(executeCanvasNodeCommand({
      id: 'delete_node',
      nodeId: edge.sourceNodeId,
    }, nodeContext)).rejects.toBe(failure)

    expect(events).toEqual([
      {
        commandId: 'rename_node',
        targetType: 'node',
        targetId: edge.sourceNodeId,
        timestamp: 4_000,
        result: 'success',
      },
      {
        commandId: 'delete_node',
        targetType: 'node',
        targetId: edge.sourceNodeId,
        timestamp: 5_000,
        result: 'success',
      },
      {
        commandId: 'delete_node',
        targetType: 'node',
        targetId: edge.sourceNodeId,
        timestamp: 6_000,
        result: 'failure',
      },
    ])
  })
})
