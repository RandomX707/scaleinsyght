# Phase 6 — Enterprise connectivity, hardening and deployment packaging

**Status:** approved by agent, pending review  
**Branch:** `phase-6`  
**Scope:** outbound-only customer-side gateway, generic read-only lake and CRM connectors, OIDC SSO, evaluation/security suites, native backup/restore tooling, load checks, and deployment-only Docker packaging. No vendor signups, real customer credentials, or real customer data.

## Assumptions

- Use standard OIDC authorization-code flow with PKCE; exercise it through a local deterministic provider in CI. Provider-specific enterprise identity setup remains configuration work.
- Keep lake and CRM adapters vendor-neutral and read-only, with synthetic contract fixtures. Do not add a vendor driver or target a real system without a customer-provided endpoint and credentials.
- Implement the customer-side gateway as an outbound HTTPS client that long-polls the control plane. It opens no inbound listener and uses the existing PostgreSQL queue; no broker or new service is introduced.
- Dockerfiles and Compose are for deployment and CI image validation only. Development and required test gates continue to use native processes and PostgreSQL 16.

## Routes and interfaces

| Route/interface | Behavior | Contract |
|---|---|---|
| `POST /api/gateways/enrollments` | An authenticated tenant administrator issues a one-use, short-lived gateway enrollment token; only a hash is stored | 1, 5 |
| `POST /api/gateways/claim` | The outbound gateway exchanges the one-use token for a scoped gateway credential; replay and cross-tenant claims fail | 1, 5, 7 |
| `POST /api/gateways/poll` | The authenticated gateway polls for the next tenant-bound, already-authorized read request; an empty queue is a successful empty response | 1, 3, 5 |
| `POST /api/gateways/results/:requestId` | Gateway returns only the validated bounded result envelope for the claimed request; replay is idempotent and stale claims are rejected | 1, 3, 5, 7 |
| Existing connection test/discover/profile/analytic routes | Support a private source routed through the customer-side gateway, plus generic read-only lake and CRM connector types | 1, 2, 3, 6, 7 |
| `GET /api/auth/oidc/:provider/start` and `GET /api/auth/oidc/:provider/callback` | Authorization-code with PKCE, verified issuer/audience/nonce/state, and tenant-bound identity mapping; password login remains available | 1 |
| `POST /api/tenant/sso` | Tenant administrator configures an allowed OIDC issuer, client ID, and secret reference; raw client secrets are never stored in the database | 1 |
| `pnpm eval:golden` | Runs the deterministic golden answer suite and adversarial prompt/plan/request cases locally and in CI | 1, 3, 4, 7 |
| `pnpm backup:drill` / `pnpm restore:drill` | Native `pg_dump`/`pg_restore` workflow validates a timestamped synthetic backup and records measured recovery point/time | 1, 5, 7 |
| `pnpm test:load` | Exercises concurrent synthetic runs and measures time to first progress event; no production load target is contacted | 1, 5 |

## Tables and storage

All new tenant-owned tables include `tenant_id`, `FORCE ROW LEVEL SECURITY`, and least-privilege grants. Migrations are owned by `si_migrate`; app and worker roles own no tables and cannot bypass RLS (Contract 1).

| Storage | Change | Contract |
|---|---|---|
| `gateway.enrollments` | Tenant, enrollment hash, expiry, one-use consumption timestamp, creator; no plaintext enrollment token | 1, 5, 7 |
| `gateway.clients` | Tenant, gateway id, credential hash, last-seen time, revoked timestamp; credential material is returned once and never persisted in plaintext | 1, 5, 7 |
| `gateway.requests` | Tenant, request id, source connection, validated plan reference, state, lease/fencing token, bounded result reference, safe failure code, timestamps; no raw result rows or secrets | 1, 3, 5, 7 |
| `core.oidc_providers` | Tenant, issuer, client id, secret reference, allowed domains, enabled state; no secret value | 1 |
| `core.external_identities` | Tenant, issuer, subject, local user id, unique issuer/subject mapping | 1 |
| Backup artifacts | Encrypted backup files and signed metadata live outside tenant tables in the configured deployment volume; keys and backup contents are never in logs | 1, 5, 7 |

Lake and CRM metadata use existing connection, graph, profile, and event tables; no connector stores customer row samples. All test inputs come from synthetic fixtures.

## Events

- `gateway_enrollment_created`, `gateway_claimed`, and `gateway_revoked` record actor, tenant, gateway id, and safe status; never tokens or credentials (Contracts 1 and 5).
- `gateway_request_claimed`, `gateway_request_completed`, `gateway_request_failed`, and `gateway_request_expired` record request id, connection id, attempt/fencing token, and safe result reference or failure code (Contracts 1, 3, 5, and 7).
- `sso_provider_configured`, `sso_login_succeeded`, and `sso_login_failed` record tenant, provider id, subject hash, and safe failure code; never authorization codes, tokens, or claims (Contract 1).
- Existing run progress events remain append-only and per-run ordered. No new event contains raw rows, prompt text, credentials, or identifiers (Contracts 5 and 7).

## UI

- **Connectors:** an administrator can issue/revoke a gateway enrollment code and see gateway online/last-seen status. The code is shown once. Private connections clearly indicate that traffic is initiated from the customer network.
- **Connector setup:** generic lake/CRM read-only connection forms use secret references and display no saved credential values. Scope and read-only warnings match existing SQL connectors.
- **Controls / SSO:** tenant administrator can configure an OIDC issuer, client id, secret reference, and allowed email domains; UI states that password login remains available as recovery.
- No evaluation, backup, restore, or load-test screens are added; those are operator CLI workflows. No Docker workflow is added to local development UI.

## Acceptance tests

| Named test case | Acceptance | Contract |
|---|---|---|
| `c1_gateway_enrollment_is_single_use_and_tenant_bound` | Enrollment token is stored hashed, expires, cannot be replayed, and cannot claim another tenant's gateway | 1, 5, 7 |
| `c5_customer_gateway_polls_outbound_without_inbound_listener` | A local gateway answers a synthetic private PostgreSQL query by outbound polling; it opens no listening socket and handles reconnect/empty queue | 1, 3, 5, 7 |
| `c5_gateway_claim_lease_and_result_replay_are_idempotent` | Concurrent polls claim at most one request; stale fencing tokens fail; retrying the same result does not duplicate completion | 1, 5 |
| `c7_gateway_result_contains_only_authorized_aggregate_envelope` | Raw rows, credentials, identifiers, unexpected fields, and over-limit results are rejected before crossing the gateway boundary | 3, 7 |
| `c7_gateway_only_collation_keeps_input_bytes_inside_network` | With gateway-only policy enabled, every private-source input is collated inside the gateway and only the cleared aggregate leaves | 7 |
| `c1_oidc_pkce_state_nonce_audience_and_tenant_are_verified` | Local OIDC flow accepts valid issuer/audience/nonce/state and rejects replay, forged state, wrong audience, untrusted issuer, and cross-tenant identity | 1 |
| `c2_lake_and_crm_read_connectors_obey_shared_read_only_contract` | Synthetic lake and CRM adapters expose discovery/query only, return stable metadata, and cannot mutate source state | 1, 2, 3, 7 |
| `phase6_gateway_and_sso_settings_ui_shows_secret_once_and_never_again` | Gateway enrollment code is shown once; SSO and connector secret references are never re-rendered as credential values | 1, 7 |
| `c3_adversarial_metadata_cannot_change_validated_plan` | Prompt-injection strings in comments/metadata cannot alter the typed plan or request broader access | 3, 7 |
| `c3_sql_guard_rejects_mutation_and_multi_statement_bypass_attempts` | DDL, DML, stacked statements, comment/encoding evasions, and unsupported functions are blocked with zero connector calls | 3 |
| `c1_cross_tenant_gateway_sso_and_connector_requests_are_isolated` | Forged tenant/gateway/source identifiers cannot read, claim, or complete another tenant's records | 1, 5 |
| `c1_gateway_request_forgery_and_replay_are_rejected` | Missing/invalid signatures, expired timestamp, wrong nonce, and replayed request id are rejected | 1, 5 |
| `c5_backup_restore_drill_meets_recovery_objectives` | Synthetic database restored from the recorded backup loses no more than 15 minutes and completes in under 4 hours | 1, 5, 7 |
| `c5_first_progress_event_p95_under_three_seconds_under_load` | Across 100 synthetic runs, first progress event arrives within 3 seconds at p95 | 1, 5 |
| `phase6_reference_compose_starts_cold_without_publishing_gateway_ports` | CI builds and starts the reference stack from cold state; required variables have no insecure defaults and the gateway publishes no inbound port | 1, 5, 7 |

## Verification gates

Run lint, typecheck, unit, sqlparse, integration, contract, adversarial, load, backup/restore, and E2E gates against PostgreSQL 16. CI builds images and validates Compose, but does not require Docker on the development machine. No CI test calls an external identity provider, CRM, lake, database, or model service. Use `tests/golden` and generated synthetic PostgreSQL data only. Merge only after the required PR checks are green and the private-network source demo and restore drill are recorded.
