# Phase 2 — Analytic mode, personal agents and governed agents

**Status:** approved by agent, pending review.

## Assumptions (pending Yashaswi)

- **Decision 28:** exercise the analytic path with a deterministic local provider and the synthetic golden question set; no hosted model calls or credentials.
- Use the design's source-group recommendation: profiler-created groups, editable through a new version, with each connection in exactly one current group (decision 20; C2 rule 6).
- Since CLAUDE.md section 3.13 forbids personas and roles, personal answer differences use vocabulary and answer style only; there is no role field or role switcher (C2 rule 7; CLAUDE.md §3.13; decision 21).

## Outcome

Ask a synthetic question that spans two source groups; show the validated plan and two collating agents, safe source results, the cross-group join, evidence and a trust badge. Two people receive the same numeric result in distinct configured answer styles. Each can inspect, edit and delete only their own memory. Feedback corrections change only that person's future synthetic answer and enter a tenant evaluation set without storing result rows or identifier values. A governed agent can be drafted, approved and rerun on the durable PostgreSQL runner with identical outputs. **Contract basis:** C1–C5, C7; design §§1.4–1.5, 2.5 and 3; CLAUDE.md §§3, 5, 8, 10–12.

## Routes and API

| Route | Behavior | Contract |
|---|---|---|
| `POST /api/runs` | Validate a nonempty question and authorized active source set; create a durable run and enqueue a deterministic golden analytic plan. Returns run id only. | C1 rules 2, 4; C3 rules 1–10; C5 rules 1–8 |
| `GET /api/runs/:runId` | Return tenant-scoped run state, validated plan summary, structured answer, evidence refs, trust route and safe error. | C1; C3; C4 rules 1–8; C5 |
| `GET /api/runs/:runId/events` | Resume append-only run events after `Last-Event-ID`; browser refresh does not restart work. | C5 rules 1–2, 17; design §1.4 |
| `POST /api/runs/:runId/feedback` | Store right/wrong verdict; thumbs-down correction updates only the current person's memory and inserts a safe evaluation case. | C1 owner scope; C2 rule 7; C7 rules 10, 15 |
| `GET/PUT/DELETE /api/me/agent` | Read, edit, or delete the authenticated person's vocabulary, default sources and answer style. Reject source defaults the person cannot access. | C1; C2 rule 7 and acceptance 6–7; C7 rule 15 |
| `GET /api/agents` | Return tenant agent summaries and current source-group membership, not prompts or secrets. | C1; C2 rules 4–8 |
| `POST /api/groups/:groupId/members/:connectionId` | Move a connection by creating a new versioned group membership; validate tenant and active connection. | C1; C2 rule 6 and acceptance 5 |
| `POST /api/governed-agents` | Save a typed, read-only definition as immutable draft version 1. | C2 rules 1–4; C3; C5 |
| `POST /api/governed-agents/:id/approve` | Approve an immutable definition version and record its approver and event. | C1; C2 rules 1, 3; C5 |
| `POST /api/governed-agents/:id/runs` | Start a durable run pinned to the approved version; rerun deterministic plan without a model call. | C1; C2; C3; C5; C7 |
| `GET /api/evaluation` | Return counts and question identifiers for the tenant's synthetic evaluation set; never returns result rows. | C1; C2 acceptance 7; C4; C7 |

Invalid plans are rejected before a step is queued. A person’s personal context may affect wording and source preference only; it never widens authorization. Event streams and logs contain identifiers, safe counts and references, never rows, SQL parameter values, raw model output or personal result data. **Contracts:** C1, C3–C5, C7.

## UI

| Screen | Behavior | Contract |
|---|---|---|
| Home (`/`) | Question composer; source selector uses only authorized active sources; analytic read-only note; live plan card; structured answer, citations, SQL/source/lineage drawer, trust badge, probable-link warning, right/wrong feedback. | C1; C3; C4; C5; C7; CLAUDE.md §10.2 Home |
| Run (`/runs/:id`) | Render persisted run state and resumable plan/event progress; reconnect after refresh without duplicate events. | C4; C5; design §1.4 |
| Agents (`/agents`) | Show orchestrator, groups, collating agents, connector agents and governed definitions; allow group move and definition draft/approval. | C1; C2; CLAUDE.md §10.2 Agents |
| My agent (`/my-agent`) | Edit vocabulary, authorized default sources and answer style; inspect/delete memory; no persona or role UI. | C1; C2 rule 7; C7 rule 15; CLAUDE.md §§3.12–13, 10.2 |
| Approval matrix (`/approval-matrix`) | Show governed definition approvals and lineage feedback review items; approve only the requested item. | C1; C2; C5; design §1.4 |

All controls are keyboard reachable, labeled and visibly focused. Run state comes from the API and event stream, not browser-owned workflow state (CLAUDE.md §§10–11; design §1.4).

## Tables and ownership

Tenant-owned tables use `tenant_id`, `ENABLE/FORCE ROW LEVEL SECURITY`, transaction-local `app.tenant_id` and runtime roles that own no tables and cannot bypass RLS (C1; CLAUDE.md §3.4).

| Table | Purpose | Contract |
|---|---|---|
| Existing `runs.runs`, `runs.steps`, `runs.events`, `runs.authz_decisions` | Durable analytic state, plan-step lease/fencing and ordered events. Add a safe plan reference and output reference; never persist result rows. | C1; C3; C4; C5 |
| `runs.analytic_plans` | Tenant-scoped, validated typed plan snapshot and canonical hash keyed to a run; contains no execution result rows. | C1; C3; C5 |
| `runs.analytic_results`, `runs.analytic_answers` | Per-step aggregate claims/evidence and final structured answer; RLS scoped to the stored run tenant and never contains result rows. | C1; C4; C5; C7 |
| Existing `registry.personal_memories` | Owner-only preferences; retain vocabulary, authorized source references and answer style. Remove role semantics to conform with CLAUDE.md §3.13. | C1; C2 rule 7; C7 rule 15 |
| `memory.feedback` | Per-person verdict/correction linked to run and plan; no result data or raw identifiers. | C1; C2; C7 rules 10, 15 |
| `memory.evaluation_cases` | Tenant-owned, safe question/plan reference and verdict for synthetic evaluation; no result rows. | C1; C2 acceptance 7; C7 |
| `registry.governed_definitions`, `registry.governed_versions` | Definition identity and immutable typed plan snapshots with status and owner. | C1; C2 rules 1–4 |
| `registry.governed_approvals` | Approver, decision, definition version and timestamp. | C1; C2; C5 |
| `registry.governed_events` | Append-only governed draft and version approval audit events with actor and version reference. | C1; C2; C5 |
| Existing `registry.source_groups`, `registry.source_group_members`, `registry.agents`, `registry.agent_versions` | Versioned groups and logical orchestrator/collating/governed agents. Each active connection has exactly one group version. | C1; C2 rules 4–8 |
| Existing `runs.events` | `plan_proposed`, `plan_validated`, `plan_rejected`, step lifecycle, evidence, feedback and governed approval/run events; append-only and sequence contiguous. | C4; C5 |

Any migration adding columns or policies must leave prior contracts and phase-0/1 rows intact. Add catalogue coverage for every new tenant-owned table (C1 acceptance 4).

## Events

Add typed safe events `plan_proposed`, `plan_validated`, `plan_rejected`, `agent_feedback`, `memory_updated`, `governed_definition_created`, `governed_definition_approved`, and `governed_run_started`. Reuse the existing run/step/evidence events for execution. State and event are committed in one transaction; sequences have no gaps; event schemas forbid rows, raw IDs, credentials, model output and corrections beyond the safe correction field (C2; C4; C5; C7).

## Acceptance tests (named cases)

Each named case cites the frozen contract or design acceptance it implements. Contract tests run against native PostgreSQL 16 and only reset `si_test`.

| Test case | Contract / criterion |
|---|---|
| `c1_analytic_request_uses_session_tenant_and_rechecks_source_authorization` | C1 rules 1–4; CLAUDE.md §3.4 |
| `c2_personal_memory_is_owner_only_editable_and_deletable` | C2 rule 7 and acceptances 6–7; C1; design §2.5 |
| `c7_feedback_is_owner_scoped_hash_only_and_changes_only_presentation` | C2 rule 7; C1 entitlement recheck; C7 rules 10, 15; design §2.5 |
| `c2_group_move_creates_new_version_and_pinned_run_keeps_old_membership` | C2 rule 6 and acceptance 5; design §2.5 |
| `c2_governed_definition_versions_are_immutable_and_approval_is_version_bound` | C2 rules 1–4; design §2.5 |
| `c3_invalid_cycles_types_budgets_or_unauthorized_sources_never_queue_steps` | C3 rules 1–5, 10 and acceptances 1, 3, 8 |
| `c3_two_group_question_routes_each_source_through_its_collating_agent` | C3 rules 6–9 and acceptances 4–6; design §2.5 |
| `c4_every_answer_claim_resolves_to_evidence_and_interpretations_add_no_facts` | C4 rules 1–4 and acceptances 1–2 |
| `c4_events_and_model_requests_never_contain_result_rows` | C4 rule 5 and acceptance 3; C7 |
| `c5_refresh_resumes_a_run_without_duplicate_events` | C5 rules 1–2, 5–8, 17; design §2.5 |
| `c5_forced_source_timeout_finishes_run_as_partial` | C5 state/lease rules; design §2.5 |
| `c7_personal_memory_and_feedback_contain_no_result_rows_or_identifier_values` | C7 rules 10, 15 and acceptance 6; design §2.5 |
| `phase2_two_people_receive_equal_values_in_distinct_saved_answer_styles` | Design §2.5 analytic acceptance; C2 rule 7 |
| `phase2_thumbs_down_correction_changes_only_owners_next_answer_and_enters_evaluation_set` | Decision 22; C2 rule 7; C7; design §2.5 |
| `phase2_governed_agent_rerun_returns_identical_numbers_without_model_calls` | C2; C3; C5; design §2.5 |
| `phase2_each_of_30_golden_questions_per_connector_meets_expected_result` | Design §2.5: at least 90% per connector |
| `phase2_home_plan_feedback_and_my_agent_are_keyboard_accessible` | CLAUDE.md §§10–11; C1–C5 |

Phase gate: all phase 0/1 tests plus lint, typecheck, unit, PostgreSQL integration, contract and E2E. No acceptance test is skipped for missing hosted credentials; the deterministic local provider is the phase assumption.

## Demo

Use only `tests/golden`. Seed two synthetic users with the same entitled sources and different saved vocabulary/answer style. Ask the two-group comparison question, inspect plan steps and citations, submit a correction for one person, then verify the second person's answer and memory did not change. Draft, approve and rerun one governed definition and compare the structured numeric output. No real credentials or external model/source calls.
