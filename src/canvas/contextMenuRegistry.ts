import {
  isCanvasOrdinaryEdgeRelationType,
  type CanvasEdge,
  type CanvasEdgeDirection,
  type CanvasEdgeLineStyle,
  type CanvasOrdinaryEdgeRelationType,
} from '@/canvas/model'
import type { CanvasEdgeCommand } from '@/canvas/commandRegistry'
import type {
  CanvasNodeCommandId,
  CanvasNodeCommandTarget,
} from '@/canvas/commandRegistry'

export interface CanvasContextMenuTargetMap {
  readonly edge: { readonly edge: CanvasEdge }
}

export type CanvasContextMenuTarget = {
  [Type in keyof CanvasContextMenuTargetMap]: {
    readonly type: Type
  } & CanvasContextMenuTargetMap[Type]
}[keyof CanvasContextMenuTargetMap]

export interface CanvasContextMenuItem {
  readonly id: string
  readonly label: string
  readonly command: CanvasEdgeCommand
  readonly checked: boolean
  readonly enabled: boolean
  readonly destructive?: boolean
}

export interface CanvasContextMenuGroup {
  readonly label: string | null
  readonly items: readonly CanvasContextMenuItem[]
}

export interface CanvasContextMenuModel {
  readonly title: string
  readonly readOnly: boolean
  readonly groups: readonly CanvasContextMenuGroup[]
}

interface CanvasContextMenuDefinition {
  readonly targetType: keyof CanvasContextMenuTargetMap
  readonly matches: (target: CanvasContextMenuTarget) => boolean
  readonly createModel: (target: CanvasContextMenuTarget) => CanvasContextMenuModel
}

const RELATIONS: readonly [CanvasOrdinaryEdgeRelationType, string][] = [
  ['default', '普通关系'],
  ['hierarchy', '上下级'],
  ['peer', '同级'],
]

const DIRECTIONS: readonly [CanvasEdgeDirection, string][] = [
  ['forward', '单向'],
  ['bidirectional', '双向'],
  ['none', '无方向'],
]

const LINE_STYLES: readonly [CanvasEdgeLineStyle, string][] = [
  ['solid', '实线'],
  ['dashed', '虚线'],
  ['dotted', '点线'],
]

function ordinaryModel(edge: CanvasEdge): CanvasContextMenuModel {
  return {
    title: '连线设置',
    readOnly: false,
    groups: [
      {
        label: '关系类型',
        items: RELATIONS.map(([relationType, label]) => ({
          id: `relation-${relationType}`,
          label,
          command: {
            id: 'update_edge_relation_type',
            edgeId: edge.id,
            relationType,
          },
          checked: edge.relationType === relationType,
          enabled: true,
        })),
      },
      {
        label: '方向',
        items: DIRECTIONS.map(([direction, label]) => ({
          id: `direction-${direction}`,
          label,
          command: {
            id: 'update_edge_direction',
            edgeId: edge.id,
            direction,
          },
          checked: edge.direction === direction,
          enabled: true,
        })),
      },
      {
        label: '线型',
        items: LINE_STYLES.map(([lineStyle, label]) => ({
          id: `line-style-${lineStyle}`,
          label,
          command: {
            id: 'update_edge_line_style',
            edgeId: edge.id,
            lineStyle,
          },
          checked: edge.lineStyle === lineStyle,
          enabled: true,
        })),
      },
      {
        label: null,
        items: [
          {
            id: 'delete',
            label: '删除连线',
            command: { id: 'delete_edge', edgeId: edge.id },
            checked: false,
            enabled: true,
            destructive: true,
          },
        ],
      },
    ],
  }
}

function membershipModel(edge: CanvasEdge): CanvasContextMenuModel {
  const ordered = edge.relationType === 'ordered_box_member'
  return {
    title: ordered ? '有序成员' : '无序成员',
    readOnly: false,
    groups: [
      {
        label: null,
        items: [
          {
            id: ordered ? 'move-unordered' : 'move-ordered',
            label: ordered ? '移到无序成员区' : '移到有序成员区',
            command: {
              id: 'move_membership_section',
              edgeId: edge.id,
              section: ordered ? 'unordered' : 'ordered',
            },
            checked: false,
            enabled: true,
          },
        ],
      },
      {
        label: null,
        items: [
          {
            id: 'remove-membership',
            label: '从节点盒移除',
            command: { id: 'remove_membership', edgeId: edge.id },
            checked: false,
            enabled: true,
            destructive: true,
          },
        ],
      },
    ],
  }
}

const definitions = [
  {
    targetType: 'edge',
    matches: (target) =>
      target.type === 'edge' &&
      isCanvasOrdinaryEdgeRelationType(target.edge.relationType),
    createModel: (target) => ordinaryModel(target.edge),
  },
  {
    targetType: 'edge',
    matches: (target) =>
      target.type === 'edge' &&
      (target.edge.relationType === 'ordered_box_member' ||
        target.edge.relationType === 'unordered_box_member'),
    createModel: (target) => membershipModel(target.edge),
  },
  {
    targetType: 'edge',
    matches: (target) => target.type === 'edge',
    createModel: (target) => ({
      title: '未知关系',
      readOnly: true,
      groups: [
        {
          label: null,
          items: [
            {
              id: 'delete',
              label: '删除连线',
              command: { id: 'delete_edge', edgeId: target.edge.id },
              checked: false,
              enabled: true,
              destructive: true,
            },
          ],
        },
      ],
    }),
  },
] as const satisfies readonly CanvasContextMenuDefinition[]

export interface CanvasNodeContextMenuModel {
  readonly nodeId: string
  readonly nodeName: string
  readonly title: string
  readonly readOnly: boolean
  readonly commands: readonly CanvasNodeCommandId[]
}

interface CanvasNodeContextMenuDefinition {
  readonly type: CanvasNodeCommandTarget['type']
  readonly title: string
  readonly commands: readonly CanvasNodeCommandId[]
}

const nodeDefinitions: readonly CanvasNodeContextMenuDefinition[] = [
  {
    type: 'text',
    title: '文字节点',
    commands: ['rename_node', 'delete_node'],
  },
  {
    type: 'sticky',
    title: '便签节点',
    commands: ['rename_node', 'delete_node'],
  },
  {
    type: 'node_box',
    title: '节点盒',
    commands: ['rename_node', 'delete_node'],
  },
  {
    type: 'unknown',
    title: '未知节点',
    commands: [],
  },
]

export const canvasContextMenuRegistry = {
  definitions,
  nodeDefinitions,
} as const

export function createCanvasContextMenuModel(
  target: CanvasContextMenuTarget,
): CanvasContextMenuModel {
  const definition = canvasContextMenuRegistry.definitions.find(
    (candidate) =>
      candidate.targetType === target.type && candidate.matches(target),
  )
  return definition?.createModel(target) ?? {
    title: '不可用',
    readOnly: true,
    groups: [],
  }
}

export function createCanvasNodeContextMenuModel(
  target: CanvasNodeCommandTarget & { readonly nodeName: string },
): CanvasNodeContextMenuModel {
  const definition = canvasContextMenuRegistry.nodeDefinitions.find(
    (candidate) => candidate.type === target.type,
  )
  return {
    nodeId: target.id,
    nodeName: target.nodeName,
    title: definition?.title ?? '未知节点',
    readOnly: definition === undefined || definition.commands.length === 0,
    commands: definition?.commands ?? [],
  }
}
