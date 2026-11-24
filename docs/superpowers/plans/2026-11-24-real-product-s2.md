# Real Product S2 SQL Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQL Server 2022 as a real, safe connector and verify it end to end through the UI against the isolated SQL Server testbed.

**Architecture:** Keep Scale Insyght native and use Colima only for a local SQL Server source. Implement `SqlServerConnector` behind the existing `ReadOnlyConnector` interface, reuse encrypted connection storage and lifecycle routes, and add SQL-derived expectations to the existing testbed runner.

**Tech Stack:** Node 22, TypeScript, pnpm, SQL Server 2022, Colima/Rosetta, `mssql` driver, Playwright, Vitest, PostgreSQL 16.

**Spec:** `docs/phases/real-product-s2.md` and `docs/superpowers/specs/2026-11-24-real-product-design.md`.

## Global Constraints

- SQL Server is a test source only; Scale Insyght development remains native and Phase 6 packaging is out of scope.
- `pnpm test:testbed` is local-only; normal CI does not require SQL Server or Docker.
- Source credentials are encrypted at rest and never logged or returned after creation.
- Every source query has a 10-second timeout, a 1,000-row ceiling, and read-only access.
- Never weaken or skip tests; preserve frozen contract envelopes and PostgreSQL behavior.
- Only fictional records are used, and shared patient/encounter identifiers are retained only in this local testbed.
- Push every S2 commit to `real-product-s2`; merge the PR only after CI is green.

## Review Focus

1. An SQL login has object-level write grants despite a read-only-looking role; test all effective database/schema/object write permissions and reject it (Task 2).
2. Metadata identifiers include SQL Server reserved words or punctuation; test bracket quoting and bind values separately (Task 2).
3. A view or routine definition is unavailable to the login; report inaccessible metadata without marking the entire source inaccessible (Task 2).
4. Encryption is disabled or certificate validation fails; default to encryption with certificate validation, and make any local testbed trust override explicit (Tasks 1 and 3).
5. SQL Server is unavailable on this Mac or Colima cannot expose an amd64 SQL Server 2022 container; keep tests local-only and report the concrete missing host/runtime requirement without replacing SQL Server with a mock (Task 1).

---

## File Map

- `testbed/sqlserver/schema.sql`, `data.sql`, `setup.ts`: isolated SQL Server 2022 schema, fictional seed and read-only login.
- `testbed/sqlserver/truth.ts` and `testbed/truth.ts`: SQL-derived SQL Server metrics and combined truth oracle.
- `testbed/up.ts`, root `package.json`, `.env.example`: local testbed lifecycle and explicitly test-only configuration.
- `packages/connectors/src/sql-server.ts` and `packages/connectors/src/index.ts`: live read-only connector, SQL Server metadata, safety checks, relationships and bounded query execution.
- `packages/connectors/package.json`, `pnpm-lock.yaml`: SQL Server driver dependency.
- `apps/api/src/server.ts`, `apps/worker/src/main.ts`: credential validation, activation/profiling, and guarded analytic execution.
- `apps/web/src/main.tsx`: source-type choice and labeled SQL Server credential form.
- `tests/unit/sql-server-connector.test.ts`, `tests/contracts/c2_sqlserver_read_only.test.ts`, `tests/testbed/c6_sqlserver_truth.test.ts`, `tests/e2e/real-product-s2.spec.ts`: named unit, real source contract, and UI acceptance cases.
- `playwright.testbed.config.ts`, `package.json`: local-only S2 walkthrough integration.
- `docs/gap-audit.md`, `docs/phases/real-product-s2-report.md`, `docs/phases/real-product-s2-demo.md`, `docs/acceptance/s2/`: truth status, run instructions and evidence.

## Tasks

### Task 1: SQL Server 2022 testbed and truth

**Interfaces:** Produces `SQLSERVER_TESTBED_URL` in ignored `.env`, `si_testbed_sqlserver`, a least-privilege test login, and `testbed/truth.json.sqlServer` counts. Colima setup is host infrastructure only; the Scale Insyght app remains native.

- [ ] Add failing `sqlserver_testbed_truth_is_database_derived` and `sqlserver_and_postgres_share_patient_and_encounter_keys` cases. Assert the five named tables, a view, a stored procedure, row/column counts and counts of shared keys, without emitting raw identifiers.
- [ ] Run those cases and confirm they fail while the SQL Server source is absent.
- [ ] Install/initialize Colima only as needed; start SQL Server 2022 with amd64/Rosetta on Apple Silicon. Create the isolated database/schema, seed rows matching PostgreSQL truth, and create a SELECT-only SQL login. Add `pnpm testbed:sqlserver:up` and make `pnpm testbed:up` refresh both SQL truth sections.
- [ ] Run `pnpm testbed:sqlserver:up` and `pnpm testbed:truth`; verify the DB rejects write attempts for the reader and that computed counts/shared-key matches match the PostgreSQL side.
- [ ] Commit and push `test: add isolated SQL Server testbed`.

### Task 2: Real SQL Server connector and safety

**Interfaces:** `SqlServerConnector(input: {server:string;port:number;database:string;username:string;password:string;encrypt:true;trustServerCertificate?:boolean;id?:string;name?:string;statementTimeoutMs?:number;maxRows?:number})` implements `ReadOnlyConnector`.

- [ ] Add failing `sqlserver_connector_rejects_effective_write_permissions`, `sqlserver_connector_limits_query_time_and_rows`, `sqlserver_catalog_discovery_includes_views_and_routines`, and `sqlserver_structural_references_label_declared_and_inferred` cases.
- [ ] Run unit and real SQL Server contract cases; confirm the connector is absent and write-capable credentials cannot be tested.
- [ ] Add the maintained `mssql` driver to `packages/connectors`. Implement encrypted-required connection, 10-second query timeout, a 1,000-row ceiling, safe bracket-quoted catalog identifiers, catalog discovery/profile, routine definitions, declared FK discovery, and bounded same-source typed query intents. Refuse sysadmin/db_owner or effective INSERT/UPDATE/DELETE/ALTER/CONTROL access before activation.
- [ ] Run focused unit and real SQL Server contracts; prove SELECT succeeds, writes and an over-time query fail, and large row results are bounded.
- [ ] Commit and push `feat: implement read-only SQL Server connector`.

### Task 3: API and worker SQL Server lifecycle

- [ ] Add failing `sqlserver_credentials_are_encrypted_before_activation`, `sqlserver_activation_creates_one_connector_agent`, and `sqlserver_profile_persists_real_catalog_metadata` contract cases.
- [ ] Run focused contracts and confirm credential-backed SQL Server input is currently rejected.
- [ ] Extend the existing connection form contract and encrypted secret decoder by connector type. Route test/activate/profile and worker query execution through `SqlServerConnector`; maintain the existing API paths and lifecycle events. Keep test-only providers under `tests/`.
- [ ] Run real PostgreSQL and SQL Server lifecycle contracts together; compare SQL Server tables, fields, row counts, views, routines and FK metadata to truth.
- [ ] Commit and push `feat: activate and profile SQL Server sources`.

### Task 4: SQL Server connector UI and answer evidence

- [ ] Add failing Playwright case `s2_empty_tenant_adds_sql_server_profiles_and_answers_with_evidence`; begin in a new empty tenant and use only the generated read-only SQL login.
- [ ] Run the case and confirm the current UI offers PostgreSQL only and cannot save a SQL Server source.
- [ ] Add a SQL Server selection and labeled credential fields to the existing Add Connector flow. Default encryption on; expose only a local testbed certificate override when needed. Test, activate, wait for real profiling, and render Profile, ER, Dictionary and live Home result evidence from API responses.
- [ ] Run the S2 UI case at 1440×900; check shared source counts, declared/inferred labels, and answer source/query/row-count evidence against truth. Save screenshots/video under `docs/acceptance/s2/`.
- [ ] Commit and push `feat: add SQL Server to the connector UI`.

### Task 5: Testbed suite, gap audit, demo and PR

- [ ] Extend `pnpm test:testbed` to run the SQL Server truth and UI cases only on local Colima; never add SQL Server to the GitHub Actions service matrix.
- [ ] Update SQL Server's `docs/gap-audit.md` status only after the UI case passes. Write the demo steps and S2 report, including assumptions, startup commands, Colima settings and all test results.
- [ ] Run lint, typecheck, unit, sqlparse, integration, contract, E2E and full `pnpm test:testbed` gates. Investigate failures at their root cause.
- [ ] Push each final commit, open/update the PR to `main`, and merge only when CI is green.
