import { describe, expect, test, vi } from 'vitest'

import {
  canvasCommandRegistry,
  executeCanvasEdgeCommand,
  executeCanvasNodeCommand,
  type CanvasEdgeCommand,
} from '@/canvas/commandRegistry'
import type { CanvasEdge, CanvasNode } from '@/canvas/model'
import type { CanvasService } from '@/canvas/service'

const CANVAS_ID = '00000000-0000-4000-8000-000000000601'
const EDGE_A = '00000000-0000-4000-8000-000000000604'
const EDGE_B = '00000000-0000-4000-8000-000000000605'
const BOX_ID = '00000000-0000-4000-8000-000000000606'
const NODE_ID = '00000000-0000-4000-8000-000000000602'

function edge(
  id: string,
  relationType: CanvasEdge['relationType'] = 'default',
  membershipPosition: number | null = null,
): CanvasEdge {
  return {
    id,
    canvasId: CANVAS_ID,
    sourceNodeId: '00000000-0000-4000-8000-000000000602',
    targetNodeId: relationType === 'ordered_box_member' ||
      relationType === 'unordered_box_member'
      ? BOX_ID
      : '00000000-0000-4000-8000-000000000603',
    relationType,
    direction: 'forward',
    lineStyle: 'solid',
    membershipPosition,
    createdAtMs: 10,
    updatedAtMs: 10,
    deletedAtMs: null,
  }
}

function serviceFixture() {
  const updateCanvasEdgeRelationType = vi.fn<CanvasService['updateCanvasEdgeRelationType']>(
    (id, relationType) => Promise.resolve({ ...edge(id), relationType }),
  )
  const updateCanvasEdgeDirection = vi.fn<CanvasService['updateCanvasEdgeDirection']>(
    (id, direction) => Promise.resolve({ ...edge(id), direction }),
  )
  const updateCanvasEdgeLineStyle = vi.fn<CanvasService['updateCanvasEdgeLineStyle']>(
    (id, lineStyle) => Promise.resolve({ ...edge(id), lineStyle }),
  )
  const deleteCanvasEdge = vi.fn<CanvasService['deleteCanvasEdge']>(
    (id) => Promise.resolve({ ...edge(id), deletedAtMs: 20, updatedAtMs: 20 }),
  )
  const reorderNodeBoxMemberships = vi.fn<CanvasService['reorderNodeBoxMemberships']>(
    (_canvasId, _boxId, orderedIds, unorderedIds) => Promise.resolve([
      ...orderedIds.map((id, membershipPosition) => ({
        ...edge(id, 'ordered_box_member', membershipPosition),
        updatedAtMs: 20,
      })),
      ...unorderedIds.map((id, membershipPosition) => ({
        ...edge(id, 'unordered_box_member', membershipPosition),
        updatedAtMs: 20,
      })),
    ]),
  )
  const renameCanvasNode = vi.fn<CanvasService['renameCanvasNode']>(
    (_canvasId, id, nodeName) => Promise.resolve({
      id,
      canvasId: CANVAS_ID,
      type: 'text',
      nodeName,
      content: { type: 'text', text: 'Body' },
      x: 10,
      y: 20,
      createdAtMs: 10,
      updatedAtMs: 20,
    }),
  )
  const deleteCanvasNode = vi.fn<CanvasService['deleteCanvasNode']>(() =>
    Promise.resolve(),
  )
  const service = {
    updateCanvasEdgeRelationType,
    updateCanvasEdgeDirection,
    updateCanvasEdgeLineStyle,
    deleteCanvasEdge,
    reorderNodeBoxMemberships,
    renameCanvasNode,
    deleteCanvasNode,
  } as unknown as CanvasService
  return {
    service,
    updateCanvasEdgeRelationType,
    updateCanvasEdgeDirection,
    updateCanvasEdgeLineStyle,
    deleteCanvasEdge,
    reorderNodeBoxMemberships,
    renameCanvasNode,
    deleteCanvasNode,
  }
}

describe('canvasCommandRegistry', () => {
  test('registers Edge and Node commands in one registry', () => {
    expect(canvasCommandRegistry.definitions.map(({ id }) => id)).toEqual([
      'update_edge_relation_type',
      'update_edge_direction',
      'update_edge_line_style',
      'delete_edge',
      'move_membership_section',
      'remove_membership',
      'rename_node',
      'delete_node',
    ])
    expect(canvasCommandRegistry.lookup('update_edge_direction')?.id).toBe(
      'update_edge_direction',
    )
    expect(canvasCommandRegistry.lookup('unknown_command')).toBeUndefined()
  })

  test.each(['text', 'sticky', 'node_box'] as const)(
    'executes rename and soft delete for a known %s node',
    async (type) => {
      const fixture = serviceFixture()
      const node: CanvasNode = type === 'text'
        ? {
            id: NODE_ID,
            canvasId: CANVAS_ID,
            type,
            nodeName: 'Old',
            content: { type, text: 'Body' },
            x: 10,
            y: 20,
            createdAtMs: 10,
            updatedAtMs: 10,
          }
        : type === 'sticky'
          ? {
              id: NODE_ID,
              canvasId: CANVAS_ID,
              type,
              nodeName: 'Old',
              content: { type, text: 'Body' },
              x: 10,
              y: 20,
              createdAtMs: 10,
              updatedAtMs: 10,
            }
          : {
              id: NODE_ID,
              canvasId: CANVAS_ID,
              type,
              nodeName: 'Old',
              content: { type },
              x: 10,
              y: 20,
              createdAtMs: 10,
              updatedAtMs: 10,
            }
      const relatedEdge = edge(EDGE_A)
      const context = {
        canvasId: CANVAS_ID,
        node: { id: node.id, type: node.type },
        edges: [relatedEdge],
        service: fixture.service,
      }

      const renamed = await executeCanvasNodeCommand({
        id: 'rename_node',
        nodeId: NODE_ID,
        nodeName: 'New',
      }, context)
      expect(renamed.updatedNode).toMatchObject({ id: NODE_ID, nodeName: 'New' })
      expect(fixture.renameCanvasNode).toHaveBeenCalledWith(CANVAS_ID, NODE_ID, 'New')

      const deleted = await executeCanvasNodeCommand({
        id: 'delete_node',
        nodeId: NODE_ID,
      }, context)
      expect(fixture.deleteCanvasNode).toHaveBeenCalledWith(CANVAS_ID, NODE_ID)
      expect(deleted).toMatchObject({
        removedNodeId: NODE_ID,
        removedEdgeIds: [EDGE_A],
      })
    },
  )

  test('rejects every mutation for an unknown node', async () => {
    const fixture = serviceFixture()
    const context = {
      canvasId: CANVAS_ID,
      node: { id: NODE_ID, type: 'unknown' as const },
      edges: [],
      service: fixture.service,
    }
    await expect(executeCanvasNodeCommand({
      id: 'rename_node',
      nodeId: NODE_ID,
      nodeName: 'New',
    }, context)).rejects.toThrow('cannot execute')
    await expect(executeCanvasNodeCommand({
      id: 'delete_node',
      nodeId: NODE_ID,
    }, context)).rejects.toThrow('cannot execute')
    expect(fixture.renameCanvasNode).not.toHaveBeenCalled()
    expect(fixture.deleteCanvasNode).not.toHaveBeenCalled()
  })

  test('executes ordinary Edge settings and delete through service capabilities', async () => {
    const fixture = serviceFixture()
    const ordinary = edge(EDGE_A)
    const context = { canvasId: CANVAS_ID, edges: [ordinary], service: fixture.service }

    await executeCanvasEdgeCommand({
      id: 'update_edge_relation_type',
      edgeId: EDGE_A,
      relationType: 'hierarchy',
    }, context)
    await executeCanvasEdgeCommand({
      id: 'update_edge_direction',
      edgeId: EDGE_A,
      direction: 'bidirectional',
    }, context)
    await executeCanvasEdgeCommand({
      id: 'update_edge_line_style',
      edgeId: EDGE_A,
      lineStyle: 'dashed',
    }, context)
    const deleted = await executeCanvasEdgeCommand({
      id: 'delete_edge',
      edgeId: EDGE_A,
    }, context)

    expect(fixture.updateCanvasEdgeRelationType).toHaveBeenCalledWith(EDGE_A, 'hierarchy')
    expect(fixture.updateCanvasEdgeDirection).toHaveBeenCalledWith(EDGE_A, 'bidirectional')
    expect(fixture.updateCanvasEdgeLineStyle).toHaveBeenCalledWith(EDGE_A, 'dashed')
    expect(fixture.deleteCanvasEdge).toHaveBeenCalledWith(EDGE_A)
    expect(deleted.removedEdgeId).toBe(EDGE_A)
  })

  test('moves memberships between sections by appending through one reorder capability', async () => {
    const fixture = serviceFixture()
    const ordered = edge(EDGE_A, 'ordered_box_member', 0)
    const unordered = edge(EDGE_B, 'unordered_box_member', 0)
    const context = {
      canvasId: CANVAS_ID,
      edges: [ordered, unordered],
      service: fixture.service,
    }

    const movedToUnordered = await executeCanvasEdgeCommand({
      id: 'move_membership_section',
      edgeId: EDGE_A,
      section: 'unordered',
    }, context)
    expect(fixture.reorderNodeBoxMemberships).toHaveBeenLastCalledWith(
      CANVAS_ID,
      BOX_ID,
      [],
      [EDGE_B, EDGE_A],
    )
    expect(movedToUnordered.updatedEdges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: EDGE_A,
        relationType: 'unordered_box_member',
        membershipPosition: 1,
        createdAtMs: 10,
      }),
    ]))

    await executeCanvasEdgeCommand({
      id: 'move_membership_section',
      edgeId: EDGE_B,
      section: 'ordered',
    }, { ...context, edges: movedToUnordered.updatedEdges })
    expect(fixture.reorderNodeBoxMemberships).toHaveBeenLastCalledWith(
      CANVAS_ID,
      BOX_ID,
      [EDGE_B],
      [EDGE_A],
    )
  })

  test('removes only the Membership Edge and rejects incompatible commands', async () => {
    const fixture = serviceFixture()
    const membership = edge(EDGE_A, 'ordered_box_member', 0)
    const context = {
      canvasId: CANVAS_ID,
      edges: [membership],
      service: fixture.service,
    }
    const removed = await executeCanvasEdgeCommand({
      id: 'remove_membership',
      edgeId: EDGE_A,
    }, context)
    expect(removed.removedEdgeId).toBe(EDGE_A)
    expect(fixture.deleteCanvasEdge).toHaveBeenCalledWith(EDGE_A)
    await expect(executeCanvasEdgeCommand({
      id: 'update_edge_direction',
      edgeId: EDGE_A,
      direction: 'none',
    }, context)).rejects.toThrow('cannot execute')
  })

  test('allows deleting an unknown Edge but rejects semantic mutations and unknown commands', async () => {
    const fixture = serviceFixture()
    const unknown = edge(EDGE_A, 'future_relation' as CanvasEdge['relationType'])
    const context = {
      canvasId: CANVAS_ID,
      edges: [unknown],
      service: fixture.service,
    }

    await expect(executeCanvasEdgeCommand({
      id: 'update_edge_relation_type',
      edgeId: EDGE_A,
      relationType: 'default',
    }, context)).rejects.toThrow('cannot execute')
    await expect(executeCanvasEdgeCommand({
      id: 'update_edge_direction',
      edgeId: EDGE_A,
      direction: 'none',
    }, context)).rejects.toThrow('cannot execute')
    await expect(executeCanvasEdgeCommand({
      id: 'update_edge_line_style',
      edgeId: EDGE_A,
      lineStyle: 'dotted',
    }, context)).rejects.toThrow('cannot execute')
    const deleted = await executeCanvasEdgeCommand({
      id: 'delete_edge',
      edgeId: EDGE_A,
    }, context)
    expect(deleted.removedEdgeId).toBe(EDGE_A)
    expect(fixture.deleteCanvasEdge).toHaveBeenCalledWith(EDGE_A)
    expect(fixture.updateCanvasEdgeRelationType).not.toHaveBeenCalled()
    expect(fixture.updateCanvasEdgeDirection).not.toHaveBeenCalled()
    expect(fixture.updateCanvasEdgeLineStyle).not.toHaveBeenCalled()

    await expect(executeCanvasEdgeCommand({
      id: 'unknown_command',
      edgeId: EDGE_A,
    } as unknown as CanvasEdgeCommand, context)).rejects.toThrow('cannot execute')
  })
})
