import {
  ChevronDown,
  Filter,
  FolderKanban,
  Pencil,
  Plus,
  Tags,
  X,
} from 'lucide-react'
import { useState, type ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import type { Project } from '@/project/model'
import type { Tag } from '@/tag/model'
import { DEFAULT_TASK_FILTER, type TaskFilter } from '@/task/model'

interface TaskFilterBarProps {
  readonly filter: TaskFilter
  readonly projects: readonly Project[]
  readonly tags: readonly Tag[]
  readonly onChange: (filter: TaskFilter) => void
  readonly onCreateProject: () => void
  readonly onRenameProject: (project: Project) => void
  readonly onCreateTag: () => void
  readonly onRenameTag: (tag: Tag) => void
}

const STATUS_LABELS = {
  todo: '待开始',
  doing: '进行中',
  completed: '已完成',
  cancelled: '已取消',
} as const

const DATE_LABELS = {
  today: '今日',
  upcoming: '即将到期',
  overdue: '已逾期',
  none: '无截止日期',
} as const

const SELECT_CLASS =
  'h-9 min-w-0 rounded-sm border border-border bg-surface px-2.5 text-sm text-foreground outline-none focus-visible:border-[var(--focus-color)] focus-visible:[box-shadow:var(--focus-ring)]'

export function TaskFilterBar({
  filter,
  projects,
  tags,
  onChange,
  onCreateProject,
  onRenameProject,
  onCreateTag,
  onRenameTag,
}: TaskFilterBarProps) {
  const [open, setOpen] = useState(false)

  function change<K extends keyof TaskFilter>(key: K, value: TaskFilter[K]) {
    onChange({ ...filter, [key]: value })
  }

  const projectName =
    filter.project === 'none'
      ? '无项目'
      : projects.find((project) => project.id === filter.project)?.name
  const tagName =
    filter.tag === 'none'
      ? '无标签'
      : tags.find((tag) => tag.id === filter.tag)?.name
  const chips: Array<{ key: keyof TaskFilter; label: string }> = []
  if (filter.status !== 'all')
    chips.push({
      key: 'status',
      label: `状态：${STATUS_LABELS[filter.status]}`,
    })
  if (filter.importance !== 'all')
    chips.push({
      key: 'importance',
      label: filter.importance === 'yes' ? '重要' : '不重要',
    })
  if (filter.urgency !== 'all')
    chips.push({
      key: 'urgency',
      label: filter.urgency === 'yes' ? '紧急' : '不紧急',
    })
  if (filter.date !== 'all')
    chips.push({ key: 'date', label: `日期：${DATE_LABELS[filter.date]}` })
  if (filter.project !== 'all' && projectName !== undefined)
    chips.push({ key: 'project', label: `项目：${projectName}` })
  if (filter.tag !== 'all' && tagName !== undefined)
    chips.push({ key: 'tag', label: `标签：${tagName}` })

  return (
    <div
      className="relative flex flex-wrap items-center gap-2"
      aria-label="任务筛选栏"
    >
      <Button
        aria-expanded={open}
        aria-controls="task-filter-panel"
        onClick={() => setOpen((current) => !current)}
        type="button"
        variant={chips.length > 0 ? 'secondary' : 'outline'}
      >
        <Filter data-icon="inline-start" />
        筛选
        {chips.length > 0 && (
          <span className="rounded-full bg-primary px-1.5 text-[11px] leading-5 text-on-primary">
            {chips.length}
          </span>
        )}
        <ChevronDown className="size-3.5" aria-hidden="true" />
      </Button>

      {chips.map((chip) => (
        <Button
          aria-label={`清除筛选：${chip.label}`}
          className="h-7 gap-1 rounded-full border-primary/15 bg-primary-softest px-2.5 text-xs text-primary hover:bg-primary-soft"
          key={chip.key}
          onClick={() => change(chip.key, 'all')}
          type="button"
          variant="outline"
        >
          {chip.label}
          <X className="size-3" aria-hidden="true" />
        </Button>
      ))}
      {chips.length > 1 && (
        <Button
          className="h-7 px-2 text-xs text-foreground-secondary"
          onClick={() => onChange(DEFAULT_TASK_FILTER)}
          type="button"
          variant="ghost"
        >
          清除全部
        </Button>
      )}

      <div className="ml-auto flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" type="button" variant="ghost">
              <FolderKanban data-icon="inline-start" />
              项目管理
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem aria-label="新建项目" onSelect={onCreateProject}>
              <Plus aria-hidden="true" />
              新建项目
            </DropdownMenuItem>
            {projects.length > 0 && <DropdownMenuSeparator />}
            {projects.length > 0 && (
              <DropdownMenuLabel>重命名项目</DropdownMenuLabel>
            )}
            {projects.map((project) => (
              <DropdownMenuItem
                aria-label={`重命名项目：${project.name}`}
                key={project.id}
                onSelect={() => onRenameProject(project)}
              >
                <Pencil aria-hidden="true" />
                {project.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" type="button" variant="ghost">
              <Tags data-icon="inline-start" />
              标签管理
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-48">
            <DropdownMenuItem aria-label="新建标签" onSelect={onCreateTag}>
              <Plus aria-hidden="true" />
              新建标签
            </DropdownMenuItem>
            {tags.length > 0 && <DropdownMenuSeparator />}
            {tags.length > 0 && (
              <DropdownMenuLabel>重命名标签</DropdownMenuLabel>
            )}
            {tags.map((tag) => (
              <DropdownMenuItem
                aria-label={`重命名标签：${tag.name}`}
                key={tag.id}
                onSelect={() => onRenameTag(tag)}
              >
                <Pencil aria-hidden="true" />
                {tag.name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {open && (
        <div
          aria-label="任务筛选条件"
          className="absolute top-11 left-0 z-dropdown grid w-[min(680px,calc(100vw-280px))] grid-cols-2 gap-3 rounded-lg border border-border bg-surface p-4 shadow-overlay md:grid-cols-3"
          id="task-filter-panel"
          role="group"
        >
          <FilterSelect
            label="状态"
            value={filter.status}
            onChange={(value) =>
              change('status', value as TaskFilter['status'])
            }
          >
            <option value="all">全部</option>
            <option value="todo">待开始</option>
            <option value="doing">进行中</option>
            <option value="completed">已完成</option>
            <option value="cancelled">已取消</option>
          </FilterSelect>
          <FilterSelect
            label="重要性"
            value={filter.importance}
            onChange={(value) =>
              change('importance', value as TaskFilter['importance'])
            }
          >
            <option value="all">全部</option>
            <option value="yes">重要</option>
            <option value="no">不重要</option>
          </FilterSelect>
          <FilterSelect
            label="紧急性"
            value={filter.urgency}
            onChange={(value) =>
              change('urgency', value as TaskFilter['urgency'])
            }
          >
            <option value="all">全部</option>
            <option value="yes">紧急</option>
            <option value="no">不紧急</option>
          </FilterSelect>
          <FilterSelect
            label="日期"
            value={filter.date}
            onChange={(value) => change('date', value as TaskFilter['date'])}
          >
            <option value="all">全部</option>
            <option value="today">今日</option>
            <option value="upcoming">即将到期</option>
            <option value="overdue">已逾期</option>
            <option value="none">无截止日期</option>
          </FilterSelect>
          <FilterSelect
            label="项目"
            value={filter.project}
            onChange={(value) => change('project', value)}
          >
            <option value="all">全部</option>
            <option value="none">无项目</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="标签"
            value={filter.tag}
            onChange={(value) => change('tag', value)}
          >
            <option value="all">全部</option>
            <option value="none">无标签</option>
            {tags.map((tag) => (
              <option key={tag.id} value={tag.id}>
                {tag.name}
              </option>
            ))}
          </FilterSelect>
        </div>
      )}
    </div>
  )
}

function FilterSelect({
  label,
  value,
  onChange,
  children,
}: {
  readonly label: string
  readonly value: string
  readonly onChange: (value: string) => void
  readonly children: ReactNode
}) {
  return (
    <label className="grid gap-1.5 text-xs font-medium text-foreground-secondary">
      {label}
      <select
        aria-label={`筛选${label}`}
        className={SELECT_CLASS}
        onChange={(event) => onChange(event.target.value)}
        value={value}
      >
        {children}
      </select>
    </label>
  )
}
