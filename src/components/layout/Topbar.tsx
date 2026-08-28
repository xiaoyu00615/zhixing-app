/**
 * 顶栏
 * - 固定高度 60px（--topbar-height）
 * - 默认显示当前页面标题（由 useLocation 查询 navigation config）
 * - Canvas List 使用页面级 Toolbar 插槽；Canvas Editor 保持普通标题
 * - 404 等未匹配路径兜底显示"页面未找到"
 */

import { useLocation } from "react-router"

import { findNavItem } from "@/config/navigation"
import { PATHS } from "@/routes/paths"

export function Topbar() {
  const location = useLocation()
  const isCanvasList = location.pathname === PATHS.CANVAS
  const current = findNavItem(location.pathname)
  const title = current?.label ??
    (location.pathname.startsWith(`${PATHS.CANVAS}/`) ? "画布" : "页面未找到")

  return (
    <header className="flex h-[var(--topbar-height)] shrink-0 items-center justify-between border-b border-border bg-surface px-6">
      {isCanvasList ? (
        <div className="min-w-0 flex-1" id="page-toolbar-root" />
      ) : (
        <>
          <h1 className="text-subtitle font-semibold text-foreground">{title}</h1>
          <div className="flex items-center gap-2" />
        </>
      )}
    </header>
  )
}
