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
| `POST /api/auth/login`, `POST /api/auth/logout` | Verify a synthetic golden account, issue a signed HttpOnly session, revoke it on logout. | C1 tenant identity; CLAUDE.md §10.2 Login |
| `GET /api/usage` | Require a live session and return usage from tenant-scoped activity events. | C1 §Usage |
| `GET /api/health` | Native process readiness for local development and Playwright. | CLAUDE.md §§5, 5.1 |

Shared shell: indigo light theme from the prototype `:root`; Scale Insyght branding, collapsible Workspace and Platform navigation groups with persistent state, disabled New chat until phase 2, notification affordance, recent conversations placeholder, profile/sign-out menu. Phase 0 shows only available destinations; later destinations are not represented as working features. Keyboard navigation, visible focus, labeled icon controls, disclosure `aria-expanded`, reduced-motion support. **Contract:** C1 and CLAUDE.md §§10–11.

## Local environment

Development and test use native PostgreSQL 16.15 without Docker, per [CLAUDE.md §5.1](../../CLAUDE.md#51-local-environment-no-docker) and decision 26. The Homebrew PostgreSQL service is already running. `pnpm db:setup` uses the local superuser and creates only the separate Scale Insyght development database, `si_migrate`, `si_app`, `si_worker`, and the separate `si_test` database; it does not access existing application databases or tables. Integration and contract tests use the real PostgreSQL server and reset only `si_test`; no Docker, mocks, PGlite or SQLite.

`.env.example` lists `DATABASE_URL`, `DATABASE_URL_WORKER` and `DATABASE_URL_MIGRATE`; `.env` contains generated local-only role passwords and is never committed. `scripts/db-setup.ts` uses local socket superuser access. If PostgreSQL is unreachable, tests fail with a clear message naming `DATABASE_URL`.

## Tables and ownership

All tenant-owned tables include `tenant_id`, enable and force RLS, and use policies based only on transaction-local `app.tenant_id` (`C1 §How tenant identity reaches the database`). Runtime roles are `NOSUPERUSER NOBYPASSRLS`, own no tables; migration credentials are separate and unavailable to app/worker processes (`C1 §How tenant identity reaches the database`).

| Schema/table | Purpose | Contract |
|---|---|---|
| `core.tenants`, `core.users`, `core.sessions`, `core.entitlements` | Tenant, verified users, hashed session tokens, connector/user allowance. | C1 |
| `registry.capabilities`, `registry.capability_versions`, `registry.agents`, `registry.agent_versions` | Immutable capability versions, approved agent versions and immutable drafts, effect-class manifest. | C2 |
| `registry.connections`, `registry.source_groups`, `registry.source_group_members` | Atomic connection/agent activation and exactly-one versioned group membership. | C2 |
| `registry.events` | Append-only `agent_created` and `agent_retired` events, committed with registry changes. | C2 |
| `registry.personal_memories` | Per-person role template, vocabulary, default source references, saved plan references, answer style and corrections; owner-only RLS. | C2 |
| `runs.runs`, `runs.steps`, `runs.events`, `runs.authz_decisions`, `runs.outbox` | Durable run state, fencing/leases, append-only ordered events, per-call policy decisions, transactional dispatch. | C1, C5 |
| `core.activity_events` | Append-only user and connector activity used to compute usage. | C1 §Usage |

`tenant_id` belongs on every listed tenant table. `runs.steps` pins `source_group_id` and `source_group_version` when supplied. Event/result payloads contain safe metadata and `result_ref` only; never result rows, credentials, or raw identifiers (C5; CLAUDE.md §3.9–10). No client connection/action credentials are introduced in this phase.

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
| `c1_revocation_blocks_next_run_step_and_each_call_has_one_decision` | C1 acceptance 6–8; C1 rules 2, 4–5 |
| `c1_usage_recount_matches_activity_event_log` | C1 acceptance 9; C1 Usage 1–2; design §2.5 |
| `c1_connector_over_allowance_rolls_back_activation_and_agent` | C1 acceptance 10; C1 Usage 3; C2 rule 5 |
| `c1_golden_user_login_creates_revocable_tenant_session_and_usage_route` | C1 identity and session tenancy; CLAUDE.md §10.2 Login and Usage |
| `c2_unregistered_unpinned_or_disabled_capability_is_rejected` | C2 acceptance 1; C2 rules 1–4 |
| `c2_approved_agent_edit_creates_immutable_draft_version` | C2 acceptance 2; C2 rule 1 |
| `c2_registered_versions_are_immutable_and_release_one_action_effects_stay_disabled` | C2 rules 1, 3 |
| `c2_bad_capability_input_and_output_return_typed_errors` | C2 acceptance 3 |
| `c2_failed_connection_activation_leaves_no_agent_or_event` | C2 acceptance 4; C2 rule 5 |
| `c2_source_group_move_versions_without_changing_pinned_run` | C2 acceptance 5; C2 rule 6 |
| `c2_personal_agent_memory_isolation_and_safe_storage` | C2 acceptances 6–7; C2 rule 7; CLAUDE.md §3.12 |
| `c5_worker_crash_at_every_step_boundary_recovers_20_runs_across_two_tenants` | C5 acceptances 1, 3–4; C5 rules 1, 5–8; C1 + C5 phase 0 two-step outcome and design §2.5 |
| `c5_racing_workers_claim_step_once_and_fence_completion` | C5 acceptance 2 and duplicate completion; C5 rules 5–8 |
| `c5_lost_effect_response_is_unknown_and_never_blindly_retried` | C5 acceptance 5; C5 external effects rules 9–12; CLAUDE.md §3.3 |
| `c5_event_stream_resumes_after_last_event_id_once_in_order` | C5 acceptance 7; C5 rule 17 |
| `c5_event_replay_rebuilds_stored_run_state` | C5 acceptance 8; C5 rules 1–2 |
| `c5_illegal_run_state_transition_is_refused` | C5 acceptance 9; C5 rules 3–4 |
| `c5_partial_retry_creates_child_and_preserves_parent_events` | C5 acceptance 10; C5 rule 15 |
| `phase0_golden_login_reaches_empty_home_and_tenant_usage` | C1; CLAUDE.md §§10–11; phase 0 UI outcome |

## Demo and phase completion

Start the native services with `pnpm dev`, then run `pnpm demo:phase0`. It creates the scripted two-step read-only run for each synthetic golden tenant; the worker consumes only the golden result references. The contract suite also kills and restarts worker processes across 20 two-step runs, then checks both tenants' isolated event streams and Usage. Completion requires all named C1/C2/C5 cases, lint, typecheck, unit, PostgreSQL integration, contract and Playwright suites, plus the design §2.5 20-run crash-recovery acceptance. No INSYGHT repository, server, database, credential or deployment is accessed. Docker is not installed or required.

## Assumptions

- Authentication uses email/password and secure server-side sessions as directed by CLAUDE.md §5. SSO remains a later feature.
- The bundled demo users and tenants are synthetic and live only in the local golden dataset/seed. No default production account or password is shipped.
- Policy is an in-process implementation behind one interface, and jobs use PostgreSQL `FOR UPDATE SKIP LOCKED`; both are specified stack choices, not added infrastructure (CLAUDE.md §§5, 8; C1 rule 5; C5).
- Usage counts distinct active users and active connectors by type from committed activity events for the selected period; connector pricing categorization stays undecided (C1 Usage; decision 19).
- The local golden seed uses the explicitly synthetic password `golden-local-only` for two fixture accounts; it is not a production account or credential and is used only in the isolated development/test databases (CLAUDE.md §§3.15, 5.1).
