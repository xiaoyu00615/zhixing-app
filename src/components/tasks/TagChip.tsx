import { Tag as TagIcon } from 'lucide-react'

import type { Tag } from '@/tag/model'

export function TagChip({ tag }: { readonly tag: Tag }) {
  return (
    <span className="inline-flex h-6 max-w-36 items-center gap-1 rounded-full border border-info/15 bg-info-soft/70 px-2 text-caption font-medium text-info">
      <TagIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{tag.name}</span>
    </span>
  )
}
