/**
 * 设置页占位
 * Phase 1A · Step 5 · 仅路由占位，非正式页面
 * 布局由 AppShell 提供，Page 不再自带 main/padding
 */

export function SettingsPage() {
  return (
    <div className="space-y-2">
      <h2 className="text-hero font-semibold text-foreground">设置</h2>
      <p className="text-body text-foreground-secondary">Phase 1A</p>
    </div>
  )
}
