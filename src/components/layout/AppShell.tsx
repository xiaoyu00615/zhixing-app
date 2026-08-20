/**
 * 应用外壳布局
 * - Sidebar 224px + 右侧（Topbar 60px + Main）
 * - 根容器 h-screen overflow-hidden 锁定 body 滚动
 * - 仅 Main 为纵向滚动容器
 * - 不使用 position: fixed，避免 100vh 嵌套溢出
 * - AppShell 在路由切换时保持挂载，不发生重新挂载；
 *   NavLink / useLocation 会根据 location 正常 re-render；
 *   Shell 几何结构保持稳定，不造成布局抖动
 */

import type { ReactNode } from "react"

import { Sidebar } from "./Sidebar"
import { Topbar } from "./Topbar"

interface AppShellProps {
  children: ReactNode
}

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="flex h-screen overflow-hidden bg-background font-sans">
      <Sidebar />
      <div className="flex h-full min-w-0 flex-1 flex-col">
        <Topbar />
        <main className="min-h-0 flex-1 overflow-y-auto p-6">{children}</main>
      </div>
    </div>
  )
}
