# 03｜Phase 开发计划

版本：V1.1  
日期：2026-08-19  
状态：CURRENT

> Phase 6 当前状态段落于 2026-09-26 同步至 baseline `e2b80e19dd95c69558742a6935a1833ef7f90198`；Phase 7 当前状态段落于同日同步 P7-S0 架构设计结论（Human Review PASS）。

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

## Phase 4｜Diary + Notes（独立 domain；原设计含 Generic Document 已废弃）

> ⚠️ 设计变更：本 Phase 原计划含 Generic Document（`DocumentRepository`，`type = diary / note`）。实际实现已改为 **Note 与 Diary 独立 domain**：独立 repository、独立 service、独立 persistence contract（各自 `src/note/*` 与 `src/diary/*`），不建立 canonical Document 实体。以下「Document 基础」仅作历史设计追溯，不代表当前实现。

### Document 基础（历史设计，未实现）

- Document Repository（未实现；当前为独立 NoteRepository / DiaryRepository）；
- type = diary / note（未采用）；
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

### Phase 4 Status: CLOSED

Phase 4 已由 formal closeout commit `417dc90 docs: close diary v1 phase` 正式关闭。Note V1：CLOSED；Diary V1：CLOSED / COMPLETE（Diary V1 closeout commit `a89b63797d8c79ae590ceee76ba8715d6393df33`）。Phase 4 启动时官方状态曾由 `NOT STARTED` 更新为 `IN PROGRESS`，且本节下方「Diary Persistence / Diary Service / Diary UI：NOT STARTED」为彼时 slice 的历史记录，不反映当前已 CLOSED 状态（见下方历史标记）。

已完成（DONE，使用真实历史 Step ID；不重新编号）：

- P4-00｜Phase 4 Boundary Design：Diary 使用独立 `diary_date`，Note 与 Diary 分域，不建立 Document 泛型 wrapper；
- P4-00A｜Contract Freeze；
- P4-01｜Migration Design Review；
- P4-02A｜Migration 0012 Foundation：`0012_add_notes_and_diary`，`notes` 与 `diary_entries` schema 进入 production migration history；CHECK constraint、`deleted_at_ms` 软删除与相关索引已冻结；
- P4-03｜Note / Diary Domain Contract：`src/note/model.ts` 与 `src/diary/model.ts`；
- P4-03A｜Shared Import + Repository Contract Repair：`src/note/repository.ts` 与 `src/diary/repository.ts`；`NOTE_REPOSITORY_ERROR_CODES` 与 `DIARY_REPOSITORY_ERROR_CODES` 与 Task 独立；
- P4-03B｜Non-Task Shared Validation Import Cleanup：canonical lowercase UUID 与非负 safe-integer ms timestamp 校验在 Native 侧复用；
- P4-04B1｜Native Note Persistence：CLOSED，commit `110b5c69aba651f04a187821d63bcc60eb364664`；
- P4-04B2｜Web Note Persistence：CLOSED；
- NoteService + runtime composition（含 `noteRuntime.native.ts` 与 Web runtime）：CLOSED；
- Note UI（workspace）：CLOSED；
- Real Web persistence E2E（真实持久化在 reload 后存活）：CLOSED；
- 基础设施维护：shared Web persistence lifecycle coordination fix，commit `79beff55d16136ecc189975ad43572bedaa0ccd0`（CLOSED）。

Note V1 closeout commit：`d655340e8f3f7e960e93a8ca1cdd93dbd3df7f1f`，commit message `feat: add note workspace`。

Note V1 closeout 后 committed gates（main HEAD `d655340`）：

- Vitest：`809 passed / 0 failed`（`49 test files`）；
- Playwright：`41 passed`（含 Note persistence E2E）；
- typecheck、lint、build：PASS；
- `git diff --check`：PASS。

明确 NOT STARTED：

- P4-04B3｜Native / Web Parity Hardening；
- Diary Persistence、Diary Service、Diary UI。

NEXT（design first，NOT implementation）：

- Diary design / contract audit：在安排 Diary Persistence 之前先完成设计与契约审计（含 Web `sqlite-wasm` constraint classification 决策）。

本计划不提前实现 Diary；本节不在这里设计 Diary 内容。后续仍须遵循 Plan → 用户/架构审核 → Implementation → Tests → Review → Commit 流程。

### P4-04B1｜Native Note Persistence（CLOSED）

Closeout commit：`110b5c69aba651f04a187821d63bcc60eb364664`，commit message `feat: add native note persistence`。

完成范围：

- `src/note/repository.ts` persistence-ready input alignment：`CreateNoteInput` 显式 `id`；`UpdateNoteInput` / `SoftDeleteNoteInput` / `RestoreNoteInput` 显式 `updatedAtMs`；
- Rust Note DB persistence（`NoteDbService`）：canonical lowercase UUID 校验、非负 safe-integer ms timestamp 校验、`NOT_FOUND` 与 `PERSISTENCE_ERROR` 结构化错误；
- 6 个 Tauri Note commands：`note_create`、`note_get_active_by_id`、`note_list_active`、`note_update`、`note_soft_delete`、`note_restore`；
- Native Tauri command registration；
- Native adapter 导出；
- `NativeNoteRepository` 实现 `NoteRepository`；
- `NOTE_REPOSITORY_ERROR_CODES` 与 Task 保持独立冻结边界；
- Dedicated `NativeNoteRepository` 单元测试；
- Rust DB tests；
- Full verified gates：cargo test、Vitest、typecheck、lint、build 均 PASS。

明确不做（P4-04B1，不作为本 Step 交付）：

- 无 Web implementation；
- 无 NoteService；
- 无 runtime composition；
- 无 `noteRuntime.native.ts`；
- 无 Note UI；
- 无 Diary persistence。

P4-04B1 closeout 后 committed baseline（main HEAD `110b5c6`）：

- `cargo test`：`139 passed / 0 failed / 0 ignored`；
- `pnpm test`：`41 test files / 654 passed`；
- typecheck、lint、build：PASS。

历史 baseline（供追溯，不再作为 current main baseline）：

- Task V1 closeout：Rust 129 / Vitest 40 files / 639 tests；
- Canvas Phase 3 closeout：Rust 129 / Vitest 40 files / 639 tests；
- `add13e8 feat: add note and diary domain contracts`：Rust 129 / Vitest 40 files / 639 tests；
- P4-04B1 commit `110b5c6` 后更新为上表新数字。

### P4-04B2｜Web Note Persistence（CLOSED）

Closeout：随 Note V1 closeout commit `d655340e8f3f7e960e93a8ca1cdd93dbd3df7f1f` 提交至 main。

完成范围：

- Worker protocol `note.*` request / response variants 与 parsers；
- Worker client `note` methods；
- `taskDatabase` 中 Note SQL 方法；
- `WebNoteRepository` 实现 `NoteRepository`；
- 现有 Web factory 集成（`Native`/`Web` capability detection 收口）；
- Web repository tests；
- 真实 Web persistence 验证（reload 后数据存活）。

复用边界（已保持）：

- existing Dedicated Worker；
- existing `TaskWorkerClient`；
- existing SQLite WASM runtime；
- existing OPFS DB；
- existing Web adapter selection 收口机制；
- 未新增第二套 Web Worker 或独立 Web SQLite connection。

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

P4-04B1 closeout 中的 Native restart verification 属于 contract-equivalent / infrastructure evidence（Native 侧 restart 数据不丢），不等于 Native/Web restart parity；真正跨平台 restart parity 仍留给 P4-04B3。

### NoteService + Runtime Composition（CLOSED）

随 Note V1 closeout commit `d655340e8f3f7e960e93a8ca1cdd93dbd3df7f1f` 完成：`NoteService`、UUID generator injection、`nowMs` injection、`noteRuntime.native.ts` 与 Web runtime composition 均已进入 production。

稳定的 Note application contract 摘要（完整规范仍以 spec 为准）：

- `NoteApplicationError`：`VALIDATION`、`NOT_FOUND`、`UNAVAILABLE`；
- identity：canonical lowercase UUID；
- 空 title 合法；空 content 合法；
- Markdown source 精确保存；
- UI placeholder `无标题` 仅用于展示。

### Note UI（CLOSED）

随 Note V1 closeout commit `d655340e8f3f7e960e93a8ca1cdd93dbd3df7f1f` 完成：Note workspace（列表 + 编辑器）。

当前 committed 产品行为：

- 创建空 Note；
- Note list / editor workspace；
- autosave；
- dirty-switch flush（切换条目时先落盘再切换）；
- 删除确认 + 软删除；
- StrictMode lifecycle regression 已修复；
- 真实持久化在 reload 后存活。

### Shared Web Persistence Lifecycle（CLOSED，infrastructure maintenance）

Closeout commit：`79beff55d16136ecc189975ad43572bedaa0ccd0`（`fix: coordinate web persistence lifecycle`）。

共享 core 的稳定事实（摘要，不展开实现细节）：

- 默认语义下多次 open 共享同一个 generation；
- 每个调用方持有独立 lease；
- dispose 幂等；
- 最后一个 lease 释放时执行 shutdown；
- closing 与 reopen 串行化；
- 显式的 worker / capability test options 仍保持非共享。

`WebTaskRepository` 的 shared lifecycle 在当前状态标记为 CURRENT_SHARED。

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

### Phase 5 Status: CLOSED

- Global Search V1：CLOSED（S0–S5 全部 CLOSED；closeout commit `a571955 fix: complete global search v1`）；
- Unified Trash V1：CLOSED（P5B S4 已验证，closeout 在 P5C-S4 slice 完成）；
- Archive V1：CLOSED after S4 verification（implementation baseline `7bb3093a9718531617c5c8354eb4f98f64891dcd`）；
- Tags V1（Task-only）：CLOSED（create / list / rename + Task assign / remove / filter + Native / Web 持久化；closeout 在 P5D-S2 slice 完成）；
- Phase 5 整体：CLOSED（四项 V1 均完成）。

### Global Search（V1 已实现并通过真实 Web E2E）

- SQLite FTS5（trigram，中文友好）；
- 当前 V1 真实实体范围（已实现）：Task（title）、Note（title + content）、Diary（title + content）、Canvas（title）；
- 当前 V1 不包含（future / planned）：CanvasNode、CaptureItem、Tag、Archive、Trash；
- 跨域统一结果流；
- 结构化 Filter（future / planned）；
- Result Preview → Open Entity。

Global Search 默认排除 Trash 与 archived Task / Note（active-only 谓词 `deleted_at_ms IS NULL AND archived_at_ms IS NULL`）；该 Archive 排除策略已在 P5C-S4 冻结，不再待 Phase 5 UI 确认。

### Tag（V1 CLOSED — Task-only）

当前 V1 已实现（CLOSED）：

- 创建（create）；
- 列出（list）；
- 重命名（rename）；
- Task 添加标签（assign）；
- Task 移除标签（remove）；
- 按标签过滤 Task（filter）；
- Native / Web 持久化 + reload 存活。

以下为 future / planned，不阻塞 Phase 5 / Tags V1 关闭：

- 标签颜色（color）；
- 标签合并（merge）；
- 标签删除（delete，NEEDS DESIGN）；
- 跨模块关联与筛选（Note / Diary / Canvas / CaptureItem）；
- Tag Search 索引；
- 独立 TagsPage。

### Archive（P5C Archive V1，CLOSED）

- `archived_at_ms` 方向已冻结：nullable，与 `status` 正交，不是 Task / Note status；
- 归档（Task + Note）；
- 恢复（Unarchive，Task + Note）；
- Delete → Trash（不允许从 Archive 直接物理永久删除）；
- Archive → Trash → Restore 保留 archived 状态；
- 普通 Search 排除 archived 实体，Unarchive 后恢复。

V1 未实现（future / planned）：Diary Archive、Canvas Archive、Permanent Delete from Archive、Clear Archive、Bulk Archive/Unarchive、Archive Search。

### Trash（P5B Unified Trash V1，CLOSED）

当前 V1 已实现：

- Task / Note / Diary 跨域统一列表；
- 单项 Restore（只走 canonical 源域服务）；
- 软删除期间排除 Search，Restore 后重新纳入；
- 默认不自动物理清理核心数据。

未来产品方向（V1 未实现）：Permanent Delete、Clear Trash、Bulk Restore / 多选、Trash 内筛选 / 检索、Canvas Trash。

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

### Phase 6 当前状态

> 以上 Storage / Migration / Backup / Restore bullets 是 Phase 6 原始产品 roadmap，予以保留。

状态：**CORE BACKEND CLOSED / PRODUCT SURFACE PARTIAL**。

Core Backend slices：P6-S4 Maintenance Foundation、P6-S5 Native Backup V1、P6-S6 Backup Inventory + Verification、P6-S8 Native Database Restore V1、P6-S9 Native Data Root Migration V1，全部 FORMALLY CLOSED / REMOTE CLOSED。

closeout commit：`e2b80e19dd95c69558742a6935a1833ef7f90198 feat: add native data root migration v1`。

#### Implemented

- Strong Maintenance Foundation（Weak + Strong quiescence、owner-scoped release、`MAINTENANCE_BUSY`）；
- **Database** Backup V1（Native；SQLite Online Backup + manifest + SHA-256 + `integrity_check` + staging 原子发布）；
- Backup Inventory / Verification（Native；四态分类；`list` 与 `verify` 分离）；
- **Database** Restore V1（Native；Safety Backup → staging → 原子替换 → rollback → IPC / 崩溃启动恢复）；
- **Simple** Data Root Migration V1（Native / Windows；whole-root 保留、原子 bootstrap 切换、rollback、old-root retention、runtime handoff）。

#### Deferred / Not Implemented

- 高级模式分路径（Advanced split storage）；
- Auto Backup；
- Portable Settings Backup / Restore；
- Attachment Backup / Restore；
- Web Backup / Restore；
- Backup retention / delete；
- Phase 6 UI surfaces（Backup History UI、Manual Backup UI、Verify UI、Restore UI、Migration UI、Recovery UI、Auto Backup UI）。

限制：Backup / Restore 为 Database-only，不含 Attachment 与 Portable Settings；Data Root Migration 为 Simple Data Root-only，当前仅 Native / Windows。

---

## Phase 7｜LAN Device Sync

### 原则

- 同一用户自己的设备；
- 每台设备独立 SQLite；
- Peer-to-Peer，无默认主设备；
- `device_id`（稳定设备标识）**≠** Trust Identity（密码学身份）；
- IP 不是设备身份；
- 不共享 SQLite 文件；
- Backup / Restore ≠ Sync；
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

### Phase 7 当前状态

- Phase 7 **implementation**：**NOT STARTED**（未写 networking、未创建 sync tables、未实现 Pair Code）。
- **P7-S0**｜Phase 7 Boundary / Threat / Identity / Sync Model Design：**COMPLETE / HUMAN REVIEW PASS**。
- Architecture：**PARTIALLY FROZEN**。
- 本轮概念范围（Device / Pair Code / Trust / SyncChange / Revision / Cursor / Push·Pull·Ack / Tombstone / Conflict / Attachment / Resume / Remove Device）**具体物理模型 NOT FROZEN**，见 P7-S0 报告。

FROZEN（已批准、可正式冻结）：

- Boundary（IN / OUT of scope）与概念职责分离；
- Threat principles（LAN 不可信、默认 fail-closed）；
- Identity separation（`device_id` ≠ Trust Identity；Trust Identity 属 Device-local；device secret 不得随 Backup / Restore 跨设备恢复）；
- Sync safety invariants（同事务原子性、change identity 不得依赖可回滚 seq、Restore × Sync 需 epoch / incarnation、no silent LWW、Search 不同步、maintenance 复用、authenticated encrypted transport 要求）。

NOT FROZEN（留待后续 slice）：exact causal model（VV / Dotted VV / HLC）、exact CRDT·relation 算法（OR-Set 仅候选）、crypto backend、transport implementation、全部物理表结构。

下一动作（待显式授权）：

```text
P7-S1 Device Secret / Trust Store Architecture Research
```

不得直接进入：networking 实现、创建 sync tables、实现 Pair Code。

后续 slice（未开始）：P7-S1.5 crypto selection review；P7-S2 Android Target Bring-up（最大未知风险，建议尽早）；P7-S3 Sync Data Model；P7-S4 Change Capture；P7-S5 Transport & Protocol；P7-S6 Pairing & Device Management；P7-S7 Core DB Sync；P7-S8 Conflict Handling；P7-S9 Windows ↔ Android E2E。

#### 已具备的 Ready foundation

- `stable device_id`（bootstrap 持久化、重启不变、Data Root Migration 明确保留、不进入 portable backup）；
- SQLite / 本地域持久化（Task / Note / Diary / Canvas / Search / Archive / Trash / Tag / Project）；
- migration infrastructure（MigrationRunner + production migration history）；
- maintenance / data safety barrier（Weak + Strong quiescence、owner permit 与 ordinary permit 分离、fail-closed）。

#### 尚未设计（属 Phase 7 后续 slice）

- Trust Identity（当前无 keypair / trust store / peer identity / pairing credential / revocation）；
- Pairing credentials；
- SyncChange / Revision / Cursor / Tombstone 物理模型；
- Conflict model 物理模型；
- network transport 实现。

`device_id` 不等于 Trust Identity：它只是稳定设备标识，不含密钥与授信关系。

#### Attachment

当前尚无共享 Attachment / File Asset contract 与 attachment hash model。该缺失**只阻塞 Attachment Sync 子切片**（Hash / Missing File Detection / File Transfer），**不阻塞** Phase 7 架构设计；不得扩大为整个 Phase 7 的 blocker。

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
