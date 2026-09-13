import type {
  Canvas,
  CanvasEdge,
  CanvasEdgeDirection,
  CanvasEdgeLineStyle,
  CanvasEdgeRelationType,
  CanvasMembershipRelationType,
  CanvasOrdinaryEdgeRelationType,
  CanvasNode,
  CanvasViewport,
  RegisteredCanvasNodeContent,
  RegisteredCanvasNodeType,
} from '@/canvas/model'

export interface CreateCanvasInput {
  readonly id: string
  readonly title: string
  readonly viewport: CanvasViewport
  readonly createdAtMs: number
}

export interface RenameCanvasInput {
  readonly id: string
  readonly title: string
  readonly updatedAtMs: number
}

export interface UpdateCanvasViewportInput {
  readonly id: string
  readonly viewport: CanvasViewport
  readonly updatedAtMs: number
}

export interface CreateCanvasNodeInput {
  readonly id: string
  readonly canvasId: string
  readonly type: RegisteredCanvasNodeType
  readonly nodeName?: string
  readonly content: RegisteredCanvasNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
}

export interface UpdateCanvasNodeContentInput {
  readonly id: string
  readonly type: RegisteredCanvasNodeType
  readonly content: RegisteredCanvasNodeContent
  readonly updatedAtMs: number
}

export interface RenameCanvasNodeInput {
  readonly canvasId: string
  readonly id: string
  readonly nodeName: string
  readonly updatedAtMs: number
}

export interface CreateTextNodeInput extends Omit<CreateCanvasNodeInput, 'type' | 'content'> {
  readonly content: import('@/canvas/model').TextNodeContent
}

export interface UpdateTextNodeInput extends Omit<UpdateCanvasNodeContentInput, 'type' | 'content'> {
  readonly content: import('@/canvas/model').TextNodeContent
}

export interface MoveCanvasNodeInput {
  readonly id: string
  readonly x: number
  readonly y: number
  readonly updatedAtMs: number
}

export interface CanvasNodePositionMove {
  readonly nodeId: string
  readonly x: number
  readonly y: number
}

export interface MoveCanvasNodesInput {
  readonly canvasId: string
  readonly moves: readonly CanvasNodePositionMove[]
  readonly updatedAtMs: number
}

export interface DeleteCanvasNodeInput {
  readonly canvasId: string
  readonly id: string
  readonly deletedAtMs: number
  readonly updatedAtMs: number
}

export interface CreateCanvasEdgeInput {
  readonly id: string
  readonly canvasId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: CanvasOrdinaryEdgeRelationType
  readonly direction: CanvasEdgeDirection
  readonly lineStyle: CanvasEdgeLineStyle
  readonly createdAtMs: number
}

export interface CreateCanvasSubgraphNodeInput {
  readonly id: string
  readonly canvasId: string
  readonly type: RegisteredCanvasNodeType
  readonly nodeName: string
  readonly content: RegisteredCanvasNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
}

export interface CreateCanvasSubgraphEdgeInput {
  readonly id: string
  readonly canvasId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: CanvasOrdinaryEdgeRelationType
  readonly direction: CanvasEdgeDirection
  readonly lineStyle: CanvasEdgeLineStyle
  readonly createdAtMs: number
}

export interface CreateCanvasSubgraphMembershipInput {
  readonly id: string
  readonly canvasId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: CanvasMembershipRelationType
  readonly membershipPosition: number
  readonly createdAtMs: number
}

export interface CreateCanvasSubgraphInput {
  readonly canvasId: string
  readonly nodes: readonly CreateCanvasSubgraphNodeInput[]
  readonly edges: readonly CreateCanvasSubgraphEdgeInput[]
  readonly memberships: readonly CreateCanvasSubgraphMembershipInput[]
  readonly createdAtMs: number
}

export interface AddCanvasNodeBoxMemberInput {
  readonly id: string
  readonly canvasId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: CanvasMembershipRelationType
  readonly createdAtMs: number
}

export interface ReorderCanvasNodeBoxMembershipsInput {
  readonly canvasId: string
  readonly nodeBoxId: string
  readonly orderedMembershipEdgeIds: readonly string[]
  readonly unorderedMembershipEdgeIds: readonly string[]
  readonly updatedAtMs: number
}

export interface UpdateCanvasEdgeDirectionInput {
  readonly id: string
  readonly direction: CanvasEdgeDirection
  readonly updatedAtMs: number
}

export interface UpdateCanvasEdgeLineStyleInput {
  readonly id: string
  readonly lineStyle: CanvasEdgeLineStyle
  readonly updatedAtMs: number
}

export interface UpdateCanvasEdgeRelationTypeInput {
  readonly id: string
  readonly relationType: CanvasOrdinaryEdgeRelationType
  readonly direction: CanvasEdgeDirection
  readonly lineStyle: CanvasEdgeLineStyle
  readonly updatedAtMs: number
}

export interface DeleteCanvasEdgeInput {
  readonly id: string
  readonly deletedAtMs: number
  readonly updatedAtMs: number
}

/**
 * Generic, history-agnostic mutation batch primitives.
 *
 * These types describe explicit domain mutations. They have no dependency on
 * the undo/redo session: operation replay or future agent paths can produce
 * the same actions. Every batch runs in a single transaction; any invalid
 * action rolls the whole batch back.
 */
export interface CanvasMutationNodeSnapshot {
  readonly id: string
  readonly canvasId: string
  readonly type: RegisteredCanvasNodeType
  readonly nodeName: string
  readonly content: RegisteredCanvasNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
}

export interface CanvasMutationEdgeSnapshot {
  readonly id: string
  readonly canvasId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: CanvasEdgeRelationType
  readonly direction: CanvasEdgeDirection
  readonly lineStyle: CanvasEdgeLineStyle
  readonly membershipPosition: number | null
  readonly createdAtMs: number
}

export type CanvasMutationAction =
  | {
      readonly kind: 'insert_nodes'
      readonly nodes: readonly CanvasMutationNodeSnapshot[]
    }
  // Slice 11A-1 restriction: this is emitted ONLY as the inverse of
  // insert_nodes by the history layer. It soft-deletes exactly the explicit
  // node ids and never cascades to edges. It is not the user-facing Node
  // Delete feature (restore_nodes / cascade handling arrive in 11A-2).
  | {
      readonly kind: 'soft_delete_nodes'
      readonly nodeIds: readonly string[]
    }
  | {
      readonly kind: 'set_node_name'
      readonly nodeId: string
      readonly nodeName: string
    }
  | {
      readonly kind: 'set_node_content'
      readonly nodeId: string
      readonly content: RegisteredCanvasNodeContent
    }
  | {
      readonly kind: 'insert_edges'
      readonly edges: readonly CanvasMutationEdgeSnapshot[]
    }
  | {
      readonly kind: 'soft_delete_edges'
      readonly edgeIds: readonly string[]
    }
  | {
      readonly kind: 'restore_edges'
      readonly edges: readonly CanvasMutationEdgeSnapshot[]
    }
  | {
      readonly kind: 'move_nodes'
      readonly moves: readonly {
        readonly nodeId: string
        readonly x: number
        readonly y: number
      }[]
    }

export interface ApplyCanvasMutationBatchInput {
  readonly canvasId: string
  readonly atMs: number
  readonly actions: readonly CanvasMutationAction[]
}

export interface CanvasRepository {
  createCanvas(input: CreateCanvasInput): Promise<Canvas>
  listCanvases(): Promise<readonly Canvas[]>
  renameCanvas(input: RenameCanvasInput): Promise<Canvas>
  getCanvas(id: string): Promise<Canvas>
  updateCanvasViewport(input: UpdateCanvasViewportInput): Promise<Canvas>
  createCanvasNode(input: CreateCanvasNodeInput): Promise<CanvasNode>
  createTextNode(input: CreateTextNodeInput): Promise<CanvasNode>
  listCanvasNodes(canvasId: string): Promise<readonly CanvasNode[]>
  updateCanvasNodeContent(input: UpdateCanvasNodeContentInput): Promise<CanvasNode>
  renameCanvasNode(input: RenameCanvasNodeInput): Promise<CanvasNode>
  updateTextNode(input: UpdateTextNodeInput): Promise<CanvasNode>
  moveCanvasNode(input: MoveCanvasNodeInput): Promise<CanvasNode>
  moveCanvasNodes(input: MoveCanvasNodesInput): Promise<readonly CanvasNode[]>
  deleteCanvasNode(input: DeleteCanvasNodeInput): Promise<void>
  createCanvasEdge(input: CreateCanvasEdgeInput): Promise<CanvasEdge>
  createCanvasSubgraph(input: CreateCanvasSubgraphInput): Promise<{
    readonly nodes: readonly CanvasNode[]
    readonly edges: readonly CanvasEdge[]
  }>
  addCanvasNodeBoxMember(input: AddCanvasNodeBoxMemberInput): Promise<CanvasEdge>
  reorderCanvasNodeBoxMemberships(
    input: ReorderCanvasNodeBoxMembershipsInput,
  ): Promise<readonly CanvasEdge[]>
  listCanvasEdges(canvasId: string): Promise<readonly CanvasEdge[]>
  updateCanvasEdgeDirection(
    input: UpdateCanvasEdgeDirectionInput,
  ): Promise<CanvasEdge>
  updateCanvasEdgeLineStyle(
    input: UpdateCanvasEdgeLineStyleInput,
  ): Promise<CanvasEdge>
  updateCanvasEdgeRelationType(
    input: UpdateCanvasEdgeRelationTypeInput,
  ): Promise<CanvasEdge>
  deleteCanvasEdge(input: DeleteCanvasEdgeInput): Promise<CanvasEdge>
  applyCanvasMutationBatch(
    input: ApplyCanvasMutationBatchInput,
  ): Promise<void>
}

export type CanvasRepositoryErrorCode =
  | 'NOT_FOUND'
  | 'DUPLICATE'
  | 'PERSISTENCE_UNAVAILABLE'
  | 'PERSISTENCE_FAILED'

export type CanvasRepositoryOperation = keyof CanvasRepository

const SAFE_MESSAGES: Record<CanvasRepositoryErrorCode, string> = {
  NOT_FOUND: 'Canvas resource not found.',
  DUPLICATE: 'Canvas relation already exists.',
  PERSISTENCE_UNAVAILABLE: 'Canvas persistence is unavailable.',
  PERSISTENCE_FAILED: 'Canvas persistence operation failed.',
}

export class CanvasRepositoryError extends Error {
  readonly code: CanvasRepositoryErrorCode
  readonly operation: CanvasRepositoryOperation

  constructor(
    code: CanvasRepositoryErrorCode,
    operation: CanvasRepositoryOperation,
  ) {
    super(SAFE_MESSAGES[code])
    this.name = 'CanvasRepositoryError'
    this.code = code
    this.operation = operation
  }
}
