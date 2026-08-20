/**
 * Phase 1A · Step 5 · App Shell 入口
 * BrowserRouter > AppShell > AppRoutes
 * 组件不直接接触数据库、Tauri、Repository
 */

import { BrowserRouter } from "react-router"

import { AppShell } from "@/components/layout/AppShell"
import { AppRoutes } from "@/routes/router"

export default function App() {
  return (
    <BrowserRouter>
      <AppShell>
        <AppRoutes />
      </AppShell>
    </BrowserRouter>
  )
}
