/**
 * Phase 1A · Step 5 · App Shell 入口
 * BrowserRouter > AppShell > AppRoutes
 * 组件不直接接触数据库、Tauri、Repository
 */

import { BrowserRouter } from "react-router"

import { AppShell } from "@/components/layout/AppShell"
import { AppRoutes } from "@/routes/router"
import { MaintenanceCoordinatorProvider } from "@/maintenance/context"

export default function App() {
  return (
    <BrowserRouter>
      {/* App-level coordinator: lives outside the route tree so it survives
          route changes and keeps unmounting-but-still-flushing editors tracked. */}
      <MaintenanceCoordinatorProvider>
        <AppShell>
          <AppRoutes />
        </AppShell>
      </MaintenanceCoordinatorProvider>
    </BrowserRouter>
  )
}
