/**
 * 侧边栏导航项
 * 使用 NavLink 实现 active 高亮（基于 location，不引入 Zustand）
 * focus 采用 box-shadow only，不临时增加 border，避免尺寸变化
 */

import { NavLink } from "react-router"

import { type NavItem } from "@/config/navigation"
import { cn } from "@/lib/utils"

interface SidebarNavItemProps {
  item: NavItem
}

export function SidebarNavItem({ item }: SidebarNavItemProps) {
  const Icon = item.icon

  return (
    <NavLink
      to={item.path}
      className={({ isActive }) =>
        cn(
          "flex h-9 items-center gap-2 rounded-sm px-3 text-body text-foreground-secondary transition-colors duration-[140ms] outline-none",
          "hover:bg-hover hover:text-foreground",
          "focus-visible:[box-shadow:var(--focus-ring)]",
          isActive && "bg-selected text-primary font-medium"
        )
      }
    >
      <Icon className="size-4 shrink-0" />
      <span>{item.label}</span>
    </NavLink>
  )
}
