export interface Project {
  readonly id: string
  readonly name: string
  readonly createdAtMs: number
  readonly updatedAtMs: number
}

export function isNonEmptyProjectName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}
