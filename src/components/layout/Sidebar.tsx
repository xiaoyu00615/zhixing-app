/**
 * 侧边栏
 * - 固定宽度 224px（--sidebar-width）
 * - 按冻结顺序显示 10 个一级导航，不渲染 group label
 * - 外壳不滚动；导航内容区 min-h-0 + overflow-y-auto 应对小窗口高度
 */

import { NAV_ITEMS } from "@/config/navigation"

import { SidebarNavItem } from "./SidebarNavItem"

export function Sidebar() {
  return (
    <aside
      className="flex h-full w-[var(--sidebar-width)] shrink-0 flex-col border-r border-border bg-sidebar"
      aria-label="主导航"
    >
      {/* Logo 区 */}
      <div className="flex h-12 shrink-0 items-center px-4">
        <span className="text-subtitle font-semibold text-foreground">知行</span>
      </div>

      {/* 导航内容区：min-h-0 保证 flex 子项可收缩，overflow-y-auto 应对小窗口高度 */}
      <nav className="min-h-0 flex-1 overflow-y-auto p-3">
        <ul className="flex flex-col gap-0.5">
          {NAV_ITEMS.map((item) => (
            <li key={item.path}>
              <SidebarNavItem item={item} />
            </li>
          ))}
        </ul>
      </nav>
    </aside>
  )
}
