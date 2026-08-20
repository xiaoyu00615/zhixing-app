/**
 * 404 NotFound 页占位
 * Phase 1A · Step 4 · 仅路由占位，非正式页面
 */

import { Link } from "react-router"

import { PATHS } from "@/routes/paths"

export function NotFoundPage() {
  return (
    <main className="min-h-screen bg-background p-6 font-sans">
      <div className="mx-auto max-w-3xl space-y-2">
        <h1 className="text-hero font-semibold text-foreground">页面未找到</h1>
        <p className="text-body text-foreground-secondary">Phase 1A</p>
        <Link
          to={PATHS.TODAY}
          className="inline-block text-body text-primary hover:text-primary-hover"
        >
          返回首页
        </Link>
      </div>
    </main>
  )
}
