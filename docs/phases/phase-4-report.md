# Phase 4 report — Hub integrations

**Assumptions — pending Yashaswi:** Decision 12 uses the recommended first interfaces, Data Studio and Semantics; BI inventory remains read-only, with Data Lake and Weave disconnected. Decision 32 uses deterministic, local fixture adapters only. These assumptions are recorded in [decisions.md](../decisions.md).

## Built

- Added versioned Data Studio and Semantics adapter interfaces backed only by `tests/golden/phase4.json`.
- Added the tenant-scoped Hub schema, forced RLS, catalogue coverage, least-privilege runtime grants and immutable history constraints.
- Added certified metric listing/query routes with entitlement rechecks, durable runs, safe lifecycle events and cited adapter evidence.
- Added immutable FlowSpec versions bound to source snapshots and policy hashes, second-member approval, expiring single-use grants, and a durable outbox handoff.
- Added same-key recovery after a crash before delivery or a lost receiver response. Receiver status is checked before retry; accepted is shown only after confirmation.
- Added tenant-scoped adapter connect/disconnect controls, Hub metrics and evidence UI, FlowSpec version/approval detail, and approval matrix entries.
- Added separate synthetic tenants for each Phase 4 E2E journey; no browser test shares the demo tenant.

## Demo

Run the local environment with `pnpm db:setup`, `pnpm db:migrate`, `pnpm db:seed:golden`, and `pnpm dev`. Open `http://127.0.0.1:5173` and sign in as `owner@phase4-hub-golden.synthetic.example` or `reviewer@phase4-hub-golden.synthetic.example` using `golden-local-only`.

In **Hub integrations**, query the certified `active_customers` metric and inspect the versioned evidence. Create a FlowSpec as the owner, sign in as the reviewer to approve its version, then return as the owner and send it to Data Studio. Create a changed version and repeat the approval. The local receiver confirms the handoff. The contract suite also simulates a process failure before delivery and a dropped receiver response, then verifies recovery with the same idempotency key.

## Verification

All required local gates passed against native PostgreSQL 16 and synthetic golden fixtures:

| Gate | Result |
|---|---|
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 11 files, 38 tests passed |
| `pnpm test:sqlparse` | 3 tests passed |
| `pnpm test:integration` | 2 files, 2 tests passed |
| `pnpm test:contracts` | 25 files, 66 tests passed |
| `pnpm test:e2e` | 8 tests passed |

The graph regression benchmark measured average fan-out 2.100 edges per asset and maximum 50. The RLS-enabled traversal plan used the tenant/source and tenant/destination index-only scans plus the lineage assertion filter; execution time was 0.081 ms. Across 50 random depth-four traversals, p50 was 103.4 ms, p95 206.5 ms and max 210.6 ms; `pg_stat_activity` observed zero lock waits. This remains below the five-second p95 target and supports Decision 9's PostgreSQL graph store.

The GitHub Actions workflow runs the same gates using its PostgreSQL 16 service container. Phase 4 CI and PR merge are pending the final push and review.

## Assumptions and limits

- No real vendor endpoint, account, data or credential was used. The Data Studio receiver is the deterministic local golden adapter.
- Adapter connection state and approvals are tenant-scoped PostgreSQL records. Local fixture receipts simulate vendor idempotency and status lookup.
- FlowSpec execution is constrained to the synthetic read/map/deliver shape; no deployment, release or client-side writes are available.
