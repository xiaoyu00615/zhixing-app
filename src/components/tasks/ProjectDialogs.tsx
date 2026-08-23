import type { FormEvent } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

interface ProjectDialogProps {
  readonly mode: 'create' | 'rename'
  readonly open: boolean
  readonly name: string
  readonly error: string | null
  readonly pending: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onNameChange: (name: string) => void
  readonly onSubmit: () => void
}

export function ProjectDialog({
  mode,
  open,
  name,
  error,
  pending,
  onOpenChange,
  onNameChange,
  onSubmit,
}: ProjectDialogProps) {
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit()
  }
  const creating = mode === 'create'
  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent
        className="gap-5 p-6 sm:max-w-[440px]"
        showCloseButton={!pending}
      >
        <form className="contents" onSubmit={submit}>
          <DialogHeader className="pr-8">
            <DialogTitle>{creating ? '新建项目' : '重命名项目'}</DialogTitle>
            <DialogDescription>
              {creating
                ? '为相关任务建立一个清晰的项目归属。'
                : '修改项目名称，不会改变任务归属。'}
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-body font-medium" htmlFor="project-name">
              项目名称
            </label>
            <Input
              id="project-name"
              autoFocus
              disabled={pending}
              value={name}
              onChange={(event) => onNameChange(event.target.value)}
              aria-invalid={error !== null}
              aria-describedby={
                error === null ? undefined : 'project-name-error'
              }
            />
            {error !== null && (
              <p id="project-name-error" className="text-auxiliary text-danger">
                {error}
              </p>
            )}
          </div>
          <DialogFooter className="-mx-6 -mb-6 px-6 py-4">
            <Button
              type="button"
              variant="outline"
              disabled={pending}
              onClick={() => onOpenChange(false)}
            >
              取消
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? '正在保存…' : creating ? '创建项目' : '保存名称'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
