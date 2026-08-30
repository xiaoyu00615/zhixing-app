import {
  isCanvasEdgeRelationType,
  type CanvasEdgeDirection,
  type CanvasEdgeLineStyle,
  type CanvasEdgeRelationType,
  type PersistedCanvasEdgeRelationType,
} from '@/canvas/model'

export interface CanvasEdgeRenderConfig {
  readonly stroke: string
  readonly selectedStroke: string
  readonly markerSize: number
}

export interface CanvasEdgeTypeDefinition {
  readonly relationType: CanvasEdgeRelationType
  readonly displayName: string
  readonly defaultDirection: CanvasEdgeDirection
  readonly defaultLineStyle: CanvasEdgeLineStyle
  readonly render: CanvasEdgeRenderConfig
}

const definitions = [
  {
    relationType: 'default',
    displayName: '普通关系',
    defaultDirection: 'forward',
    defaultLineStyle: 'solid',
    render: {
      stroke: '#7b8495',
      selectedStroke: 'var(--color-primary)',
      markerSize: 16,
    },
  },
  {
    relationType: 'hierarchy',
    displayName: '上下级',
    defaultDirection: 'forward',
    defaultLineStyle: 'solid',
    render: {
      stroke: '#667085',
      selectedStroke: 'var(--color-primary)',
      markerSize: 16,
    },
  },
  {
    relationType: 'peer',
    displayName: '同级',
    defaultDirection: 'none',
    defaultLineStyle: 'solid',
    render: {
      stroke: '#7b8495',
      selectedStroke: 'var(--color-primary)',
      markerSize: 16,
    },
  },
] as const satisfies readonly CanvasEdgeTypeDefinition[]

const byRelationType = new Map(
  definitions.map((definition) => [definition.relationType, definition]),
)

export const canvasEdgeRegistry = {
  definitions,
  byRelationType,
  default: byRelationType.get('default')!,
} as const

export function getCanvasEdgeTypeDefinition(
  relationType: PersistedCanvasEdgeRelationType,
): CanvasEdgeTypeDefinition | null {
  return isCanvasEdgeRelationType(relationType)
    ? (byRelationType.get(relationType) ?? null)
    : null
}

export const UNKNOWN_CANVAS_EDGE_RENDER: CanvasEdgeRenderConfig = {
  stroke: '#8b8f99',
  selectedStroke: 'var(--color-primary)',
  markerSize: 16,
}
