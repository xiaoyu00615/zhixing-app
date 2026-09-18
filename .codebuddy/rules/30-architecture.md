# 30｜Architecture

Only architecture red lines are frozen here. Full specifications stay in repository docs.

## 1. Dependency Direction

```text
React UI
→ Application Service
→ Repository Interface
→ Platform Adapter
→ Persistence
```

Web:

```text
Adapter
→ shared TaskWorkerClient boundary
→ Worker
→ sqlite-wasm
→ OPFS
```

Native:

```text
Adapter
→ Tauri command
→ Rust DB Service
→ SQLite
```

UI holds input / display / interaction state and calls services.
Adapter owns DTO, transport, and platform error mapping.
Persistence owns transactions, constraints, and restart durability.

## 2. Forbidden Without Explicit Architecture Approval

- React direct SQLite access
- Application Service importing a Web adapter
- Application Service importing a Native adapter
- page-level platform detection
- second Web persistence architecture
- second database lifecycle / duplicate connection management
- generic persistence framework
- a second callback chain that bypasses Repository

Platform selection is composed in a runtime/adapter boundary, never inside pages.

## 3. Reuse Before Create

Before creating a Component, Hook, Service, Repository, Validator, Parser, Adapter helper, Command, Registry, Persistence helper, or Utility:

```text
SEARCH
→ REUSE / EXTEND / EXTRACT / NEW
```

Classify what you found:

- `CURRENT_SHARED` — already exists, reuse it
- `DOMAIN_SHARED` — shared inside one domain, extend it
- `CANDIDATE_EXTRACT` — repeated mechanism not yet extracted; record only
- `DO_NOT_GENERALIZE` — similar code, different business semantics; keep separate

Choosing `NEW` requires stating: what was searched, why reuse/extend/extract fails, single responsibility, allowed and forbidden dependents.

Prefer: reuse, extend, composition, facade, config, registry.
Before: deep inheritance and large generic layers.

## 4. Premature Generics Are Forbidden

Do not create merely to reduce duplicated lines:

```text
DocumentService
BaseDocumentService
GenericCrud
GenericRepository
UniversalApplicationError
IdentityService
ClockService
SharedResourceManager
Generic DatabaseAdapter
```

Task / Note / Diary keep domain semantics unless a future **approved real use case** proves extraction.
Shared code should carry stable mechanisms (validation, transport, error mapping), not blurred business meaning.

## 5. Examples of Do-Not-Merge

- merging Project and Tag services or repositories
- unifying Task / Note / Diary error codes into one taxonomy prematurely
- adding an app-wide error model before real failure cases justify it

## 6. Unknown Boundary

If a change touches a shared module, adapter boundary, worker protocol, or database lifecycle:
stop, report, and request architecture review before coding.
