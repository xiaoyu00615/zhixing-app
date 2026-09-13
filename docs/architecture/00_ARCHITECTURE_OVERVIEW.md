# 知行｜Architecture Governance V2

> 基线：`main @ 3abcdc6802e8da004badd2fb8bd46065e7867355`
> 状态：DRAFT FOR REVIEW
> 目标：让项目在主要由 AI Agent 持续开发的情况下，仍保持可理解、可复用、可测试、可维护。

---

## 1. 为什么需要这套规则

知行当前已经具备较清楚的主架构：

```text
React UI
→ Application Service
→ Repository Interface
→ Platform Adapter
→ Web Worker / Native Tauri
→ SQLite / OPFS
```

Canvas 也已经出现：

```text
Node Registry
Edge Registry
Command Registry
Context Menu Registry
Clipboard
History
Repository / Service
Runtime
```

当前最大的风险不是“架构已经坏了”，而是项目继续增长后可能出现：

- AI 看到相似代码后直接复制一份；
- 公共模块存在，但 Agent 不知道应该先搜索；
- Project / Tag / Canvas 等模块各自继续扩张；
- Page、Service、Rust 文件逐渐成为热点；
- 用户无法直接审核 Rust / SQLite / Worker 细节；
- 测试越来越重；
- Agent 为了完成任务越过 Scope；
- 架构知识依赖聊天记忆，而不是仓库文档。

这套规则的目标不是让项目“更复杂”，而是让复杂度可控。

---

## 2. 永久主调用链

### Web

```text
React Page / Component
→ Application Service
→ Repository Interface
→ Web Adapter
→ Worker Client / Protocol
→ SQLite WASM / OPFS
```

### Native

```text
React Page / Component
→ Application Service
→ Repository Interface
→ Native Adapter
→ Tauri Command
→ Rust Domain / Database Service
→ SQLite
```

### 永久边界

- React UI 不直接执行 SQL。
- React UI 不直接散落 Tauri `invoke()`。
- Domain 不依赖 React。
- Shared 基础模块不依赖具体业务 Domain。
- Repository Interface 不关心 Web / Native 实现。
- Web / Native 应共享同一业务 Contract。
- 高风险数据修改必须事务化、可测试、fail-closed。

---

## 3. 当前模块地图

### UI

```text
src/pages/
src/components/
```

当前公共 UI：

```text
src/components/ui/
```

至少已经包含：

```text
Button
Dialog
Input
Select
Checkbox
Tooltip
Dropdown Menu
Badge
Tabs
Sonner
```

新 UI 前先搜索这里，不为轻微差异复制基础组件。

---

### Task

```text
src/task/
src/components/tasks/
src-tauri/src/task.rs
```

负责 Task Domain、业务规则、Repository / Service。

---

### Project

```text
src/project/
src/adapters/native/projectRepository.ts
src/adapters/web/WebProjectRepository.ts
src-tauri/src/project.rs
```

保留 Project Domain 语义。

---

### Tag

```text
src/tag/
src/adapters/native/tagRepository.ts
src/adapters/web/WebTagRepository.ts
src-tauri/src/tag.rs
```

保留 Tag Domain 语义。

---

### Canvas

```text
src/canvas/
src/components/canvas/
src/pages/CanvasPage.tsx
src/pages/CanvasEditorPage.tsx
src/adapters/native/canvasRepository.ts
src/adapters/web/WebCanvasRepository.ts
src-tauri/src/canvas.rs
src-tauri/src/commands.rs
```

Canvas 当前已经是项目最成熟的模块化样板。

新增 Canvas 能力前，应优先检查：

```text
Node Registry
Edge Registry
Command Registry
Context Menu Registry
History
Clipboard
Repository Contract
```

而不是直接在 `CanvasEditorPage.tsx` 新写一套逻辑。

---

## 4. 当前热点

以下是“观察项”，不是立即重构命令：

```text
src/pages/CanvasEditorPage.tsx
src-tauri/src/canvas.rs
src-tauri/src/commands.rs
src/adapters/web/taskDatabase.ts
```

判断是否需要拆分，不看单纯行数，而看：

- 一个新功能是否需要修改多个互不相关区域；
- 一个模块是否承担多个职责；
- 修改是否越来越难测试；
- AI 是否必须理解大量隐式状态才能安全修改。

---

## 5. 未来治理结构

所有正式开发遵循：

```text
先找已有能力
↓
决定 REUSE / EXTEND / EXTRACT / NEW
↓
确认模块归属与调用链
↓
必要时给代码结构示例
↓
实现
↓
分层测试
↓
人工审核
↓
提交 main
```

大型主线完整进入 `main` 后：

```text
一次 Health Review
```

小 Slice 不做完整 Health Review，只走正常测试和 Scope Gate。

---

## 6. 用户与 AI 的分工

### 用户

负责：

- 产品目标；
- 交互取舍；
- 核心架构批准；
- 风险取舍；
- 人工验收。

### ChatGPT / Architecture Reviewer

负责：

- 架构设计；
- 模块边界；
- 抽象判断；
- Architecture Contract；
- Health Review；
- Trae 任务格式。

### Trae / Coding Agent

负责：

- 搜索已有模块；
- 按 Contract 实现；
- 维护 Web / Native parity；
- 编写测试；
- 输出证据；
- 经批准后维护事实型架构文档。

---

## 7. 最重要的一条

> 新增代码不是默认动作；查找已有能力才是默认动作。
