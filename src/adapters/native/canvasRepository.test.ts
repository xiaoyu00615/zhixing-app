import { beforeEach, vi } from 'vitest'

import { NativeCanvasRepository } from './canvasRepository'
import type {
  CreateCanvasInput,
  CreateCanvasNodeInput,
  CreateCanvasEdgeInput,
  CreateTextNodeInput,
  DeleteCanvasEdgeInput,
  MoveCanvasNodeInput,
  MoveCanvasNodesInput,
  RenameCanvasInput,
  RenameCanvasNodeInput,
  UpdateCanvasEdgeDirectionInput,
  UpdateCanvasEdgeLineStyleInput,
  UpdateCanvasEdgeRelationTypeInput,
  UpdateCanvasViewportInput,
  UpdateCanvasNodeContentInput,
  UpdateTextNodeInput,
} from '@/canvas/repository'
import { CanvasContractBackend, defineCanvasRepositoryContract } from '@/test/canvasRepositoryContract'

const invokeMock = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }))
beforeEach(() => {
  invokeMock.mockReset()
})

defineCanvasRepositoryContract('NativeCanvasRepository', () => {
  const backend = new CanvasContractBackend()
  invokeMock.mockImplementation((command: string, args?: Record<string, unknown>) => {
    switch (command) {
      case 'canvas_create': return backend.createCanvas(args?.input as CreateCanvasInput)
      case 'canvas_list': return backend.listCanvases()
      case 'canvas_get': return backend.getCanvas((args?.input as { id: string }).id)
      case 'canvas_rename': return backend.renameCanvas(args?.input as RenameCanvasInput)
      case 'canvas_update_viewport': return backend.updateCanvasViewport(args?.input as UpdateCanvasViewportInput)
      case 'canvas_node_create_text': return backend.createTextNode(args?.input as CreateTextNodeInput)
      case 'canvas_node_create': return backend.createCanvasNode(args?.input as CreateCanvasNodeInput)
      case 'canvas_node_list': return backend.listCanvasNodes((args?.input as { id: string }).id)
      case 'canvas_node_update_text': return backend.updateTextNode(args?.input as UpdateTextNodeInput)
      case 'canvas_node_update_content': return backend.updateCanvasNodeContent(args?.input as UpdateCanvasNodeContentInput)
      case 'canvas_node_rename': return backend.renameCanvasNode(args?.input as RenameCanvasNodeInput)
      case 'canvas_node_move': return backend.moveCanvasNode(args?.input as MoveCanvasNodeInput)
      case 'canvas_nodes_move': return backend.moveCanvasNodes(args?.input as MoveCanvasNodesInput)
      case 'canvas_edge_create': return backend.createCanvasEdge(args?.input as CreateCanvasEdgeInput)
      case 'canvas_edge_list': return backend.listCanvasEdges((args?.input as { id: string }).id)
      case 'canvas_edge_set_direction': return backend.updateCanvasEdgeDirection(args?.input as UpdateCanvasEdgeDirectionInput)
      case 'canvas_edge_set_line_style': return backend.updateCanvasEdgeLineStyle(args?.input as UpdateCanvasEdgeLineStyleInput)
      case 'canvas_edge_set_relation_type': return backend.updateCanvasEdgeRelationType(args?.input as UpdateCanvasEdgeRelationTypeInput)
      case 'canvas_edge_delete': return backend.deleteCanvasEdge(args?.input as DeleteCanvasEdgeInput)
      default: throw new Error(`Unexpected command ${command}`)
    }
  })
  return { repository: new NativeCanvasRepository(), backend }
})
