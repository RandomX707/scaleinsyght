# Phase 6 Report — Enterprise connectivity, hardening and deployment

**Branch:** `phase-6`  
**Status:** implementation complete; PR #8 checks green, merge pending  
**Decision:** 36 remains assumed, pending Yashaswi.

## Assumptions pending Yashaswi

- **Decision 36 — identity and connector defaults:** use vendor-neutral OIDC authorization-code with PKCE and generic read-only lake/CRM connectors, tested with synthetic providers and fixtures. A different choice would add provider-specific configuration and adapter work; the tenant identity, read-only, and audit boundaries remain the same.

## Built

- Tenant-bound OIDC login with PKCE, state/nonce and claim validation, hashed external identity mappings, audit events, and password login as recovery.
- A PostgreSQL-backed outbound customer gateway with one-use enrollment, source-bound credentials, lease fencing, bounded aggregate results, revocation, and no inbound listener.
- Generic read-only lake and CRM connectors registered, tested, and activated through API routes.
- Deterministic adversarial plan evaluation, encrypted AES-256-GCM backup/restore tooling, and a 100-run first-progress load check.
- Gateway, SSO, and generic connector administration UI.
- Deployment-only API, worker, web, SQL parser, and gateway images plus reference Compose configuration. Development and local tests continue to run as native processes; Docker was not used locally.

## Demo and operator commands

Use a configured local `.env` with native PostgreSQL 16 and the synthetic golden accounts. Never print `.env` values.

```sh
pnpm db:setup
pnpm dev
pnpm test:load
pnpm backup:drill
pnpm gateway:start
```

`pnpm gateway:start` requires a configured control-plane URL, one-time claimed gateway credential, and source connection. Run the optional customer-side gateway only in the intended private network.

## Verification results

| Gate | Result |
|---|---|
| `pnpm lint` | Pass |
| `pnpm typecheck` | Pass |
| `pnpm test` | Pass — 60 tests across 19 files |
| `pnpm test:sqlparse` | Pass — 3 tests |
| `pnpm test:integration` | Pass — 4 tests; PostgreSQL graph benchmark also passed the 1-second p95 regression guard |
| `pnpm test:contracts` | Pass — 89 tests across 34 files; includes synthetic real PostgreSQL source and generated dbt manifest contracts |
| `pnpm eval:golden` | Pass — 6 deterministic and adversarial cases |
| `pnpm test:e2e` | Pass — 11 tests |
| `pnpm backup:drill` | Pass — 3 synthetic rows, RPO 0.102s, RTO 0.242s; retained artifact is encrypted |
| `pnpm test:load` | Pass — 100 synthetic runs; first progress event p50 2.6ms, p95 6.6ms, max 19.8ms |
| Docker image build and cold Compose start | Pass — [PR #8 CI](https://github.com/RandomX707/scaleinsyght/actions/runs/45185478463); all five images built, Compose started the reference services and health checks passed |

The generated local sample PostgreSQL source contains 42,132 fake rows and is accessed through the read-only connector role. Local E2E and contract fixtures use synthetic tenants and accounts only. No external identity provider, CRM, lake, or customer database was contacted.

## Deviations and remaining check

The first full E2E run found ambiguous Playwright locators after adding gateway controls and a second status notice. Locators were narrowed to the exact intended source field and status message; the rerun passed all 11 tests without changing assertions or test coverage. CI's PostgreSQL source contract also found a mismatch between a static sample-source URL in the workflow environment and the random password created by the sample-source setup. The static override has been removed so dbt and connector tests read the generated URL from ignored `.env`.

The first PR workflow stopped before tests because the runner's Ubuntu repositories do not include `postgresql-client-16`. Switching to Ubuntu's generic client package then failed the backup drill's intentional PostgreSQL 16 client-version guard. The official PostgreSQL repository installed version 16, but the runner's default `PATH` still selected its newer client. CI now adds `/usr/lib/postgresql/16/bin` to the Actions path after installation. The subsequent full workflow passed, including image builds, Compose cold start, and health checks.

The Docker image build and cold-start acceptance gate is delegated to CI under the local no-Docker constraint. The CI workflow runs Compose validation, builds all five deployment targets, starts the reference services from a cold state, waits for health, and cleans up. Phase completion is now contingent only on merging PR #8.
