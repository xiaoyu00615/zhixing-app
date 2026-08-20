import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        // UI V1.2 §10: 36px 高 / 8px 圆角 / 14px 字号 / surface 背景 / border-default
        "flex h-9 w-full min-w-0 rounded-sm border border-border bg-surface px-3 py-2 text-sm transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-foreground-tertiary focus-visible:border-[var(--focus-color)] focus-visible:[box-shadow:var(--focus-ring)] disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-surface-secondary disabled:opacity-50 aria-invalid:border-destructive aria-invalid:[box-shadow:var(--focus-ring)]",
        className
      )}
      {...props}
    />
  )
}

export { Input }
