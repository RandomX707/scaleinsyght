# Phase 4 — Scale Data Hub integrations

**Status:** approved by agent, pending review.

## Assumptions (pending Yashaswi)

- **Decision 12:** implement Data Studio and Semantics first, using the recommended interface order. BI inventory remains the Phase 3 read-only integration; Data Lake and Weave remain disconnected. (Decision 12; design §1.8.)
- **Decision 32:** use deterministic, local Data Studio and Semantics adapters fed only by synthetic fixtures in `tests/golden/phase4.json`. Their versioned interfaces exercise reads, metric execution and FlowSpec hand-off without vendor endpoints, credentials or external systems. (CLAUDE.md §§3.15, 5.1; design §§1.8, 2.5.)
- FlowSpec approval is by a different authenticated member of the same tenant, using the approval boundary in Contract 8; requester self-approval is denied. (C1; C8 rule 5.)

## Outcome and constraints

Answer a certified synthetic metric by querying the Semantics adapter and cite the adapter response as evidence. Draft a typed FlowSpec, approve its exact hash and source snapshot, and hand it to the Data Studio adapter. The hand-off is blocked without a valid, unconsumed grant; delivery is idempotent, reconciled by key after an uncertain response, and shown as accepted only after Data Studio confirms. Changing an approved FlowSpec creates a new version and requires approval again. Disconnecting all Hub adapters leaves Phases 1–3 usable. **Contracts:** C1–C5, C7–C8; CLAUDE.md §§3.3–3.5, 3.8–3.10, 4–5, 7–8, 10–11; design §§1.4, 1.8–1.9, 2.5 Phase 4, Part 3 Contracts 1, 3–5, 7–8.

No contract changes, client writes, real vendor connections or credentials are in scope. All adapter data is synthetic. The Data Studio adapter accepts only FlowSpec hand-offs; it does not deploy or run pipelines. Semantics returns only a certified aggregate and safe metadata, never rows or compiled SQL in event/log payloads. Data Lake, Weave and live BI integrations are not implemented in this phase.

## Routes

All routes require an authenticated tenant session, enforce C1 authorization and tenant RLS, and expose no adapter credentials.

| Route | Behavior | Contract |
|---|---|---|
| `GET /api/hub/adapters` | List tenant-visible adapter product, version, connection state and supported operations; report only safe metadata. | C1 rules 1–4; C2; C7 rules 1, 3 |
| `GET /api/semantics/metrics` | List certified metrics from connected Semantics adapter versions, with dimensions, certification state and safe source references. | C1; C2; C4; C7 rules 1, 3 |
| `POST /api/semantics/metrics/:metricId/query` | Start a durable read-only run pinned to metric and adapter versions; return the certified value and evidence only after the adapter confirms it. | C1 rules 2–4; C3; C4 rules 1–5; C5; C7 |
| `GET /api/flowspecs` and `GET /api/flowspecs/:id` | List tenant FlowSpec versions and safe status, approval, source snapshot and hand-off outcome. | C1; C5; C8 rules 1, 6–7 |
| `POST /api/flowspecs` | Validate and save an immutable draft version from a bounded typed mapping; compute canonical subject hash and capture referenced source snapshot IDs. | C1; C3; C5; C8 rules 1, 8 |
| `POST /api/flowspecs/:id/versions` | Create the next immutable draft version; any change invalidates prior approvals and grants. | C1; C5; C8 rule 1 |
| `POST /api/flowspecs/:id/approve` | Approve the exact version/hash/snapshot/policy before expiry, by a different same-tenant member; issue one single-use grant. | C1; C5; C8 rules 1, 2, 5 |
| `POST /api/flowspecs/:id/handoff` | Require exact approved hash and available grant; enqueue a durable HANDOFF step with an idempotency key and outbox intent. Return pending/confirmed/unknown, never optimistic success. | C1; C5; C8 rules 1–4, 7–8 |
| `GET /api/flowspecs/:id/handoff/:handoffId` | Reconcile status by idempotency key with Data Studio after uncertain delivery; never resend blindly; return accepted only on receiver confirmation. | C1; C5; C8 rules 3–4, 7 |

The Data Studio delivery adapter accepts only the typed FlowSpec and idempotency key. Its fixture status lookup returns the same single accepted record for repeated reconciliation. Semantic queries bind only allowlisted fixture metric IDs. **Contracts:** C1, C3–C5, C7–C8.

## Tables and ownership

Every new tenant-owned table has `tenant_id`, `ENABLE/FORCE ROW LEVEL SECURITY`, transaction-local tenant context and app/worker grants limited to required operations (C1; CLAUDE.md §3.4). Adapter secrets are not stored in these tables.

| Tables | Purpose | Contract |
|---|---|---|
| `hub.adapters`, `hub.adapter_versions` | Tenant-scoped product adapter state, immutable version, capabilities and synthetic fixture key; no secrets. | C1; C2; C7 |
| `hub.certified_metrics` | Safe metric identity, adapter version, certification state, dimensions and semantic asset references; no returned values. | C1; C2; C4; C7 |
| `hub.metric_results` | Run-linked aggregate value, classification and evidence reference; tenant-scoped and retained only as the structured answer/evidence, never source rows. | C1; C4; C5; C7 |
| `hub.flowspecs`, `hub.flowspec_versions` | FlowSpec identity and immutable typed payload, canonical hash, source snapshot IDs and policy version. | C1; C3; C5; C8 rule 1 |
| `hub.flowspec_approvals`, `hub.handoff_grants` | Append-only approver/hash/expiry and single-use grant lifecycle; grant consumption is atomic with hand-off claim. | C1; C5; C8 rules 1–3, 5 |
| `hub.handoffs` | Idempotency key, payload hash, outbox/run/step references and confirmed/unknown/reconciled status. No payload rows or credentials. | C1; C5; C8 rules 2–4, 7 |
| Existing `runs.runs`, `runs.steps`, `runs.events`, `runs.outbox` | Durable metric reads and HANDOFF intents; state and safe event commit together, with fenced worker claims. | C1; C4–C5; C8 rules 2–4 |

Register every new tenant table in the C1 catalogue and test forced RLS, cross-tenant denial, runtime-role ownership and grants. Migrations are reversible and leave Phases 0–3 rows intact. **Contracts:** C1, C4–C5, C7–C8.

## Events

Append-only safe events: `hub_adapter_connected`, `hub_adapter_disconnected`, `certified_metric_queried`, `flowspec_drafted`, `flowspec_versioned`, `flowspec_approval_requested`, `flowspec_approved`, `flowspec_rejected`, `handoff_grant_consumed`, `handoff_intent_recorded`, `handoff_confirmed`, `handoff_outcome_unknown`, `handoff_reconciled`. Payloads include IDs, versions, hashes, status, safe counts and idempotency-key references only. They exclude metric result rows, compiled SQL, FlowSpec payload copies, credentials and raw connector responses. Approval/grant state, outbox intent and event commit atomically. **Contracts:** C1; C4–C5; C7–C8.

## UI

| Screen | Behavior | Contract |
|---|---|---|
| Hub Integrations (`/hub`) | Show Data Studio and Semantics adapter state/version and safe capabilities; allow connecting/disconnecting the local golden adapters. Show certified metrics and let the user query one, rendering the exact returned value, certification badge and evidence. | C1; C2; C4; C7; CLAUDE.md §§10–11 |
| FlowSpec detail (`/flowspecs/:id`) | Show typed mapping, source snapshot, version/hash, draft/approval/hand-off status. Editing creates a new version. Request approval and hand-off are separate actions. | C1; C3; C5; C8 rules 1–4, 7–8 |
| Approval matrix (`/approval-matrix`) | Add FlowSpecs awaiting approval with requester, exact version/hash, targets, expiry and safe diff. An eligible second member can approve or reject; approval shows the single-use grant state. | C1; C5; C8 rules 1–2, 5 |
| Hand-off status | Show pending, confirmed, unknown and reconciled distinctly. Only confirmed receiver state is labelled accepted; an unknown response offers status reconciliation, not retry delivery. | C1; C5; C8 rules 3–4, 7 |

All controls are keyboard reachable, labeled and visibly focused. Disconnected adapters show an actionable empty state; no Phase 1–3 screen depends on a Hub adapter. **Contracts:** C1; C4–C5; C7–C8; CLAUDE.md §§10–11.

## Acceptance tests — named cases

| Test case | Contract / criterion |
|---|---|
| `c1_hub_adapters_and_metrics_are_tenant_scoped_with_forced_rls` | C1 rules 1–4 and acceptance 4; all new tables catalogue-covered |
| `c2_hub_adapters_are_versioned_and_disconnection_preserves_history` | C2 versioning and append-only history; design §1.8 |
| `c1_hub_routes_expose_only_authorized_adapter_capabilities` | C1 rules 2–4; C2 allow-list and version pinning |
| `c4_certified_metric_uses_semantics_value_and_cites_adapter_evidence` | C4 rules 1–5; design §2.5 Phase 4 certified metric equality |
| `c5_certified_metric_run_persists_safe_events_and_resumes_without_duplicates` | C4 rule 5; C5 rules 1–8; C7 |
| `c8_flowspec_hash_binds_version_snapshots_policy_and_expiry` | C8 rule 1; changing any bound field requires new approval |
| `c8_handoff_without_valid_grant_is_refused_without_delivery` | C8 rules 1–2; design §2.5 Phase 4 unapproved/expired/consumed hand-off blocked |
| `c8_flowspec_requester_cannot_self_approve` | C1 authorization; C8 rule 5 and Decision 32 assumption |
| `c8_single_use_grant_race_delivers_exactly_once` | C5 fencing; C8 rules 2–3; design §2.5 Phase 4 concurrent executors |
| `c8_crash_after_grant_claim_reuses_key_and_delivers_once` | C5 lease/fencing; C8 rule 3; design §1.4 and Contract 8 acceptance |
| `c8_dropped_receiver_response_reconciles_by_key_without_duplicate_flowspec` | C5 outbox recovery; C8 rules 3–4; design §2.5 Phase 4 lost response |
| `c8_changed_flowspec_after_approval_requires_new_approval` | C8 rule 1; design §2.5 Phase 4 mapping change invalidates approval |
| `c8_handoff_ui_shows_accepted_only_after_receiver_confirmation` | C8 rule 7; CLAUDE.md §§10–11 |
| `phase4_hub_metrics_and_flowspec_approval_are_keyboard_accessible` | CLAUDE.md §§10–11; C1; C4; C8 |
| `phase4_phase1_to_phase3_workflows_pass_with_all_hub_adapters_disconnected` | Design §2.5 Phase 4 disconnected-adapter regression criterion |

Use synthetic fixtures in `tests/golden/phase4.json`, real PostgreSQL 16 and only `si_test` for database suites. Required phase gates: lint, typecheck, unit, sqlparse, integration, contract and E2E. No test is skipped when an adapter is disconnected; deterministic fixtures cover the adapter contract without external services.

## Demo

Seed and sign in with the Phase 4 synthetic tenant. Connect the local Semantics adapter, query its certified `active_customers` metric, and compare the displayed value with its adapter evidence. Connect Data Studio, draft a FlowSpec from a synthetic source mapping, approve it as the second tenant member, then hand it off. Show the confirmed receiver status. Repeat with a changed mapping and a simulated dropped response: the old approval is refused, while the approved version reconciles by the same key and exists once in Data Studio. Disconnect both adapters and verify existing connectors, analytics and lineage remain available.
