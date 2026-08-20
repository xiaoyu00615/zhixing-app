import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"

import { cn } from "@/lib/utils"
import { CheckIcon } from "lucide-react"

function Checkbox({
  className,
  size = "default",
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root> & {
  size?: "default" | "lg"
}) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      data-size={size}
      // UI V1.2 §10: Checkbox default=16x16; lg=18x18 (任务核心场景)
      // 4px radius = Engineering Implementation Value（UI V1.2 未冻结 Checkbox 圆角）
      className={cn(
        "peer relative flex shrink-0 items-center justify-center rounded-[4px] border border-border transition-colors outline-none group-has-disabled/field:opacity-50 group-has-[:focus-visible]/field-label:ring-0 group-has-[:focus-visible]/field-label:not-data-checked:border-border after:absolute after:-inset-x-3 after:-inset-y-2 focus-visible:border-[var(--focus-color)] focus-visible:[box-shadow:var(--focus-ring)] disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:border-destructive aria-invalid:[box-shadow:var(--focus-ring)] aria-invalid:aria-checked:border-primary data-checked:border-primary data-checked:bg-primary data-checked:text-on-primary group-has-[:focus-visible]/field-label:data-checked:border-primary",
        size === "default" ? "size-4" : "size-[18px]",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="grid place-content-center text-current transition-none [&>svg]:size-3.5"
      >
        <CheckIcon
        />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
