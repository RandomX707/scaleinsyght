# Phase 1 Profiler Implementation Plan

**Status:** In progress on `phase-1`.

**Goal:** Deliver `docs/phases/phase-1.md` on native PostgreSQL 16, using only synthetic golden sources and no real credentials or external client systems.

**Frozen requirements:** C1–C7 in `docs/system-design-v3.2.md` Part 3; especially C2 agent activation, C3 scope enforcement, C5 durable jobs, C6 graph/assertions and C7 metadata/file boundaries.

## Global constraints

- Keep all tenant-owned records under forced RLS and transaction-local tenant context (C1).
- Keep every client connection read-only; no action credentials or client writes (CLAUDE.md §3.3).
- Excluded/list-only objects are never profiled, sampled, fingerprinted or queried (C3 rule 10; C6 rule 16).
- Never persist workbook plaintext, row samples, raw identifiers, restricted values, credentials, or unsafe descriptive metadata in events/logs/model requests (CLAUDE.md §3, C6, C7).
- Use only the golden fixture; no new infrastructure or vendor-hosted test system.
- Each task follows RED → implementation → targeted checks → commit. Post-commit hook pushes the branch.

## Task 1: Golden source catalog and connector interface

**Files:** `packages/connectors/**`, `tests/golden/phase1/**`, connector unit/contracts.

- [ ] Write connector contract tests for test/discover/profile/capability/error behavior.
- [ ] Add synthetic schemas: 500-table source, renamed/changed objects, inaccessible objects and workbook sheets.
- [ ] Implement typed read-only connector interface and deterministic golden adapters for PostgreSQL, SQL Server, Snowflake and Excel.
- [ ] Prove identical source snapshots produce identical canonical outputs; commit.

## Task 2: Connection lifecycle, scope and safe credentials

**Files:** DB migration, `packages/db`, `packages/registry`, API connection/scope modules, tests.

- [ ] Add RED tests for atomic activation/agent event, scope boundaries, tenant isolation and secret redaction.
- [ ] Add tenant-scoped encrypted connector secret storage and connection test/activation routes.
- [ ] Add include/list-only/exclude scope persistence; make collector refuse per-object operations outside Profile scope.
- [ ] Verify connector/agent activation rollback as one transaction and catalogue the forced RLS roles; commit.

## Task 3: Encrypted workbook artifact volume

**Files:** `packages/artifacts/**`, artifact migration, `.env.example`, synthetic workbook fixture, tests.

- [ ] Add RED tests for ciphertext-at-rest, tenant isolation, connector deletion, tamper rejection and no plaintext in database/logs.
- [ ] Implement tenant-derived AES-256-GCM encryption, opaque paths and atomic cleanup when a connector is removed.
- [ ] Verify ciphertext cannot be opened across tenants and removal makes it unrecoverable; commit.

## Task 4: Harvest, graph, profile and refresh

**Files:** `packages/graph/**`, `packages/profiler/**`, migrations, worker modules, tests/contracts.

- [ ] Add tests for 500-table harvest under 10 minutes, deterministic profile versions, coverage, inaccessible objects and changed-only nightly refresh.
- [ ] Add RLS graph assets/versions, relationships/assertions/evidence/gaps and profiler jobs/object state.
- [ ] Implement deterministic schema harvesting, safe profile statistics and structural ER inference; foreign keys are `REFERENCES`, never lineage.
- [ ] Add append-only safe graph/profile events and resumable worker processing with durable C5 semantics; commit.

## Task 5: C7 metadata boundary and notifications

**Files:** `packages/classification/**`, `apps/api`, `apps/worker`, notifications migration, tests.

- [ ] Add the five mandatory phase 1 C7 metadata tests before implementing the boundary.
- [ ] Classify metadata explicitly, scrub descriptive text, withhold tagged/small-group statistics, and expose no model caller in phase 1.
- [ ] Create one discovery/nightly summary notification per user/job and enforce read-once new/earlier state.
- [ ] Scan test logs, event payloads, API output and stored values for prohibited content; commit.

## Task 6: Product shell and demo

**Files:** `apps/web/**`, API routes, Playwright tests, README.

- [ ] Add E2E cases for add/test/scope/profile, connector agent, Dictionary, ER, notification and accessible navigation.
- [ ] Implement connectors/add modal, Profile, first-class Dictionary, Controls, ER explorer, notification panel and catalogue lookup without model calls.
- [ ] Run the synthetic four-source demo and record the 500-table timing/coverage baseline; commit.

## Task 7: Phase gate and integration

- [ ] Run lint, typecheck, unit, PostgreSQL integration, contract and E2E suites; fix root causes without weakening tests.
- [ ] Confirm every phase 0 test still passes and `si_test` is the only database reset by tests.
- [ ] Write `docs/phases/phase-1-report.md`, with assumptions at the top and exact test/demo results.
- [ ] Update `docs/decisions.md` for assumptions per instruction; commit report.
- [ ] Open `phase-1` → `main` PR and merge after CI is green; use `gh`.
