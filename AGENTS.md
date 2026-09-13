# AGENTS.md

本文件定义 Coding Agent 进入本仓库后的长期操作规则。
它不是完整产品需求、开发日志或技术规范副本。

## 1. 项目身份

- 项目：知行｜个人知识与行动中枢。
- 性质：single-user、local-first、offline-first。
- 本项目不是多人 SaaS。
- 目标平台：Web、Windows Desktop / Tauri，后续 Android。
- 核心闭环：捕捉 → 梳理 → Task / Note / Diary / Canvas → 执行 / 沉淀 → 搜索 / 关联 / 回看 → 再利用。

不得擅自引入团队、组织、成员、协作者、Presence、公开分享、云套餐或其他多人 SaaS 语义。

## 2. 事实来源优先级

事实冲突时按以下顺序执行：

1. 用户当前明确指令。
2. `docs/00_当前版本清单.md`。
3. `project_rules.md`。
4. CURRENT UI / Technical Specs。
5. 当前 committed implementation / manifests。
6. 历史讨论。
7. Agent 自己判断。

- 不得用推测覆盖高优先级来源。
- `docs/archive/` 中内容默认只用于历史追溯。
- 发现文档、Git 与代码冲突时，先报告，不得擅自修复。
- 最新进度真值始终以 `docs/00_当前版本清单.md` 为准。

## 3. 接管状态快照

截至本 AGENTS.md 创建时的项目状态：

- Phase 1A。
- 已完成至 Step 9.1。
- 接管参考基线：`1bd669e docs: sync current project state`。
- 下一计划 Step：Phase 1A Step 10｜StorageAdapter Base。
- Step 10 尚未开始。

实际当前 Git HEAD 和开发进度必须在每轮开始时读取。最新进度真值以 `docs/00_当前版本清单.md` 加实际 `git status` / `git log` 为准。以上阶段信息只是接管时间点快照，不得覆盖更新后的 CURRENT 文档、committed implementation 或 Git 状态。

## 4. 冻结架构

Native 目标调用链：

```text
React UI
→ TypeScript Application Service
→ TypeScript Repository Interface
→ Platform Adapter
→ Native Tauri Command
→ Rust Database Service
→ SQLite
```

未来 Web 调用链：

```text
React UI
→ Application Service
→ Repository
→ Platform Adapter
→ Web Worker
→ SQLite WASM
→ OPFS
```

硬性边界：

- React Component 禁止直接访问 SQLite。
- React Component 和页面禁止散落 `@tauri-apps/api` 或 `invoke()`。
- 平台能力必须收口到 Platform / Native Adapter 边界。
- 业务层不得直接依赖具体平台实现。
- 持久业务数据的事实来源是 Repository / 本地数据库，不是 UI Store。
- 未经审核不得建立第二套竞争性数据访问架构。

## 5. 技术栈边界

当前主要冻结技术栈：

- Node.js 24.x。
- pnpm 11.x。
- React 19。
- TypeScript 6 strict。
- Vite 8。
- Tailwind CSS 4。
- React Router 8。
- Tauri 2.11.x。
- Rust stable MSVC。
- rusqlite native SQLite。

精确 patch 版本以以下文件为准：

- `package.json`。
- `pnpm-lock.yaml`。
- `src-tauri/Cargo.toml`。
- `src-tauri/Cargo.lock`。

未经当前 Step 计划和用户明确批准，不得主动升级 major version 或替换冻结技术栈。

## 6. 已冻结 Native DB 基础设施

Phase 1A Step 8、Step 9、Step 9.1 已验收并冻结：

- `bootstrap.json`。
- Data Root。
- SQLite connection policy。
- MigrationRunner。
- `schema_migrations` metadata table。
- migration checksum。
- transactional migration。
- Migration Safety Snapshot。
- SQLite Backup API。
- migration history validation。
- 单列 `UNIQUE(id)` 精确验证。

截至 Step 9.1 已验收状态：

- Production `MIGRATIONS = []`。
- 尚无业务 migration。
- 尚无业务表。
- `schema_migrations` 是 Runner metadata，不是业务表。

以上属于 Step 9.1 时间点状态。未来经正式批准的后续 Step 可以通过 Migration 引入业务 schema；届时以更新后的 `docs/00_当前版本清单.md` 和实际 committed implementation 为准。永久规则是：业务表必须通过正式 Migration 引入，不得绕过 Migration 偷偷创建。

后续 Step 不得顺手重构或重新实现这些已验收基础设施。
发现明确缺陷时只报告，等待是否安排独立 hotfix 的决定。

## 7. 永久数据安全红线

Agent、自动化和测试不得为了制造异常状态而删除、覆盖、破坏或重写真实用户：

- `bootstrap.json`。
- Data Root。
- `zhixing.db`。
- `zhixing.db-wal`。
- `zhixing.db-shm`。
- `attachments/`。
- `backup/`。

以下测试状态必须使用 `tempfile`、sandbox 或 test-specific path：

- FirstBoot。
- Corrupt。
- Missing。
- Migration Failure。
- Snapshot Failure。
- Restore。
- DataRoot Failure。

未经用户明确授权：

- 不得操作真实 `%APPDATA%`。
- 不得操作真实 `%LOCALAPPDATA%`。
- 不得操作真实 Data Root。
- 禁止 `remove_dir_all(real_data_root)`。
- 禁止删除真实 `zhixing.db`。
- 禁止删除真实 `bootstrap.json`。

测试清理必须只针对已验证的临时路径，不得依赖模糊路径、真实用户路径或未解析环境变量。

## 8. Step 工作流与 Git 规则

每个开发 Step 使用以下流程：

```text
Understand / Inspect
→ Plan
→ User / Architecture Review
→ Implementation
→ Tests
→ Review
→ User Approval
→ Commit
```

- 一次只推进一个 Step。
- Plan 阶段不得提前实现。
- 未经审核不得跨 Step 或 Phase。
- 实施完成后保持 dirty working tree，提供测试、状态和 diff 报告。
- 不得自动 `git add` 或 commit。
- 只有用户明确批准后才允许 commit。
- 未经用户要求不得 push。
- 不得改写历史 commit。
- 不得使用 reset、force 或历史改写隐藏 Agent 自己造成的问题。
- 工作树已有用户修改时，必须保留并避开无关变更。

## 9. Scope Discipline

- 不得因为“顺便”“更优雅”“未来可能需要”或“最佳实践”扩大当前 Step。
- 只修改完成当前任务所必需的文件和行为。
- 不提前创建未来业务表、Repository、Application Service 或 Tauri command。
- 不为了展示能力主动重构已冻结基础设施。
- 发现旁支问题时先报告。
- 除非问题直接阻塞当前 Step 或属于安全问题，否则不得自动修复。
- 发现历史 blocking safety issue 时，停止当前 Step，报告并等待决定。
- 需要扩大权限、架构或数据生命周期边界时，必须先取得用户批准。

## 10. 当前代码边界

- `src/`：共享前端。
- `src/adapters/`：平台边界。
- `src/components/`：UI 组件与布局。
- `src/pages/`：页面。
- `src/routes/`：路由。
- `src-tauri/src/`：Native / Rust。
- `src-tauri/src/bootstrap/`：Bootstrap。
- `src-tauri/src/storage/`：Data Root / storage infrastructure。
- `src-tauri/src/db/`：SQLite / migration / snapshot。

不得虚构尚不存在的目录或能力。目录变化后以实际文件树为准。

## 11. Tauri 使用规则

- 前端直接使用 `@tauri-apps/api` 只能存在于 Native Adapter 边界。
- React component、page 和业务 service 不得随意 `invoke()`。
- 平台差异必须经明确 Adapter 接口收口。
- 新 Tauri command 必须属于明确批准的 Step 需求。
- 不得为了临时方便增加 command 或绕过分层。

## 12. 数据库规则

- Rust Database Service 负责 SQLite connection、Native DB infrastructure 和 Migration execution。
- TypeScript 上层不得直接拼接或执行 SQLite。
- 后续业务表必须通过正式 Migration 引入。
- 禁止在启动时偷偷创建业务表。
- 禁止绕过 Migration 临时修改 Schema。
- Migration 失败必须 fail-closed，不得自动修复或重建真实用户数据库。
- 不得为了测试改变真实用户数据库或 migration history。

## 13. 测试规则

- 测试结果必须来自实际执行。
- 未运行不得写 PASS；应写 `NOT RUN`、`BLOCKED` 或 `NOT APPLICABLE`。
- Rust DB destructive / error-path tests 必须使用 sandbox / tempfile。
- 测试范围必须与当前任务和风险匹配。
- 纯文档任务不要求无差别运行全部 build / test。

根据当前 Step 的适用范围选择：

- `cargo check --manifest-path src-tauri/Cargo.toml`。
- `cargo test --manifest-path src-tauri/Cargo.toml`。
- `pnpm typecheck`。
- `pnpm lint`。
- `pnpm build`。
- `pnpm peers check`（仅在命令可用且任务适用时）。
- `git diff --check`。

如果失败属于当前已经批准的 Step / Task 范围，读取完整错误，执行最小必要修复，并重跑失败项及受影响回归测试。

如果失败来自当前范围外代码、历史遗留问题、已冻结基础设施、安全问题，或修复需要新增依赖、扩大架构、改变数据生命周期，不得自动修复。只报告问题、影响和建议，等待用户决定。

## 14. UI 规则

- UI 真值以 `docs/specs/UI设计规范_V1.2.md` 和 `design/` 中冻结图片为依据。
- 不得按个人审美重新设计。
- 不得从图片实际像素反推 CSS 尺寸；规范 Token 优先。
- 文字规范与视觉图冲突时，按事实来源优先级处理并报告。
- 涉及 UI 的 Step 必须按适用尺寸和交互状态进行实际验证。

## 15. 禁止事项

- 未审核跨 Step / Phase。
- 未授权 commit 或 push。
- 主动升级 major dependencies。
- 擅自修改 frozen architecture。
- React 组件直接访问 SQLite。
- React 组件或页面散落 `invoke()`。
- 绕过 Migration 创建业务表。
- 自动修复真实损坏数据库。
- 操作真实用户数据模拟失败。
- 为消除 warning 随意添加 `allow`。
- 用 placeholder 假装功能完成。
- 测试未执行却标 PASS。
- 将未来能力描述成当前已实现。
- 在无批准时新增依赖、平台权限或高风险文件操作。

## 17. Architecture Governance

正式中型以上开发任务开始前，根据任务范围读取：

```text
docs/architecture/00_ARCHITECTURE_OVERVIEW.md   # 系统事实与模块地图
docs/architecture/01_SHARED_MODULES.md          # 已有能力、Reuse 决策
docs/architecture/02_ARCHITECTURE_RULES.md      # 依赖 / 复用 / 抽象规则
docs/architecture/03_AI_DEVELOPMENT_CONTRACT.md # 任务 Contract 模板
docs/architecture/04_TEST_AND_REVIEW.md         # 测试 Gate 与 Health Review
```

架构文档维护时再读取：

```text
docs/architecture/05_MAINTENANCE.md
```

核心原则（来自 03 与 02）：

- **Reuse Before Create** — 新增 Component / Hook / Service / Repository / Validator / Parser / Adapter helper / Command / Registry / Persistence helper / Utility 前必须 SEARCH → REUSE / EXTEND / EXTRACT / NEW。
- **Audit Only** — 用户要求 audit / inspect / review 时，只读不写，禁止自动升级成 implementation。
- **Large-line once review** — 大型 main 主线完成后做一次 Health Review；小 Slice 不重复完整 Health Review。

## 16. 每轮开始与结束检查

开始前：

1. 读取 `docs/00_当前版本清单.md`、`project_rules.md` 和当前 Step 资料。
2. 检查 `git status`、相关代码、Migration、测试和实际文件树。
3. 明确当前目标、禁止范围、风险和需要审核的决策。

结束前：

1. 确认只修改批准范围内文件。
2. 运行适用测试和 `git diff --check`。
3. 报告实际执行结果、未运行项、已知问题与风险。
4. 保持未提交状态，等待用户审核；除非用户已明确批准提交。
