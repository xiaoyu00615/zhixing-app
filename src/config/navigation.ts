/**
 * 导航配置
 * 数据驱动 Sidebar 渲染，避免重复 JSX
 * 依据：UI 设计规范 V1.2 §13 一级导航（10 项）
 *
 * 注：group 字段为内部结构，当前 Sidebar 不渲染可见 group label
 *     （UI V1.2 未冻结分组标题，不增加规范外的视觉元素）
 */

import {
  Archive,
  BookOpen,
  Home,
  LayoutGrid,
  ListTodo,
  type LucideIcon,
  Search,
  Settings,
  StickyNote,
  Tag,
  Trash2,
} from "lucide-react"

import { PATHS } from "@/routes/paths"

export interface NavItem {
  /** 中文名称 */
  label: string
  /** 路由路径（引用 PATHS） */
  path: string
  /** lucide 图标 */
  icon: LucideIcon
  /** 所属分组（内部结构，当前不渲染） */
  group: NavGroup
}

export type NavGroup = "main" | "library" | "system"

/**
 * 一级导航 10 项
 * 顺序严格按 UI V1.2 §13 冻结顺序
 */
export const NAV_ITEMS: NavItem[] = [
  { label: "首页", path: PATHS.TODAY, icon: Home, group: "main" },
  { label: "任务", path: PATHS.TASKS, icon: ListTodo, group: "main" },
  { label: "画布", path: PATHS.CANVAS, icon: LayoutGrid, group: "main" },
  { label: "日记", path: PATHS.DIARY, icon: BookOpen, group: "library" },
  { label: "笔记", path: PATHS.NOTES, icon: StickyNote, group: "library" },
  { label: "搜索", path: PATHS.SEARCH, icon: Search, group: "library" },
  { label: "标签", path: PATHS.TAGS, icon: Tag, group: "library" },
  { label: "归档", path: PATHS.ARCHIVE, icon: Archive, group: "system" },
  { label: "回收站", path: PATHS.TRASH, icon: Trash2, group: "system" },
  { label: "设置", path: PATHS.SETTINGS, icon: Settings, group: "system" },
]

/**
 * 根据 path 查询导航项 label
 * 用于 Topbar 显示当前页面标题；未匹配时返回 null（由调用方兜底）
 */
export function findNavItem(path: string): NavItem | undefined {
  return NAV_ITEMS.find((item) => item.path === path)
}
