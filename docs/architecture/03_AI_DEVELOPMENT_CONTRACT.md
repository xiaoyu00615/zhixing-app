# 03｜AI Development Contract

> 所有中型以上开发任务，先完成 Contract，再实现。

---

## 1. 用户先看什么

每次正式任务前，先给用户解释：

```text
这一步干什么
用户能看到什么结果
为什么现在做
数据库 / 高风险影响
Agent / 推理强度
预计时间
额度风险
```

然后才给 Trae 完整指令。

---

## 2. Trae 开发标准流程

```text
Read
→ Search Existing Modules
→ REUSE Decision
→ Architecture Contract
→ Implement
→ Layered Tests
→ Scope Audit
→ Human Review
→ Git Closeout
```

---

## 3. Contract 模板

```text
TASK
本次只解决什么。

USER VISIBLE RESULT
用户最终看到什么。

WHY NOW
为什么现在做。

ARCHITECTURE PATH
UI
→ Service
→ Repository
→ Adapter
→ Persistence

REUSE CHECK
搜索过：
结论：REUSE / EXTEND / EXTRACT / NEW
原因：

PUBLIC API
新增或扩展什么正式入口。

DATA IMPACT
NONE / READ / WRITE / SCHEMA

MIGRATION
NONE / REQUIRED

NATIVE / WEB PARITY
需要保持哪些行为一致。

FAILURE BEHAVIOR
失败时：
用户看到什么：
数据库发生什么：
是否 rollback / fail-closed：

FILES ALLOWED
预计允许修改什么。

FILES FORBIDDEN
明确禁止改什么。

TEST PLAN
Unit：
Repository / Contract：
Rust：
E2E：

STOP CONDITIONS
哪些情况必须停下来。
```

---

## 4. 为什么这样写

Trae 不只需要给代码，还必须解释：

1. 为什么这个功能属于这个模块；
2. 为什么复用这些已有模块；
3. 为什么不用复制；
4. 为什么不用深继承；
5. 为什么不直接调用平台 API；
6. 为什么测试放在这些层。

---

## 5. 参考代码规则

参考代码表达：

```text
依赖方向
API 形状
错误行为
transaction boundary
命名方式
```

不是让 Trae 机械复制。

### 正确示例

```ts
await canvasService.deleteEdge(edgeId)
```

### 错误示例

```ts
await invoke('canvas_edge_delete', { edgeId })
```

直接写在 React Page。

原因：

- UI 与平台耦合；
- 绕过 Repository；
- Web 无法共享；
- 测试边界变差。

---

## 6. Canvas Task 必查

正式 Canvas 任务先查：

```text
Node Registry
Edge Registry
Command Registry
Context Menu Registry
History
Clipboard
Repository Contract
```

然后明确：

```text
REUSE / EXTEND 哪个基础设施
为什么不在 CanvasEditorPage 另写一套
```

---

## 7. 高风险任务

以下必须先 Design Review：

```text
Migration
Backup
Restore
Data Root
Permanent Delete
Sync
Schema Change
Cross-platform persistence architecture
新的公共基础设施
```

Design Review 阶段：

```text
CODE CHANGES: NONE
COMMIT: NO
PUSH: NO
```

额外说明：

```text
OLD STATE
NEW STATE
MIGRATION PATH
SAFETY SNAPSHOT
TRANSACTION
ROLLBACK
OLD DATA COMPATIBILITY
RESTART PERSISTENCE
WEB / NATIVE PARITY
```

---

## 8. Audit Only

如果用户说“检查、审计、看看”，必须使用：

```text
AUDIT ONLY

只读取。
不修改任何文件。
不删除任何文件。
不顺手修复。
不 commit。
不 push。

发现问题只报告。
```

Audit 不能自动升级成 Implementation。

---

## 9. Git Closeout

只有用户审核通过后：

```text
GIT CLOSEOUT ONLY

不改功能。
只审查 staged scope。
确认没有 artifact / temp / unrelated files。
commit。
只有用户明确要求时 push。
验证 HEAD == origin/main。
停止。
```

---

## 10. 最终报告

```text
TASK:
...

RESULT:
PASS / PARTIAL / BLOCKED

REUSE DECISION:
...

ARCHITECTURE:
...

FILES CHANGED:
...

TESTS:
...

KNOWN ISSUES:
...

TECH DEBT CREATED:
NONE / ...

MODULE DOC UPDATE NEEDED:
YES / NO

WORKING TREE:
DIRTY / CLEAN

COMMIT:
NO / <hash>

PUSH:
NO / PASS

READY FOR REVIEW:
YES / NO
```
