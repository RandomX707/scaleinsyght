# S2 Conversation, Answer, Identifier, and ER Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver durable Home conversations with validated, model-authored typed queries and model answer provenance, exact source identifiers, a truth-matched ER view, and shared UI controls.

**Architecture:** Associate authenticated-user conversations with the existing analytic runs, answers and evidence. Extend the semantic query-intent schema compatibly and validate every table, column, relationship, source, row limit and timeout before execution. Store planner and answer model call provenance in tenant-scoped run data. Render the Home transcript and ER view from API data.

**Tech Stack:** TypeScript, React, Fastify, PostgreSQL 16/RLS, Zod, OpenAI-compatible model gateway, SQL Server/PostgreSQL connectors, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-24-s2-conversation-answer-er-design.md`

## Global Constraints

- No S3 work; changes stay on `real-product-s2-fixes`.
- No runtime fixtures, mocks, raw identifier values or unvalidated SQL.
- PostgreSQL and SQL Server queries remain read-only, time-bounded and row-limited.
- Preserve source identifiers exactly, including punctuation, underscores and case.
- Conversation and provenance data obey tenant RLS and authenticated-principal ownership.
- No template/keyword answer fallback when the model or typed plan fails.
- Conversation and model-provenance gap-audit entries remain Fake until the full real-source walkthrough proves them.

## Review Focus

- Follow-up pronouns cannot read turns from another thread, user or tenant — contract/API ownership tests.
- Unsupported model plans must fail before any SQL executes — schema/validator and query-count tests.
- Aggregated answer-generation prompts cannot include raw result values or patient identifiers — model-boundary capture test.
- Source labels and SQL remain byte-for-byte unchanged through UI formatting — formatter and browser assertions.
- Inferred ER edges below threshold and all containment edges stay out of the relationship count — SQL-backed ER contract.

---

### Task 1: Conversation persistence and routes

**Files:**
- Create: `packages/db/migrations/024_s2_conversations.ts`
- Modify: `apps/api/src/server.ts`
- Tests: `tests/contracts/c1_s2_conversations.test.ts`

**Interfaces:**
- `POST /api/conversations` creates an empty thread and returns `{ conversationId }`.
- `GET /api/conversations` returns owner-scoped `{ conversationId, title, updatedAt }` newest first.
- `GET /api/conversations/:id` returns ordered question/run/answer turns.
- `POST /api/runs` accepts `conversationId`; it verifies ownership, adds only prior turns from that thread to planner context, sets the first-question title, and associates the new run.

- [ ] Write failing cases for create/list/reopen, title/order, turn association, context, and cross-owner/tenant rejection.
- [ ] Run `pnpm test:contracts -- --run tests/contracts/c1_s2_conversations.test.ts` and confirm the expected missing-route/schema failures.
- [ ] Add RLS-protected conversation records and nullable run association; add the three routes and context assembly.
- [ ] Run the focused contract cases and verify isolation plus newest-first ordering.
- [ ] Commit: `feat: persist owner-scoped Home conversations`; push immediately.

### Task 2: Full typed query plan, validation, and SQL execution

**Files:**
- Modify: `packages/contracts/src/query-intent.ts`
- Modify: `packages/connectors/src/postgres.ts`
- Modify: `packages/connectors/src/sql-server.ts`
- Modify: `packages/analytic/src/index.ts`
- Modify: `apps/api/src/server.ts`
- Tests: `tests/contracts/c3_s2_typed_plan.test.ts`, `tests/testbed/c3_real_postgres_query_intents.test.ts`, `tests/testbed/c2_sqlserver_read_only.test.ts`

**Interfaces:**
- Preserve existing intent variants. Add compatible predicates (including null checks), grouped ordering/limit, average-per-nested-group, and relationship-checked multi-table filtered aggregate intent.
- The model returns semantic plan steps with source index and intent; Zod schema, candidate source scope, catalog assets/fields, relationship assertions, and connector caps validate before enqueue.
- SQL compilers use parameterized values and quoted identifiers; no model-authored SQL is accepted.

- [ ] Add failing schema/compiler cases for Emergency + year predicates, orders top-five by count, average encounter count per patient grouped by provider, two-source patient-count comparison, and phone non-null follow-up.
- [ ] Run the focused contract and source tests and confirm each fails because its intent/compiler is missing.
- [ ] Implement backwards-compatible schema additions and PostgreSQL/SQL Server compilers with evidence-based join validation.
- [ ] Run the cases against both local testbeds and compare outputs to `testbed/truth.json`.
- [ ] Commit: `feat: extend validated S2 query plans`; push immediately.

### Task 3: Model provenance and model-composed answers

**Files:**
- Create: `packages/db/migrations/025_s2_model_provenance.ts`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/worker/src/main.ts`
- Modify: `packages/analytic/src/executor.ts`
- Modify: `apps/web/src/main.tsx`
- Tests: `tests/contracts/c7_s2_model_provenance.test.ts`, `tests/e2e/real-product-s2.spec.ts`

**Interfaces:**
- Persist planner/answer model name, actual input/output tokens and validated typed plan per run under RLS.
- `/api/runs/:id` returns provenance with planner and answer calls and the validated semantic plan.
- The worker prompts only with the question, validated plan, aggregate results, source names and SQL evidence, then requires a sentence grounded in the returned aggregates. Provider/validation failure marks the answer failed; it never emits a templated substitute.

- [ ] Add failing tests proving model and token metadata are stored/rendered; typed plan equals the validated model output; generation prompts contain no row-level identifiers; a failed/unsupported plan runs no SQL and produces a clear status.
- [ ] Run focused contract/E2E tests to confirm they fail for missing provenance and template fallback.
- [ ] Persist and expose actual gateway call provenance; compose answer prose from aggregate-only evidence; show “How this was answered”, total tokens and the plan in Home.
- [ ] Run focused tests plus the five-question local testbed walkthrough.
- [ ] Commit: `feat: expose model provenance and composed answers`; push immediately.

### Task 4: Home conversation UI and recent threads

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/shell.css`
- Modify: `tests/e2e/real-product-s2.spec.ts`

- [ ] Add failing Playwright steps for greeting, send clears composer, follow-up retains earlier turn, New chat starts a distinct thread, and recent thread reopens every turn.
- [ ] Run the focused S2 walkthrough and confirm these assertions fail.
- [ ] Render API-backed conversation list and transcript; navigate by conversation ID; pass thread ID on send; set title from first question and keep recent order from API.
- [ ] Run the focused walkthrough and save Home/sidebar screenshots at 1440×900.
- [ ] Commit: `feat: render persistent Home conversations`; push immediately.

### Task 5: Exact names, ER evidence/layout, shared file control

**Files:**
- Modify: `apps/web/src/main.tsx`
- Modify: `apps/web/src/phase3.css`
- Modify: `apps/api/src/server.ts`
- Modify: `packages/ui/src/index.tsx`, `packages/ui/src/components.css`
- Tests: `tests/unit/source-name-rendering.test.ts`, `tests/testbed/c6_s2_er_truth.test.ts`, `packages/ui/tests/ui.test.tsx`

- [ ] Add failing checks for exact `encounter_id`, `department_order_summary`, and `public.patients` rendering, exact truth relationship set/count, confidence/evidence labels, field data types, view/table distinction, non-overlapping routed edges, and styled FileInput.
- [ ] Run focused unit/UI/source tests and confirm the current name normalization, missing confidence/type and file control style cause failures.
- [ ] Render identifiers verbatim; return field types, confidence and evidence from the API; filter inferred edges at the documented threshold; route edges around cards and style view nodes differently; add shared `FileInput`.
- [ ] Run focused tests and 1440×900 E2E ER/dictionary comparisons.
- [ ] Commit: `fix: render exact source names and evidence-backed ER`; push immediately.

### Task 6: Acceptance, gap audit, and merge

**Files:**
- Modify: `tests/e2e/real-product-s2.spec.ts`
- Modify: `tests/testbed/c6_sqlserver_truth.test.ts`
- Modify: `docs/gap-audit.md`
- Modify: `docs/phases/real-product-s2-report.md`
- Create/Update: `docs/acceptance/s2/`

- [ ] Walk through all five requested questions and verify every displayed number and SQL against `testbed/truth.json`; unsupported shapes return an explicit unsupported message without executing different SQL.
- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:sqlparse`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`, and `pnpm test:testbed`.
- [ ] Mark conversation/provenance Real only if the real-source walkthrough passes; otherwise leave both Fake with the precise remaining gap.
- [ ] Update report and screenshot/video evidence; run `git diff --check`.
- [ ] Commit and push; open a PR to `main`; merge only when every CI check is green.
