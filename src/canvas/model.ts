export interface CanvasViewport {
  readonly x: number
  readonly y: number
  readonly zoom: number
}

export interface Canvas {
  readonly id: string
  readonly title: string
  readonly viewport: CanvasViewport
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface TextNodeContent {
  readonly type: 'text'
  readonly text: string
}

export interface StickyNodeContent {
  readonly type: 'sticky'
  readonly text: string
}

export interface UnknownNodeContent {
  readonly type: 'unknown'
  readonly raw: unknown
}

export type RegisteredCanvasNodeType = 'text' | 'sticky'
export type RegisteredCanvasNodeContent = TextNodeContent | StickyNodeContent
export const CANVAS_NODE_NAME_MAX_LENGTH = 120

export interface CanvasTextNode {
  readonly id: string
  readonly canvasId: string
  readonly type: 'text'
  readonly nodeName: string
  readonly content: TextNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CanvasStickyNode {
  readonly id: string
  readonly canvasId: string
  readonly type: 'sticky'
  readonly nodeName: string
  readonly content: StickyNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export interface CanvasUnknownNode {
  readonly id: string
  readonly canvasId: string
  readonly type: 'unknown'
  readonly originalType: string
  readonly nodeName: string
  readonly content: UnknownNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export type CanvasNode = CanvasTextNode | CanvasStickyNode | CanvasUnknownNode

export const CANVAS_EDGE_RELATION_TYPES = [
  'default',
  'hierarchy',
  'peer',
] as const
export type CanvasEdgeRelationType =
  (typeof CANVAS_EDGE_RELATION_TYPES)[number]

declare const UNKNOWN_CANVAS_EDGE_RELATION_TYPE: unique symbol
export type UnknownCanvasEdgeRelationType = string & {
  readonly [UNKNOWN_CANVAS_EDGE_RELATION_TYPE]: true
}
export type PersistedCanvasEdgeRelationType =
  | CanvasEdgeRelationType
  | UnknownCanvasEdgeRelationType

export const CANVAS_EDGE_DIRECTIONS = [
  'forward',
  'bidirectional',
  'none',
] as const
export type CanvasEdgeDirection = (typeof CANVAS_EDGE_DIRECTIONS)[number]

export const CANVAS_EDGE_LINE_STYLES = ['solid', 'dashed', 'dotted'] as const
export type CanvasEdgeLineStyle = (typeof CANVAS_EDGE_LINE_STYLES)[number]

export interface CanvasEdge {
  readonly id: string
  readonly canvasId: string
  readonly sourceNodeId: string
  readonly targetNodeId: string
  readonly relationType: PersistedCanvasEdgeRelationType
  readonly direction: CanvasEdgeDirection
  readonly lineStyle: CanvasEdgeLineStyle
  readonly createdAtMs: number
  readonly updatedAtMs: number
  readonly deletedAtMs: number | null
}

const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isCanonicalCanvasId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_LOWERCASE_UUID.test(value)
}

export function isNonEmptyCanvasTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isPersistedCanvasNodeName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Array.from(value).length <= CANVAS_NODE_NAME_MAX_LENGTH &&
    value === value.trim()
  )
}

export function isCanvasCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

export function isCanvasEdgeRelationType(
  value: unknown,
): value is CanvasEdgeRelationType {
  return (
    typeof value === 'string' &&
    CANVAS_EDGE_RELATION_TYPES.includes(value as CanvasEdgeRelationType)
  )
}

export function isPersistedCanvasEdgeRelationType(
  value: unknown,
): value is PersistedCanvasEdgeRelationType {
  return typeof value === 'string' && value.length > 0 && value === value.trim()
}

export function isCanvasEdgeDirection(
  value: unknown,
): value is CanvasEdgeDirection {
  return (
    typeof value === 'string' &&
    CANVAS_EDGE_DIRECTIONS.includes(value as CanvasEdgeDirection)
  )
}

export function isCanvasEdgeLineStyle(
  value: unknown,
): value is CanvasEdgeLineStyle {
  return (
    typeof value === 'string' &&
    CANVAS_EDGE_LINE_STYLES.includes(value as CanvasEdgeLineStyle)
  )
}

export function isCanvasViewport(value: unknown): value is CanvasViewport {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (
    keys.length !== 3 ||
    !keys.includes('x') ||
    !keys.includes('y') ||
    !keys.includes('zoom')
  ) {
    return false
  }
  const viewport = value as Record<string, unknown>
  return (
    isCanvasCoordinate(viewport.x) &&
    isCanvasCoordinate(viewport.y) &&
    isCanvasCoordinate(viewport.zoom) &&
    viewport.zoom > 0
  )
}

export function parseCanvasViewportJson(value: unknown): CanvasViewport | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isCanvasViewport(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function isTextNodeContent(value: unknown): value is TextNodeContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false
  }
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('text')) {
    return false
  }
  const content = value as Record<string, unknown>
  return content.type === 'text' && typeof content.text === 'string'
}

export function isStickyNodeContent(value: unknown): value is StickyNodeContent {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const keys = Object.keys(value)
  if (keys.length !== 2 || !keys.includes('type') || !keys.includes('text')) return false
  const content = value as Record<string, unknown>
  return content.type === 'sticky' && typeof content.text === 'string'
}

export function isRegisteredCanvasNodeContent(
  value: unknown,
): value is RegisteredCanvasNodeContent {
  return isTextNodeContent(value) || isStickyNodeContent(value)
}

export function parseCanvasNodeContentJson(
  nodeType: string,
  value: unknown,
): RegisteredCanvasNodeContent | UnknownNodeContent | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    if (nodeType === 'text') return isTextNodeContent(parsed) ? parsed : null
    if (nodeType === 'sticky') return isStickyNodeContent(parsed) ? parsed : null
    return { type: 'unknown', raw: parsed }
  } catch {
    return null
  }
}

export function parseTextNodeContentJson(
  value: unknown,
): TextNodeContent | null {
  if (typeof value !== 'string') return null
  try {
    const parsed: unknown = JSON.parse(value)
    return isTextNodeContent(parsed) ? parsed : null
  } catch {
    return null
  }
}
