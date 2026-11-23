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
- A lineage and report workspace with evidence review, ID tracing, impacts and snapshot comparison.
- A SQLGlot parser service that scrubs literal values and rejects unsupported dialects; synthetic golden dbt/Tableau/Power BI metadata import.
- Directional partial indexes and direct endpoint probes for recursive graph traversal. Traversal accepts a bounded maximum depth (default 20; benchmark uses 4).

## PostgreSQL traversal diagnosis

The benchmark seeds exactly 100,000 synthetic assets and 104,999 directed data-flow edges in `si_test`, then runs `ANALYZE` on graph assets, relationships, assertions, evidence and gaps. The generated four-level DAG has average incident degree **2.100**, maximum **50**, and **4,852** assets with more than 10 incident edges.

`EXPLAIN (ANALYZE, BUFFERS, VERBOSE)` ran as `si_app` with tenant RLS context active. PostgreSQL used `graph_relationships_from_lineage` and `graph_relationships_to_lineage` index scans at each recursive step. The RLS tenant predicate appeared as a one-time filter. The sample edge traversal took **1.029 ms**, with **1,375 shared buffer hits**, and no lock waits were observed in 49 `pg_stat_activity` samples. The earlier delay came from the recursive query joining the tenant's relationship set before applying endpoint predicates; the direct endpoint probes use the intended indexes.

Across 50 deterministic random start assets and four-hop, bidirectional traversals, full `queryLineage` timings were:

| Measure | Time |
|---|---:|
| p50 | 104.3 ms |
| p95 | 106.1 ms |
| Maximum | 110.6 ms |

The p95 is below the five-second Decision 9 threshold. Keep PostgreSQL; no graph extension or separate graph database is required.

## Demo

Run `pnpm dev` and sign in with the synthetic local analyst account described in `docs/phases/phase-2-report.md`. Import the golden dbt manifest from the Lineage workspace, inspect the Power BI report lineage and evidence-backed hops, review the missing hop and disputed mapping, then open the customer ID path, Impact, Snapshot Compare and BI Reports. All source metadata comes from `tests/golden/phase3.json`.

## Verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 10 files, 32 unit tests passed.
- `pnpm test:sqlparse` — 3 parser tests passed.
- `pnpm test:integration` — 2 PostgreSQL integration tests passed, including the 50-start traversal benchmark.
- `pnpm test:contracts` — 21 files, 48 PostgreSQL contract tests passed, including the separately named depth-limit acceptance case.
- `pnpm test:e2e` — 6 browser tests passed, including review-state independence in the Lineage UI and the scoped SQL Server profile action.

All database tests used native PostgreSQL and reset only `si_test`. No live connector, real user data, external system or credential was used.
