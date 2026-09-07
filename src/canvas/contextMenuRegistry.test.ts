import { describe, expect, test } from 'vitest'

import {
  createCanvasContextMenuModel,
  createCanvasNodeContextMenuModel,
} from '@/canvas/contextMenuRegistry'
import type { CanvasEdge } from '@/canvas/model'

const edge: CanvasEdge = {
  id: '00000000-0000-4000-8000-000000000604',
  canvasId: '00000000-0000-4000-8000-000000000601',
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

describe('canvasContextMenuRegistry', () => {
  test('builds grouped ordinary Edge actions with current values', () => {
    const model = createCanvasContextMenuModel({ type: 'edge', edge })
    expect(model.title).toBe('连线设置')
    expect(model.groups.map((group) => group.label)).toEqual([
      '关系类型',
      '方向',
      '线型',
      null,
    ])
    expect(model.groups.flatMap((group) => group.items).filter((item) => item.checked).map((item) => item.label)).toEqual([
      '普通关系',
      '单向',
      '实线',
    ])
  })

  test('builds narrow ordered and unordered Membership menus', () => {
    const ordered = createCanvasContextMenuModel({
      type: 'edge',
      edge: { ...edge, relationType: 'ordered_box_member', membershipPosition: 0 },
    })
    expect(ordered.title).toBe('有序成员')
    expect(ordered.groups.flatMap((group) => group.items).map((item) => item.label)).toEqual([
      '移到无序成员区',
      '从节点盒移除',
    ])
    const unordered = createCanvasContextMenuModel({
      type: 'edge',
      edge: { ...edge, relationType: 'unordered_box_member', membershipPosition: 0 },
    })
    expect(unordered.title).toBe('无序成员')
    expect(unordered.groups.flatMap((group) => group.items).map((item) => item.label)).toEqual([
      '移到有序成员区',
      '从节点盒移除',
    ])
  })

  test('keeps unknown Edge semantics read-only and exposes only delete', () => {
    const model = createCanvasContextMenuModel({
      type: 'edge',
      edge: {
        ...edge,
        relationType: 'future_relation' as CanvasEdge['relationType'],
        direction: 'bidirectional',
        lineStyle: 'dotted',
      },
    })
    expect(model.title).toBe('未知关系')
    expect(model.readOnly).toBe(true)
    expect(model.groups.flatMap((group) => group.items)).toEqual([
      expect.objectContaining({
        label: '删除连线',
        command: { id: 'delete_edge', edgeId: edge.id },
      }),
    ])
  })

  test.each([
    ['text', '文字节点'],
    ['sticky', '便签节点'],
    ['node_box', '节点盒'],
  ] as const)('exposes the narrow rename/delete menu for %s nodes', (type, title) => {
    expect(createCanvasNodeContextMenuModel({
      id: edge.sourceNodeId,
      type,
      nodeName: '节点名称',
    })).toEqual({
      nodeId: edge.sourceNodeId,
      nodeName: '节点名称',
      title,
      readOnly: false,
      commands: ['rename_node', 'delete_node'],
    })
  })

  test('keeps unknown Node semantics read-only without mutation commands', () => {
    expect(createCanvasNodeContextMenuModel({
      id: edge.sourceNodeId,
      type: 'unknown',
      nodeName: '未来节点',
    })).toEqual({
      nodeId: edge.sourceNodeId,
      nodeName: '未来节点',
      title: '未知节点',
      readOnly: true,
      commands: [],
    })
  })
})
