# Phase 4 Hub Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task by task. Follow superpowers:test-driven-development for each change.

**Goal:** Deliver the Phase 4 certified-metric and approved FlowSpec outcomes using tenant-scoped deterministic Data Studio and Semantics adapters backed only by `tests/golden/phase4.json`.

**Architecture:** Add a focused `@scaleinsyght/hub-adapters` workspace package for versioned adapter contracts and deterministic fixture drivers. Persist adapter catalog, immutable FlowSpec versions, approvals, single-use grants, metric evidence and hand-off state in PostgreSQL with forced RLS. Use the existing durable runner/event/outbox model for metric reads and hand-off intent; the receiver adapter accepts an idempotency key and supports status lookup. Add authenticated API routes and Hub/FlowSpec UI, then prove lifecycle and failure recovery through PostgreSQL contract tests and browser tests.

**Tech Stack:** TypeScript, Fastify, React, Vitest, Playwright, PostgreSQL 16, pnpm workspaces.

**Global Constraints:** Frozen contracts C1–C8; no real vendor systems, data or credentials; no new infrastructure; no live client writes; RLS on every tenant table; HANDOFF is the only external effect and is simulated by the local golden Data Studio adapter; never show accepted before receiver confirmation. Preserve Phase 0–3 behavior when adapters are disconnected.

## File Structure

- `tests/golden/phase4.json` — synthetic certified metric, adapter versions, source snapshot and FlowSpec delivery outcomes.
- `packages/hub-adapters/` — adapter types, allowlisted fixture implementations, Semantics query and Data Studio hand-off/status lookup.
- `packages/db/migrations/014_hub_integrations.ts` — hub schemas/tables, checks, indexes, forced RLS, runtime grants, catalogue coverage and rollback.
- `packages/contracts/src/index.ts` — strict FlowSpec, approval and Hub response schemas; safe event allowlist updates.
- `packages/registry/src/index.ts` — immutable FlowSpec version hashing, approval eligibility and grant lifecycle helpers.
- `packages/runner/src/index.ts` — durable HANDOFF claim, intent and reconciliation hooks if the existing outbox primitives need integration.
- `apps/api/src/server.ts` — tenant-authorized adapter, metric and FlowSpec routes.
- `apps/api/src/main.ts`, `apps/worker/src/main.ts`, `scripts/seed-golden.ts` — fixture load, adapter worker registration and synthetic seed data.
- `apps/web/src/main.tsx`, `apps/web/src/style.css` — Hub Integrations, metric evidence, FlowSpec detail and approval status UI.
- `tests/unit/hub_adapters.test.ts` — fixture adapter validation and deterministic behavior.
- `tests/contracts/c1_hub_integrations.test.ts`, `c4_semantic_metric.test.ts`, `c5_handoff_recovery.test.ts`, `c8_flowspec_handoff.test.ts` — RLS, evidence, approval, grant, crash, idempotency and disconnected behavior.
- `tests/e2e/phase4.spec.ts` — keyboard-accessible metric query and approved hand-off user journey.
- `docs/phases/phase-4-report.md`, `docs/decisions.md` — demo, gates, assumptions and outcomes.

## Task 1: Define fixtures and adapter contract

1. Add a failing unit case `hub_semantics_adapter_returns_certified_metric_and_safe_evidence` using a `phase4.json` fixture with a deterministic integer value and no rows or SQL.
2. Run `pnpm exec vitest run tests/unit/hub_adapters.test.ts`; it must fail because the adapter package/fixture does not exist.
3. Add the fixture and package with strict `SemanticsAdapter` and `DataStudioAdapter` interfaces, version/capability metadata, disconnected states, metric lookup, idempotent `deliverFlowSpec(key,payload)` and `lookupFlowSpec(key)`.
4. Test invalid metric IDs, disconnected operations, deterministic value/evidence, identical delivery on repeated keys, and lost-response lookup.
5. Run the focused unit file and `pnpm typecheck`; expect all unit cases and TypeScript build to pass.
6. Commit `feat: add synthetic hub adapter contracts` and push `phase-4`.

## Task 2: Persist tenant-scoped Hub and FlowSpec state

1. Add failing C1 cases for cross-tenant adapter/metric/FlowSpec reads and catalogue coverage of every Phase 4 tenant table.
2. Run `pnpm test:contracts -- --run tests/contracts/c1_hub_integrations.test.ts`; expect failure against missing tables.
3. Add reversible migration 014 with `hub.adapters`, `hub.adapter_versions`, `hub.certified_metrics`, `hub.metric_results`, `hub.flowspecs`, `hub.flowspec_versions`, `hub.flowspec_approvals`, `hub.handoff_grants`, and `hub.handoffs`; add constraints, immutable-row triggers, indexes, forced RLS, least-privilege grants and catalogue rows.
4. Seed the two adapters and certified metrics under only the synthetic Phase 4 tenant, with no secret fields.
5. Prove app/worker roles own no tables, cannot bypass RLS, other tenants see zero rows, and only `si_test` is reset.
6. Run focused contracts and `pnpm db:migrate`; expect migration up/down and RLS cases to pass.
7. Commit `feat: add tenant-scoped hub integration schema` and push `phase-4`.

## Task 3: Query certified metrics through Semantics

1. Add failing contract `c4_certified_metric_uses_semantics_value_and_cites_adapter_evidence` and durability/privacy case `c5_certified_metric_run_persists_safe_events_and_resumes_without_duplicates`.
2. Call the route through Fastify with the Phase 4 tenant; assert value equals adapter fixture, trust route is `certified_metric`, evidence source/version/hash resolves, and event payload contains no returned row/SQL.
3. Add `GET /api/hub/adapters`, `GET /api/semantics/metrics` and `POST /api/semantics/metrics/:metricId/query`; authorize at route and capability boundaries, pin adapter/metric versions, create a durable run, and persist structured claim/evidence.
4. Return disconnected or unauthorized states without falling back silently to another metric route.
5. Run focused contracts, existing analytic contracts and `pnpm typecheck`; expect all pass with exact synthetic value.
6. Commit `feat: route certified metrics through semantics` and push `phase-4`.

## Task 4: Draft immutable FlowSpec versions and approve exact hashes

1. Add failing contracts `c8_flowspec_hash_binds_version_snapshots_policy_and_expiry`, `c8_flowspec_requester_cannot_self_approve`, and `c8_changed_flowspec_after_approval_requires_new_approval`.
2. Draft a typed schema with bounded nodes, endpoints, mappings and source snapshot references; reject unsupported actions and any `MUTATION`, `DEPLOY`, `RELEASE` or `IRREVERSIBLE` behavior.
3. Add canonical payload hash and transactional create-version/approval/grant helpers. Approval requires a second same-tenant principal and binds exact hash, source snapshots, policy version and expiry. A changed draft is a new immutable version and cannot reuse approval.
4. Add `GET/POST /api/flowspecs`, `GET /api/flowspecs/:id`, `POST /api/flowspecs/:id/versions` and `/approve` with strict schemas, session tenant, reauthorization and safe errors.
5. Prove expired, changed, cross-tenant, self-approved and already-consumed subjects cannot hand off.
6. Run focused C1/C8 contracts and governed-definition regression tests; expect them green.
7. Commit `feat: version and approve flowspecs` and push `phase-4`.

## Task 5: Deliver exactly once and reconcile uncertain outcomes

1. Add failing C8 tests `c8_handoff_without_valid_grant_is_refused_without_delivery`, `c8_single_use_grant_race_delivers_exactly_once`, `c8_crash_after_grant_claim_reuses_key_and_delivers_once`, and `c8_dropped_receiver_response_reconciles_by_key_without_duplicate_flowspec`.
2. Add a durable hand-off claim path that consumes grant and records `runs.outbox` intent plus safe event in one transaction, with one stable key per version/hash.
3. Deliver only through the allowlisted Data Studio adapter. Keep receiver idempotency record and status lookup keyed by the stable idempotency key. After timeout/worker loss, query status first; never blindly redeliver.
4. Add `POST /api/flowspecs/:id/handoff` and `GET /api/flowspecs/:id/handoff/:handoffId`; return `accepted` only when the adapter reports confirmed state. Unknown stays unknown until reconciliation.
5. Test concurrent consumers, expiry, crash after grant claim, lost response and post-approval hash change against PostgreSQL; assert exactly one receiver record and contiguous append-only events.
6. Run C5 runner contracts, C8 hand-off contracts and typecheck; expect all pass.
7. Commit `feat: deliver and reconcile approved flowspec handoffs` and push `phase-4`.

## Task 6: Build Hub and approval experiences

1. Add Playwright cases for disconnected empty states, certified metric value/evidence, two-member FlowSpec approval, receiver confirmation, changed-version reapproval and keyboard operation.
2. Run the new E2E file first and verify failure on missing Phase 4 screens/routes.
3. Add `/hub` and `/flowspecs/:id` interfaces; extend Approval matrix with FlowSpec items. Separate draft, approve, deliver and reconcile actions. Render pending, confirmed, unknown and reconciled distinctly; only confirmed receiver state is accepted.
4. Add deterministic synthetic tenant members to seed data. Each stateful E2E uses its own tenant and never shares the demo tenant.
5. Run `pnpm test:e2e`; expect metric and hand-off journey plus existing Phase 0–3 browser tests to pass.
6. Commit `feat: add hub integrations and flowspec approval ui` and push `phase-4`.

## Task 7: Final regression gates and report

1. Add an adapter-disconnected regression case that runs existing Phase 1–3 API flows with no Hub adapter state.
2. Run gates in order: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:sqlparse`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`; fix root causes and rerun failed gates.
3. Review diff for frozen-contract compatibility, unsafe event/row/credential exposure, forced RLS/catalogue coverage, route authorization and stale workflow state.
4. Write `docs/phases/phase-4-report.md` with assumptions at the top, build and demo steps, gate output, and any limits. Record Decision 32 as assumed/pending in `docs/decisions.md`.
5. Commit `docs: report phase four hub integrations` and push `phase-4`.
6. Open/update the Phase 4 pull request. Merge only when the PR CI workflow passes all gates against PostgreSQL 16. Do not begin Phase 5.

## Review Focus

- A FlowSpec hash cannot be approved for one payload and delivered for another; expiry or source snapshot drift invalidates it.
- The grant is consumed atomically with a fenced durable claim and stable idempotency key; an uncertain receiver response is reconciled by key before any delivery attempt.
- No API, event, log, fixture or UI path stores/displays credentials, raw source rows or compiled SQL; a disconnected adapter cannot silently become a different trust route.
- The browser only shows Data Studio acceptance after receiver confirmation.
- Every new tenant table and route is tested for RLS and authorization; Phases 1–3 remain usable with adapters disconnected.
