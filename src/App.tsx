/**
 * Phase 1A · Step 4 · Router 入口
 * 使用 React Router 8 Declarative Mode（BrowserRouter）
 * 组件不直接接触数据库、Tauri、Repository
 */

import { BrowserRouter } from "react-router"

import { AppRoutes } from "@/routes/router"

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  )
}
