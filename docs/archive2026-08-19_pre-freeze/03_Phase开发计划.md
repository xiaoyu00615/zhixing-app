# 03｜Phase 开发计划

版本：V1.0  
日期：2026-08-19

## Phase 0｜项目技术评审

### 目标
在正式写业务代码前确认项目没有理解偏差。

### 不允许
- 不实现 Task
- 不实现 Canvas
- 不实现 Diary / Note
- 不实现 LAN Sync
- 不实现 AI

### 输出
1. 项目理解
2. 页面与功能清单
3. 技术架构建议
4. 目录结构
5. 数据模型初稿
6. 风险清单
7. Phase 1 实施计划
8. Phase 1 验收标准
9. 需要用户确认的问题

---

## Phase 1｜App Shell + Core Architecture

### 目标
搭建整个软件地基。

### 内容
- React / TypeScript / Vite 工程
- Tailwind CSS
- shadcn/ui
- Lucide
- Router
- App Shell
- Sidebar
- Topbar
- Theme
- Zustand 基础
- Tauri 2
- SQLite
- Migration
- Repository Base
- Service Base
- Storage Base
- Settings Base
- Error Handler
- Logger
- UUID
- 日期工具

### 不做
- Task 业务
- Canvas 业务
- Diary / Notes 业务
- Sync
- AI

---

## Phase 2｜Task

### 内容
- Task CRUD
- Task List
- 四象限
- Calendar
- Timeline
- Task Detail Drawer
- Create / Edit Modal
- Importance
- Urgency
- Deadline
- Overdue
- Tags
- Soft Delete
- Trash Restore
- 搜索基础
- Empty / Loading / Error

---

## Phase 3｜Canvas

### 内容
- Canvas List
- Canvas Editor
- Text Node
- Image Node
- Link Node
- Task Node
- Node Drag
- Edge
- Zoom
- Pan
- Selection
- Multi Select
- Group
- Copy / Paste
- Undo / Redo
- Local Save
- Node Property Panel
- Mini Map
- 当前画布搜索

### 暂不做
- 大型 AI 功能
- 多人协作
- 云同步

---

## Phase 4｜Diary + Notes

### Document System
优先建立统一 Document 模型。

### Diary
- Today Diary
- Calendar
- Timeline
- Tags
- Smart Folder
- Auto Save

### Notes
- Note List
- Folder
- Tags
- Favorite
- Tiptap Editor
- Attachments
- Entity Relation

---

## Phase 5｜Search + Tags + Archive + Trash

### Search
- FTS5
- Task
- Canvas
- CanvasNode
- Note
- Diary
- Tag
- Attachment metadata

### Tags
- 创建
- 重命名
- 颜色
- 合并
- 删除
- 跨模块筛选

### Archive
- 归档
- 恢复

### Trash
- Soft Delete
- 恢复
- 永久删除
- 清空回收站

---

## Phase 6｜Data Management + Backup

### 数据管理
- 数据位置查看
- 自定义数据位置
- 安全迁移
- 附件位置
- 缓存
- 导入 / 导出

### Backup
- 自动备份
- 手动备份
- Backup History
- Restore
- Restore 前安全快照
- Manifest
- Backup Integrity Check

---

## Phase 7｜LAN Device Sync

### 原则
每台设备都有独立本地数据库。

禁止多个设备直接共享同一个 SQLite 文件。

### 内容
- Device
- Pairing
- Pair Code / QR
- Change Log
- Revision
- Cursor
- Pull
- Push
- Ack
- Tombstone
- Conflict
- Attachment Hash
- Resume
- Device Remove

### 第一验收目标
Windows ↔ Android

---

## Phase 8｜AI

### 原则
AI 是嵌入式工具。

### 内容
- 自动标签
- Note 总结
- Diary 总结
- Canvas 分类
- Canvas 布局建议
- 发现关系
- 从内容提取 Task
- 日期识别

### 要求
必须通过 AIAdapter / AIService 接入。

---

## Phase 9｜未来扩展

可能包括：
- 云同步
- 账户
- 更多平台
- 插件体系
- 高级知识图谱
- 更多导出格式

当前不开发。

---

## Phase 统一规则

每个 Phase：

需求理解  
→ 计划  
→ 用户批准  
→ 开发  
→ 自动测试  
→ Bug 修复  
→ UI / 功能验收  
→ 用户批准  
→ DONE  
→ 下一 Phase

禁止同时进行多个未验收 Phase。
