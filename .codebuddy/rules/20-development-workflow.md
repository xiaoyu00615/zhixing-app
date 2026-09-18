# 20｜Development Workflow

Frozen lifecycle for a normal Slice. Do not skip or reorder steps.

## 1. Slice Lifecycle

```text
1.  Verify baseline: branch, HEAD vs remote, working tree
2.  Read governance + relevant code / spec
3.  Search existing modules before creating anything
4.  Design Audit first when required
5.  Human approval
6.  Implementation within approved scope
7.  Focused tests
8.  Scope audit
9.  Full gates according to risk
10. Implementation report
11. Human review
12. Git closeout
13. Commit / push only when explicitly authorized
```

Baseline verification result must be reported, not assumed.

## 2. Task Type Behavior

| Task type | Behavior |
|---|---|
| AUDIT | READ ONLY. No file edit, no commit, no debt repair. |
| IMPLEMENTATION | NO COMMIT, NO PUSH by default. Keep changes reviewable. |
| GIT CLOSEOUT | NO NEW IMPLEMENTATION. Only review scope, then commit. |

## 3. Stop Conditions

STOP and report when:

- unexpected dirty file appears
- a test fails
- toolchain guard fails
- the task needs scope, architecture, dependency, or data-lifetime expansion
- an out-of-scope historical bug appears
- real user data would be touched

Do not hide a failure with a workaround.
Do not add `allow`/skip/eslint-disable to make a gate green without fixing the cause.

## 4. Git Behavior

Never:

- auto `git add`, `commit`, or `push`
- push without an explicit request
- rewrite history, reset, force-push
- auto `pull` / `rebase` / `merge` on rejection

If push fails (network, DNS, auth, non-fast-forward, remote divergence):

```text
STOP
→ REPORT
→ wait for human decision
```

After an authorized push, verify the local and remote heads agree.

## 5. Reporting

Every report must distinguish:

- actually executed vs NOT RUN / BLOCKED / NOT APPLICABLE
- files changed vs files read
- dependencies added (should be none unless approved)
- migrations added (should be none unless approved)
