/**
 * 路由路径集中管理
 * 避免页面中散落字符串，所有路径统一从此处引用
 * 依据：UI 设计规范 V1.2 §13 一级导航
 *
 * 注：/tags /archive /trash 的英文 URL 为 Engineering Implementation Value
 * （冻结文档未规定英文 URL，由工程实现统一约定）
 */

export const PATHS = {
  /** 首页（今日摘要） */
  TODAY: "/today",
  /** 任务 */
  TASKS: "/tasks",
  /** 画布 */
  CANVAS: "/canvas",
  /** 日记 */
  DIARY: "/diary",
  /** 笔记 */
  NOTES: "/notes",
  /** 搜索 */
  SEARCH: "/search",
  /** 标签 */
  TAGS: "/tags",
  /** 归档 */
  ARCHIVE: "/archive",
  /** 回收站 */
  TRASH: "/trash",
  /** 设置 */
  SETTINGS: "/settings",
} as const

/** 默认首页路径 */
export const DEFAULT_PATH = PATHS.TODAY

/** 通配符路径，用于 404 兜底 */
export const WILDCARD = "*"
