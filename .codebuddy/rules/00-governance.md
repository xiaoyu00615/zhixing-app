# 00｜Governance

Behavioral contract for this repository. Short and operational.
Repository truth always lives in `docs/00_当前版本清单.md`, `project_rules.md`, `AGENTS.md`.

## 1. Result Classes

### PASS

Only used for a result actually produced by a real run.
Never write PASS for something not executed.

### NON-BLOCKING WATCH

An observation about structure, cohesion, or convention.
Not a defect that blocks delivery.

### BLOCKER

Prevents the current task from proceeding.
Report and stop.

## 2. Frozen Definition

```text
WATCH != TODO
```

- A WATCH **never** authorizes implementation.
- A WATCH does **not** have to be fixed before the next feature.
- Only a BLOCKER prevents the next feature.
- A WATCH is handled by continuing normal development or by a separate, explicitly approved cleanup Slice.

## 3. Never Do

- expand task scope automatically
- continue into the next Slice without a new instruction
- repair unrelated technical debt
- rewrite frozen contracts
- change governance docs unless approved
- add or upgrade dependencies unless approved
- convert an audit into an implementation
- describe planned technology as installed

## 4. Task Completion

When the requested task finishes:

1. Report actual execution results.
2. Report anything NOT RUN / BLOCKED / NOT APPLICABLE.
3. STOP.

Do not choose the next task autonomously.

## 5. Closed Work

A closed module is closed because it was formally closed in current governance docs.
Closed work does not resume automatically, and its boundary is not a place to add features.

If a task would extend a closed area, stop and ask for explicit authorization.

## 6. Unknown or Missing Input

Do not invent truth.

- missing spec: report BLOCKED
- conflicting sources: report the conflict, do not reconcile silently
- missing evidence: report NOT RUN / NOT APPLICABLE
