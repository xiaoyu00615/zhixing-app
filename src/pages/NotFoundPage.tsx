/**
 * 404 NotFound 页占位
 * Phase 1A · Step 5 · 仅路由占位，非正式页面
 * 布局由 AppShell 提供，Page 不再自带 main/padding
 */

import { Link } from "react-router"

import { PATHS } from "@/routes/paths"

export function NotFoundPage() {
  return (
    <div className="space-y-2">
      <h2 className="text-hero font-semibold text-foreground">页面未找到</h2>
      <p className="text-body text-foreground-secondary">Phase 1A</p>
      <Link
        to={PATHS.TODAY}
        className="inline-block text-body text-primary hover:text-primary-hover"
      >
        返回首页
      </Link>
    </div>
  )
}
