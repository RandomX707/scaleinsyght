# Phase 5b — Real connections

**Status:** approved by agent, pending review  
**Branch:** `phase-5b`  
**Scope:** synthetic-only source data; local PostgreSQL and dbt; explicit local OpenAI live test. CI remains deterministic and fixture-backed.

## Routes and interfaces

| Route/interface | Behavior | Contract |
|---|---|---|
| Existing `GET /api/sources`, `POST /api/connections`, and connection test/activate/profile/discover routes | Configure and activate the local PostgreSQL source using its dedicated read-only role; no source write capability is exposed | 1, 2, 7 |
| Existing harvest/profile/ER/dictionary/nightly worker routes and jobs | Run the full profiler lifecycle against `si_sample_source`, persist metadata and evidence only | 5, 6, 7 |
| Existing dbt artifact import route | Import a locally generated `manifest.json`; Tableau and Power BI continue to use golden fixtures | 6, 7 |
| Existing analytic and lineage routes plus local `pnpm test:live` | CI and normal routes stay deterministic; the local-only harness reads synthetic aggregate and lineage metadata, then calls configured gateway models under the tenant budget | 3, 4, 7 |
| `GET/PUT /api/tenant/settings` | Read/update `allowSelfApproval` and tenant time zone; model caps come from `.env` and apply independently to each tenant | 1, 2, 5, 7 |
| Existing `POST /api/governed-agents/:id/approve` | Enforce second-user approval unless the tenant setting enables self-approval; enabled self-approval is explicit in audit | 1, 2 |
| Existing `GET/POST/DELETE /api/me/schedules` | Accept daily or weekly local wall-clock schedule and weekday; return local display values; persist UTC schedule instants/slots | 1, 5 |
| Existing Usage route | Include model tokens and cost for the current billing period and configured daily caps, with no prompt or result content | 1, 5, 7 |
| `pnpm test:live` | Explicitly local-only Phase 2 analytic and Phase 3 lineage flow against `si_sample_source` and configured OpenAI gateway | 3, 4, 7 |

## Tables and storage

All tenant-owned records have tenant keys, forced RLS, and least-privilege grants. Migrations run as `si_migrate`; `si_app` and `si_worker` own no tables and do not bypass RLS (Contract 1).

| Storage | Change | Contract |
|---|---|---|
| Local `si_sample_source` | Synthetic `patients`, `encounters`, `orders`, `departments`, and `providers`, at least 10,000 rows total; connection uses a dedicated read-only PostgreSQL role | 2, 6, 7 |
| Tenant settings and model budget | `allow_self_approval` defaults false; IANA `time_zone` defaults `Asia/Kolkata`; `.env` supplies per-tenant daily token/cost caps (USD 2/day by default) | 1, 2, 7 |
| `reports.schedules` / `reports.schedule_slots` | Cadence (`daily`/`weekly`), tenant-local time and optional ISO weekday; `next_run_at`, `due_slot`, and idempotency remain `timestamptz` UTC instants | 1, 5 |
| Model usage ledger | Tenant, UTC day, configured model name, input/output tokens, computed cost, request id and safe outcome; no prompts/results | 1, 5, 7 |
| Audit log | Record approval mode (`other_user` or `self_approved`) and actor against the immutable version | 1, 2 |

The hospital schema contains fake values only. It is generated locally from deterministic seed code and is excluded from client connectors, fixtures and committed database dumps. `tests/golden` remains the source for automated fixtures.

## Events

- Existing profiler and durable-run events are used for harvest, profile, ER inference, dictionary generation and nightly refresh; changes and event writes remain atomic (Contracts 5 and 6).
- `governed_definition_approved` records exact immutable version and approval mode; no definition text is copied into the audit event (Contracts 1, 2).
- `scheduled_run_enqueued` records schedule id, UTC due slot, cadence, and deterministic run id (Contract 5).
- Each model request appends one `core.model_usage` outcome (`completed`, `failed`, or `budget_rejected`) with tenant, model alias/name, provider-reported tokens and cost when available, request id and safe error code only. It contains no prompt, row values, identifiers or response content (Contracts 1, 5 and 7).

## UI

- **Connector setup:** PostgreSQL connection fields and read-only capability; no password appears after save. Local synthetic source is clearly labeled as demo data.
- **Controls / tenant settings:** tenant time zone (default `Asia/Kolkata`) and explicit “Allow self-approval” toggle, off by default, with an explanation that enabled approvals are audited as self-approved.
- **Reports:** choose daily/weekly, tenant-local time, and weekday for weekly schedules; show local time and time zone. UTC is an internal scheduling detail.
- **Usage:** display current-period model token and cost totals and configured daily cap; the gateway blocks before provider calls when the cap is reached.
- **Live model invocation:** no new general-purpose chat UI. `pnpm test:live` is the opt-in local demonstration.

## Acceptance tests

| Named test case | Acceptance | Contract |
|---|---|---|
| `phase2_governed_agent_rerun_returns_identical_numbers_without_model_calls` | Checks safe tenant defaults, second-member approval, opt-in self-approval audit, and deterministic analytic behavior | 1, 2, 3 |
| `c5_daily_schedule_claim_dispatches_at_most_once_per_utc_slot` plus timezone unit cases | Daily/weekly tenant-local times map to UTC slots with DST handling and at-most-once dispatch | 1, 5 |
| `c7_openai_gateway_outbound_request_contains_only_disclosed_metadata_and_keyed_fingerprints` | Captured request omits synthetic identifiers, emails, names and golden record IDs; permitted identifiers leave only as keyed fingerprints | 7 |
| `c1_model_usage_and_budget_rows_are_tenant_isolated` | Usage is RLS-isolated between tenants | 1, 7 |
| `c7_model_budget_reserves_a_conservative_utf8_request_size_before_calling_provider` | Daily token cap blocks a request before provider call when a conservative input reservation exceeds the cap | 1, 5, 7 |
| `c7_gateway_does_not_record_estimated_tokens_as_provider_usage` | Missing provider usage is recorded as a safe failure, not fabricated billing totals | 5, 7 |
| `real_postgres_read_only_connector_harvests_profiles_infers_er_dictionary_and_nightly_refresh` | Dedicated source role runs harvest/profile/ER/dictionary/nightly and imports the compiled manifest idempotently; database, schema, tables and rows remain unwritable | 2, 5, 6, 7 |
| `c3_test_live_refuses_ci_even_when_opted_in` and `c3_test_live_requires_explicit_local_opt_in` | `pnpm test:live` is local-only, requires opt-in and uses model IDs from `.env` | 3, 4, 7 |
| `secret_scanner_rejects_openai_style_key_in_env_example` | Shared scanner accepts the empty placeholder, rejects a synthetic OpenAI-style key without printing it, and is wired into staged pre-commit checks and CI working-tree checks; Gitleaks scans history | 7 |
| `phase-5b-vendor-prerequisites-document` | Prerequisites name the exact SQL Server instance and free Snowflake trial/account details needed; no install or signup occurs | 6 |

## Verification gates

Run lint, typecheck, unit, sqlparse, integration, contract and E2E suites against PostgreSQL 16. Add the PostgreSQL service-container CI path if absent. Run live model calls only with `pnpm test:live` on a local machine after an explicit configured key; never run it in CI. Never skip a failed required gate.
