# UI Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Align every Scale Insyght screen with the prototype while preserving existing backend behavior, and provide repeatable demo data and inspected screenshot comparisons.

**Architecture:** Add `@scaleinsyght/ui` as the sole renderer of native form controls. Recompose the existing React client with shared components and exact prototype tokens, then add an idempotent seed and a Playwright screenshot runner. Existing APIs and schema remain the source of truth.

**Tech Stack:** React 18, strict TypeScript, Vite, plain CSS variables, Vitest, Playwright, PostgreSQL 16.

**Spec:** `docs/superpowers/specs/2026-11-23-ui-rebuild-design.md` and `docs/phases/ui-rebuild.md`

## Global Constraints

- Keep APIs, schemas, authorization, migrations, and service behavior unchanged.
- Use no new runtime dependencies or infrastructure.
- Match `docs/prototype/index.html` at 1440×900 and `CLAUDE.md` section 11.
- Do not show internal IDs, role names, real vendor names, or the word “synthetic” in UI copy.
- Only `packages/ui` may render native `button`, `input`, `select`, or `textarea` elements.
- Demo data is fake; the `si_sample_source` connector stays read-only; `.env` remains ignored.
- Seed login reuses `golden-tenant-north`, `analyst@north.example`, and `golden-local-only`; UI display name is Yashaswi.
- Every completed change is committed and pushed to `ui-rebuild`; never push directly to `main`.

## Review Focus

- Entered identifier lookup values must not persist or be rendered: `ui_lineage_table_column_and_identifier_trace`.
- Repeated demo seeding must not duplicate connections, reports, questions, findings, or approvals: `ui_demo_seed_is_repeatable_and_populates_all_screens`.
- Long labels, empty API collections, and narrow viewports must retain usable layouts: `ui_shared_components_render_labeled_accessible_controls` and `ui_empty_states_explain_purpose_and_next_action`.
- Reloading routes must preserve the selected asset and wait for data before drawing lineage: `ui_lineage_table_column_and_identifier_trace`.
- Fixture import controls must be absent unless `DEMO_MODE=true`: `ui_screens_have_no_internal_ids_or_demo_wording`.

---

## File map

- `packages/ui/package.json`, `src/index.ts`, `src/tokens.css`, `src/components.css`: exports, exact visual tokens, and shared components.
- `packages/ui/src/assets/insyght-logo.png`: prototype logo extracted from its embedded image.
- `packages/ui/tests/ui.test.tsx`: component/accessibility and token assertions.
- `apps/web/package.json`, `apps/web/src/main.tsx`, `apps/web/src/style.css`, `apps/web/src/phase*.css`: package dependency, app surfaces, shell, and migrated styles.
- `tests/unit/ui-raw-controls.test.ts`: fail on raw native controls outside `packages/ui`.
- `scripts/demo-seed.ts`, root `package.json`: idempotent local-only demo seed and `pnpm demo:seed`.
- `scripts/screens.ts`, root `package.json`: 1440×900 route capture, montage output, and `pnpm screens`.
- `docs/ui/screens/*`, `docs/ui/ui-report.md`: inspected pairs and per-screen differences.
- `docs/phases/ui-rebuild.md`, `CLAUDE.md`: contracts, coverage, and definition of done.

### Task 1: Prototype tokens, logo, shared controls, and enforcement

**Interfaces:** `@scaleinsyght/ui` exports all requested components and the source CSS. Every form field takes an explicit label rendered above the native control. Button has `primary`, `secondary`, and `ghost` variants.

- [ ] `ui_tokens_match_prototype_values` asserts copied color/font/type/spacing/radius/shadow values.
- [ ] `ui_shared_components_render_labeled_accessible_controls` asserts labels, keyboard focus, tabs, disclosure, modal, toast, and button states.
- [ ] `ui_no_raw_native_controls_outside_shared_package` source scan fails on a native tag in app/test source.
- [ ] Add `@scaleinsyght/ui` workspace package and exported components; move native tags in `main.tsx` to package components.
- [ ] Run `pnpm test -- tests/unit/ui-raw-controls.test.ts` and `pnpm typecheck`; fix failures, then commit and push.

### Task 2: Shell and API-backed screen redesign

**Interfaces:** Existing route handlers, props, and API types remain authoritative; shared components are imported from `@scaleinsyght/ui`.

- [ ] `ui_shell_matches_prototype_and_signed_in_identity` covers logo, brand, nav groups, New chat, Platform/Recent footer, notices, header, and account identity.
- [ ] `ui_home_chat_plan_evidence_and_feedback` covers chat, plan, claims/evidence, trust, and feedback.
- [ ] `ui_connectors_add_flow_and_scope_navigation` covers source selection, setup, scope, and success.
- [ ] `ui_profile_to_er_navigation` and `ui_dictionary_navigation_and_tabs` cover Profile, ER, Standard/Custom, procedures, and collapsibles.
- [ ] `ui_lineage_table_column_and_identifier_trace` covers persistent selection, edge rendering, ID lookup order, and value clearing.
- [ ] `ui_screens_have_no_internal_ids_or_demo_wording` covers user-facing copy and demo-control gating.
- [ ] Restyle Connectors, Profile, ER, Dictionary, Lineage, BI reports, Reports, Agents, My agent, Hub, Approval, Controls, Usage, login, and FlowSpec in the shared system; retain all API calls and states.
- [ ] Run targeted UI tests, `pnpm lint`, and `pnpm typecheck`; fix failures, then commit and push.

### Task 3: Idempotent Riverside demo seed

**Interfaces:** `pnpm demo:seed` runs `scripts/demo-seed.ts`; it may call the local app API and existing seed helpers, but does not change database migrations or `si_sample_source`.

- [ ] `ui_demo_seed_is_repeatable_and_populates_all_screens` asserts stable row counts after two runs and a successful login.
- [ ] `ui_demo_seed_screen_inventory` asserts the sample source, four fictional connector names, profile/ER/dictionary, graph/ID paths, distinct BI/governed reports, agent groups, Hub state, findings, saved questions, and one pending approval.
- [ ] Implement stable identifiers/idempotent upserts and read-only sample connection; gate controls via `DEMO_MODE=true`.
- [ ] Run both named seed tests and verify sample source read-only permissions; commit and push.

### Task 4: Route screenshot automation and visual review

**Interfaces:** `pnpm screens` runs the demo seed, launches/reuses the local web app, captures prototype hash routes and app routes at 1440×900, and writes PNG pairs under `docs/ui/screens/` plus `docs/ui/ui-report.md`.

- [ ] `ui_screens_generates_1440_side_by_side_pairs` asserts every mapped screen/flow has both images and every report entry has an intentional-difference note or “None”.
- [ ] Capture every route/flow in `docs/phases/ui-rebuild.md`; capture Hub and FlowSpec app-only with the documented reason.
- [ ] Inspect every generated pair at full size, correct visual differences, rerun captures, and list the final pair inventory.
- [ ] Update `CLAUDE.md` definition of done to require prototype screenshots and a visual match for every changed screen; commit and push.

### Task 5: Complete gates and merge

- [ ] Run `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm test:sqlparse`, `pnpm test:integration`, `pnpm test:contracts`, `pnpm test:e2e`, and `pnpm screens`.
- [ ] Fix root causes without weakening tests; commit and push each fix.
- [ ] Open PR `ui-rebuild` → `main`; wait for required CI green, then merge and verify the final commit on main.
- [ ] Keep the local app running and report its URL plus the verified demo login.
