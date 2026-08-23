import { beforeEach, vi } from 'vitest'

import { NativeCanvasRepository } from './canvasRepository'
import type {
  CreateCanvasInput,
  CreateTextNodeInput,
  MoveCanvasNodeInput,
  RenameCanvasInput,
  UpdateCanvasViewportInput,
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
      case 'canvas_node_list': return backend.listCanvasNodes((args?.input as { id: string }).id)
      case 'canvas_node_update_text': return backend.updateTextNode(args?.input as UpdateTextNodeInput)
      case 'canvas_node_move': return backend.moveCanvasNode(args?.input as MoveCanvasNodeInput)
      default: throw new Error(`Unexpected command ${command}`)
    }
  })
  return { repository: new NativeCanvasRepository(), backend }
})
