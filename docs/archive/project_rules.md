# 知行项目长期开发规则

版本：V1.0  
日期：2026-08-19  
适用对象：TRAE / 其他代码 Agent / 人工开发者

## 1. 项目定位

本项目暂定名为“知行｜个人知识与行动中枢”。

这是一个：
- 单用户
- 本地优先（Local First）
- 离线优先（Offline First）
- 数据由用户掌控
- Web / Windows Desktop / Android 多端发展的个人效率软件

核心模块包括：首页、任务、无限画布、日记、笔记、搜索、标签、归档、回收站、本地数据管理、备份与恢复、自己设备之间的局域网同步，以及后续 AI 辅助能力。

## 2. 严禁偏离的产品边界

本项目不是多人 SaaS。

禁止擅自增加：团队、组织、成员、协作者、多人头像、在线协作、团队评论、公开分享、工作空间邀请、云空间套餐、会员体系、社交系统、多人权限系统。

“设备同步”仅表示同一个用户自己的设备之间同步自己的数据。

## 3. 技术栈原则

技术栈以《技术架构与开发技术栈规范》最新批准版本为准。

未经用户明确批准，不得自行更换：
- React
- TypeScript
- Vite
- Tailwind CSS
- shadcn/ui
- Lucide Icons
- Zustand
- React Hook Form
- Zod
- React Flow
- Tiptap
- Tauri 2
- Rust
- SQLite
- SQLite FTS5
- Vitest
- Playwright

如认为需要调整技术栈，必须先提交：当前方案的问题、替代方案、修改收益、修改成本、对已有代码的影响、长期维护风险，等待用户批准后才能修改。

## 4. UI 规则优先级

发生冲突时优先级为：
1. 当前用户明确指令
2. 最新批准《全局 UI 设计规范》
3. 最新批准《技术架构规范》
4. 当前模块设计图
5. 旧版设计稿
6. Agent 自行判断

PNG / JPG 设计图只作为视觉与布局参考，不允许根据图片文件的实际像素直接反推 CSS 尺寸。

正式 UI 尺寸以最新 UI 规范中的 Design Token 为准。

## 5. 当前 UI 基准

当前批准基准：
- 主设计尺寸：1920 × 1080
- 响应验证：1440 × 900
- 最低桌面宽度：1280 px
- Sidebar：224 px
- Topbar：60 px
- 默认正文：14 px
- 默认按钮：36 px
- 默认 Input：36 px
- 标准 Card 圆角：12 px
- Modal / Drawer 圆角：16 px
- Task Detail Drawer：约 420 px
- 主要间距：8 / 12 / 16 / 24 / 32 px

## 6. 代码架构硬性规则

统一采用：

UI  
↓  
Application Service  
↓  
Repository  
↓  
Adapter  
↓  
SQLite / File System / System API

禁止 React Component 直接大量调用数据库。数据访问必须通过 Repository / Service。

## 7. 数据模型硬性规则

所有核心 Entity 原则上预留：
- id
- created_at
- updated_at
- deleted_at
- revision
- device_id

核心 ID 使用 UUID。核心删除默认采用 Soft Delete，不直接物理删除。

## 8. Canvas 硬性规则

Canvas 至少拆分为：
- Canvas
- CanvasNode
- CanvasEdge

禁止整个画布只保存为一个巨大 JSON。

画布列表页和画布编辑器必须分离。画布编辑器默认不常驻完整画布列表和大型 AI 面板；节点属性和 AI 整理按需出现。

## 9. 附件硬性规则

图片 / 附件实际文件保存在本地文件系统。

SQLite 只保存 metadata，例如：
- id
- filename
- path
- mime
- size
- hash
- created_at

不得把大量附件直接作为 SQLite BLOB 保存。

## 10. 本地数据位置规则

必须支持：
- 系统默认数据位置
- 用户自定义数据位置
- 数据位置迁移
- 附件位置管理
- 备份位置管理

迁移必须经过：

检查空间 → 暂停写入 → 创建安全备份 → 复制 → 校验 → 切换路径 → 重新打开 → 验证

迁移成功后不得立即自动删除旧数据。

## 11. 开发流程硬性规则

任何开发任务都必须遵循：

需求理解  
↓  
用户审核  
↓  
实施计划  
↓  
用户审核  
↓  
开始编码  
↓  
运行测试  
↓  
修复  
↓  
重新测试  
↓  
提交开发报告  
↓  
用户人工验收  
↓  
DONE

未经用户确认，不得跳过审核阶段。

## 12. Phase 规则

不允许跨 Phase 开发。

长期 Phase 顺序：
- Phase 0：项目技术评审
- Phase 1：App Shell + Core Architecture
- Phase 2：Task
- Phase 3：Canvas
- Phase 4：Diary + Notes
- Phase 5：Search + Tags + Archive + Trash
- Phase 6：Data Management + Backup
- Phase 7：LAN Device Sync
- Phase 8：AI
- Phase 9：未来扩展

## 13. 测试规则

没有实际运行的测试，不得写 PASS。

如果无法运行，必须明确写“未验证”或“无法验证”，并说明原因。

测试失败必须：发现失败 → 分析 → 修改 → 重测，直到通过，或形成明确阻塞问题提交用户决定。

## 14. UI 状态要求

正式页面必须考虑：
- Default
- Hover
- Focus
- Pressed（关键按钮）
- Disabled
- Empty
- Loading
- Error
- Offline（确有必要时）

## 15. Git / 修改规则

禁止一次修改大量无关模块。禁止顺手进行大规模无关重构。

禁止未经说明删除：
- Migration
- 数据库
- 配置
- 用户附件
- UI 规范
- 技术规范
- 重要源码目录

一个 Phase / 模块审核通过后再形成清晰 Commit。

## 16. Agent 的目标

Agent 的职责不是“尽快生成最多代码”。

正确目标是：可测试、可审核、可回退、可维护、数据安全、严格按设计实现、一个模块完成后再进入下一个模块。
