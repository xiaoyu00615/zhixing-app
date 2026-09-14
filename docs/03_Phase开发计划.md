# 03｜Phase 开发计划

版本：V1.1  
日期：2026-08-19  
状态：CURRENT

## Phase 0｜项目技术评审

### 目标

在创建正式工程和业务代码前，确认产品、技术架构、数据模型、Phase 边界不存在理解偏差。

### 当前禁止

- 不创建完整工程；
- 不安装正式依赖；
- 不实现 Task / Canvas / Diary / Note；
- 不实现 LAN Sync；
- 不实现 AI。

### 必须输出

1. 项目理解；
2. 页面与功能清单；
3. 技术架构检查；
4. 推荐目录结构；
5. 领域模型 / 数据模型初稿；
6. 风险清单；
7. Phase 1A / 1B 实施计划；
8. Phase 1 验收标准；
9. 需要用户确认的问题。

---

## Phase 1A｜App Shell + Native Core Architecture

### 目标

建立 Native / Windows 优先的工程地基，同时保持 Web UI 可运行。

### 内容

- Node.js 24 LTS / pnpm 工程；
- React + TypeScript + Vite；
- React Router；
- Tailwind CSS + Design Tokens；
- shadcn/ui + Lucide React；
- App Shell / Sidebar / Topbar；
- Theme / Appearance 基础；
- Zustand UI Store 基础；
- Tauri 2；
- Rust 基础工程；
- Native SQLite；
- Migration Runner；
- Repository Interface；
- Application Service Base；
- Native Database Adapter；
- StorageAdapter Base；
- Settings Base；
- Error Boundary / Error Model；
- Logging；
- UUID / 时间工具；
- Test Foundation。

### Foundation 提取原则

依赖真实领域与 caller 的 Repository、Application Service、Adapter、Error Model、UUID / Time 和 UI Store，不为了 Phase 清单形式完整而提前创建空接口、placeholder 或 generic abstraction。

禁止预先建立：

- `Repository<T>`；
- `ApplicationService<T>`；
- generic `DatabaseAdapter` / CRUD API；
- generic command bus；
- 向上层暴露 SQL 的 generic Worker API。

这些能力应从首个真实 vertical slice 的 use case 中提取。Phase 1A Foundation-Building Mode 可以在工程安全底座充分、但上述能力尚无真实 caller 时退出；Deferred、Blocked 或 Needs More Design 项不得因此写成 COMPLETED。

### 不做

- Task 业务 CRUD；
- Canvas 业务；
- Document 业务；
- 正式 Search；
- Backup；
- Sync；
- AI。

### 验收重点

- Web 开发环境启动；
- Windows Tauri 启动；
- App Shell / Router / Token 工作；
- Native SQLite 建库 / 写入 / 重启持久化；
- Migration 可执行；
- 不以空 Repository Interface 或 placeholder Test Adapter 作为退出门槛；真实 Repository contract 由首个 vertical slice 提取并通过跨平台 contract tests 验证；
- 无关键 Console / Rust 错误。

---

## Phase 1B｜Web Persistence + Web Repository Adapter

### 目标

在进入 Task 业务前，让浏览器版本也拥有真实本地持久化，不依赖 Mock 作为主数据。

首个真实 persistence contract 由经批准的 Task V1 domain / persistence contract 提供。允许在 Phase 1B 前置冻结该 contract，并在 Phase 1B 建立必要的 Native Task persistence reference slice；这属于跨平台 persistence enablement，不表示 Phase 2 Application Service 或 Task 产品 UI 已开始。

### 内容

- SQLite WASM；
- OPFS；
- Dedicated Worker 数据库执行层；
- 基于真实 Task capability 的 Worker protocol；
- Native Task persistence reference implementation；
- `WebTaskRepository`；
- Capability Detection；
- OPFS 不可用时的明确兼容提示 / 受限模式；
- Native / Web 共用 `TaskRepository` Contract；
- Native / Web contract parity；
- Web 持久化重启测试。

Phase 1B 不创建 generic Web CRUD、generic `DatabaseAdapter` 或向 Application / UI 暴露的 SQL query / execute API。Web Worker 内部可以执行实现已批准 Task capability 与 Migration 所必需的 SQL，但平台外部边界必须保持 capability-specific。

### 验收门槛

Phase 1A + 1B 均通过后，才能进入 Phase 2。Phase 1B COMPLETE 还要求 Task V1 contract 已批准、Native / Web persistence 已验证、浏览器真实重启持久化通过，且 OPFS 不可用时不得静默降级为易丢失的主数据存储。

---

## Phase 2｜Task

### Entry Boundary

Phase 2 只在 Phase 1B COMPLETE 后开始。Phase 1B 负责基于 Task contract 的跨平台 persistence enablement；Phase 2 才正式实现 Task Application Service、产品 UI 与业务交互。

### 内容

- Task CRUD；
- Status：todo / doing / completed / cancelled；
- Task List；
- 四象限；
- Calendar；
- Timeline（具体形态经 Phase 0 批准，不默认甘特图）；
- Task Detail Drawer；
- Create/Edit Modal；
- Importance；
- Urgency；
- Deadline；
- Overdue 动态计算；
- Project；
- Tag；
- Soft Delete / Trash Restore；
- Empty / Loading / Error；
- Task 与 Repository / Web / Native 的真实持久化。

### 暂不锁死

- Subtask 的物理模型；
- Timeline 是否使用 `start_at`；
- 历史日志是否进入 Phase 2 V1；
- 批量操作完整范围。

---

## Phase 3｜Canvas

### 内容

- Canvas List / Editor 分离；
- React Flow 基础；
- Node Types：text / sticky / image / link / task / note / diary；
- Canvas / CanvasNode / CanvasEdge 持久化；
- Drag / Zoom / Pan；
- Edge；
- Selection / Multi Select；
- Group：组合 / 整体移动 / 取消组合；
- Copy / Paste；
- Undo / Redo（Session History）；
- Node Property Panel；
- MiniMap；
- Canvas Editor Search；
- Linked Entity 失效状态；
- 图片 Node 文件存储。

### 不做

- AI 整理；
- Frame Node；
- 子画布；
- relation_type 强语义知识图谱；
- 多人协作；
- 云同步。

### Canvas V1 Status: COMPLETE AFTER FORMAL SCOPE REVISION

Phase 3 Canvas V1 于 2026-09-13 经正式产品 Scope Decision 关闭。关闭原因不是原始 Phase 3 全部条目均已完成，而是对原始 Phase 3 范围进行了正式修订，并明确保留历史计划可追踪性。

Phase 3 Canvas V1 保留为已完成的核心闭环：

- Canvas List / Editor；
- React Flow Core；
- Text Node；
- Sticky Node；
- Node Box；
- Canvas / CanvasNode / CanvasEdge persistence；
- Drag / Zoom / Pan；
- Edge；
- Selection；
- Multi Select；
- Collective Move；
- Node Box ordered membership；
- Node Box unordered membership；
- Node Box reorder；
- Copy / Paste；
- Internal Edge Copy；
- Undo / Redo；
- Move History；
- Selection Preservation；
- Context Menu；
- Node / Edge soft delete；
- Native persistence；
- Web persistence；
- Restart persistence；
- Unknown type safety。

正式从 Phase 3 移出的原始条目：

| 原 Phase 3 条目 | Scope Decision | 目标阶段 / 条件 |
|---|---|---|
| Group：组合 / 整体移动 / 取消组合 | DEFER TO CANVAS ENHANCEMENT | 当前 Multi Select、Collective Move、Node Box 已满足 V1 组织需求；未来仅在需要 persistent group identity 或 group / ungroup semantics 时设计 |
| Node Property Panel | DEFER TO CANVAS ENHANCEMENT | 当前 inline edit 与 Context Menu 覆盖 V1 核心属性操作；节点类型与属性数量显著增加后再设计 |
| MiniMap | DEFER TO CANVAS ENHANCEMENT | 大画布导航增强；实际大画布使用产生导航成本后引入 |
| Canvas Editor Search | MOVE TO SEARCH INTEGRATION | Phase 5 / Global Search 基础建立后，再决定 Global Search 与 Canvas-local Search 的公共索引 / query 机制 |
| Link Node | DEFER TO CANVAS ENHANCEMENT | 不阻塞 Canvas V1 与 Phase 4 Diary + Note |
| Image Node + 图片 Node 文件存储 | MOVE AFTER DOCUMENT CORE / SHARED ATTACHMENT CONTRACT | 两个项目作为一个整体迁移；先明确 Canvas / Note / Diary 可复用的 Attachment / File Asset Contract；SQLite 只存 metadata / references，真实图片存 local filesystem |
| Task Entity Node | MOVE TO LINKED ENTITY INTEGRATION | Task Domain 已存在，但缺少正式 Canvas ↔ Entity reference contract；不创建 Task Node 特例 |
| Note Entity Node | DEPEND ON PHASE 4 NOTE DOMAIN | Phase 4 Note Domain 完成后进入 Linked Entity Integration |
| Diary Entity Node | DEPEND ON PHASE 4 DIARY DOMAIN | Phase 4 Diary Domain 完成后进入 Linked Entity Integration |
| Linked Entity 失效状态 | MOVE WITH LINKED ENTITY CONTRACT | 与 entity reference、entity lifecycle、deleted state、unavailable state、open behavior 一起设计 |

Document Compiler / Processor 等能力继续保持 FUTURE ARCHITECTURE，不进入 Phase 3 closeout debt，包括：Processor、Document Compiler、Renderer Registry、Markdown Export、AI Processor、Auto Layout、Cross-canvas Paste、Node Box Nesting、Frame Node、Sub-canvas。

Phase 3 下一正式阶段：

- Phase 4｜Diary + Note。

---

## Phase 4｜Diary + Notes + Document System

### Document 基础

- Document Repository；
- type = diary / note；
- content_json + plain_text；
- Tag / Attachment / Entity Relation；
- Local Auto Save。

### Diary

- Today Diary；
- `diary_date`；
- Calendar；
- Timeline；
- Local Saved View / 智能日记夹；
- Tag；
- Related Content。

### Note

- Note List；
- Folder；
- Favorite；
- Tiptap Editor；
- Attachment；
- Related Content；
- Local Auto Save。

### 产品方向但非自动视为 V1 必做

- 转为 Task；
- 添加到 Canvas；
- 新建关联 Diary；
- 更多转换语义。

### Phase 4 Status: IN PROGRESS

Phase 4 已实际启动，官方状态由 `NOT STARTED` 更新为 `IN PROGRESS`。冲突来源：`docs/00_当前版本清单.md` 在 `ab8e7ec feat: add note and diary schema` 与 `add13e8 feat: add note and diary domain contracts` 进入 main 之后未及时同步。以 `add13e8e4ea510b516c26c818f0ffdacdcc33974` 为治理 baseline 修订本节。

已完成（DONE，使用真实历史 Step ID；不重新编号）：

- P4-00｜Phase 4 Boundary Design：Diary 使用独立 `diary_date`，Note 与 Diary 分域，不建立 Document 泛型 wrapper；
- P4-00A｜Contract Freeze；
- P4-01｜Migration Design Review；
- P4-02A｜Migration 0012 Foundation：`0012_add_notes_and_diary`，`notes` 与 `diary_entries` schema 进入 production migration history；CHECK constraint、`deleted_at_ms` 软删除与相关索引已冻结；
- P4-03｜Note / Diary Domain Contract：`src/note/model.ts` 与 `src/diary/model.ts`；
- P4-03A｜Shared Import + Repository Contract Repair：`src/note/repository.ts` 与 `src/diary/repository.ts`；`NOTE_REPOSITORY_ERROR_CODES` 与 `DIARY_REPOSITORY_ERROR_CODES` 与 Task 独立；
- P4-03B｜Non-Task Shared Validation Import Cleanup：canonical lowercase UUID 与非负 safe-integer ms timestamp 校验在 Native 侧复用。

进行中（IN PROGRESS）：

- P4-04B1｜Native Note Persistence（见下方 Scope）。当前 dirty implementation 保留，未 stage、未 commit。

明确 NOT STARTED：

- P4-04B2｜Web Note Persistence；
- P4-04B3｜Native / Web Parity Hardening；
- NoteService + runtime composition（含 `noteRuntime.native.ts`）；
- Note UI；
- Diary Persistence、Diary Service、Diary UI。

本节不合并 NoteService、runtime composition 或 Note UI 至 persistence step。后续仍须遵循 Plan → 用户/架构审核 → Implementation → Tests → Review → Commit 流程。

### P4-04B1｜Native Note Persistence（IN PROGRESS）

Scope：

- `src/note/repository.ts` persistence-ready input alignment：`CreateNoteInput` 显式 `id`；`UpdateNoteInput` / `SoftDeleteNoteInput` / `RestoreNoteInput` 显式 `updatedAtMs`；
- Rust `NoteDbService`：canonical lowercase UUID 校验、非负 safe-integer ms timestamp 校验、`NOT_FOUND` 与 `PERSISTENCE_ERROR` 结构化错误；
- 6 个 Tauri Note commands：`note_create`、`note_get_active_by_id`、`note_list_active`、`note_update`、`note_soft_delete`、`note_restore`；
- `NativeNoteRepository` 实现 `NoteRepository`；
- `NOTE_REPOSITORY_ERROR_CODES` 与 Task 保持独立冻结边界；
- Native adapter tests；
- Rust DB tests；
- Dedicated `NativeNoteRepository` 单元测试（P4-04B1 范围）。

明确不做（P4-04B1）：

- 无 Web implementation；
- 无 NoteService；
- 无 runtime composition；
- 无 `noteRuntime.native.ts`；
- 无 UI。

当前 dirty implementation 状态：IN PROGRESS，不得写为 DONE。缺少 dedicated `NativeNoteRepository` 单元测试、human review 与 git closeout。

P4-04B1 当前 uncommitted verification（WORKING TREE / UNCOMMITTED，非 committed baseline）：

- `cargo test`：`139 passed`（WORKING TREE / UNCOMMITTED）；
- `pnpm test`：`40 files / 639 passed`（WORKING TREE / UNCOMMITTED）；
- 上述计数为 dirty working tree 记录，不写入 `docs/00_当前版本清单.md` 的 committed baseline 字段；committed baseline 见该文档：Rust 129、Vitest 40 files / 639。

### P4-04B2｜Web Note Persistence（NOT STARTED）

Scope（后续独立 Step）：

- Worker protocol `note.*` request / response variants 与 parsers；
- Worker client `note` methods；
- `taskDatabase` 中 Note SQL 方法；
- `WebNoteRepository` 实现 `NoteRepository`；
- 现有 Web factory 集成（`Native`/`Web` capability detection 收口）；
- Web repository tests。

必须复用：

- existing Dedicated Worker；
- existing `TaskWorkerClient`；
- existing SQLite WASM runtime；
- existing OPFS DB；
- existing Web adapter selection 收口机制。

明确不做（P4-04B2）：

- 不新增第二套 Web Worker；
- 不新增独立 Web SQLite connection；
- 不提前引入 NoteService / runtime composition / UI。

### P4-04B3｜Native / Web Parity Hardening（NOT STARTED）

Scope（在 P4-04B1 + P4-04B2 均完成后）：

- 同一 `NoteRepository` 契约下 Native 与 Web 语义一致；
- Lookup 缺失或已软删除返回 `null`；
- Mutation 对缺失或状态冲突抛 `NOT_FOUND`；
- `title` 与 `content` 精确保存，不做 trim / normalize 之外的改写；
- `createdAtMs` 与 `updatedAtMs` 时间戳语义一致；
- List ordering 一致：`updated_at_ms DESC, id ASC`；
- Error code 映射安全，不外泄底层错误消息；
- Restart persistence parity。

### NoteService + Runtime Composition（LATER STEP）

`NoteService`、UUID generator injection、`nowMs` injection、`noteRuntime.native.ts`、以及可能的 Web runtime composition 属于 persistence 完成之后的独立 Step。P4-04B1 / P4-04B2 / P4-04B3 均不实现。

### Note UI（LATER STEP）

Note UI 属于独立的后续 Step，进入 UI 前需另开 Plan / 用户批准。

### Diary Tracking

- Schema：DONE（Migration 0012）；
- Domain Contract：DONE（`src/diary/model.ts` 与 `src/diary/repository.ts`）；
- Persistence：NOT STARTED；
- Service：NOT STARTED；
- UI：NOT STARTED。

已知设计 blocker（本轮不解决）：

- Web `sqlite-wasm` 当前尚未冻结 `DIARY_DATE_CONFLICT` 的可靠结构化 constraint classification 方案。Web 侧 SQLite constraint 错误（`SQLITE_CONSTRAINT_UNIQUE` 等）到 `DiaryRepositoryError` 的稳定映射需要在 Diary Persistence Step 之前完成设计决策；Native 侧不阻塞。

---


## Phase 5｜Global Search + Tags + Archive + Trash

### Global Search

- SQLite FTS5；
- Task；
- Canvas；
- CanvasNode；
- Note；
- Diary；
- CaptureItem；
- 结构化 Filter；
- Result Preview → Open Entity。

Global Search 默认排除 Trash。Archive 是否默认包含，在 Phase 5 UI 实现时最终确认。

### Tag

- 创建；
- 重命名；
- 颜色；
- 合并；
- 删除；
- 跨模块关联与筛选。

### Archive

- `archived_at` 方向评审；
- 归档；
- 恢复；
- Delete → Trash。

### Trash

- Soft Delete 管理；
- Restore；
- Permanent Delete；
- Clear Trash；
- 强确认；
- 默认不自动物理清理核心数据。

---

## Phase 6｜Data Management + Backup

### Storage

- 简单模式数据根目录；
- 高级模式分路径；
- 当前数据位置；
- 打开位置；
- 数据位置失效处理；
- 安全迁移；
- Cache 管理；
- Import / Export。

### Migration

- Pause Writes；
- Flush Pending Writes；
- SQLite Safety Snapshot；
- Temporary Target；
- Hash / `integrity_check`；
- Reopen / Verify；
- Atomic Switch；
- 旧目录保留直到用户确认。

### Backup / Restore

- Manual Backup；
- Auto Backup；
- Backup History；
- Portable Settings；
- Backup Manifest；
- Safety Snapshot；
- Staging Restore；
- Hash / DB / Attachment Integrity Check。

---

## Phase 7｜LAN Device Sync

### 原则

- 同一用户自己的设备；
- 每台设备独立 SQLite；
- Peer-to-Peer，无默认主设备；
- device_id + Trust Identity；
- IP 不是设备身份；
- 不共享 SQLite 文件；
- 不默认静默 Last Write Wins。

### 内容

- Device；
- Pair Code / QR；
- Trust；
- SyncChange；
- Revision；
- Cursor；
- Push / Pull / Ack；
- Tombstone；
- Conflict；
- Attachment Hash / Missing File Detection / File Transfer；
- Resume；
- Remove Device / Revoke Trust。

### 第一验收目标

Windows <-> Android。

Android UI 设计必须在本 Phase 正式验收前补齐。

---

## Phase 8｜AI

### 原则

AI 是嵌入式能力，通过 AIAdapter / AIService 接入，不作为一级主导航。

### 可能内容

- 自动标签；
- Note / Diary 总结；
- Canvas 分类与布局建议；
- 关系发现；
- 从内容提取 Task；
- 日期识别。

所有 AI 修改类操作优先 Preview → User Apply，不静默改写用户数据。

---

## Phase 9｜未来扩展

可能包括：

- 可选云同步；
- 账户；
- 更多平台；
- 插件体系；
- 高级知识图谱；
- 更多导出格式。

当前不开发。

## Phase 通用门禁

每个 Phase 必须：

```text
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
```

禁止同时推进多个未验收 Phase。
