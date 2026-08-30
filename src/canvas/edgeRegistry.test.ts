import { describe, expect, test } from 'vitest'

import {
  canvasEdgeRegistry,
  getCanvasEdgeTypeDefinition,
  UNKNOWN_CANVAS_EDGE_RENDER,
} from '@/canvas/edgeRegistry'
import type { PersistedCanvasEdgeRelationType } from '@/canvas/model'

describe('canvasEdgeRegistry', () => {
  test('registers only the three active semantic types with their defaults', () => {
    expect(canvasEdgeRegistry.definitions).toEqual([
      expect.objectContaining({ relationType: 'default', displayName: '普通关系', defaultDirection: 'forward', defaultLineStyle: 'solid' }),
      expect.objectContaining({ relationType: 'hierarchy', displayName: '上下级', defaultDirection: 'forward', defaultLineStyle: 'solid' }),
      expect.objectContaining({ relationType: 'peer', displayName: '同级', defaultDirection: 'none', defaultLineStyle: 'solid' }),
    ])
    expect(canvasEdgeRegistry.byRelationType.has('ordered_box_member' as never)).toBe(false)
    expect(canvasEdgeRegistry.byRelationType.has('unordered_box_member' as never)).toBe(false)
  })

  test('provides render metadata and a neutral unknown fallback without semantic normalization', () => {
    expect(getCanvasEdgeTypeDefinition('hierarchy')?.render.markerSize).toBe(16)
    expect(getCanvasEdgeTypeDefinition('peer')?.render.stroke).toBeTruthy()
    expect(getCanvasEdgeTypeDefinition('future_relation' as PersistedCanvasEdgeRelationType)).toBeNull()
    expect(UNKNOWN_CANVAS_EDGE_RENDER).toMatchObject({ markerSize: 16 })
  })
})
