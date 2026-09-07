import {
  isCanvasMembershipRelationType,
  isCanvasOrdinaryEdgeRelationType,
  type CanvasEdge,
  type CanvasEdgeDirection,
  type CanvasEdgeLineStyle,
  type CanvasNode,
  type CanvasOrdinaryEdgeRelationType,
  type RegisteredCanvasNodeType,
} from '@/canvas/model'
import { emitCanvasCommandEvent } from '@/canvas/commandEvents'
import type { CanvasService } from '@/canvas/service'

export type CanvasEdgeCommand =
  | {
      readonly id: 'update_edge_relation_type'
      readonly edgeId: string
      readonly relationType: CanvasOrdinaryEdgeRelationType
    }
  | {
      readonly id: 'update_edge_direction'
      readonly edgeId: string
      readonly direction: CanvasEdgeDirection
    }
  | {
      readonly id: 'update_edge_line_style'
      readonly edgeId: string
      readonly lineStyle: CanvasEdgeLineStyle
    }
  | { readonly id: 'delete_edge'; readonly edgeId: string }
  | {
      readonly id: 'move_membership_section'
      readonly edgeId: string
      readonly section: 'ordered' | 'unordered'
    }
  | { readonly id: 'remove_membership'; readonly edgeId: string }

export type CanvasEdgeCommandId = CanvasEdgeCommand['id']

export type CanvasNodeCommand =
  | {
      readonly id: 'rename_node'
      readonly nodeId: string
      readonly nodeName: string
    }
  | { readonly id: 'delete_node'; readonly nodeId: string }

export type CanvasNodeCommandId = CanvasNodeCommand['id']
export type CanvasCommand = CanvasEdgeCommand | CanvasNodeCommand

export interface CanvasNodeCommandTarget {
  readonly id: string
  readonly type: RegisteredCanvasNodeType | 'unknown'
}

export interface CanvasEdgeCommandContext {
  readonly canvasId: string
  readonly edges: readonly CanvasEdge[]
  readonly service: CanvasService
}

export interface CanvasEdgeCommandResult {
  readonly updatedEdges: readonly CanvasEdge[]
  readonly removedEdgeId: string | null
  readonly feedback: string
}

export interface CanvasEdgeCommandDefinition {
  readonly targetType: 'edge'
  readonly id: CanvasEdgeCommandId
  readonly canExecute: (command: CanvasEdgeCommand, edge: CanvasEdge) => boolean
  readonly execute: (
    command: CanvasEdgeCommand,
    edge: CanvasEdge,
    context: CanvasEdgeCommandContext,
  ) => Promise<CanvasEdgeCommandResult>
}

export interface CanvasNodeCommandContext {
  readonly canvasId: string
  readonly node: CanvasNodeCommandTarget
  readonly edges: readonly CanvasEdge[]
  readonly service: CanvasService
}

export interface CanvasNodeCommandResult {
  readonly updatedNode: CanvasNode | null
  readonly removedNodeId: string | null
  readonly removedEdgeIds: readonly string[]
  readonly feedback: string
}

export interface CanvasNodeCommandDefinition {
  readonly targetType: 'node'
  readonly id: CanvasNodeCommandId
  readonly canExecute: (
    command: CanvasNodeCommand,
    node: CanvasNodeCommandTarget,
  ) => boolean
  readonly execute: (
    command: CanvasNodeCommand,
    context: CanvasNodeCommandContext,
  ) => Promise<CanvasNodeCommandResult>
}

export type CanvasCommandDefinition =
  | CanvasEdgeCommandDefinition
  | CanvasNodeCommandDefinition

const NO_CHANGE: CanvasEdgeCommandResult = {
  updatedEdges: [],
  removedEdgeId: null,
  feedback: '',
}

function isOrdinary(edge: CanvasEdge): boolean {
  return isCanvasOrdinaryEdgeRelationType(edge.relationType)
}

function isMembership(edge: CanvasEdge): boolean {
  return isCanvasMembershipRelationType(edge.relationType)
}

function invalidCommand(): never {
  throw new Error('Canvas command definition received an incompatible command.')
}

function membershipIds(
  edges: readonly CanvasEdge[],
  nodeBoxId: string,
  relationType: 'ordered_box_member' | 'unordered_box_member',
): string[] {
  return edges
    .filter(
      (edge) =>
        edge.targetNodeId === nodeBoxId && edge.relationType === relationType,
    )
    .sort(
      (left, right) =>
        (left.membershipPosition ?? 0) - (right.membershipPosition ?? 0) ||
        left.id.localeCompare(right.id),
    )
    .map((edge) => edge.id)
}

const edgeDefinitions: readonly CanvasEdgeCommandDefinition[] = [
  {
    targetType: 'edge',
    id: 'update_edge_relation_type',
    canExecute: (command, edge) =>
      command.id === 'update_edge_relation_type' && isOrdinary(edge),
    execute: async (command, edge, context) => {
      if (command.id !== 'update_edge_relation_type') return invalidCommand()
      if (edge.relationType === command.relationType) return NO_CHANGE
      const updated = await context.service.updateCanvasEdgeRelationType(
        edge.id,
        command.relationType,
      )
      return {
        updatedEdges: [updated],
        removedEdgeId: null,
        feedback: '关系类型已保存',
      }
    },
  },
  {
    targetType: 'edge',
    id: 'update_edge_direction',
    canExecute: (command, edge) =>
      command.id === 'update_edge_direction' && isOrdinary(edge),
    execute: async (command, edge, context) => {
      if (command.id !== 'update_edge_direction') return invalidCommand()
      if (edge.direction === command.direction) return NO_CHANGE
      const updated = await context.service.updateCanvasEdgeDirection(
        edge.id,
        command.direction,
      )
      return {
        updatedEdges: [updated],
        removedEdgeId: null,
        feedback: '连线方向已保存',
      }
    },
  },
  {
    targetType: 'edge',
    id: 'update_edge_line_style',
    canExecute: (command, edge) =>
      command.id === 'update_edge_line_style' && isOrdinary(edge),
    execute: async (command, edge, context) => {
      if (command.id !== 'update_edge_line_style') return invalidCommand()
      if (edge.lineStyle === command.lineStyle) return NO_CHANGE
      const updated = await context.service.updateCanvasEdgeLineStyle(
        edge.id,
        command.lineStyle,
      )
      return {
        updatedEdges: [updated],
        removedEdgeId: null,
        feedback: '连线样式已保存',
      }
    },
  },
  {
    targetType: 'edge',
    id: 'delete_edge',
    canExecute: (command, edge) =>
      command.id === 'delete_edge' && !isMembership(edge),
    execute: async (command, edge, context) => {
      if (command.id !== 'delete_edge') return invalidCommand()
      await context.service.deleteCanvasEdge(edge.id)
      return {
        updatedEdges: [],
        removedEdgeId: edge.id,
        feedback: '连线已删除',
      }
    },
  },
  {
    targetType: 'edge',
    id: 'move_membership_section',
    canExecute: (command, edge) => {
      if (command.id !== 'move_membership_section') return false
      return command.section === 'ordered'
        ? edge.relationType === 'unordered_box_member'
        : edge.relationType === 'ordered_box_member'
    },
    execute: async (command, edge, context) => {
      if (command.id !== 'move_membership_section') return invalidCommand()
      const ordered = membershipIds(
        context.edges,
        edge.targetNodeId,
        'ordered_box_member',
      ).filter((edgeId) => edgeId !== edge.id)
      const unordered = membershipIds(
        context.edges,
        edge.targetNodeId,
        'unordered_box_member',
      ).filter((edgeId) => edgeId !== edge.id)
      if (command.section === 'ordered') {
        ordered.push(edge.id)
      } else {
        unordered.push(edge.id)
      }
      const updated = await context.service.reorderNodeBoxMemberships(
        context.canvasId,
        edge.targetNodeId,
        ordered,
        unordered,
      )
      return {
        updatedEdges: updated,
        removedEdgeId: null,
        feedback: command.section === 'ordered'
          ? '已移到有序成员区'
          : '已移到无序成员区',
      }
    },
  },
  {
    targetType: 'edge',
    id: 'remove_membership',
    canExecute: (command, edge) =>
      command.id === 'remove_membership' && isMembership(edge),
    execute: async (command, edge, context) => {
      if (command.id !== 'remove_membership') return invalidCommand()
      await context.service.deleteCanvasEdge(edge.id)
      return {
        updatedEdges: [],
        removedEdgeId: edge.id,
        feedback: '已从节点盒移除',
      }
    },
  },
]

const nodeDefinitions: readonly CanvasNodeCommandDefinition[] = [
  {
    targetType: 'node',
    id: 'rename_node',
    canExecute: (command, node) =>
      command.id === 'rename_node' && node.type !== 'unknown',
    execute: async (command, context) => {
      if (command.id !== 'rename_node') return invalidCommand()
      const updatedNode = await context.service.renameCanvasNode(
        context.canvasId,
        command.nodeId,
        command.nodeName,
      )
      return {
        updatedNode,
        removedNodeId: null,
        removedEdgeIds: [],
        feedback: updatedNode.nodeName === ''
          ? '节点名称已清空'
          : '节点名称已保存',
      }
    },
  },
  {
    targetType: 'node',
    id: 'delete_node',
    canExecute: (command, node) =>
      command.id === 'delete_node' && node.type !== 'unknown',
    execute: async (command, context) => {
      if (command.id !== 'delete_node') return invalidCommand()
      await context.service.deleteCanvasNode(context.canvasId, command.nodeId)
      return {
        updatedNode: null,
        removedNodeId: command.nodeId,
        removedEdgeIds: context.edges
          .filter(
            (edge) =>
              edge.sourceNodeId === command.nodeId ||
              edge.targetNodeId === command.nodeId,
          )
          .map((edge) => edge.id),
        feedback: '节点已删除',
      }
    },
  },
]

const definitions: readonly CanvasCommandDefinition[] = [
  ...edgeDefinitions,
  ...nodeDefinitions,
]

const byId = new Map<string, CanvasCommandDefinition>(
  definitions.map((definition) => [definition.id, definition]),
)

export const canvasCommandRegistry = {
  definitions,
  lookup(id: string): CanvasCommandDefinition | undefined {
    return byId.get(id)
  },
} as const

export async function executeCanvasEdgeCommand(
  command: CanvasEdgeCommand,
  context: CanvasEdgeCommandContext,
): Promise<CanvasEdgeCommandResult> {
  try {
    const edge = context.edges.find((item) => item.id === command.edgeId)
    const definition = canvasCommandRegistry.lookup(command.id)
    if (
      edge === undefined ||
      definition === undefined ||
      definition.targetType !== 'edge' ||
      !definition.canExecute(command, edge)
    ) {
      throw new Error('Canvas Edge command cannot execute for this target.')
    }
    const result = await definition.execute(command, edge, context)
    emitCanvasCommandEvent({
      commandId: command.id,
      targetType: 'edge',
      targetId: command.edgeId,
      timestamp: Date.now(),
      result: 'success',
    })
    return result
  } catch (error: unknown) {
    emitCanvasCommandEvent({
      commandId: command.id,
      targetType: 'edge',
      targetId: command.edgeId,
      timestamp: Date.now(),
      result: 'failure',
    })
    throw error
  }
}

export async function executeCanvasNodeCommand(
  command: CanvasNodeCommand,
  context: CanvasNodeCommandContext,
): Promise<CanvasNodeCommandResult> {
  try {
    const definition = canvasCommandRegistry.lookup(command.id)
    if (
      definition === undefined ||
      definition.targetType !== 'node' ||
      command.nodeId !== context.node.id ||
      !definition.canExecute(command, context.node)
    ) {
      throw new Error('Canvas Node command cannot execute for this target.')
    }
    const result = await definition.execute(command, context)
    emitCanvasCommandEvent({
      commandId: command.id,
      targetType: 'node',
      targetId: command.nodeId,
      timestamp: Date.now(),
      result: 'success',
    })
    return result
  } catch (error: unknown) {
    emitCanvasCommandEvent({
      commandId: command.id,
      targetType: 'node',
      targetId: command.nodeId,
      timestamp: Date.now(),
      result: 'failure',
    })
    throw error
  }
}
