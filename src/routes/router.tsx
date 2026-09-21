/**
 * 路由配置
 * 使用 React Router 8 Declarative Mode（BrowserRouter + Routes）
 * 不使用 createBrowserRouter / RouterProvider / loader / action / useFetcher
 * 依据：UI 设计规范 V1.2 §13 一级导航
 */

import { Navigate, Route, Routes, useSearchParams } from "react-router"

import { TodayPage } from "@/pages/TodayPage"
import { TasksPage } from "@/pages/TasksPage"
import { CanvasPage } from "@/pages/CanvasPage"
import { CanvasEditorPage } from "@/pages/CanvasEditorPage"
import { DiaryPage } from "@/pages/DiaryPage"
import { NotesPage } from "@/pages/NotesPage"
import { SearchPage } from "@/pages/SearchPage"
import { TagsPage } from "@/pages/TagsPage"
import { ArchivePage } from "@/pages/ArchivePage"
import { TrashPage } from "@/pages/TrashPage"
import { SettingsPage } from "@/pages/SettingsPage"
import { NotFoundPage } from "@/pages/NotFoundPage"

import { DEFAULT_PATH, PATHS, WILDCARD } from "./paths"

/**
 * 应用路由表
 * - "/" 重定向到默认首页
 * - 十个一级导航页面（首页/任务/画布/日记/笔记/搜索/标签/归档/回收站/设置）
 * - 通配符兜底 404
 */
export function AppRoutes() {
  // P5 S4: the Global Search workspace deep-links into the Task / Note / Diary
  // workspaces with `?id=<entityId>`. The value is passed down so the pages
  // keep owning their own selection mechanism. Canvas keeps /canvas/:canvasId.
  const [searchParams] = useSearchParams()
  const requestedId = searchParams.get("id")

  return (
    <Routes>
      <Route path="/" element={<Navigate to={DEFAULT_PATH} replace />} />
      <Route path={PATHS.TODAY} element={<TodayPage />} />
      <Route path={PATHS.TASKS} element={<TasksPage requestedTaskId={requestedId} />} />
      <Route path={PATHS.CANVAS} element={<CanvasPage />} />
      <Route path={`${PATHS.CANVAS}/:canvasId`} element={<CanvasEditorPage />} />
      <Route path={PATHS.DIARY} element={<DiaryPage requestedDiaryId={requestedId} />} />
      <Route path={PATHS.NOTES} element={<NotesPage requestedNoteId={requestedId} />} />
      <Route path={PATHS.SEARCH} element={<SearchPage />} />
      <Route path={PATHS.TAGS} element={<TagsPage />} />
      <Route path={PATHS.ARCHIVE} element={<ArchivePage />} />
      <Route path={PATHS.TRASH} element={<TrashPage />} />
      <Route path={PATHS.SETTINGS} element={<SettingsPage />} />
      <Route path={WILDCARD} element={<NotFoundPage />} />
    </Routes>
  )
}
