export interface Tag {
  readonly id: string
  readonly name: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export function isNonEmptyTagName(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.trim() === value
  )
}
