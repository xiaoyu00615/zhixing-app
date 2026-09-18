# 10｜Data Safety

Highest-priority boundary. Applies to every task, including tests and automation.

## 1. Real User Data Is Forbidden

Automated tests and agents must never touch real:

- `bootstrap.json`
- Data Root
- `zhixing.db`
- `zhixing.db-wal`
- `zhixing.db-shm`
- journal files
- `attachments/`
- `backup/`
- real AppData / LocalAppData user data

Never access real user data to reproduce or "verify" anything.

## 2. Allowed Test Data

All persistence tests must use:

- temporary paths
- sandbox / tempfile
- isolated profile
- test-specific paths

Never depend on ambiguous paths, real user paths, or unresolved environment variables.
Cleanup must only target verified temporary paths.

## 3. Never

- delete or overwrite a real user database
- repair a real database automatically
- modify migration history to make tests pass
- rewrite or bypass migration to fix a schema problem
- use real user data to reproduce an error state
- silently recreate an empty database when a data location is unavailable

## 4. Failure Behavior

Migration / database failure:

```text
FAIL CLOSED
→ REPORT
→ STOP
```

Do not auto-heal, do not fall through to a degraded silent mode.

## 5. High-Risk Changes Require Design Review First

Before implementation, get explicit design review + human approval for:

- schema change
- migration
- Rust persistence layer
- Web persistence lifecycle
- shared adapter boundary
- anything that changes data lifetime, deletion, restore, or backup semantics

## 6. Product Data Rules

- Core deletion is Soft Delete by default.
- Permanent Delete happens only through the Trash path.
- Restore must preserve prior state, relations, and timestamps.
- Business truth is the repository / local database, never UI state.
