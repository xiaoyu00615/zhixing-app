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

export interface CanvasTextNode {
  readonly id: string
  readonly canvasId: string
  readonly type: 'text'
  readonly content: TextNodeContent
  readonly x: number
  readonly y: number
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export type CanvasNode = CanvasTextNode

const CANONICAL_LOWERCASE_UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export function isCanonicalCanvasId(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_LOWERCASE_UUID.test(value)
}

export function isNonEmptyCanvasTitle(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function isCanvasCoordinate(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
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
