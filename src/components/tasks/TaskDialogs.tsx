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
import type { LocalDate, Task } from '@/task/model'

interface CreateTaskDialogProps {
  readonly open: boolean
  readonly title: string
  readonly error: string | null
  readonly dueDateError: string | null
  readonly isImportant: boolean
  readonly isUrgent: boolean
  readonly dueDate: LocalDate | null
  readonly pending: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly onTitleChange: (title: string) => void
  readonly onImportanceChange: (isImportant: boolean) => void
  readonly onUrgencyChange: (isUrgent: boolean) => void
  readonly onDueDateChange: (dueDate: LocalDate | null) => void
  readonly onSubmit: () => void
}

export function CreateTaskDialog({
  open,
  title,
  error,
  dueDateError,
  isImportant,
  isUrgent,
  dueDate,
  pending,
  onOpenChange,
  onTitleChange,
  onImportanceChange,
  onUrgencyChange,
  onDueDateChange,
  onSubmit,
}: CreateTaskDialogProps) {
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit()
  }

  return (
    <Dialog
      onOpenChange={(nextOpen) => {
        if (!pending) {
          onOpenChange(nextOpen)
        }
      }}
      open={open}
    >
      <DialogContent showCloseButton={!pending}>
        <form className="contents" onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>新建任务</DialogTitle>
            <DialogDescription>
              输入任务标题。任务将保存到当前本地数据存储。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <label className="text-body font-medium" htmlFor="create-title">
                标题
              </label>
              <Input
                aria-describedby={
                  error === null ? undefined : 'create-title-error'
                }
                aria-invalid={error !== null}
                autoFocus
                disabled={pending}
                id="create-title"
                onChange={(event) => onTitleChange(event.target.value)}
                placeholder="输入任务标题"
                value={title}
              />
              {error !== null && (
                <p
                  className="text-auxiliary text-danger"
                  id="create-title-error"
                >
                  {error}
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="flex items-center gap-2 text-body text-foreground">
                <input
                  checked={isImportant}
                  className="size-[18px] accent-primary"
                  disabled={pending}
                  onChange={(event) => onImportanceChange(event.target.checked)}
                  type="checkbox"
                />
                重要任务
              </label>
              <label className="flex items-center gap-2 text-body text-foreground">
                <input
                  checked={isUrgent}
                  className="size-[18px] accent-primary"
                  disabled={pending}
                  onChange={(event) => onUrgencyChange(event.target.checked)}
                  type="checkbox"
                />
                基础紧急
              </label>
            </div>
            <div className="space-y-2">
              <label
                className="text-body font-medium"
                htmlFor="create-due-date"
              >
                截止日期
              </label>
              <Input
                aria-describedby={
                  dueDateError === null ? undefined : 'create-due-date-error'
                }
                aria-invalid={dueDateError !== null}
                disabled={pending}
                id="create-due-date"
                onChange={(event) =>
                  onDueDateChange(
                    event.target.value === '' ? null : event.target.value,
                  )
                }
                type="date"
                value={dueDate ?? ''}
              />
              {dueDateError !== null && (
                <p
                  className="text-auxiliary text-danger"
                  id="create-due-date-error"
                >
                  {dueDateError}
                </p>
              )}
            </div>
          </div>
          <DialogFooter>
            <Button disabled={pending} type="submit">
              {pending ? '正在创建…' : '创建任务'}
            </Button>
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

interface RenameTaskDialogProps {
  readonly task: Task | null
  readonly title: string
  readonly error: string | null
  readonly pending: boolean
  readonly onClose: () => void
  readonly onTitleChange: (title: string) => void
  readonly onSubmit: () => void
}

export function RenameTaskDialog({
  task,
  title,
  error,
  pending,
  onClose,
  onTitleChange,
  onSubmit,
}: RenameTaskDialogProps) {
  function submit(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault()
    onSubmit()
  }

  return (
    <Dialog
      onOpenChange={(open) => {
        if (!open && !pending) {
          onClose()
        }
      }}
      open={task !== null}
    >
      <DialogContent showCloseButton={!pending}>
        {task !== null && (
          <form className="contents" onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>重命名任务</DialogTitle>
              <DialogDescription>
                修改任务标题，不会改变任务的当前状态。
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <label className="text-body font-medium" htmlFor="rename-title">
                标题
              </label>
              <Input
                aria-describedby={
                  error === null ? undefined : 'rename-title-error'
                }
                aria-invalid={error !== null}
                autoFocus
                disabled={pending}
                id="rename-title"
                onChange={(event) => onTitleChange(event.target.value)}
                value={title}
              />
              {error !== null && (
                <p
                  className="text-auxiliary text-danger"
                  id="rename-title-error"
                >
                  {error}
                </p>
              )}
            </div>
            <DialogFooter>
              <Button disabled={pending} type="submit">
                {pending ? '正在保存…' : '保存修改'}
              </Button>
              <Button
                disabled={pending}
                onClick={onClose}
                type="button"
                variant="outline"
              >
                取消
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
