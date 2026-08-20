/**
 * 顶栏
 * - 固定高度 60px（--topbar-height）
 * - 左侧显示当前页面标题（由 useLocation 查询 navigation config）
 * - 右侧预留操作区（Step 5 留空，不实现搜索/AI/通知）
 * - 404 等未匹配路径兜底显示"页面未找到"
 */

import { useLocation } from "react-router"

import { findNavItem } from "@/config/navigation"

export function Topbar() {
  const location = useLocation()
  const current = findNavItem(location.pathname)
  const title = current?.label ?? "页面未找到"

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between border-b border-border bg-surface px-6">
      <h1 className="text-subtitle font-semibold text-foreground">{title}</h1>
      {/* 右侧预留操作区，Step 5 不实现 */}
      <div className="flex items-center gap-2" />
    </header>
  )
}
