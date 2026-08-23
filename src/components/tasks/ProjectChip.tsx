import { Folder } from 'lucide-react'

import type { Project } from '@/project/model'

export function ProjectChip({ project }: { readonly project: Project }) {
  return (
    <span className="inline-flex h-6 max-w-40 items-center gap-1 rounded-full border border-primary/15 bg-primary-softest px-2 text-caption font-medium text-primary">
      <Folder className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{project.name}</span>
    </span>
  )
}
