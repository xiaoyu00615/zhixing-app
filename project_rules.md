# 知行项目长期开发规则

版本：V1.1  
日期：2026-08-19  
状态：CURRENT / FROZEN BASELINE  
适用对象：TRAE、其他代码 Agent、人工开发者

## 1. 文档地位与真值优先级

本文件是项目长期开发的最高级工程行为规则之一。发生冲突时按以下优先级执行：

1. 当前用户明确指令；
2. `/docs/00_当前版本清单.md` 中标记为 CURRENT 的最新批准规范；
3. 本 `project_rules.md`；
4. 最新批准《全局 UI 设计规范》；
5. 最新批准《技术架构与开发技术栈规范》；
6. 当前模块已冻结设计图；
7. 历史文档；
8. Agent 自行判断。

`/docs/archive/` 中的文件仅用于历史追溯，不得作为当前开发依据，除非用户明确要求。

## 2. 项目定位

“知行｜个人知识与行动中枢”是一个：

- 单用户；
- 本地优先（Local First）；
- 离线优先（Offline First）；
- 数据由用户掌控；
- Web / Windows Desktop / Android 多端发展的个人效率软件。

核心模块：

- 首页；
- 任务；
- 无限画布；
- 日记；
- 笔记；
- 全局搜索；
- 标签；
- 归档；
- 回收站；
- 数据与存储；
- 备份与恢复；
- 自己设备之间的局域网同步；
- 后续 AI 辅助能力。

## 3. 严禁偏离的产品边界

本项目不是多人 SaaS。禁止擅自增加：

- 团队、组织、成员、负责人、协作者；
- 多人头像、在线成员、Presence；
- 团队评论、多人权限、工作空间邀请；
- 公开分享、云空间套餐、会员体系、社交系统；
- 任何未经批准的远程销毁其他设备数据能力。

“设备同步”仅表示同一个用户自己的设备之间同步自己的数据。

## 4. 当前 UI 冻结状态

以下四批设计理解已经冻结：

- Batch 01：`design/1.基础UI.png` + `design/2.首页.png`；
- Batch 02：`design/3.任务.png` + `design/4.画布.png`；
- Batch 03：`design/5.日记 - 笔记.png` + `design/6.搜索.png`；
- Batch 04：`design/7.设置.png`。

设计图片只用于视觉与交互结构参考。禁止根据 PNG/JPG 文件实际像素反推 CSS 尺寸。

当前 UI 真值：

- 主设计基准：1920 × 1080；
- 响应验证：1440 × 900；
- 最低桌面宽度：1280 px；
- Sidebar：224 px；
- Topbar：60 px；
- 默认正文：14 px；
- 默认按钮 / Input：36 px；
- 标准 Card：12 px 圆角；
- Modal / Drawer：16 px 圆角；
- Task Detail Drawer：约 420 px；
- 主要间距：8 / 12 / 16 / 24 / 32 px。

## 5. 技术栈原则

技术栈以最新批准《技术架构与开发技术栈规范》为准。未经明确批准不得自行替换：

- React；
- TypeScript；
- Vite；
- React Router；
- Tailwind CSS；
- shadcn/ui；
- Lucide React；
- Zustand；
- React Hook Form；
- Zod；
- React Flow / `@xyflow/react`；
- Tiptap；
- Tauri 2；
- Rust；
- SQLite / FTS5；
- Vitest；
- Playwright。

如认为需要调整，必须先提交：问题、替代方案、收益、成本、迁移影响、长期维护风险，并等待批准。

## 6. 架构硬性规则

统一采用：

```text
UI Component
    ↓
Application Service
    ↓
Repository Interface
    ↓
Adapter
    ↓
SQLite / OPFS / File System / System API
```

React Component 不允许直接执行 SQL；业务页面不得直接散落 `db.execute(...)`。

持久业务数据的事实来源是 Repository / 本地数据库，不是 Zustand。

## 7. 核心实体统一规则

核心业务实体的**业务字段**由各 domain contract 决定；不得仅因旧的通用预留规则，把所有业务表强制成同一字段集合。

当前已确立的通用约定（按各 domain 的真实 Schema 描述，不得据此凭空新增字段）：

- `id`（UUID）；
- `created_at` / `updated_at`；
- `deleted_at`（Soft Delete）；
- 需要归档能力的实体优先考虑 `archived_at nullable`。

真实 Schema 以已批准的 migration history 为准；本规则**不得**被解读为要求给现有业务表补 `revision` / `device_id`。

**同步元数据不属于业务实体字段基线。** Phase 7 的同步 identity / revision / causality metadata（`revision`、origin device、causal context、sync tombstone 等）**不得**仅因旧的通用预留规则而强制写入所有业务表。它们是否需要按行存储、还是独立存在于同步层（SyncChange / SyncState / Tombstone / Conflict 等），由 **Phase 7 Sync Data Model** 单独设计；具体物理模型 NOT FROZEN。

核心删除默认 Soft Delete。Permanent Delete 只能从 Trash 发生。

## 8. Task 冻结规则

Task 的业务 status 固定为：

- `todo`；
- `doing`；
- `completed`；
- `cancelled`。

`Archive` 不是 status。

`Overdue` 是动态计算：

```text
due_at < now
AND status != completed
AND status != cancelled
```

`Importance` 与 `Urgency` 必须分离：

- Importance：用户判断“是否重要”；
- Urgency：时间压力 / 截止时间产生的紧急程度。

Overdue 可以影响 Urgency，但不得自动修改 Importance。

四象限由 Importance + Urgency 共同决定。

`Project` 为 Task 内部轻量分组实体，不是一级导航。`task.project_id` 可为 nullable。

Project 与 Tag 必须区分：Project 仅服务 Task；Tag 是跨模块用户标签。

Timeline 当前不得自行定义为甘特图，也不得因此提前增加 `start_at`。

子任务具体数据结构留到 Phase 0 决定。

## 9. CaptureItem / QuickCapture 冻结规则

首页“最近记录”不等于 Diary。

新增轻量实体：`CaptureItem / QuickCapture`，用于承接快速捕捉的碎片信息，可后续转换或关联到：

- Task；
- Note；
- Diary；
- Canvas。

首页快速记录位于正常文档流最后一个模块，不是 Sticky Footer。

如保留 `@`，其语义为引用本地实体，不表示 @人员。

## 10. Diary / Note 冻结规则

Diary 与 Note 在产品层是两个独立模块；在架构层是**两个独立领域（separate domains）**，不是 `Document` + `type = diary | note` 的统一实体。

- 各自独立的领域模型：`src/note/model.ts` 与 `src/diary/model.ts`；
- 各自独立的 Repository 契约：`NoteRepository` 与 `DiaryRepository`；
- 各自独立的 Application Service 与错误语义：`NoteApplicationError` 与 `DiaryApplicationError`；
- 各自独立的持久化表：`notes` 与 `diary_entries`（均由 Migration 12 `0012_add_notes_and_diary` 建立）。

二者允许的复用（Reuse Before Create，composition over premature genericization）：

- 共享校验：`@/shared/validation` 中的 canonical lowercase UUID 与非负 safe-integer ms timestamp 校验；
- 共享 Web 持久化基础设施：`WebTaskRepository` 共享 generation / lease / dispose 生命周期，Diary 仅是另一个使用该 generation 的 repository；
- 共享 Worker / client / database 生命周期；
- 共享 UI primitives 与实现模式（如 NotesPage 与 DiaryPage 的 workspace / autosave / StrictMode 模式）。

严禁引入：`DocumentRepository`、`DocumentService`、`BaseDocument`、`GenericCrud`，或任何以 `type = note | diary` 区分的统一 Document 实体。

`tag_ids`、`attachment_ids` 不作为实体的数组字段；它们是实体关联关系。

Diary 使用独立逻辑日期字段，暂命名 `diary_date`，与 `created_at / updated_at` 分离，以支持补写过去日期。

不锁死 Diary title = 日期；标题策略在 Phase 0 决定。

“智能日记夹”是本地规则筛选 / Saved View，不是 Note Folder，也不依赖 AI。

Note 支持 Folder，但当前不锁死必须多层级嵌套。

本地自动保存必须可靠；不锁死具体 debounce 毫秒值，不依赖 `beforeunload` 作为主要数据安全机制。

## 11. Canvas 冻结规则

Canvas 必须拆分：

- Canvas；
- CanvasNode；
- CanvasEdge。

禁止整个 Canvas 只保存为一个巨大 JSON。

画布列表页与画布编辑器分离；编辑器默认不常驻完整画布列表和大型 AI 面板。

Phase 3 初始 Node Types：

- `text`；
- `sticky`；
- `image`；
- `link`；
- `task`；
- `note`；
- `diary`。

Group 是组织能力；Frame 不是已批准 V1 Node Type。

Undo / Redo 使用 Command / History + 内存 Undo Stack；数据库持久化最终 Node / Edge 状态，不要求永久记录每一步操作历史。

CanvasEdge V1 首先是普通连线；`relation_type` 仅可作为未来扩展预留，不得成为 V1 必填能力。

Task / Note / Diary 被 Soft Delete 时，对应 CanvasNode 不级联删除；Node 保留并显示关联失效状态，允许恢复、重新关联或删除 Node。

`content_json` 必须按 Node Type 建立明确 TypeScript Schema；关联实体节点不能复制完整业务实体，`linked_entity_type + linked_entity_id` 是关联真值。

Canvas Editor Search = 当前画布节点；Global Search = 跨所有 Canvas / CanvasNode。

AI 正式实现属于 Phase 8，不属于 Phase 3。

## 12. Search / Tag / Archive / Trash 冻结规则

Ctrl+K = Command Palette，负责快速导航、快速命令、快速创建、最近访问；不承担全文搜索职责。

Global Search 是独立本地全文搜索页面。实体结果范围基线：

- Task；
- Canvas；
- CanvasNode；
- Note；
- Diary；
- CaptureItem。

Attachment metadata 可后续加入。

Project 是筛选维度，不是 Search Result Entity Type；Favorite 是实体属性 / 特殊视图，不是实体类型。

Tag 是跨模块自定义标签；Folder、Project、Badge、Status 均不是 Tag。

Archive 不是 Task status。归档内容默认从主要工作页面隐藏，可恢复。

Archive 中执行 Delete 必须进入 Trash；Archive 页面不得直接 Permanent Delete。

Global Search 默认排除 Trash 内容。Trash 自己可以提供搜索 / 管理。

V1 不默认自动物理清空 Trash；未经用户明确永久删除，不自动销毁核心数据。

Attachment 当前不作为 Trash 的独立一级内容类型。

## 13. Storage 冻结规则

存储位置支持两级模式：

### 简单模式

用户只设置一个“知行数据位置”，内部自动管理：

```text
database/
attachments/
thumbnails/
backup/
metadata/
```

### 高级模式

允许分别配置 Database / Attachments / Backup / Cache。

核心 SQLite 主库必须位于本机文件系统，不允许 NAS / SMB / 普通网络共享作为实时主库。

Cache 仅表示明确可重新生成内容，例如缩略图、预览图、临时文件、渲染缓存。不得因为“清缓存”删除正式业务数据或默认删除 FTS5 数据结构。

数据位置失效时必须提示“无法访问当前数据位置”，提供重试、重新连接磁盘、定位已有数据目录、重新指定位置、从 Backup 恢复等入口；禁止自动创建新空数据库。

## 14. 安全迁移规则

迁移不是修改路径字符串。

方向：

```text
检查目标位置与空间
→ 暂停应用层写入
→ flush pending writes
→ 建立 SQLite 安全快照 / 备份
→ 复制到临时目标
→ Hash / integrity_check
→ 从新位置重新打开并验证
→ 切换正式配置
```

不得依赖直接复制运行中的 sqlite + `-wal` + `-shm` 作为一致性方案。

迁移成功后不得立即自动删除旧数据。

## 15. Backup / Restore 冻结规则

Backup 是数据安全 / 历史恢复；Sync 是多设备数据一致，两者互不替代。

完整 Backup 原则上包含：

- SQLite Database；
- Attachments；
- Portable Settings；
- Backup Manifest。

Settings 必须区分：

- Portable Settings：可迁移用户偏好；
- Device-local Settings：`device_id`、本机绝对路径、Pairing / Trust 凭证、系统权限等，不得被另一个设备的 Backup 无脑覆盖。

Device Identity 的 private key material **不属于 Backup 内容**：它既不进入业务 SQLite，也不进入 Database Backup、Portable Settings 或 Data Root。**禁止**出现「完整备份 / 恢复即可把设备身份复制到另一设备」的语义。

Data Root Manifest 与 Backup Manifest 是两个独立文件格式，可复用部分类型定义但职责不同。

Restore 优先采用 Staging Restore：先在临时恢复区解包并完成 Manifest / Hash / Database / Attachment 校验，再切换为正式数据；Restore 前仍必须创建当前数据 Safety Snapshot。

## 16. Device Sync 冻结规则

每台设备都有独立本地数据库，通过 Sync Engine 同步，不共享同一个 SQLite 文件。

所有设备是对等 Peer，不存在“主设备 / 从设备”默认概念。

设备身份依赖稳定 `device_id + 配对信任信息`；IP 地址只是当前连接信息，不是设备身份。

Pair Code / QR Code 是临时配对凭证，不是永久密码；具体长度、过期时间、算法留到 Phase 7。

Remove Device = 撤销 Trust；不得远程删除另一设备业务数据，也不得因为对方离线而阻止本机撤销。

Sync 状态不做多人 Presence 系统，优先使用“可连接 / 不可连接 / 正在同步 / 同步完成 / 需要处理”等设备状态。

不得默认用静默 Last Write Wins 丢弃用户数据。不可安全自动合并时必须进入 Conflict。**`updatedAtMs` 较新不得自动取胜**（时钟漂移 / 离线 / 并发写使时间戳不足以作为冲突真值）。无法安全自动合并时：保留双方 → 持久 Conflict → 用户解决；Note / Diary 正文 V1 不得静默覆盖。

`device_id` **不等于** cryptographic Trust Identity：它只是稳定设备标识，不携带密钥、不能用于认证。Trust Identity 属于 Device-local state，需要密码学身份；**private key / device secret 不得随普通 Database Backup / Restore 被恢复到另一设备**。

**Device Identity 存储方向（P7-S1 + P7-S1R，HUMAN REVIEW PASS）**：backend 方向已由 `P7-S1 Device Secret / Trust Store Architecture Research` 与 `P7-S1R Windows CNG / TPM Secret Backend Review`（Human Review PASS）研究并冻结方向；本规则仍**不选具体库、不装依赖**。以下是永久不变量：

- **operation-oriented Device Identity**：共享 capability 围绕 `ensure identity` / `status` / `public identity` / `sign` / `key agreement where required` / `explicit reset·rotation` 设计；
- **no `getPrivateKeyBytes` shared contract**：禁止把「导出私钥字节」类入口（含任何等价命名）写进 shared contract；
- **private identity material 是 Device-local**：不进入业务 SQLite、不进入 Database Backup、不进入 Portable Settings、不进入 Data Root；
- **无 Backup / Restore 可移植性**：不得因未来「完整备份」而把设备身份私钥复制到另一台设备；
- **Windows 存储方向**：Preferred = Microsoft Platform Crypto Provider（TPM-backed）；Fallback = Microsoft Software Key Storage Provider（CNG key isolation）；两者皆不可用 ⇒ Sync identity = UNAVAILABLE，**fail closed**；
- **no silent raw-byte downgrade**：provider-managed key 不可用时不得静默回退到原始字节凭据存储；Credential Manager / DPAPI 仅保留为 raw-byte fallback candidate，**不是** preferred identity backend；
- **no silent key regeneration**：`device_id` 存在但身份私钥不可用时，结果为 Sync unavailable / fail closed 并保留 trust 证据，**绝不**自动重建；必须由用户显式 repair 或 reset identity / re-pair；
- **Restore / Migration × crypto identity**：Database Restore **旋转 sync epoch**，但**不改变** cryptographic device identity；Data Root Migration **既不改变** crypto identity，**也不改变** sync epoch（same device ≠ new device）。

以下**不**写成永久冻结规则：exact algorithm / curve / key size、exact API method names、physical trust metadata format；三者分别留待 Identity Crypto Design 与 Sync Data Model。

Device-local trust 数据区分两类，**不要求相同物理存储**：

- **DeviceSecret**（private key、pairing secret、其他密码学 secret）：高度敏感 Device-local state；
- **device-local trust metadata**（trusted peer public identity、fingerprint、display name、revocation status）。

Change capture 必须满足**同事务原子性**：business mutation 与其对应的 SyncChange 必须落在同一事务，不得出现「业务已提交但 sync change 缺失」。具体代码结构（persistence-layer dual-write 等）DEFER 到 Sync Data Model / implementation design。

Change identity **不得**只依赖 `(device_id, restorable monotonic seq)`：Database Restore 会造成 sequence rewind ⇒ identity collision。方向为 globally unique random identity（UUID-style）。

**Restore × Sync 不变量**：Database Restore 可能回滚 business rows / sync journal / cursor / sequence，因此 Phase 7 必须具备 device incarnation / sync epoch 或等价 restore-safe 机制；Restore 成功后不得继续盲信旧 cursor 与旧 sequence identity。**Data Root Migration = same device ≠ new device**，不得仅因 data root 路径变化而旋转 device identity。

因果性：Sync protocol 必须能够区分 causally newer / causally older / concurrent / duplicate；**wall-clock only 不足**。具体 causal representation（Version Vector / Dotted Version Vector / HLC / 其他 bounded causal representation）留待 Sync Data Model slice 决定。

关系（如 `task_tags`）必须解决 add / remove 并发；物理删除必须有 tombstone / deletion event 或等价传播证据。OR-Set 仅为候选，**不是** V1 强制算法。

Search / FTS 是 **derived local projection**，不得作为跨设备业务真值同步；正确方向是 business data sync → 对端本地 triggers / rebuild → 本地 Search projection。

**不参与同步**（NOT SYNCED）：search / FTS projection、`schema_migrations`、backup bundles、restore operation journal、data-root-migration journal、`bootstrap.json`、private trust secrets、device-local paths / settings。

Maintenance：Sync **必须复用** Phase 6 Maintenance admission / barrier；Restore / Data Root Migration 进入 exclusive maintenance 时，已有 sync DB work 必须 drain、新 sync apply 不得进入。**禁止**引入第二套 DB global lock。

Transport：必须是 **authenticated encrypted transport**，需满足 Windows + Android、mutual device authentication、MITM resistance、reconnect、batching、backpressure。候选方向为 Noise-family 或 TLS 1.3 with pinned device identity；最终选择 DEFER 到 transport research。**禁止 custom crypto。**

Sync Engine 实现层面：**Rust Native Core 为 RECOMMENDED ARCHITECTURE DIRECTION**（理由：SQLite transaction、networking、crypto、Windows + Android 复用、maintenance 集成），不是「唯一理论可行方案」。

Phase 7 V1 第一验收目标为 **Windows ↔ Android**；**Web Sync 对 V1 为 OUT OF SCOPE**，共享逻辑模型仍应尽量保持平台无关。

Attachment Sync 不同步另一设备的实际路径；同步 metadata + hash + bytes，目标设备由自己的 StorageAdapter 决定保存位置。Attachment Sync **implementation 当前 BLOCKED**（no shared File Asset contract / no production writer / no hash ownership），但该缺失**不阻塞** Phase 7 核心架构。

P7-S0 冻结粒度：**Boundary / Threat principles / Identity separation / Sync safety invariants = FROZEN**；**exact causal model / exact CRDT·relation algorithm / crypto backend / transport implementation = NOT FROZEN**。

LAN Sync 正式实现只属于 Phase 7。Phase 1–6 最多做接口与数据结构预留。

## 17. 开发流程硬性规则

所有开发任务：

```text
读取资料
→ 需求理解
→ 用户审核
→ 实施计划
→ 用户审核
→ 编码
→ 测试
→ 修复与重测
→ 设计稿对照
→ 开发报告
→ 用户人工验收
→ DONE
```

未经用户明确批准不得跨步骤、跨 Phase 开发。

## 18. Phase 顺序

- Phase 0：项目技术评审；
- Phase 1A：App Shell + Native Core Architecture；
- Phase 1B：Web Persistence（SQLite WASM + OPFS）+ Web Repository Adapter；
- Phase 2：Task；
- Phase 3：Canvas；
- Phase 4：Diary + Notes；
- Phase 5：Search + Tags + Archive + Trash；
- Phase 6：Data Management + Backup；
- Phase 7：LAN Device Sync；
- Phase 8：AI；
- Phase 9：未来扩展。

Phase 1A + 1B 都验收通过后，才允许进入 Phase 2。

## 19. 测试与完成声明

没有实际运行的测试不得标记 PASS。无法运行时必须写 `NOT RUN` / `BLOCKED` / `未验证`，并说明原因。

一个模块只有在 UI、业务逻辑、数据持久化、重启恢复、异常状态、自动测试、适用平台验证、用户人工审核均完成后才能标记 DONE。

## 20. Agent 最终职责

Agent 的目标不是尽快生成最多代码，而是以可测试、可审核、可回退、可维护、数据安全的方式逐阶段完成项目。
