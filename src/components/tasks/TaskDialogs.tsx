import type { FormEvent } from 'react'
import { CalendarDays, Star, Zap } from 'lucide-react'

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
      <DialogContent
        className="gap-5 p-6 sm:max-w-[520px]"
        showCloseButton={!pending}
      >
        <form className="contents" onSubmit={submit}>
          <DialogHeader className="pr-8">
            <DialogTitle className="text-module font-semibold">
              新建任务
            </DialogTitle>
            <DialogDescription>
              记录任务并设置当前需要的规划属性，内容会保存到本地。
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-5">
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
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                  isImportant
                    ? 'border-primary/35 bg-primary-softest'
                    : 'border-border bg-surface hover:bg-hover'
                }`}
              >
                <input
                  checked={isImportant}
                  className="size-[18px] accent-primary"
                  disabled={pending}
                  onChange={(event) => onImportanceChange(event.target.checked)}
                  type="checkbox"
                />
                <span className="flex min-w-0 items-center gap-2 text-body font-medium text-foreground">
                  <Star
                    aria-hidden="true"
                    className={`size-4 text-primary ${isImportant ? 'fill-current' : ''}`}
                  />
                  重要任务
                </span>
              </label>
              <label
                className={`flex cursor-pointer items-center gap-3 rounded-lg border p-3 transition-colors ${
                  isUrgent
                    ? 'border-warning/35 bg-warning-soft'
                    : 'border-border bg-surface hover:bg-hover'
                }`}
              >
                <input
                  checked={isUrgent}
                  className="size-[18px] accent-primary"
                  disabled={pending}
                  onChange={(event) => onUrgencyChange(event.target.checked)}
                  type="checkbox"
                />
                <span className="flex min-w-0 items-center gap-2 text-body font-medium text-foreground">
                  <Zap
                    aria-hidden="true"
                    className={`size-4 text-warning ${isUrgent ? 'fill-current' : ''}`}
                  />
                  基础紧急
                </span>
              </label>
            </div>
            <div className="space-y-3 rounded-lg border border-border bg-surface-secondary/35 p-4">
              <div className="flex items-center gap-2">
                <CalendarDays
                  aria-hidden="true"
                  className="size-4 text-foreground-secondary"
                />
                <label
                  className="text-body font-medium"
                  htmlFor="create-due-date"
                >
                  截止日期
                </label>
                <span className="text-caption text-foreground-tertiary">
                  可选
                </span>
              </div>
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
          <DialogFooter className="-mx-6 -mb-6 px-6 py-4">
            <Button
              disabled={pending}
              onClick={() => onOpenChange(false)}
              type="button"
              variant="outline"
            >
              取消
            </Button>
            <Button disabled={pending} type="submit">
              {pending ? '正在创建…' : '创建任务'}
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
      <DialogContent className="gap-5 p-5" showCloseButton={!pending}>
        {task !== null && (
          <form className="contents" onSubmit={submit}>
            <DialogHeader className="pr-8">
              <DialogTitle className="text-subtitle font-semibold">
                重命名任务
              </DialogTitle>
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
            <DialogFooter className="-mx-5 -mb-5 px-5 py-4">
              <Button
                disabled={pending}
                onClick={onClose}
                type="button"
                variant="outline"
              >
                取消
              </Button>
              <Button disabled={pending} type="submit">
                {pending ? '正在保存…' : '保存修改'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
