# 05｜Maintenance

> 目标：让这些文档由 Trae 持续维护，但不能让 Trae 自己改写核心规则。

---

## 1. 事实型文档

Trae 可以在用户批准后维护：

```text
00_ARCHITECTURE_OVERVIEW.md 中的实际模块地图部分
01_SHARED_MODULES.md
Health Review records
```

允许更新：

- 新增已提交模块；
- 路径变化；
- Public API 变化；
- Candidate 正式抽取；
- 新 shared module；
- 新热点。

---

## 2. 原则型文档

以下不能由 Trae 自己改变：

```text
02_ARCHITECTURE_RULES.md
03_AI_DEVELOPMENT_CONTRACT.md
04_TEST_AND_REVIEW.md 的核心流程
```

涉及：

```text
依赖方向
技术栈
Migration 安全
Reuse 规则
抽象原则
数据安全红线
Health Review 频率
```

必须由用户批准。

---

## 3. 文档什么时候更新

不是每个小任务都更新。

### 小 bugfix

通常：

```text
NO DOC UPDATE
```

### 结构变化

例如：

```text
新增 shared module
新增 Registry
新增完整 Domain
路径重构
公共 API 改变
```

才更新。

---

## 4. 大型主线完成后的固定动作

```text
1. 主线通过测试
2. 用户审核
3. commit / push main
4. working tree clean
5. 一次 Health Review
6. 检查 Module Map 是否过期
7. 检查 Shared Modules 是否过期
8. 决定继续功能或 Cleanup
```

---

## 5. Shared Candidate 生命周期

```text
发现重复
→ CANDIDATE_EXTRACT
→ Architecture Review
→ 正式抽取
→ Tests
→ CURRENT_SHARED
```

禁止：

```text
文档先写成 shared
但代码其实还没抽
```

---

## 6. 公共模块废弃

```text
CURRENT_SHARED
→ DEPRECATED
→ callers migrated
→ dedicated cleanup remove
```

禁止直接删除公共模块后让调用者自行坏掉。

---

## 7. 文档漂移检查

Health Review 时检查：

- 文档说存在的模块是否真实存在；
- 路径是否还有效；
- Public API 是否一致；
- Candidate 是否已经实现；
- 是否出现未登记的新公共基础设施。

---

## 8. Trae 维护报告

```text
ARCHITECTURE DOC SYNC

BASELINE:
<commit>

OVERVIEW:
NO CHANGE / UPDATED

SHARED MODULES:
NO CHANGE / UPDATED

ARCHITECTURE RULES:
NO CHANGE

AI CONTRACT:
NO CHANGE

TEST / REVIEW RULES:
NO CHANGE

WHY:
...

FILES CHANGED:
...

COMMIT:
NO
```

先给用户看。

用户批准后再提交。

---

## 9. 永久职责

### 用户

决定：

```text
产品
交互
核心规则
高风险取舍
最终验收
```

### ChatGPT

负责：

```text
架构设计
Review
Health Review
抽象判断
Trae 指令
```

### Trae

负责：

```text
搜索现有模块
实现
测试
证据
事实型文档维护
```

Trae 不拥有改变核心架构原则的权限。
