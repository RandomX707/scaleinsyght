# Phase 3 Lineage, IDs and Tool Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** Build evidence-backed lineage, safe identifier tracing, local dbt/Tableau/Power BI metadata imports, impact analysis and snapshot comparison on the existing PostgreSQL graph.

**Architecture:** Add a `@scaleinsyght/graph` repository over the existing graph schema and extend it with forced-RLS identifier, snapshot and event tables. Ingest allowlisted golden metadata, parse SQL through the already-specified Python/SQLGlot service, and expose session-scoped APIs and UI. Derive tenant HMAC keys from the existing application master key with a purpose-specific tenant context; never persist raw identifier values.

**Tech Stack:** TypeScript/Node 22, Fastify, React/Vite, PostgreSQL 16, Vitest, Playwright, Python 3.11/FastAPI/SQLGlot, pnpm.

**Spec:** `docs/phases/phase-3.md`; frozen contracts C1, C5, C6 and C7 in `docs/system-design-v3.2.md` Part 3.

## Global Constraints

- Tests and demo use only `tests/golden/phase3.json`; no client data, vendor systems or credentials.
- Decision 9: retain PostgreSQL; the measured 100,000-asset depth-4 p95 is 106.1 ms.
- Every new tenant table has `tenant_id`, `ENABLE/FORCE ROW LEVEL SECURITY`; app/worker own no tables and cannot bypass RLS (C1).
- Structural edges never become data-flow edges; inference review never sets verification; paths retain gaps (C6).
- Raw identifier values never enter persistent storage, logs, events or model inputs; compare tenant-keyed HMACs only (C6/C7; CLAUDE.md §3.6).
- Assets/assertions are never deleted; changes add versions/events or mark state stale/inactive (C6 rule 9).
- dbt/BI imports accept fixture keys only; no arbitrary local path, URL or credential.
- Do not add infrastructure beyond PostgreSQL and the Python SQL parse service already listed in CLAUDE.md §5.

## Review Focus

- A structural foreign key exists between two assets: it must not show as lineage (`c6_structural_foreign_key_never_becomes_lineage`).
- A run event names a different target at dataset or field grain: the assertion must stay unverified (`c6_only_exact_successful_run_input_output_pair_becomes_run_verified`, `c6_dataset_run_event_does_not_verify_field_flow`).
- A lookup value is sensitive or malformed: it is bound, transient, and omitted from logs/events (`c7_all_graph_and_event_records_contain_no_raw_identifier_values`).
- Conflicting evidence is reviewed: both evidence items stay visible and the assertion remains disputed (`c6_conflicting_mapping_is_disputed_with_both_evidence_items`).
- A past-date query predates the first observation: return “not observable,” not reconstructed history (`c6_history_query_before_capture_returns_not_observable`).

## File Map

- `packages/graph/`: graph domain types, repository queries, path traversal and lineage state transitions.
- `packages/db/migrations/012_lineage_ids.ts`: new graph structures, temporal fields, safe event records, report notifications and RLS.
- `packages/contracts/src/index.ts`: phase 3 schemas for imports, assertions, ID paths, gaps and graph events.
- `tests/golden/phase3.json`: synthetic multi-tool flow, known missing hop, disputed mapping, report impact and renamed-ID path.
- `tests/contracts/c6_lineage_*.test.ts`, `tests/contracts/c7_identifier_boundary.test.ts`, `tests/integration/graph-benchmark.test.ts`: PostgreSQL contracts and traversal timing.
- `services/sqlparse/`: local FastAPI/SQLGlot parser and tests; `pnpm dev` and CI invoke the documented service.
- `apps/api/src/server.ts`: authenticated metadata, lineage, ID, report, review and impact routes.
- `apps/web/src/main.tsx`, `apps/web/src/phase3.css`: Lineage, ID Trace, Impact, Snapshot Compare, BI Reports and Approval Matrix views.
- `tests/e2e/phase3.spec.ts`: browser acceptance of the synthetic lineage and review flow.
- `docs/phases/phase-3-report.md`, `docs/decisions.md`: final results and assumptions.

## Task 1: Golden lineage model and graph schema

**Files:** `tests/golden/phase3.json`, contracts schemas, migration `012_lineage_ids.ts`, `packages/graph/`.

**Interfaces:** `GraphAssertion`, `LineagePath`, `LineageGap`, `IdentifierField`, `IdPath`, and safe `GraphEvent` Zod schemas; `queryLineage(pool,{tenantId,assetId,direction,maxDepth?,asOf?,methods?})`; `writeGraphEvent(tx,event)`.

- [x] Write named C1/C6/C7 contract tests for RLS, append-only evidence, independent review/verification fields, no deletion, golden missing/disputed hops and history cutoff; run to observe expected failures.
- [x] Add the synthetic phase3 corpus with dataset and selected field flows, the removed hop, contradictory mapping evidence, report dependency, and renamed identifier fields (no sample values).
- [x] Add migration 012 for identifier fields, keyed fingerprints, path-step references, snapshot indexes, graph events, temporal assertion state and notification extension. Apply forced RLS and grants.
- [x] Add `@scaleinsyght/graph` package implementing tenant-scoped query/write contracts; run C1/C6/C7 contract tests, catalogue tests, typecheck and lint.
- [x] Commit `feat: persist phase three lineage graph`.

## Task 2: Synthetic tool metadata import and SQL parsing

**Files:** `packages/connectors/`, `services/sqlparse/`, API import route, fixtures and integration tests.

**Interfaces:** `importGoldenMetadata(pool,{tenantId,principalId,connectionId,fixtureKey})`; Python `POST /parse` accepts SQL text and returns typed source/target field references plus a scrubbed transformation representation.

- [x] Test safe import keys, cross-tenant rejection, SQL literal scrubbing, unsupported dialect, parse error, dbt declared edges, report assets and no arbitrary path/URL access.
- [x] Implement deterministic dbt manifest/catalog, Tableau and Power BI golden connectors that create typed agents and report asset links; add declared/parsed assertions and safe evidence.
- [x] Implement the FastAPI/SQLGlot parse service with SQL Server, PostgreSQL and Snowflake dialect handling; add it to native dev and CI as an existing §5 service.
- [x] Run importer/parser unit, integration and C1/C6/C7 contracts; commit `feat: import synthetic tool lineage`.

## Task 3: Lineage query, review and verification

**Files:** `packages/graph/`, Fastify lineage routes, C6 contract tests.

**Interfaces:** `reviewAssertion(pool,{tenantId,principalId,assertionId,status})`; `verifyAssertionFromRun(pool,{tenantId,assertionId,runId})`; `reconcileAssertion(pool,{tenantId,assertionId,evidenceId,passed})`; `getLineage(...)` returns path, evidence, gaps and coverage.

- [x] Test structure-vs-flow separation, inference review independence, exact run pair/grain verification, separate reconciliation, stale transformation and as-of semantics.
- [x] Implement session-scoped routes and transactional event writes; use C8 approval boundary only for assertion review where required; caller can never submit verification status directly.
- [x] Run C1/C5/C6 tests and commit `feat: query and review lineage assertions`.

## Task 4: Identifier registry and safe tracing

**Files:** `packages/graph/src/identifiers.ts`, importer/profile detection, API ID routes, C6/C7 tests.

**Interfaces:** `detectIdentifierFields(pool,{tenantId,sourceId})`; `fingerprintIdentifier(masterKey,tenantId,value):string`; `buildIdPath(pool,{tenantId,startAssetId})`; `traceIdentifier(pool,{tenantId,assetId,value})`.

- [x] Test format-only detection, same-tenant fingerprint match, cross-tenant mismatch, renamed probable SAME_AS, path confidence/gap, authenticated transient lookup, and database/log/event scans with zero raw values.
- [x] Detect all golden eligible fields; store only per-tenant HMAC fingerprints, format patterns, entity hints and assertion references; derive paths from data-flow assertions and gaps.
- [x] Add read-only routes; reject missing input, overlong value and unauthorized asset; bind the explicit lookup value and ensure no SQL logging or event payload contains it.
- [x] Run C1/C6/C7 tests and commit `feat: detect and trace identifiers safely`.

## Task 5: Impact, snapshots, reports and notifications

**Files:** graph snapshot/impact queries, notifications, API routes, C1/C5/C6 tests.

**Interfaces:** `createGraphSnapshot(...)`; `compareGraphSnapshots(...)`; `getImpactRadius(...)`; `listReports(...)`; `notifyAffectedReports(...)`.

- [x] Test before/after graph diff, table/column impact traversal, safe report notification on dropped Power BI column, idempotent notification, and historical inactive asset query.
- [x] Implement indexed depth-limited traversal and event-based snapshot references. Keep current graph facts and historical facts queryable.
- [x] Run integration and contract tests; run 100,000-asset depth-4 traversal benchmark and record p95. If >5 seconds, stop and report instead of adding a graph database.
- [x] Commit `feat: add lineage impact and graph snapshots`.

## Task 6: Lineage, ID trace and report UI

**Files:** `apps/web/src/main.tsx`, `apps/web/src/phase3.css`, `tests/e2e/phase3.spec.ts`.

**Interfaces:** UI consumes the typed API routes from Tasks 2–5; graph edges render family, evidence method, review and verification independently; gaps render broken links with incomplete coverage.

- [x] Add E2E for Power BI-to-source traversal with missing hop/disputed assertion, accept without verification, renamed ID path, report list, snapshot compare, impact notification and keyboard access.
- [x] Implement Lineage lanes and evidence drawer, ID Trace tab, Impact view, Snapshot Compare, BI Reports and Approval Matrix review rows.
- [x] Run E2E and keyboard navigation checks; commit `feat: build phase three lineage workspace`.

## Task 7: Phase gate and PR

- [x] Run lint, typecheck, unit, integration, contract, RLS catalogue, parser and E2E suites; fix root causes without weakening tests.
- [x] Verify 100% golden dataset flows, at least 90% selected field flows, one honest gap, one disputed mapping, zero raw ID values and the 100k traversal target.
- [x] Write `docs/phases/phase-3-report.md`, update `docs/decisions.md`, and check the plan/spec against the delivered behavior.
- [ ] Open `phase-3` → `main`; merge only after GitHub CI passes.
