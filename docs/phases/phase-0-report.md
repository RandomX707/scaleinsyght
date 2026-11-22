# Phase 0 report — Foundation and contracts

**Status:** Complete on `phase-0`; spec remains **approved by agent, pending review**.

## What was built

- Native PostgreSQL 16 development/test setup with Corepack-pinned pnpm 12.21.0, ignored local `.env`, `.env.example`, and `pnpm db:setup` for the two Scale Insyght databases and three constrained roles.
- PostgreSQL migrations for tenant RLS, authentication/session records, entitlements and activity events; versioned registry, append-only registry events, source-group versions, personal memory, durable runs, queue leases, fencing, ordered events and outbox.
- Tenant-bound transaction helpers, 1,000 interleaved pool requests, server-side golden login/logout, usage recount, capability authorization and connector activation.
- Durable worker claim/recovery with `FOR UPDATE SKIP LOCKED`, database-time leases, monotonic fencing, atomic completion/finalization events, uncertain-effect handling, event replay/resume, and partial child retries.
- Native Fastify API, React/Vite login, empty read-only Home, Usage, persistent accessible navigation groups and profile sign-out menu.
- Two-tenant golden demo runner and process-level worker termination/restart contracts.
- GitHub Actions PostgreSQL 16 service; no Docker dependency.

## Demo

Use the setup and demo commands in [README.md](../../README.md). In short: run `pnpm db:setup`, `pnpm db:migrate`, `pnpm db:seed:golden`, start `pnpm dev`, then run `pnpm demo:phase0`. The browser entry is `http://127.0.0.1:5173/login`. The fixture-only password is `golden-local-only` for `analyst@north.example` and `analyst@south.example`.

The local demo produced two completed runs. Each run had two succeeded steps and ten ordered events. Each result reference came from `tests/golden/phase0.json`.

## Verification results

All commands completed successfully against native PostgreSQL 16.15 and the real `si_test` database.

| Command | Result |
|---|---|
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 10 unit tests passed |
| `pnpm test:integration` | 1 integration test passed |
| `pnpm test:contracts` | 22 contract tests passed across 9 files, including 20 two-step process-kill/restart cycles across two tenants |
| `pnpm test:e2e` | 1 Playwright test passed |
| `pnpm demo:phase0` | Two synthetic tenant runs completed; 2 succeeded steps and 10 events each |

The contract and E2E setup reset only `si_test`; the development database was migrated and seeded with the synthetic golden fixture. No real client data, credentials, INSYGHT services or databases were used.

## Assumptions recorded

- The golden-only demo password `golden-local-only` is synthetic and is seeded only by the local/test golden seed. It is not a production credential.
- Phase 0 makes no model calls, so no model endpoint or credential is configured.
- PostgreSQL remains the only runtime service; API, worker and web run as native processes.
- Connector pricing remains grouped by type while decision 19 is open.
