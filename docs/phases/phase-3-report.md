# Phase 3 report — Lineage, IDs and tool connectors

**Status:** built; approved by agent, pending review.

## Assumptions (pending Yashaswi)

- **Decision 11:** a successful run verifies only the exact input/output pair named by its event; reconciliation remains a separate verification value.
- **Decision 16:** identifier metadata stores fields, formats, matches and tenant-keyed fingerprints; it never stores raw values.
- **Decision 17:** profiler mode builds field paths; an explicitly requested value trace is transient and is not persisted or logged.
- **Decision 18:** detect eligible identifier fields and allow tenants to prioritize important business IDs.
- **Decision 31:** dbt, Tableau and Power BI metadata are local synthetic fixtures; no vendor endpoints or credentials are used.

Decision 9 is decided by Yashaswi: PostgreSQL remains the graph store. Benchmark evidence is below.

## What was built

- Tenant-scoped PostgreSQL graph traversal, assertions, evidence, honest gaps, snapshots, safe append-only events, report impact notices and identifier paths.
- Authenticated lineage, ID, review, verification, impact, snapshot and BI report routes; tool metadata imports use only allowlisted synthetic fixture keys.
- A lineage and report workspace with evidence review, ID tracing, impacts and snapshot comparison. Fixture imports reuse an active connection by synthetic `sourceId`; keyed graph facts and import snapshots are idempotent.
- A SQLGlot parser service that scrubs literal values and rejects unsupported dialects; synthetic golden dbt/Tableau/Power BI metadata import.
- Directional covering indexes, an assertion lookup index and breadth-first frontier queries. Traversal accepts a bounded maximum depth (default 20; benchmark uses 4), removes previously visited assets between levels and applies date/method filters before following an edge.
- Import tests exercise the UI API route twice with the same relationship-bearing Power BI fixture; the connection and assets, relationships, assertions, evidence, events and snapshots retain identical row counts. E2E cases use separate synthetic tenants and select assets by exact ID.

## PostgreSQL traversal diagnosis

The benchmark seeds exactly 100,000 synthetic assets and 104,999 directed data-flow edges with synthetic assertions in `si_test`, then runs `ANALYZE` on graph assets, relationships, assertions, evidence and gaps. The generated four-level graph has average incident degree **2.100**, maximum **50**, and **4,852** assets with more than 10 incident edges. Benchmark connections use `statement_timeout=10s`; there were no timeouts.

`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` ran as `si_app` with tenant RLS context active. The first breadth-first frontier used `graph_relationships_from_lineage` and `graph_relationships_to_lineage` index-only scans, each with a nested-loop semi-join to `graph_assertions_lineage_filter`. RLS tenant predicates appeared as one-time filters, and `current_setting('app.tenant_id')` was evaluated in init plans rather than per row. This frontier took **0.071 ms** with **25 shared buffer hits and 4 reads**. No lock waits were observed in **50 `pg_stat_activity` samples**. The original delay came from expanding relationship paths before endpoint probes and assertion filters; breadth-first frontier queries bound work at each level.

Across 50 deterministic random start assets and four-hop, bidirectional traversals, full `queryLineage` timings were:

| Measure | Time |
|---|---:|
| p50 | 103.7 ms |
| p95 | 104.7 ms |
| Maximum | 107.6 ms |

The p95 is below the five-second Decision 9 threshold. Keep PostgreSQL; no graph extension or separate graph database is required.

## Demo

Run `pnpm dev`, seed the synthetic fixtures with `pnpm db:seed:golden`, and sign in as `phase3-lineage@synthetic.example` with the local golden password. Import the golden dbt manifest and Power BI report from Lineage, inspect the evidence-backed hops, then open the customer ID path, Impact, Snapshot Compare and BI Reports. All source metadata comes from `tests/golden/phase3.json`.

## Verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 10 files, 33 unit tests passed.
- `pnpm test:sqlparse` — 3 parser tests passed.
- `pnpm test:integration` — 2 PostgreSQL integration tests passed, including the 50-start traversal benchmark (p50 103.7 ms; p95 104.7 ms; max 107.6 ms).
- `pnpm test:contracts` — 22 files, 51 PostgreSQL contract tests passed, including API import idempotency, fixture ownership and depth/date/method-filtered lineage.
- `pnpm test:e2e` — 6 browser tests passed. Each stateful test uses its own synthetic tenant; Phase 3 verifies exact-ID selection and that accepted assertions remain unverified.

The pull-request workflow in `.github/workflows/ci.yml` runs for pushes and pull requests. It uses a PostgreSQL 16 service and runs lint, typecheck, unit, SQL parser, integration, contract and E2E gates.

All database tests used native PostgreSQL and reset only `si_test`. No live connector, real user data, external system or credential was used.
