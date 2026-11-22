# Phase 0 Foundation Implementation Plan

**Status:** Complete. Implementation follows `docs/phases/phase-0.md`; its spec remains approved by agent, pending review.

**Goal:** Deliver the phase 0 outcome in `docs/phases/phase-0.md` on the `phase-0` branch.

**Architecture:** A pnpm TypeScript monorepo with React/Vite, Fastify API and a separate worker; the separate Scale Insyght development and test databases on native PostgreSQL 16 are the source of truth for RLS, registry, durable runs, events and queue. Integration and contract tests use the real PostgreSQL server, never Docker, mocks, PGlite or SQLite.

**Tech Stack:** Node.js 22, pnpm 12.21.0 via Corepack, TypeScript strict, React 18, Vite, Fastify, Zod, native PostgreSQL 16, `pg`, node-pg-migrate, Vitest, Playwright.

**Spec:** `docs/phases/phase-0.md`; frozen requirements in `docs/system-design-v3.2.md` Part 3 contracts 1, 2, 5.

## Global Constraints

- Release 1 reads, explains and proposes; it never changes client systems (CLAUDE.md §3.3).
- Every tenant-owned table includes tenant_id and FORCE ROW LEVEL SECURITY; tenant context is transaction local (C1).
- App and worker roles own no tables and cannot bypass RLS; migration role is separate (C1).
- Events are append-only, gapless per run, and committed with their state change (C5).
- Workers use stored run tenant, database-clock leases and fencing tokens on writes (C1/C5).
- No result rows, raw identifiers or credentials in model input, event payloads or logs (CLAUDE.md §§3.5–6, 3.9).
- No infrastructure beyond CLAUDE.md §§5–5.1; Docker is not installed or required.
- Use only the new Scale Insyght databases; do not access pre-existing application databases or tables.

## Review Focus

- Tenant context omitted or connection reused: test empty tenant and 1,000 interleaved requests (Task 3).
- App role accidentally owns or bypasses a table: catalogue check (Task 3).
- Worker message tenant forged or lease stale: test stored-run tenant and fencing (Task 4).
- RLS policies omitted on a new tenant table: catalogue contract test (Task 3).
- Event JSON accidentally includes unsafe data: schema validation and event scans (Task 4).

---

### Task 1: Workspace and runnable reference deployment

**Files:** root package manifests, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.github/workflows/ci.yml`, app/package/service workspace manifests, `.gitignore`, `README.md`, `.env.example`.

**Interfaces:** Produces workspace scripts `dev`, `db:migrate`, `test`, `test:integration`, `test:contracts`, `test:e2e`, `lint`, `typecheck` as required by CLAUDE.md §15. PostgreSQL runtime and migration roles are provisioned separately.

- [x] Create strict TypeScript pnpm workspace and scripts; pin Node 22 and PostgreSQL 16.
- [x] Add native PostgreSQL connection configuration and CI PostgreSQL service with non-superuser app/worker roles and separate migration role.
- [x] Add CI jobs for lint, typecheck, unit, PostgreSQL integration, contracts, RLS catalogue and Playwright.
- [x] Verify `pnpm install --frozen-lockfile` and all scripts resolve; commit scaffold.

### Task 2: Contract schemas and migration roles

**Files:** `packages/contracts/**`, `packages/db/**`, `scripts/db-setup.ts`, `tests/contracts/c1_runtime_roles_and_all_tenant_tables_force_rls.test.ts`.

**Interfaces:** Tenant transaction helper `withTenant<T>(tenantId: string, fn: (client: PoolClient) => Promise<T>): Promise<T>` sets `SET LOCAL app.tenant_id` after BEGIN. `pnpm db:setup` uses local socket superuser access to provision only Scale Insyght's separate databases and roles; migrations use only migration URL. Tests reset only `si_test`.

- [x] Write contract schema tests for principal, decision, registry entries, run, step and event payloads.
- [x] Implement Zod schemas, tenant-scoped transaction helper and catalogue inspection.
- [x] Add `DATABASE_URL`, `DATABASE_URL_WORKER`, and `DATABASE_URL_MIGRATE` in `.env.example`; keep `.env` ignored. Add database setup and migrations for the exact phase 0 tables; force RLS on each tenant table.
- [x] Test empty context, cross-tenant reads, catalog ownership and RLS; commit.

### Task 3: Identity, RLS and authorization

**Files:** `apps/api/src/auth/**`, `packages/policy/**`, `packages/db/src/**`, `tests/contracts/c1_*.test.ts`, `tests/integration/tenancy/**`.

**Interfaces:** `authorise(request: AuthzRequest): Promise<AuthzDecision>`; authentication verifies an opaque session token and derives tenant/principal only from stored session state. API middleware establishes transaction context.

- [x] Add RED tests for all C1 acceptance cases from phase spec, using real PostgreSQL for RLS/pool behavior.
- [x] Implement password hashing, session issuance/expiry/revocation, entitlements, one policy implementation, persisted decisions and connector allowance transaction.
- [x] Implement per-request transaction tenant binding; prove forged tenant request fields are ignored.
- [x] Run C1 contracts.

### Task 4: Registry, durable runner and recovery

**Files:** `packages/registry/**`, `packages/runner/**`, `apps/worker/**`, `apps/api/src/runs/**`, `tests/contracts/c2_*.test.ts`, `tests/contracts/c5_*.test.ts`, `tests/integration/runner/**`.

**Interfaces:** Registry versions are immutable. `createRun(principal, input)` persists run and initial event; `claimNext(workerId)` atomically claims queued steps with database-time lease and increasing fence; `completeStep(claim, result)` validates the current fence and appends event in the same transaction. Worker tenancy is loaded from `runs.runs`.

- [x] Write C2/C5 RED tests for versioning, atomic activation, transitions, gapless events, two-worker claim, recovery, stale writes, replay, child runs, lost responses and duplicate completion.
- [x] Implement append-only event sequencing and legal transition table.
- [x] Implement queue claiming, leases, fencing, idempotency, outbox and resumable event retrieval.
- [x] Implement scripted two-step read-only demo capability and kill/restart integration harness.
- [x] Run C2/C5 suites including 20 crash cycles.

### Task 5: Usage and phase 0 UI

**Files:** `apps/api/src/usage/**`, `apps/web/**`, `packages/ui/**`, `tests/unit/**`, `tests/e2e/phase0.spec.ts`.

**Interfaces:** Gateway reads model routing from configuration and accepts only typed/scrubbed inputs; no default key or model credential. `getUsage(tenant, period)` derives distinct user and connector counts from activity events under tenant transaction.

- [x] Write failing UI/accessibility and usage recount tests.
- [x] Keep model calls disabled in phase 0; no gateway or model credential is configured because phase 0 does not call a model.
- [x] Implement `/login`, empty `/`, `/usage` and responsive shell from prototype behavior and CLAUDE.md §§10–11.
- [x] Run unit and Playwright tests.

### Task 6: Full phase gate and report

**Files:** `docs/decisions.md`, `docs/phases/phase-0-report.md`, CI configuration.

- [x] Run lint, typecheck, unit, integration, contracts, RLS catalogue and E2E; fix root causes without weakening tests.
- [x] Demonstrate 20 worker terminations/recoveries across two tenants and inspect usage/event results.
- [x] Record assumptions in the phase report and decision 26.
- [x] Confirm no INSYGHT repository/service/database/credential was accessed; report exact command results and demo instructions.
- [x] Merge `phase-0` into local `main` only after all acceptance cases pass.
