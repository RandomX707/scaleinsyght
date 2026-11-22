# Phase 2 Analytic Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the synthetic two-group analytic experience, personal memory and feedback, and an approved governed-agent rerun on the existing PostgreSQL runner.

**Architecture:** Keep plans, authorization, events and results server-owned. A deterministic local provider builds typed plans and structured answers from golden fixtures; the existing PostgreSQL runner persists/claims work. Personal memory is selected only by the authenticated person and never changes entitlements.

**Tech Stack:** TypeScript/Node 22, Fastify, React, Zod, PostgreSQL 16 RLS, Vitest, Playwright, pnpm/Corepack.

**Spec:** `docs/phases/phase-2.md`; frozen contracts C1–C5 and C7 in `docs/system-design-v3.2.md` Part 3.

## Global Constraints

- Use only `tests/golden`; make no hosted model, vendor system, credential, or real-data calls (decision 28).
- Tenant-owned tables use `tenant_id` and `ENABLE/FORCE ROW LEVEL SECURITY`; bind tenant from the authenticated session or stored run (C1).
- No role/persona field or UI (CLAUDE.md §3.13); personal context cannot widen entitlements (C1/C2/C3).
- Plans are typed and validated before queueing; read capabilities only; source calls are read-only (C2/C3; CLAUDE.md §3.3).
- Events are append-only, ordered and committed with state; refresh resumes by event id (C5).
- Answers use structured claims and evidence; rows and raw identifiers never enter memory, events or model input (C4/C7).
- Use the existing PostgreSQL runner and native PostgreSQL 16; add no service/infrastructure (CLAUDE.md §§3.14, 5.1).

## Review Focus

- A personal default source is revoked after memory was saved: API ignores it and the capability check still denies it.
- A run resumes after lease expiry while the stale worker is still active: fencing rejects its writes and events do not duplicate.
- One source times out after another succeeds: terminal state is `PARTIAL` with evidence only for completed work.
- A correction contains a row value or identifier: reject it before persistence and keep the evaluation case safe.
- A governed definition is edited after approval: create a new draft version; never mutate the approved run target.

## Task 1: Golden analytic corpus and typed plan schemas

**Files:** `tests/golden/phase2.json`, `packages/contracts/src/index.ts`, `tests/unit/analytic-plan.test.ts`.

**Interfaces:** Expose strict `AnalyticPlanSchema`, `PlanStepSchema`, `ClaimSchema`, `EvidenceRefSchema`, and canonical `hashPlan(plan)`; fixtures contain 30 prompts and expected result/evidence for each of SQL Server, PostgreSQL, Snowflake and Excel.

- [ ] Add named tests for strict plan/step/claim/evidence schemas, canonical hash stability, 30 questions per connector and literal expected outputs; run `pnpm exec vitest run tests/unit/analytic-plan.test.ts` and observe failures.
- [ ] Add schemas and deterministic corpus; verify the literal corpus has exactly 30 complete cases per connector and no model calls.
- [ ] Run lint/typecheck/unit; commit `feat: define analytic plans and golden questions`.

## Task 2: Memory and governed-definition persistence

**Files:** migration `008_analytic_mode.ts`, `packages/registry/src/index.ts`, `apps/api/src/server.ts`, RLS catalogue contract tests.

**Interfaces:** Add `getPersonalMemory(pool,tenantId,principalId)`, `putPersonalMemory(...)`, `deletePersonalMemory(...)`; `moveConnectionToGroup(...)`; `createGovernedDraft(...)`, `approveGovernedVersion(...)`, and `getApprovedGovernedVersion(...)`. Drop the old `role_template` column to follow CLAUDE.md §3.13. Add feedback and evaluation tables that store references/question/correction only, no result rows.

- [x] Write C1/C2/C7 PostgreSQL contract cases for owner-only read/write/delete, entitlement non-expansion, immutable versions, approval binding, source-group version moves and prohibited memory data.
- [x] Run targeted contract tests and verify failing behavior.
- [x] Add forced RLS, grants and immutable-version triggers; add `POST /api/groups/:groupId/members/:connectionId`; run `pnpm test:contracts` and catalogue checks; commit `feat: persist personal memory and governed definitions`.

## Task 3: Authorization, deterministic planning and run creation

**Files:** `packages/analytic/src/`, new package manifest/tsconfig, `apps/api/src/server.ts`, `tests/contracts/c3_analytic_plan_validation.test.ts`.

**Interfaces:** `createAnalyticPlan(input): AnalyticPlan`; `validateAnalyticPlan(pool,input): Promise<ValidatedPlan>`; `startAnalyticRun(pool,input): Promise<{runId:string}>`. Retrieve source groups, authorization and memory from tenant-scoped database state; never accept tenant/principal/entitlement claims from the body.

- [x] Add tests that invalid cycles/types/budgets/scope/auth never create a run or runner step; add separate cases for wrong source-group version and malformed model-proposed step inputs.
- [x] Implement deterministic golden planner, canonical plan hash and policy recheck before step dispatch.
- [x] Add `POST /api/runs`, `GET /api/runs/:id`, and resumable `GET /api/runs/:id/events`; test cross-tenant and forged-principal cases; commit `feat: validate and start analytic runs`.

## Task 4: Two-group collating, evidence and critic

**Files:** `packages/analytic/src/executor.ts`, `apps/worker/src/main.ts`, `packages/db/migrations/008_analytic_mode.ts`, C4/C5 contracts.

**Interfaces:** `executeGoldenStep(task): Promise<StructuredResult>`; `collateGroupResults(results): StructuredAnswer`; `criticCheck(answer,plan): CriticResult`. A task reads its source/group version from stored plan/run records. The golden scenario routes through two collating agents and emits two group joins plus one cross-group join.

- [x] Test both collating-agent routes, evidence on every material claim, interpretation labeling, no rows in requests/events, timeout to `PARTIAL`, and stale fencing.
- [x] Implement runner worker step dispatch against synthetic golden outputs; use no external model/source call.
- [x] Run C3–C5 contracts; commit `feat: execute and collate two-group golden runs`.

## Task 5: Personal answer shaping and feedback

**Files:** `packages/analytic/src/personal-context.ts`, API memory/feedback routes, `tests/contracts/c2_personal_memory_*.test.ts`.

**Interfaces:** `applyPersonalContext(answer,memory)` may alter wording/order only; numeric values, claims, evidence and authorized sources remain identical. `submitFeedback(...)` writes one verdict; a safe correction updates only that principal's memory and inserts one evaluation case.

- [x] Test two owners get identical values but distinct answer shape, corrections are owner-only, no raw identifiers/rows persist, and thumbs-up stores a reusable plan reference only.
- [x] Add `GET/PUT/DELETE /api/me/agent` and `POST /api/runs/:id/feedback`; test entitlement recheck for saved defaults.
- [x] Run targeted contracts/unit tests; commit `feat: add personal memory and answer feedback`.

## Task 6: Governed-agent lifecycle

**Files:** governed registry APIs, durable-run integration, `tests/contracts/c2_governed_agent.test.ts`.

- [ ] Test create draft → approve exact version → run → identical rerun, edit-after-approval creates a new draft, unauthorized approval is refused and no model call occurs.
- [ ] Implement governed-definition endpoints and durable-runner dispatch using the approved immutable plan version.
- [ ] Run C2/C5 contracts; commit `feat: run approved governed definitions`.

## Task 7: Product screens and E2E

**Files:** `apps/web/src/main.tsx`, phase CSS, `tests/e2e/phase2.spec.ts`.

- [ ] Add E2E for two-group question, live plan/event resume, evidence/trust badge, two-person answer shape, feedback correction, My agent edit/delete, group move and governed approval/rerun.
- [ ] Implement Home composer/answer, plan card, Agents/group controls, My agent and Approval matrix with keyboard access and persisted API state.
- [ ] Run Playwright and accessibility behavior checks; commit `feat: add phase two analytic workspace`.

## Task 8: Phase gate and PR

- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:integration`, `pnpm test:contracts`, and `pnpm test:e2e`; fix root causes without weakening tests.
- [ ] Verify golden score is at least 90% for 30 prompts per connector; verify RLS and no rows/IDs in memory/events.
- [ ] Record test results and assumptions in `docs/phases/phase-2-report.md`; update `docs/decisions.md`.
- [ ] Open `phase-2` → `main`; merge only when GitHub CI is green.
