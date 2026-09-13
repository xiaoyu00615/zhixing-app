# 01｜Shared Modules

> 目标：让 Agent 开发前先知道“已有能力在哪里”，避免复制扩张。

---

## 1. 状态定义

公共能力分为：

```text
CURRENT_SHARED
DOMAIN_SHARED
CANDIDATE_EXTRACT
DO_NOT_GENERALIZE
```

### CURRENT_SHARED

已经存在，可正式复用。

### DOMAIN_SHARED

只在某个 Domain 内共用。

### CANDIDATE_EXTRACT

发现重复机制，但还没有正式抽取。

### DO_NOT_GENERALIZE

虽然代码相似，但业务语义不同，不应该合并。

---

## 2. CURRENT_SHARED

### UI primitives

位置：

```text
src/components/ui/
```

当前公共 UI 包括：

```text
badge
button
checkbox
dialog
dropdown-menu
input
select
sonner
tabs
tooltip
```

规则：

- 新建基础 UI 前先搜索这里。
- 页面差异优先通过 props / variant / composition。
- 不复制出 `Button2`、`SpecialDialog` 一类近似组件。

---

### Tailwind class merge

位置：

```text
src/lib/utils.ts
```

Public API：

```ts
cn(...)
```

禁止各模块自己重新写一套 class merge helper。

---

## 3. Canvas DOMAIN_SHARED

### Node Registry

```text
src/canvas/nodeRegistry.tsx
```

负责：

- Node type；
- renderer；
- default data；
- data parsing。

---

### Edge Registry

```text
src/canvas/edgeRegistry.ts
```

负责 Edge type / semantic presentation。

---

### Command Registry

```text
src/canvas/commandRegistry.ts
```

负责：

- Node / Edge 正式命令；
- 为 Context Menu / Toolbar / Shortcut 提供共享执行语义。

禁止不同 UI 入口重新写相同业务操作。

---

### Context Menu Registry

```text
src/canvas/contextMenuRegistry.ts
```

负责 Menu definition 与 Command 映射。

---

### Clipboard

```text
src/canvas/clipboard.ts
```

Canvas app-local clipboard。

禁止页面建立第二套 Canvas clipboard state。

---

### History

```text
src/canvas/history/
```

负责：

```text
History Session
History Entry
Undo / Redo
```

新增 History 功能时优先扩展现有体系，不建立第二套 Undo stack。

---

## 4. CANDIDATE_EXTRACT

这些只是候选，不能假装已经存在。

### UUID validation

当前在：

```text
src/task/model.ts
```

当前 API：

```ts
isCanonicalLowercaseUuid(...)
```

但 Project / Tag 等非 Task Domain 也使用它。

候选未来位置：

```text
src/shared/validation/id.ts
```

规则：

- 新 Domain 不得再复制 UUID Regex。
- 是否迁移，放到专门 Architecture Cleanup Slice 决定。

---

### Timestamp validation

当前在：

```text
src/task/model.ts
```

API：

```ts
isNonNegativeSafeIntegerMilliseconds(...)
```

候选未来位置：

```text
src/shared/validation/time.ts
```

---

### Named Entity Dialog Shell

当前观察：

```text
Project Dialog
Tag Dialog
```

重复机制包括：

```text
create / rename mode
name
error
pending
Input
Cancel
Submit
```

如果未来出现第三个真正同类 Dialog，再正式评估抽：

```text
NamedEntityDialogShell
```

但保留：

```text
ProjectDialog
TagDialog
```

作为业务入口。

---

### Native Adapter helper

Project / Tag Native Repository 中已出现相似机制：

```text
record parsing
input validation
invoke try/catch
Repository error mapping
DTO parsing
```

候选未来抽 transport helper。

不合并 ProjectRepository / TagRepository。

---

### Web Adapter helper

Project / Tag Web Repository 也有相似：

```text
record parsing
validation
worker error mapping
```

候选未来抽机制。

---

## 5. DO_NOT_GENERALIZE

以下默认不要合并：

```text
ProjectService + TagService
ProjectRepository + TagRepository
```

原因：

- 业务语义不同；
- 将来规则可能分化；
- 减少几行代码不值得牺牲 Domain 边界。

可以共享机制，但保留 Domain API。

---

## 6. 新公共模块登记格式

当 Trae 在正式主线中新增真正公共模块后，应更新：

```text
名称：
状态：
路径：
职责：
Public API：
关键词：
允许调用者：
禁止：
修改影响：
必跑测试：
```

只有代码真实存在并通过测试后，才能登记为 `CURRENT_SHARED`。
