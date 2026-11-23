# Phase 5b — Real connections

**Status:** approved by agent, pending review  
**Branch:** `phase-5b`  
**Scope:** synthetic-only source data; local PostgreSQL and dbt; explicit local OpenAI live test. CI remains deterministic and fixture-backed.

## Routes and interfaces

| Route/interface | Behavior | Contract |
|---|---|---|
| Existing `POST /api/connectors` and connector activation routes | Configure and activate a local PostgreSQL source with read-only credentials; no write capability is exposed | 1, 2, 7 |
| Existing harvest/profile/ER/dictionary/nightly worker routes and jobs | Run the full profiler lifecycle against `si_sample_source`, persist metadata and evidence only | 5, 6, 7 |
| Existing dbt artifact import route | Import a locally generated `manifest.json`; Tableau and Power BI continue to use golden fixtures | 6, 7 |
| Existing analytic and lineage answer routes | Deterministic provider remains default; local-only gateway provider uses configured models and tenant budget | 3, 4, 7 |
| `GET/PUT /api/tenant/settings` | Read/update `allowSelfApproval`, tenant time zone, and model daily budget configuration within validated bounds | 1, 2, 5, 7 |
| Existing `POST /api/governed-agents/:id/approve` | Enforce second-user approval unless the tenant setting enables self-approval; enabled self-approval is explicit in audit | 1, 2 |
| Existing `GET/POST/DELETE /api/me/schedules` | Accept daily or weekly local wall-clock schedule and weekday; return local display values; persist UTC schedule instants/slots | 1, 5 |
| Existing Usage route | Include model tokens and cost by tenant/day, with no prompt or result content | 1, 7 |
| `pnpm test:live` | Explicitly local-only Phase 2 analytic and Phase 3 lineage flow against `si_sample_source` and configured OpenAI gateway | 3, 4, 7 |

## Tables and storage

All tenant-owned records have tenant keys, forced RLS, and least-privilege grants. Migrations run as `si_migrate`; `si_app` and `si_worker` own no tables and do not bypass RLS (Contract 1).

| Storage | Change | Contract |
|---|---|---|
| Local `si_sample_source` | Synthetic `patients`, `encounters`, `orders`, `departments`, and `providers`, at least 10,000 rows total; connection uses a dedicated read-only PostgreSQL role | 2, 6, 7 |
| Tenant settings | `allow_self_approval` default false, IANA `time_zone` default `Asia/Kolkata`; bounded per-tenant daily model token/cost budget defaults from `.env` (USD 2/day) | 1, 2, 7 |
| `reports.schedules` / `reports.schedule_slots` | Cadence (`daily`/`weekly`), tenant-local time and optional ISO weekday; `next_run_at`, `due_slot`, and idempotency remain `timestamptz` UTC instants | 1, 5 |
| Model usage ledger | Tenant, UTC day, configured model name, input/output tokens, computed cost, request id and safe outcome; no prompts/results | 1, 5, 7 |
| Audit log | Record approval mode (`other_user` or `self_approved`) and actor against the immutable version | 1, 2 |

The hospital schema contains fake values only. It is generated locally from deterministic seed code and is excluded from client connectors, fixtures and committed database dumps. `tests/golden` remains the source for automated fixtures.

## Events

- Existing profiler and durable-run events are used for harvest, profile, ER inference, dictionary generation and nightly refresh; changes and event writes remain atomic (Contracts 5 and 6).
- `governed_definition_approved` records exact immutable version and approval mode; no definition text is copied into the audit event (Contracts 1, 2).
- `scheduled_run_enqueued` records schedule id, UTC due slot, cadence, and deterministic run id (Contract 5).
- `model_request_completed` records tenant, model alias, token counts, cost, request id and outcome only; it contains no prompt, row values, identifiers or response content (Contracts 5 and 7).
- `model_budget_rejected` records a safe budget reason and UTC day, with no request body (Contracts 5 and 7).

## UI

- **Connector setup:** PostgreSQL connection fields and read-only capability; no password appears after save. Local synthetic source is clearly labeled as demo data.
- **Controls / tenant settings:** tenant time zone (default `Asia/Kolkata`) and explicit “Allow self-approval” toggle, off by default, with an explanation that enabled approvals are audited as self-approved.
- **Reports:** choose daily/weekly, tenant-local time, and weekday for weekly schedules; show local time and time zone. UTC is an internal scheduling detail.
- **Usage:** display daily model token and cost totals and configured cap; show a clear blocked state when the cap is reached.
- **Live model invocation:** no new general-purpose chat UI. `pnpm test:live` is the opt-in local demonstration.

## Acceptance tests

| Named test case | Acceptance | Contract |
|---|---|---|
| `c1_tenant_settings_are_rls_isolated_and_have_safe_defaults` | New tenants default to self-approval off and `Asia/Kolkata`; one tenant cannot read or change another tenant's settings | 1 |
| `c2_governed_approval_requires_another_member_unless_tenant_allows_self` | Default rejects owner approval; enabled setting permits it only for the exact pending immutable version and writes `self_approved` audit evidence | 1, 2 |
| `c5_daily_and_weekly_schedules_convert_tenant_wall_time_to_utc_slots` | Daily and weekly schedules use tenant IANA zone, correct DST-aware UTC instants, stable slot keys and at-most-once dispatch | 1, 5 |
| `c1_schedule_settings_and_slots_are_tenant_isolated` | Schedule configuration and worker slots cannot cross tenant boundaries | 1, 5 |
| `c7_openai_gateway_outbound_request_contains_only_disclosed_metadata` | Captured outbound request excludes raw rows, restricted values and raw identifiers; permitted identifier references are keyed fingerprints | 7 |
| `c1_model_budget_is_tenant_scoped_and_usage_is_rls_isolated` | Budget applies per tenant/UTC day; usage screen reports token/cost totals; reaching cap blocks before external call with safe error | 1, 5, 7 |
| `c7_model_gateway_rejects_unclassified_and_restricted_metadata` | Gateway refuses unclassified or restricted payloads regardless of prompt instructions | 7 |
| `c6_postgres_read_only_connector_harvests_synthetic_hospital_schema` | Dedicated source role can harvest/profile/ER/dictionary/nightly refresh but cannot mutate source objects or rows | 2, 5, 6, 7 |
| `c6_dbt_generated_manifest_imports_without_row_data` | Local dbt project compiles against synthetic source and its manifest imports as metadata; no raw rows enter graph/model requests | 6, 7 |
| `c3_test_live_is_local_only_and_uses_configured_gateway_models` | `pnpm test:live` refuses CI execution, reads names from environment, runs analytic and lineage questions only with explicit local opt-in | 3, 4, 7 |
| `c7_secret_scanner_blocks_staged_credentials` | Configured pre-commit hook rejects a staged synthetic canary secret and CI scans commits; `.env` remains ignored | 7 |
| `c6_sql_server_and_snowflake_requirements_are_documented` | Prerequisites document requests only a SQL Server instance and a free Snowflake trial/account with least-privilege read-only credentials; no signup/install occurs | 6 |

## Verification gates

Run lint, typecheck, unit, sqlparse, integration, contract and E2E suites against PostgreSQL 16. Add the PostgreSQL service-container CI path if absent. Run live model calls only with `pnpm test:live` on a local machine after an explicit configured key; never run it in CI. Never skip a failed required gate.
