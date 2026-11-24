# S1: Empty Tenant to Real PostgreSQL Implementation Plan

> **For agentic workers:** Required approach: execute this plan task by task in the current session. Every task is TDD; push each commit immediately to `real-product`. No later slice starts until S1 is merged.

**Goal:** A newly provisioned tenant can sign in, invite a member, connect a read-only PostgreSQL database through the UI, and see real profile/ER/Dictionary data plus one evidence-backed Home answer.

**Architecture:** Remove product runtime fixture providers and keep deterministic fixtures only in tests. Use tenant-scoped login credentials, hashed single-use invites, encrypted connection secrets, and a general PostgreSQL connector. The S1 testbed creates an isolated hospital database and truth oracle; the local Playwright test drives the same UI flow as a user.

**Tech Stack:** Node 22, TypeScript, pnpm, Fastify, React/Vite, PostgreSQL 16, `pg`, ExcelJS, Playwright, Vitest, OpenAI-compatible model gateway.

**Spec:** `docs/superpowers/specs/2026-11-24-real-product-design.md` (approved 24 Nov 2026)

## Global Constraints

- User-approved slices merge independently with a click-through demo, their part of `pnpm test:testbed`, and a gap-audit update.
- Golden fixtures and deterministic providers are test-only; testbed synthetic records are under `testbed/` and excluded from product builds.
- PostgreSQL source access is read-only, uses a 10-second statement timeout, and caps returned rows at 1,000.
- Refuse connector activation if the supplied account can write or has elevated database/role privileges.
- Secrets are encrypted at rest, never logged, echoed, committed, snapshotted, or returned after submission.
- Identifier values are never persisted raw; contract 7 classifications and scrubbing remain authoritative.
- Preserve the frozen outer `AnalyticPlanSchema`; typed query intent is validated inside its existing `inputs` record.
- No CI or local test may be weakened, skipped, or redirected to a mock database. PostgreSQL contracts use real PostgreSQL 16.
- Do not start S2 or Phase 6.

## Review Focus

1. **Same email exists in different tenants:** tenant ID is mandatory on password login; test wrong tenant/email combinations fail without revealing which field matched.
2. **Credential role has inherited write grants:** activation inspects effective privileges and fails before profile or agent creation; test table, schema, database, superuser, and role grants.
3. **Long-running or wide source query:** all PostgreSQL statements observe the 10-second timeout and result ceiling; test statement timeout and 1,001-row source.
4. **Sensitive metadata accidentally disclosed:** testbed tags are sourced from PostgreSQL comments, not column-name heuristics; prove values and sensitive statistics never reach the model boundary.
5. **Malformed or conflicting dictionary import:** validate CSV/XLSX headers, duplicate keys, unknown tables/columns, and descriptions with quotes/newlines; reject atomically with a useful error.

## File Map

- `packages/db/migrations/021_real_product_tenant_auth.ts`: tenant administrator membership and hashed invite state with RLS.
- `packages/db/migrations/022_real_postgres_connections.ts`: connection display-name metadata; credentials remain in the existing encrypted `registry.connection_secrets` table.
- `packages/db/migrations/023_real_dictionary_descriptions.ts`: source/asset-scoped imported descriptions with RLS.
- API work belongs in `apps/api/src/server.ts`, `apps/api/src/main.ts`, and focused helpers beside them.
- `scripts/tenant-create.ts`: operator-only tenant/first-user provisioner; package script `tenant:create`.
- `packages/connectors/src/postgres.ts`: generic connection configuration, read-only validation, timeout, row cap, live discovery/profile/query operations.
- `packages/connectors/src/connection-secrets.ts`: AES-256-GCM encryption/decryption using a dedicated `CONNECTION_SECRET_KEY`.
- `packages/profiler/src/index.ts`: generic real profiling; remove golden structural-reference fallback and create evidence-backed declared/inferred assertions.
- `packages/graph/src/dictionary.ts`: persist/list real dictionary descriptions and coverage; `packages/graph/src/index.ts` has no golden metadata import.
- `packages/analytic/src/query-intent.ts`: typed, validated operation schema and source/asset/join-bound validation for the five supported shapes.
- `packages/analytic/src/executor.ts`: production-only guarded query execution and evidence; deterministic executor moves under `tests/support/`.
- `apps/worker/src/worker.ts`: injectable worker loop; `apps/worker/src/main.ts` supplies only the live executor and never imports tests.
- `apps/web/src/main.tsx`, `apps/web/src/style.css`: prototype-faithful S1 screens and credential/invite/dictionary/import flows; API-bound values only.
- `testbed/postgres/schema.sql`, `testbed/postgres/data.sql`, `testbed/dictionary.csv`: small fake hospital source with declared and undeclared relationships, tagged sensitive columns, views, functions, and shared keys.
- `testbed/up.ts`, `testbed/truth.ts`, `testbed/truth.json`: isolated database setup/reset and SQL-derived oracle.
- `tests/support/`: test-only fixture providers, database tenant helper, testbed config readers, and an injectable deterministic worker entrypoint used only by Playwright/CI.
- `tests/unit/`, `tests/contracts/`, `tests/e2e/real-product-s1.spec.ts`: named unit, PostgreSQL contract, and Playwright acceptance cases.
- `docs/gap-audit.md`: S1 status update; label a row Real only after the corresponding E2E test passes.

## S1 Interfaces

- `createConnectionDraft(pool, {tenantId, principalId, connectorType:'postgres', displayName, credential}) -> {connectionId}` stores only the encrypted credential; connection identity/credentials are not returned.
- `decryptConnectionSecret({tenantId, connectionId, key}) -> {host, port, database, username, password, sslMode}` is available only to API/worker source adapters.
- `PostgresConnector({connectionString, id, name, statementTimeoutMs:10000, maxRows:1000})` implements discovery, profile, structural references, effective read-only validation, and typed read queries.
- `pnpm tenant:create` accepts a workspace slug/name, first-user email and hidden password prompt; it prints the workspace id and user email, never password/hash. Password login requires workspace id.
- `POST /api/tenant/invites` creates a 24-hour, single-use invite and returns a one-time copyable URL. `POST /api/tenant/invites/accept` accepts token, password, and display name; only the token hash is stored.
- `POST /api/connections` accepts `connectorType:'postgres'`, a display name, and PostgreSQL credential fields. Test and activate use `POST /api/connections/:id/test` and `/activate`; successful activation creates the connector agent and starts a real profile.
- `POST /api/connections/:id/dictionary/import` accepts CSV or XLSX with columns `table`, `column`, `description`; results are tenant/source scoped and atomic.
- A `PlanStep.inputs` entry uses `{query_intent: <strict typed intent>}`. Intent variants are `count`, `filtered_count`, `group_by`, `join_aggregate`, and `compare_aggregates`. All query references resolve to assets in the selected connection(s); joins require a stored graph assertion; literals bind as parameters; source SQL is generated by the compiler, never copied from model text.

## Tasks

### Task 1: Isolated PostgreSQL testbed and truth oracle

**Files:**
- Create `testbed/postgres/schema.sql`, `testbed/postgres/data.sql`, `testbed/dictionary.csv`, `testbed/up.ts`, `testbed/truth.ts`, `testbed/truth.json`
- Modify root `package.json` scripts
- Test: `tests/unit/testbed-truth.test.ts`, `tests/testbed/c6_testbed_postgres_truth.test.ts`

- [ ] **Step 1: Write failing test cases** `testbed_truth_is_sql_derived_and_has_expected_fixtures` and `testbed_pg_has_five_hospital_tables_two_views_two_functions_sensitive_tags_and_undeclared_pair`. Assert schema has patient, encounter, order, department, provider; >=2,000 rows total; two DB-declared FK pairs; one shared-key relationship with no declared FK; tags for name, DOB, MRN, phone; and truth keys for row/column counts, FK pairs, inferred pair, sensitive columns, null rates, and metrics.
- [ ] **Step 2: Run `pnpm exec vitest run tests/unit/testbed-truth.test.ts tests/testbed/c6_testbed_postgres_truth.test.ts` and confirm the new tests fail because the testbed files/scripts do not exist.**
- [ ] **Step 3: Implement `testbed:up` and `testbed:truth`** using PostgreSQL 16, an isolated `si_testbed_pg` database, a generated `si_testbed_reader` role with only SELECT/CONNECT, and `.env`-only generated credentials. Keep the tenant app database separate. Seed stable fake patient/encounter IDs. `truth.ts` queries the source database directly and writes only computed truth values to `testbed/truth.json`.
- [ ] **Step 4: Rerun the two tests and both commands; require the expected table/column/key/tag counts and verify `si_testbed_reader` cannot INSERT/UPDATE/DELETE or create schema objects.**
- [ ] **Step 5: Commit and push `test: add isolated PostgreSQL testbed truth`.**

### Task 2: Encrypted connection credentials and PostgreSQL safety

**Files:**
- Create `packages/connectors/src/connection-secrets.ts`
- Modify `packages/connectors/src/postgres.ts`, `packages/connectors/src/index.ts`, `.env.example`
- Tests: `tests/unit/connection-secrets.test.ts`, `tests/unit/phase3-connectors.test.ts`, `tests/contracts/c2_postgres_activation_requires_read_only_role.test.ts`

- [ ] **Step 1: Add failing tests** `connection_secret_roundtrips_and_authentication_fails_on_tamper`, `postgres_connector_sets_timeout_and_row_ceiling`, and `postgres_activation_refuses_effective_write_or_elevated_privileges`. Use real PostgreSQL roles and grants for the contract test.
- [ ] **Step 2: Run those tests and confirm the connector accepts the current broad privileges, has no per-query row ceiling, and no connection-secret cipher exists.**
- [ ] **Step 3: Implement `encryptConnectionSecret`/`decryptConnectionSecret` with AES-256-GCM and a 32-byte base64 `CONNECTION_SECRET_KEY`; generalize connector constructor; set `statement_timeout=10000`, `default_transaction_read_only=on`, and bounded metadata/data queries; verify effective database/schema/table write privileges and role flags before returning `readOnly:true`.**
- [ ] **Step 4: Rerun focused tests; prove writable and elevated roles fail before profile/activation, read-only role succeeds, timeout aborts a long statement, and result queries return at most 1,000 rows.**
- [ ] **Step 5: Commit and push `feat: secure real PostgreSQL connector credentials`.**

### Task 3: Tenant creation, database-backed login, and invites

**Files:**
- Create migration `packages/db/migrations/021_real_product_tenant_auth.ts`, `scripts/tenant-create.ts`, `tests/support/tenant.ts`
- Modify `apps/api/src/server.ts`, `apps/api/src/main.ts`, `apps/web/src/main.tsx`, `apps/web/src/style.css`, `package.json`
- Tests: `tests/contracts/c1_tenant_create_empty_workspace_and_single_use_invite.test.ts`, `tests/unit/tenant-create.test.ts`, `tests/e2e/real-product-s1.spec.ts`

- [ ] **Step 1: Add failing cases** `c1_tenant_create_provisions_no_product_records`, `c1_password_login_is_workspace_scoped`, `c1_invite_is_hashed_expires_and_is_single_use`, and `c1_invite_cannot_cross_tenant`. Assert newly provisioned workspaces have zero connections, profiler jobs, graph assets, findings, saved questions, approvals, conversations/runs, and reports.
- [ ] **Step 2: Run focused tests and confirm current auth requires a fixture allowlist and no tenant/invite provisioning exists.**
- [ ] **Step 3: Implement the `pnpm tenant:create` CLI, mandatory workspace-id password login, invite migration/API/UI, 24-hour expiry, token hashing, atomic one-time acceptance, and tenant-scoped membership capability. Add the login-required workspace-id field.**
- [ ] **Step 4: Run migration tests and contract tests; create tenant A/B with the same email, verify tenant boundary and invite replay failures, and inspect the new tenant for zero product rows.**
- [ ] **Step 5: Commit and push `feat: provision empty tenants and invite members`.**

### Task 4: Remove runtime fixtures and move deterministic providers under tests

**Files:**
- Modify `apps/api/src/main.ts`, `apps/api/src/server.ts`, `apps/worker/src/main.ts`, `packages/connectors/src/index.ts`, `packages/connectors/src/metadata.ts`, `packages/connectors/src/generic.ts`, `packages/profiler/src/index.ts`, `packages/graph/src/index.ts`, `packages/analytic/src/index.ts`, `packages/analytic/src/executor.ts`, `packages/hub-adapters/src/index.ts`, root `package.json`
- Create `tests/support/fake-connector.ts`, `tests/support/deterministic-analytic-provider.ts`, `tests/support/fake-hub-adapter.ts`, `tests/support/test-worker.ts`, `tests/unit/product-runtime-fixture-isolation.test.ts`
- Modify `playwright.config.ts` and all tests/e2e/CI setup that currently imports fixture-backed runtime paths; retain each existing test case and assertion intent

- [ ] **Step 1: Add failing test** `product_runtime_has_no_fixture_seed_or_canned_result_imports`. Scan shipped `apps/` and `packages/` runtime sources for imports/paths under `tests/golden`, `createGoldenConnector`, `importGoldenMetadata`, `runGoldenProfile`, `executeGoldenStep`, fixture Hub defaults, `golden://` and `demo:seed`; allow these only under `tests/` and test-only support.
- [ ] **Step 2: Run the new isolation test and confirm it finds the existing fixture imports and demo script.**
- [ ] **Step 3: Remove fixture catalog/connector/profile/metadata import/result/Hub fallback from production; remove `demo:seed`, `db:seed:golden`, and `demo:phase0` product commands. Export the worker loop as `runWorker({executor})`; production `apps/worker/src/main.ts` supplies only the live executor, while `tests/support/test-worker.ts` supplies the deterministic test executor. Put test fixture data under `tests/`, inject test providers only from test server/worker entry points, and update every existing contract/E2E setup without dropping or weakening assertions.**
- [ ] **Step 4: Run isolation test and all existing unit/contract/E2E tests; fixture paths must resolve only from test code and production API must return no seeded sources or results.**
- [ ] **Step 5: Commit and push `refactor: isolate all fixture providers under tests`.**

### Task 5: Live PostgreSQL connector UI and actual profile/ER

**Files:**
- Create migration `packages/db/migrations/022_real_postgres_connections.ts`
- Modify `packages/registry/src/index.ts`, `packages/profiler/src/index.ts`, `apps/api/src/server.ts`, `apps/web/src/main.tsx`, `apps/web/src/style.css`
- Tests: `tests/contracts/c2_postgres_ui_lifecycle.test.ts`, `tests/contracts/c6_postgres_profile_dictionary_er.test.ts`

- [ ] **Step 1: Add failing route/API tests** `c2_user_supplied_postgres_credential_is_encrypted_before_activation`, `c2_successful_activation_creates_one_connector_agent`, `c6_postgres_profile_matches_source_catalogue`, and `c6_postgres_er_separates_declared_and_inferred_relationships`.
- [ ] **Step 2: Confirm the current sourceId-only API rejects credential-based PostgreSQL config and falls back to golden structural references.**
- [ ] **Step 3: Implement PostgreSQL credential draft/test/activate using the encrypted secret store, persist a user display name, open a live connector from the stored credential, run profiling from the real source, and write source catalog-derived table/view/routine inventory, fields, column comments/definitions, profiles, FK evidence, and connector-agent registration. Dictionary displays actual view/function definitions; SQL lineage parsing is completed in S4. No golden fallback remains.**
- [ ] **Step 4: Run against `si_testbed_pg`; compare listed/profiled tables, views, routines, fields, row counts, and declared FK pairs, source write refusal, and agent count to `testbed/truth.json`.**
- [ ] **Step 5: Commit and push `feat: profile tenant PostgreSQL connections`.**

### Task 6: Classification, inferred relationship, and real dictionary import

**Files:**
- Create migration `packages/db/migrations/023_real_dictionary_descriptions.ts`, `packages/graph/src/dictionary.ts`, `packages/profiler/src/classification.ts`
- Modify `packages/connectors/src/postgres.ts`, `packages/profiler/src/index.ts`, `packages/graph/src/index.ts`, `apps/api/src/server.ts`, `apps/web/src/main.tsx`
- Tests: `tests/contracts/c6_postgres_sensitive_classification_dictionary_inference.test.ts`, `tests/unit/dictionary-import.test.ts`

- [ ] **Step 1: Add failing test cases** `c6_postgres_comment_tags_classify_sensitive_fields_without_name_heuristics`, `c7_sensitive_statistics_never_reach_model`, `c6_undeclared_shared_key_is_inferred_not_declared`, and `dictionary_csv_xlsx_updates_documented_coverage_atomically`.
- [ ] **Step 2: Confirm profile output ignores non-identifier sensitivity tags, there is no inference for the undeclared pair, and the dictionary import route/table is absent.**
- [ ] **Step 3: Read sensitivity tags from PostgreSQL comments/tags; store and render tags without sampling sensitive columns. Compare candidate identifiers in a read-only bounded query, discard raw values, and store only assertion/evidence/fingerprint data with `evidence_method='inferred'`. Import CSV/XLSX table/column/description rows into a tenant/source-scoped RLS table and compute harvested/documented coverage.**
- [ ] **Step 4: Verify tagged name/DOB/MRN/phone columns in Profile, prove no raw values or sensitive statistics cross the model boundary, verify the relationship is rendered inferred, and compare Dictionary coverage/descriptions to truth.**
- [ ] **Step 5: Commit and push `feat: classify profile fields and import dictionaries`.**

### Task 7: Typed analytic query intents and real count execution

**Files:**
- Create `packages/analytic/src/query-intent.ts`, `packages/analytic/src/query-compiler.ts`, `tests/support/test-analytic-executor.ts`, `apps/worker/src/worker.ts`, `tests/support/test-worker.ts`
- Modify `packages/contracts/src/index.ts` only if needed while retaining wire compatibility; modify `packages/analytic/src/index.ts`, `packages/analytic/src/executor.ts`, `packages/model-gateway/src/index.ts`, `apps/api/src/server.ts`, `apps/worker/src/main.ts`
- Tests: `tests/unit/analytic-query-intent.test.ts`, `tests/contracts/c3_query_intent_source_bounds.test.ts`, `tests/contracts/c4_real_query_answer_evidence.test.ts`

- [ ] **Step 1: Add failing cases** `c3_query_intent_validates_count_filtered_count_group_by_join_and_compare`, `c3_query_intent_rejects_unselected_sources_unknown_assets_unasserted_joins_and_raw_sql`, and `c4_real_postgres_count_answer_cites_executed_sql_source_and_row_count`.
- [ ] **Step 2: Confirm current validator accepts only a question hash and worker returns a golden metric without executing source SQL.**
- [ ] **Step 3: Add strict query-intent variants inside the existing `PlanStep.inputs` record for count, filtered count, group-by, within-source join aggregate, and two-source aggregate comparison. Keep outer contract fields unchanged. Compile identifiers only from tenant-scoped graph metadata, bind all literals, require assertion-backed joins, enforce source selection, row limit, timeout, and query budget. Have the OpenAI planner propose this shape via the existing disclosure-gated gateway and validate before runner enqueue. Execute the count query in the worker through the credential-backed PostgreSQL connector.**
- [ ] **Step 4: Run plan tests for all five shapes and invalid cases; run the real SQL contract and compare count to truth. Verify answer evidence has scrubbed SQL, selected source, one-row result count, asset references, and no raw data/model result rows.**
- [ ] **Step 5: Commit and push `feat: execute validated PostgreSQL analytic queries`.**

### Task 8: S1 prototype-matched UI and complete empty-state demo

**Files:**
- Modify `apps/web/src/main.tsx`, `apps/web/src/style.css`, `apps/web/index.html`
- Test: `tests/e2e/real-product-s1.spec.ts`, `tests/unit/no-raw-form-controls-outside-ui.test.ts` if shared UI components are required by the control lint gate

- [ ] **Step 1: Add Playwright failing scenario** `s1_empty_tenant_adds_postgres_profiles_opens_er_dictionary_and_answers_real_count`. Begin with a CLI-created empty tenant; assert no fixture/demo copy, add PostgreSQL credentials, test/activate, wait for profile, inspect real declared/inferred ER, import dictionary, inspect coverage, ask one count, and check answer/evidence against truth.
- [ ] **Step 2: Run the scenario and verify it fails on the current fixed-source chooser and missing prototype screen structure.**
- [ ] **Step 3: Port the prototype markup/CSS classes and spacing for S1 shell, login/invite, Home chat, connectors/add flow, Profile, ER, and Dictionary. Use API values only; use accurate empty states and source metadata. Wire the PostgreSQL credential form and CSV/XLSX dictionary upload.**
- [ ] **Step 4: Run Playwright at 1440×900; capture screenshot and video under `docs/acceptance/s1/`; compare with `docs/prototype/index.html`; verify recents do not clip and login/connector errors reveal no credentials.**
- [ ] **Step 5: Commit and push `feat: connect PostgreSQL from the real-product UI`.**

### Task 9: S1 walkthrough command, audit, full gates, PR

**Files:**
- Modify `package.json`, `docs/gap-audit.md`, `docs/superpowers/specs/2026-11-24-real-product-design.md`
- Create `tests/e2e/real-product-s1.spec.ts` if not created in Task 8, `docs/acceptance/s1/README.md`

- [ ] **Step 1: Add failing test** `testbed_walkthrough_starts_empty_and_s1_acceptance_reaches_real_postgres_answer`; wire `pnpm test:testbed` to `testbed:up`, `testbed:truth`, tenant creation, and Playwright.
- [ ] **Step 2: Run `pnpm test:testbed` and confirm it fails if source/query/profile/evidence differs from SQL truth or the empty tenant already has product rows.**
- [ ] **Step 3: Complete the S1 walkthrough assertion set; update only passing gap-audit rows to `Real`, and change removed fixture-backed capabilities to `Missing` with reasons until their later slice.**
- [ ] **Step 4: Run all required gates:** `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:sqlparse`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`, and `pnpm test:testbed`. Do not report green unless each exits zero. Open S1 PR; merge only after required CI is green.**
- [ ] **Step 5: Commit and push `docs: record real PostgreSQL S1 acceptance`.**

## Coverage Self-Review

- Slice S1: Tasks 1–9 cover tenant creation/login/invite, complete runtime fixture removal, real PostgreSQL UI lifecycle, profile, ER, Dictionary import, classification, inference, Home count, testbed/truth, screenshots/video, audit and merge.
- S2–S9: explicitly excluded from this plan; they have separate slice rows in the approved design and will get their own plans after S1 merges.
- Outer frozen plan schema: preserved; query intent uses its existing extensible `inputs` record. No contract weakening or new outer plan field.
- SQL safety and raw identifiers: covered in Tasks 2, 6, 7 and Review Focus cases.
- No CI test weakening: all existing suites run after fixture injection is moved to tests.
- Plan-shape truth: validator accepts all five shapes in S1; only count is executed end-to-end in S1. Later S7 adds the remaining four to `pnpm test:testbed` and validates all outputs against truth.
