# Phase 0 — Foundation and contracts

**Status:** approved by agent, pending review  
**Scope:** Release 1 phase 0 only. No profiler, analytical query, or phase 1 connector behavior.

## Outcome

Provide a runnable, two-tenant foundation where a scripted two-step read-only run survives worker loss, resumes from its append-only event stream, and cannot cross tenant boundaries. The web demo includes authenticated login, the empty Home shell, and Usage.

## Routes and UI

| Route | Behavior | Contract |
|---|---|---|
| `/login` | Email/password sign-in and session creation; no persona or role switcher. SSO is visibly unavailable until its later phase. | C1 §Identity; CLAUDE.md §10.2 Login |
| `/` (Home) | Empty conversation state, “Analytic mode · read-only” and no runnable question interface until phase 2. | C1; CLAUDE.md §10.2 Home |
| `/usage` | Active users and connector counts grouped by connector type, derived from tenant-scoped activity events. | C1 §Usage; CLAUDE.md §10.2 Usage |

Shared shell: indigo light theme from the prototype `:root`; Scale Insyght branding, collapsed Workspace and Platform navigation groups, New chat, notification affordance, recent conversations placeholder, profile menu and persistent sidebar/group state. Phase 0 shows only available destinations; later destinations are not represented as working features. Keyboard navigation, visible focus, labeled icon controls, disclosure `aria-expanded`, reduced-motion support. **Contract:** C1 and CLAUDE.md §§10–11.

## Tables and ownership

All tenant-owned tables include `tenant_id`, enable and force RLS, and use policies based only on transaction-local `app.tenant_id` (`C1 §How tenant identity reaches the database`). Runtime roles are `NOSUPERUSER NOBYPASSRLS`, own no tables; migration credentials are separate and unavailable to app/worker processes (`C1 §How tenant identity reaches the database`).

| Schema/table | Purpose | Contract |
|---|---|---|
| `core.tenants`, `core.users`, `core.sessions`, `core.entitlements` | Tenant, verified users, hashed session tokens, connector/user allowance. | C1 |
| `registry.capabilities`, `registry.capability_versions`, `registry.agents`, `registry.agent_versions` | Immutable capability/agent versions and effect-class manifest. | C2 |
| `registry.connections`, `registry.source_groups`, `registry.source_group_members` | Atomic connection/agent activation and exactly-one versioned group membership. | C2 |
| `runs.runs`, `runs.steps`, `runs.events`, `runs.authz_decisions`, `runs.outbox` | Durable run state, fencing/leases, append-only ordered events, per-call policy decisions, transactional dispatch. | C1, C5 |
| `core.activity_events` | Append-only user and connector activity used to compute usage. | C1 §Usage |

`tenant_id` belongs on every listed tenant table. Event/result payloads contain safe metadata and `result_ref` only; never result rows, credentials, or raw identifiers (C5; CLAUDE.md §3.9–10). No client connection/action credentials are introduced in this phase.

## Events

Events are append-only, per-run sequence numbered without gaps, and committed atomically with the state change (C5 §§Rules: state and events). Use the C5 phase 0 vocabulary without changing meanings:

- Run: `run_created`, `run_state_changed`, `run_terminal`, `child_run_created`
- Plan: `plan_proposed`, `plan_validated`, `plan_rejected`
- Step: `step_claimed`, `step_started`, `step_succeeded`, `step_failed`, `step_blocked`, `step_reused`, `stale_write_rejected`
- Evidence: `evidence_added`, `artifact_ready`
- Approval: `approval_requested`, `approval_decided`, `grant_consumed`
- Effect: `effect_intent_recorded`, `effect_confirmed`, `effect_failed`, `effect_unknown`, `effect_reconciled`
- Registry: `agent_created`, `agent_retired`

Payloads have explicit Zod schemas and exclude sensitive values. Database outbox messages are inserted in the same transaction as the state transition (C5 §Rules: external effects).

## Capabilities and policies

One `authorise()` policy interface evaluates the principal, capability, resources, purpose and environment; it records outcome, obligations, reasons and policy version. API entry and capability dispatch both authorize (C1 §Rules). Starter entitlements are pinned to a run; admin grants configuration only. Registered effect classes include `READ`, `MUTATION`, `DEPLOY`, `RELEASE`, `IRREVERSIBLE`; only safe read capabilities are enabled for tenants (C2 §§Rules 2–4; CLAUDE.md §3.3). Capability and approved agent versions are immutable. Connector activation and its agent plus `agent_created` event are one transaction (C2 rule 5).

## Acceptance tests (named cases)

Each case is a required test name or equivalent descriptive test title; test files live under `tests/contracts/` for contract cases. `C1`, `C2`, and `C5` refer to Part 3 of `docs/system-design-v3.2.md`; global safety constraints cite `CLAUDE.md` section 3.

| Test case | Contract implemented |
|---|---|
| `c1_tenant_a_cannot_read_tenant_b_rows_in_any_table` | C1 acceptance 1; C1 RLS rule 1 |
| `c1_missing_tenant_context_reads_zero_and_rejects_insert` | C1 acceptance 2; C1 tenant identity 2 |
| `c1_interleaved_pool_requests_never_cross_tenants` (1,000 interleaved requests) | C1 acceptance 3; C1 tenant identity 1–2 |
| `c1_runtime_roles_and_all_tenant_tables_force_rls` (catalogue check) | C1 acceptance 4; C1 tenant identity 3–4 |
| `c1_forged_job_tenant_uses_stored_run_tenant` | C1 acceptance 5; C1 tenant identity 6 |
| `c1_capability_rechecks_source_entitlement` | C1 acceptance 6; C1 rules 2, 4 |
| `c1_revocation_blocks_next_run_step` | C1 acceptance 7 |
| `c1_each_capability_call_has_one_policy_decision` | C1 acceptance 8; C1 rules 4–5 |
| `c1_usage_recount_matches_activity_event_log` | C1 acceptance 9; C1 Usage 1–2 |
| `c1_connector_over_allowance_rolls_back_activation_and_agent` | C1 acceptance 10; C1 Usage 3; C2 rule 5 |
| `c2_unregistered_unpinned_or_disabled_capability_is_rejected` | C2 acceptance 1; C2 rules 1–4 |
| `c2_approved_agent_edit_creates_immutable_draft_version` | C2 acceptance 2; C2 rule 1 |
| `c2_bad_capability_input_and_output_return_typed_errors` | C2 acceptance 3 |
| `c2_failed_connection_activation_leaves_no_agent_or_event` | C2 acceptance 4; C2 rule 5 |
| `c2_source_group_move_versions_without_changing_pinned_run` | C2 acceptance 5; C2 rule 6 |
| `c2_personal_agent_memory_isolation` | C2 acceptance 6; C2 rule 7 |
| `c2_personal_memory_contains_no_results_or_identifier_values` | C2 acceptance 7; C2 rule 7; CLAUDE.md §3.12 |
| `c5_worker_crash_at_every_step_boundary_recovers_20_runs` | C5 acceptance 1; C5 rules 1, 5–8 |
| `c5_racing_workers_claim_step_once` | C5 acceptance 2; C5 rule 5 |
| `c5_expired_worker_fencing_rejects_stale_result` | C5 acceptance 3; C5 rules 6–8 |
| `c5_expired_lease_reclaim_increments_attempt_and_fence` | C5 acceptance 4; C5 rule 8 |
| `c5_lost_effect_response_is_unknown_and_never_blindly_retried` | C5 acceptance 5; C5 external effects rules 9–12; CLAUDE.md §3.3 |
| `c5_duplicate_completion_message_is_idempotent` | C5 acceptance 6 |
| `c5_event_stream_resumes_after_last_event_id_once_in_order` | C5 acceptance 7; C5 rule 17 |
| `c5_event_replay_rebuilds_stored_run_state` | C5 acceptance 8; C5 rules 1–2 |
| `c5_illegal_run_state_transition_is_refused` | C5 acceptance 9; C5 rules 3–4 |
| `c5_partial_retry_creates_child_and_preserves_parent_events` | C5 acceptance 10; C5 rule 15 |
| `phase0_two_tenant_two_step_run_survives_worker_termination` | C1 + C5; phase 0 outcome and acceptance in design §2.5 |
| `phase0_usage_isolated_and_matches_activity_events` | C1 acceptance 9; design §2.5 |
| `phase0_insyght_repository_and_services_untouched` | CLAUDE.md §3.1; design §2.2 and §2.5 |

## Demo and phase completion

Run the two-tenant scripted two-step read-only run from the local Compose PostgreSQL deployment; terminate the worker after a step boundary, restart it, and show both tenants' event streams and Usage separately. Completion requires all named C1/C2/C5 cases, lint, typecheck, unit, PostgreSQL integration, contract and Playwright suites, plus the design §2.5 20-run crash-recovery acceptance. No INSYGHT repository, server, database, credential or deployment is accessed.

## Assumptions

- Authentication uses email/password and secure server-side sessions as directed by CLAUDE.md §5. SSO remains a later feature.
- The bundled demo users and tenants are synthetic and live only in the local golden dataset/seed. No default production account or password is shipped.
- Policy is an in-process implementation behind one interface, and jobs use PostgreSQL `FOR UPDATE SKIP LOCKED`; both are specified stack choices, not added infrastructure (CLAUDE.md §§5, 8; C1 rule 5; C5).
- Usage counts distinct active users and active connectors by type from committed activity events for the selected period; connector pricing categorization stays undecided (C1 Usage; decision 19).
