# UI rebuild phase

**Status:** approved by agent, pending review
**Branch:** `ui-rebuild`
**Scope:** frontend and local demo seed only. Backend routes, schemas, database migrations, and service behavior remain unchanged.

## Contracts implemented

- **Contract 1 — identity, tenancy, authorisation:** signed-in shell and seeded demo use the existing tenant/account mapping; no cross-tenant data is introduced.
- **Contract 2 — agent registry and capability manifest:** connector, agent, profile, and Controls UI report existing API state without claiming unavailable capabilities.
- **Contract 3 — orchestration plan schema:** Home shows only validated plan details returned by the existing run API.
- **Contract 4 — task, result, and evidence envelopes:** answers, evidence, and exports preserve existing evidence labels and source references.
- **Contract 5 — durable runs and events:** Home displays run progress from existing events and does not invent completion or duplicate events.
- **Contract 6 — metadata graph and lineage:** ER, table/column lineage, ID trace, BI reports, and assertion review display API graph facts with gaps and verification unchanged.
- **Contract 7 — classification and disclosure:** forms and screens never display row values or raw identifiers in saved UI state; demo database source is read-only.
- **Contract 8 — approval protocol:** Approval matrix and FlowSpec surfaces retain their existing approval and handoff behavior; UI makes pending and accepted states explicit.

## Routes, UI, tables, and events

| App route | Prototype route / screen | UI content and interactions | Tables / events |
|---|---|---|---|
| `/` and `/runs/:runId` | `#home` Home | Chat greeting, saved questions, plan, evidence, trust label, feedback | Existing run, event, evidence, feedback, and personal-question APIs; no table changes; existing run lifecycle and feedback events |
| `/connectors` | `#connectors` Connectors | Source cards, add-source flow, scope step, connection status | Existing registry connection, agent, profile, scope APIs; connection/profile events unchanged |
| `/profile/:connectionId` | `#discovery` Profile | Profile ring, category counts/cards, navigation to ER and Dictionary | Existing profiler/profile APIs; existing profile completion notifications |
| `/er/:connectionId` | `#explorer` ER explorer | Entity graph and category navigation | Existing metadata graph tables/APIs; existing assertion facts unchanged |
| `/dictionary?connection=…` | `#dictionary` Dictionary | Imported summary; Standard/Custom and procedure tabs; collapsible objects | Existing dictionary/profile APIs; no new events |
| `/lineage` | `#lineage` Lineage | Table flow, coverage and gaps, evidence/assertions | Existing graph assets, relationships, assertions, gaps; graph events unchanged |
| `/lineage/columns` | `#lineage` column view | Column-level flow and evidence | Existing graph assets, relationships, assertions; graph events unchanged |
| `/lineage/ids` | `#lineage` ID trace | Identifier field selector; lookup above results; path and fingerprint matches | Existing identifier registry/path/trace APIs; no raw lookup value persisted |
| `/bi-reports` | `#lineage` BI reports | Source report inventory and lineage status | Existing graph report and assertion tables/APIs |
| `/reports` | `#reports` Reports | Governed reports, schedules, snapshots and exports | Existing governed report, schedule, snapshot APIs; existing report run events |
| `/agents` | `#agents` Agents | Agent groups, status and actions | Existing registry tables/APIs; no capability changes |
| `/my-agent` | `#my-agent` My agent | Personal preferences and saved questions | Existing personal memory/questions APIs; no new events |
| `/hub` | No prototype equivalent | Existing integration cards in the shared visual style; report app-only screenshot | Existing Hub APIs; existing handoff events |
| `/approval-matrix` | `#review` Approval matrix | Last-night run and pending approval/review actions | Existing decision, assertion, and approval APIs; existing audit events |
| `/controls` | `#controls` Controls | Source scope, policy controls, and Demo data section only with `DEMO_MODE=true` | Existing scope/control APIs; no schema changes |
| `/usage` | `#usage` Usage | Usage counters and model usage | Existing usage APIs; no new events |
| `/login` | `#login` Login | Prototype brand, Scale Data Hub, SSO and password sign-in | Existing auth API; no schema changes |
| Existing `/flowspecs/:id` | No prototype equivalent | Existing approval/handoff in shared visual style | Existing FlowSpec APIs and contract-8 events |

**Database tables:** no tables are added, renamed, or structurally changed. `pnpm demo:seed` updates/reuses demo rows in the existing `core`, `registry`, `profiler`, `graph`, `runner`, `analytic`, `reports`, and `hub` schemas through current APIs or idempotent seed operations. It never writes to `si_test` or to `si_sample_source`.

**Events:** no event types or envelopes are added or changed. Existing connection/profile, run lifecycle, notification, feedback, graph review, approval, report, and handoff events are preserved at their current API boundaries.

## Demo seed inventory

The repeatable seed sets the existing north demo tenant display to Riverside Health and presents the allow-listed `analyst@north.example` session as Yashaswi in the UI; it does not create an API user or change auth. It creates/reuses a read-only connection to `si_sample_source`, fictional connectors Meridian Lumen, Meridian Harbor, Meridian Aurora Cloud, and Report Studio, profile and ER counts, Standard and Custom dictionary entries with procedures, table and column lineage plus identifier paths, separate BI and governed reports, agent groups, Hub integration cards, last-night findings, saved questions, and exactly one pending approval. Stable keys prevent duplicate rows after repeated seed runs.

## Acceptance tests

- `ui_tokens_match_prototype_values` (Contracts 1–8 presentation only): exact prototype color, font, type, spacing, radius, and shadow tokens are asserted from `packages/ui`.
- `ui_shared_components_render_labeled_accessible_controls` (Contract 1): every shared field has a label above it, keyboard focus is visible, and dialog/tab/disclosure semantics are present.
- `ui_no_raw_native_controls_outside_shared_package` (Contracts 1–8): source scan rejects raw `input`, `select`, `textarea`, or `button` elements outside `packages/ui`.
- `ui_shell_matches_prototype_and_signed_in_identity` (Contract 1): logo, Scale Insyght wordmark, grouped sidebar, bottom Platform and Recent, notifications panel, top bar, and Yashaswi initials/name match the prototype.
- `ui_screens_have_no_internal_ids_or_demo_wording` (Contracts 1, 2, 6, 7): UI copy contains no internal identifiers, role names, or “synthetic”; fixture actions appear only in Controls > Demo data when enabled.
- `ui_demo_seed_is_repeatable_and_populates_all_screens` (Contracts 1, 2, 6, 8): two runs preserve counts, keep the sample source read-only, and expose the documented local login.
- `ui_connectors_add_flow_and_scope_navigation` (Contracts 1, 2, 7): add-source type selection, setup, scope, and completion work by pointer and keyboard.
- `ui_profile_to_er_navigation` (Contracts 2, 6): seeded profile ring/categories navigate to matching ER content.
- `ui_dictionary_navigation_and_tabs` (Contracts 2, 6): Standard/Custom and procedure tabs plus collapsible cards show seeded content.
- `ui_lineage_table_column_and_identifier_trace` (Contracts 6, 7): table/column selection renders returned edges; ID lookup sits above results and raw values are discarded.
- `ui_home_chat_plan_evidence_and_feedback` (Contracts 3, 4, 5): greeting, validated plan, evidence, and feedback use existing API results.
- `ui_notifications_new_and_earlier_groups` (Contracts 1, 5): notification panel groups new/earlier records and marks records read.
- `ui_screens_generates_1440_side_by_side_pairs` (Contracts 1–8 presentation only): every mapped screen/flow has a 1440×900 capture pair, every pair is visually inspected, and the report lists intentional differences; Hub and FlowSpec are documented as app-only.
- Existing API contract suites (Contracts 1–8) remain unchanged and pass.
