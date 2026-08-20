import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-sm font-medium whitespace-nowrap transition-all outline-none select-none focus-visible:border-[var(--focus-color)] focus-visible:[box-shadow:var(--focus-ring)] active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:[box-shadow:var(--focus-ring)] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-primary text-on-primary hover:bg-primary-hover active:bg-primary-pressed",
        outline:
          "border-border bg-background hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        secondary:
          "bg-secondary text-secondary-foreground hover:bg-[color-mix(in_oklch,var(--secondary),var(--foreground)_5%)] aria-expanded:bg-secondary aria-expanded:text-secondary-foreground",
        ghost:
          "hover:bg-hover hover:text-foreground aria-expanded:bg-hover aria-expanded:text-foreground",
        destructive:
          "bg-destructive/10 text-destructive hover:bg-destructive/20 focus-visible:border-destructive/40 focus-visible:[box-shadow:0_0_0_3px_rgba(229,72,77,0.12)]",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        // Small 30px / 10px padding / 12px font / 8px radius (UI V1.2 §9)
        sm: "h-[30px] gap-1 rounded-sm px-2.5 text-xs has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*='size-'])]:size-3.5",
        // Medium 36px / 14px padding / 14px font / 9px radius (UI V1.2 §9)
        default:
          "h-9 gap-1.5 rounded-[9px] px-3.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        // Large 40px / 18px padding / 14px font / 9px radius (UI V1.2 §9)
        lg: "h-10 gap-1.5 rounded-[9px] px-4.5 text-sm has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2",
        // Icon-only variants keep square aspect ratio
        icon: "size-9 rounded-[9px]",
        "icon-sm": "size-[30px] rounded-sm",
        "icon-lg": "size-10 rounded-[9px]",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
