# Zhixing WorkBuddy Project Entry

This repository uses strict project governance.

> 本项目（知行｜个人知识与行动中枢）使用严格的项目治理。
> WorkBuddy 工程规则**增强**仓库治理，不替代 `AGENTS.md`、`project_rules.md`、`docs/00_当前版本清单.md`。

---

## 1. Read Order Before Every Task

In order:

1. current explicit task instruction
2. `AGENTS.md`
3. `docs/00_当前版本清单.md`
4. `project_rules.md`
5. relevant current specs / architecture docs
6. committed implementation / manifests
7. historical docs only when needed

Do not start a task without completing this read.
Do not begin with historical discussion.

## 2. Truth Priority

```text
current explicit instruction
  > docs/00_当前版本清单.md
    > project_rules.md
      > current specs
        > committed implementation / manifests
          > historical discussion
            > agent judgment
```

Do not silently resolve conflicts.
Report the conflict, name both sources, and stop for a decision.

## 3. Current Status Source

Always read current project status from **`docs/00_当前版本清单.md`**.
Never permanently hard-code Phase / module status here.

Snapshot at Harness authoring time (for orientation only, not frozen):

- Phase 4｜Diary + Note: IN PROGRESS
- Note V1: CLOSED
- Diary: NOT STARTED
- Next planned area: Diary design / contract audit

**Note V1 is CLOSED. Diary implementation is NOT automatically authorized.**

## 4. Toolchain Guard

Required before any project command:

- Node: `>= 24`（preferred / frozen when available: `24.14.1`）
- pnpm: `11.20.0`
- pnpm is the **only** allowed package manager.

Before `install` / `test` / `build` / `typecheck` / `lint` / Playwright / any dependency mutation,
verify the actual execution environment.

If the shell reports **Node < 24**, or **pnpm unavailable / wrong version**:

1. STOP before running any project command.
2. Report `TOOLCHAIN NOT READY`.
3. Wait for authorization.

Never:

- silently run the project on Node 22;
- switch package managers;
- install or update Node / pnpm without explicit authorization.

## 5. Behavioral Boundaries

- Scope is granted per task. Do not choose the next Slice autonomously.
- A completed task ends with a report; STOP.
- Audit / inspection tasks: READ ONLY.
- Implementation tasks: no commit, no push by default.
- Never touch real user data. Tests use temp / sandbox / isolated paths only.
- Never fix recorded WATCH items unless they are re-authorized as their own task.

Details are frozen in `.codebuddy/rules/*.md`:

| File | Scope |
|---|---|
| `00-governance.md` | PASS / WATCH / BLOCKER, scope discipline |
| `10-data-safety.md` | real user data, test data, fail-closed |
| `20-development-workflow.md` | Slice lifecycle, Git behavior |
| `30-architecture.md` | dependency direction, reuse before create |
| `40-testing-gates.md` | gates per risk, exact commands |

## 6. Conflict With Repository Truth

If WorkBuddy project memory / rules conflict with repository truth:

1. Report the conflict.
2. Do not silently override repository governance.
3. Repository truth wins until a human approves a change.

## 7. Volatile Facts

Do not search this Harness for volatile facts:

- current commit SHA
- current Vitest / Playwright counts
- current Phase milestone commits
- roadmaps, Diary design, product backlogs

Those live in `docs/00_当前版本清单.md` and current specs.
Rule files point there on purpose, to prevent Harness drift.

Planned technology != committed dependency.
Verify `package.json` before claiming a dependency exists.
