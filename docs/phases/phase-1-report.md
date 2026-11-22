# Phase 1 report — Profiler mode and workspace shell

**Status:** built on `phase-1`; PR and CI pending.

## Assumptions (pending Yashaswi)

- **Decision 27:** the phase uses deterministic fixtures for all four sources, with no vendor system or real credential; the 500-object target is measured on the synthetic fixture.
- **Decision 10:** each tenant's workbook is encrypted on the local artifact volume and deleted with its connector; retention for other records is deferred.

## What was built

- Deterministic, read-only golden connectors for SQL Server, PostgreSQL, Snowflake and Excel. Scope rules keep excluded and list-only objects out of profiling.
- PostgreSQL graph, profiler, scope, workbook and notification tables with forced RLS, append-only profile events, versioned metadata, structural `REFERENCES` relationships and evidence.
- A profiler that harvests and profiles the golden catalog, records inaccessible objects, skips unchanged objects on the nightly fixture, and emits read-once notifications. Catalog search reads stored metadata and makes no model request.
- Tenant-specific AES-256-GCM workbook storage with opaque paths and key salts; removing a connector removes its workbook data and graph assets become inactive/stale.
- Connector APIs and the workspace shell for Connectors, Profile, Dictionary, ER explorer, Controls, Approval matrix and notifications.
- A setup fix so CI-provided PostgreSQL credentials take precedence over a generated local `.env`; fresh local setup also creates a random artifact master key.

The golden 500-object profile completed in **668 ms** in the local PostgreSQL contract run, with 499 profiled objects and one inaccessible object. No model calls were made.

## Demo

On macOS with native PostgreSQL 16 running:

```sh
corepack enable
pnpm install
pnpm db:setup
pnpm db:migrate
pnpm db:seed:golden
pnpm dev
```

Open `http://127.0.0.1:5173`, then sign in with the synthetic account `analyst@north.example` and password `golden-local-only`. Add one of the four golden sources, start profiling, and inspect the Profile, Dictionary, ER explorer and notifications. All test resets target `si_test`; demo data is synthetic.

## Verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — passed (20 unit cases, including local artifact-key generation).
- `pnpm test:integration` — passed (1 PostgreSQL 16 integration case).
- `pnpm test:contracts` — passed (12 files, 32 cases, including the phase-0 contracts and phase-1 C6/C7 contracts).
- `pnpm test:e2e` — passed (3 Playwright cases: phase 0 login/usage; phase 1 connector activation/profile/dictionary/notification; keyboard navigation and catalog-only search).
- GitHub phase-0 PR checks — passed and merged. Phase-1 CI will run after its PR is opened.

## Limits

- External databases and cloud connector services are intentionally not contacted; connector behavior is exercised against synthetic golden data.
- Phase 1 makes no model calls. The metadata boundary is tested independently before any future model integration.
- Excel workbook bytes are encrypted and isolated by tenant. The current phase-1 source demo uses its synthetic sheet fixture; connector removal deletes uploaded workbook bytes.
