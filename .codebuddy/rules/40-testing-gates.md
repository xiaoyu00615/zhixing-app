# 40｜Testing Gates

Always report **exact commands** and **exact results**.
Never write only "tests passed".

## 1. Gate Selection by Risk

UI / application changes, normally:

- focused tests
- `pnpm test`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm build`
- `git diff --check`

`pnpm test` is the canonical project command.
Underlying runner: `vitest run`.
Repository scripts take precedence over invoking the underlying CLI directly.

Persistence / UI round-trip: add the relevant Playwright E2E.

Shared Web persistence change: full Playwright required.

Rust / database change: focused Rust tests, `cargo check` / `cargo test` as relevant, plus the applicable TypeScript gates.

Docs-only change: normally `git diff --check` only.

Migration / high-risk persistence: design review first, then the appropriate Rust / Web parity gates.

## 2. Toolchain Comes First

Do not run any project gate if the toolchain guard fails.

Node `< 24` or wrong/missing pnpm:

```text
TOOLCHAIN NOT READY
→ do not run install / test / build / typecheck / lint / Playwright
→ report
```

Do not silently run gates on Node 22.

## 3. Commands Are Declared, Not Invented

Use the repository's real scripts and manifests.
If a command is not present in the repository, report it as NOT DEFINED instead of inventing one.

## 4. Result States

Allowed only:

```text
PASS
FAIL
NOT RUN
BLOCKED
NOT APPLICABLE
```

An unrun item is never PASS. A partial run is never PASS.

## 5. Test Data Constraint

Every test touching persistence runs against temp / sandbox / isolated paths.
See `10-data-safety.md`. No gate may be satisfied using real user data.

## 6. Before Finishing

Run the scope audit:

```text
git status --short
git diff --stat
git diff --check
```

Report: unexpected files, unrelated changes, added dependencies, added migrations, temporary hacks.
