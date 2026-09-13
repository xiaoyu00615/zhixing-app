# 04｜Test & Review

> 小任务走普通 Gate。
> 一条大型 main 主线完整完成后，做一次 Health Review。

---

## 1. 普通开发 Gate

每个 Slice 根据风险运行适用测试。

### Unit

适合：

```text
纯函数
History stack
validation
mapping
command decision
```

### Repository / Integration

适合：

```text
CRUD
transaction
atomic rollback
soft delete
restart persistence
Web / Native contract
```

### Rust

适合：

```text
Native domain
SQLite transaction
migration
command mapping
```

### UI / Component

适合：

```text
form
dialog
state
keyboard
error / empty / loading
```

### E2E

只覆盖真实用户流：

```text
drag
click
keyboard shortcut
refresh
restart
real persistence
```

不要用 E2E 证明本来 Unit / Repository 就能证明的所有组合。

---

## 2. 测试状态

只允许：

```text
PASS
FAIL
NOT RUN
BLOCKED
NOT APPLICABLE
```

没有运行不能写 PASS。

---

## 3. 测试失败规则

```text
读取完整错误
→ 找根因
→ 最小修复
→ 重跑失败测试
→ 跑受影响回归
```

禁止：

- 为过测试增加 test-only production API；
- 用 Harness 替代本应真实 UI 操作的 E2E；
- 测试失败后不断猜 magic offset；
- 把 PARTIAL 写成 PASS。

---

## 4. Scope Gate

每个实现结束至少检查：

```text
git status --short
git diff --stat
git diff --check
```

并报告：

```text
UNRELATED CHANGES
MIGRATIONS
DEPENDENCIES
DOCS
TEMP HACKS
```

---

## 5. 什么叫大型 main 主线

满足任一语义条件即可：

- 一个完整跨层功能；
- 一个完整 Domain；
- 大型 Canvas 能力；
- 新 Registry / History / Command infrastructure；
- Migration / Schema 主线；
- Backup / Restore / Storage / Sync；
- 新 shared module 影响多个 Domain。

不按“改了多少行”机械判断。

---

## 6. Health Review 频率

### 小 Slice

```text
不做完整 Health Review
```

只走普通 Gate。

### 一条大型主线完整进入 main

```text
做一次完整 Health Review
```

就够了。

不要每个小 commit 都写健康报告。

---

## 7. Health Review 检查项

只看最重要的 9 类：

```text
1. Architecture Boundary
2. Reuse / Duplication
3. Module Cohesion
4. Cognitive Load
5. Data Safety
6. Test Architecture
7. Hotspots
8. Tooling / Disk Health
9. Agent Discipline
```

---

## 8. Health Review 不改代码

默认：

```text
HEALTH REVIEW ONLY
```

只读 mainline。

不：

- 顺手重构；
- 升级依赖；
- 改 Migration；
- 改产品逻辑；
- 修旁支 bug。

发现问题只提出：

```text
继续开发
或
单独开 Architecture Cleanup Slice
```

---

## 9. 健康报告简化模板

```text
HEALTH REVIEW
BASELINE:
<commit>

OVERALL:
HEALTHY / NEEDS ATTENTION / CLEANUP REQUIRED

ARCHITECTURE:
PASS / RISK

REUSE:
PASS / RISK

HOTSPOTS:
...

DATA SAFETY:
PASS / RISK

TEST HEALTH:
PASS / RISK

TOOLING / DISK:
PASS / RISK

AGENT DISCIPLINE:
PASS / RISK

TOP RISKS:
1.
2.
3.

KEEP AS IS:
1.
2.
3.

DECISION:
CONTINUE FEATURE DEVELOPMENT
或
CREATE ARCHITECTURE CLEANUP SLICE

MODULE DOC UPDATE:
YES / NO
```

不追求复杂评分。

需要长期趋势时再额外给 0–10 分。

---

## 10. 当前基线观察项

当前 main 已知观察：

```text
CanvasEditorPage.tsx
src-tauri/src/canvas.rs
src-tauri/src/commands.rs
src/adapters/web/taskDatabase.ts
```

同时关注：

```text
Project / Tag duplication
UUID / timestamp shared candidate
Rust target / Playwright artifacts
Agent scope discipline
```

这些不是立即重构命令。
