# 02｜Architecture Rules

> 本文件合并：依赖规则、组合规则、继承规则、复用规则、抽象规则。

---

## 1. Reuse Before Create

创建以下内容前：

```text
Component
Hook
Service
Repository
Validator
Parser
Adapter helper
Command
Registry
Persistence helper
Utility
```

必须先：

```text
SEARCH
↓
REUSE / EXTEND / EXTRACT / NEW
```

---

## 2. 四种决策

### REUSE

已有能力已经满足，直接使用。

### EXTEND

已有模块职责正确，只缺当前能力。

### EXTRACT

多个地方重复的是同一种稳定机制，抽出公共部分。

### NEW

前三种都不适合，才新建。

如果选择 `NEW`，Agent 必须说明：

```text
搜索过什么
为什么不能 REUSE
为什么不能 EXTEND
为什么不能 EXTRACT
新模块唯一职责
谁可以依赖
谁不能依赖
```

---

## 3. Rule of Three

### 第一次

允许具体实现。

### 第二次

记录为重复候选，不急着抽象。

### 第三次

原则上必须做一次 Reuse / Extract Review。

不是强制合并。

如果业务语义不同，可以保留，但必须说明原因。

---

## 4. 抽机制，不抹掉业务语义

优先抽：

```text
稳定验证
transport helper
error mapping
UI shell
Registry infrastructure
transaction helper
公共协议
```

谨慎抽：

```text
业务规则
Domain Service
Domain Repository
未来尚未发生的需求
```

---

## 5. Composition Over Deep Inheritance

复杂能力默认优先：

```text
Composition
Facade
Parameter Object
Registry
Strategy
```

谨慎：

```text
Inheritance
```

禁止用深继承隐藏复杂度：

```text
Base
→ StorageBase
→ HistoryStorageBase
→ EditableHistoryStorageBase
→ CanvasEditableHistoryStorageBase
```

---

## 6. 什么时候允许继承

只有当：

1. 是稳定的 `is-a`；
2. 父类合同长期稳定；
3. 子类不会大量 override；
4. 不需要多个能力组合；
5. 继承链很浅。

如果关系更像：

```text
has history
has clipboard
has exporter
has repository
```

用组合。

---

## 7. Facade

调用者应该面对简单入口。

例如 Canvas 内部可以有：

```text
History
Clipboard
Command Registry
Node Registry
Repository
```

UI 不应该同时理解这些模块。

理想入口：

```ts
canvasService.moveNodes(...)
canvasService.undo(...)
canvasService.copy(...)
```

Facade 用来降低认知负担，不是用来做 God Object。

---

## 8. 参数规则

如果函数开始出现大量 positional parameters：

```ts
fn(a, b, c, d, e, f, g, h, i, j)
```

不要继续加参数。

先评估：

```text
Parameter Object
Dependency Object
拆职责
Registry / Strategy
Facade
```

例如：

```ts
createService({
  repository,
  history,
  runtime,
})
```

比 10 个位置参数更安全。

如果 options object 自己又有 15 个无关字段，说明职责仍然过大。

---

## 9. Domain 边界

保留：

```text
TaskService
ProjectService
TagService
CanvasService
```

禁止为了“少写代码”合成：

```text
GenericCrudService<T>
UniversalRepository<T>
BaseEverything
AbstractEntityManager
```

如果一个所谓“通用层”内部大量出现：

```text
if entityType
switch kind
featureFlag
```

说明抽象可能错了。

---

## 10. 层级职责

### UI

负责：

```text
input
display
interaction state
call service
```

不负责：

```text
SQL
transaction
schema
Tauri invoke
Worker protocol
```

### Application Service

负责：

```text
业务用例
validation orchestration
Repository call
稳定业务入口
```

### Repository Interface

描述持久化合同。

### Adapter

负责：

```text
DTO
transport
platform error mapping
platform boundary
```

### Persistence

负责：

```text
真实数据修改
transaction
constraint
restart persistence
```

---

## 11. Cognitive Load Gate

出现以下任意信号时，必须做 Architecture Review：

- 一个函数/构造器有 5–7 个以上独立概念；
- options object 有 10+ 个互不相关字段；
- 一个继承链超过 2–3 层；
- 一个 Page 增加功能需要修改 3–4 个互不相关区域；
- 新功能需要理解多个没有文档的内部模块；
- 出现第三份同机制实现；
- Agent 想复制一个近似文件再改名。

这些是评估信号，不是自动重构命令。

---

## 12. Stop Conditions

以下情况 Agent 必须停止：

- UI 准备直接写 SQL；
- Page 准备直接 invoke；
- Shared 准备依赖具体 Domain；
- 为复用准备建立大型 Generic Service；
- 普通 feature 需要新 Migration；
- 需要新 dependency；
- 需要删除重要文件；
- 需要扩大当前 Slice；
- 发现范围外历史 bug；
- 必须修改真实用户数据。

停止后只报告，不顺手修。
