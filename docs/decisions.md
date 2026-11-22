# Decision log

Each entry records one decision: what was decided, the alternatives, who approved it and when. Numbers 1–20 follow `system-design-v3.2.md` ("Decisions requiring approval"). Add new decisions from 26 onward.

Status values: **decided**, **open** (with the phase it is needed by).

| # | Decision | Status | Current answer | Approved by / date |
|---|---|---|---|---|
| 1 | The eight contracts are the frozen baseline | decided | The eight contracts in Part 3 are the frozen baseline | Yashaswi, 23 Nov 2026 |
| 2 | Tenant deployment model | decided | Shared control plane; dedicated deployment per regulated client | Yashaswi, 23 Nov 2026 |
| 3 | Language | decided | TypeScript on Node.js 22 | Yashaswi, 23 Nov 2026 |
| 4 | Default model placement | decided | Hosted by default, local by configuration | Yashaswi, 23 Nov 2026 |
| 5 | First reference environment | decided | Synthetic golden dataset; gateway not pulled forward | Yashaswi, 23 Nov 2026 |
| 6 | Release 1 connector set | decided | SQL Server, PostgreSQL, Excel upload, Snowflake, dbt, Tableau, Power BI | 18 Nov 2026 |
| 7 | Run engine | decided | PostgreSQL runner; revisit past 30-day waits or 50 concurrent runs with lease contention | Yashaswi, 23 Nov 2026 |
| 8 | Disclosure defaults | decided | No platform default; tagged data blocked until a tenant sets a policy | Yashaswi, 23 Nov 2026 |
| 9 | Graph store | open (phase 3) | Stay on PostgreSQL unless depth-4 traversal on 100k assets > 5 s p95 | |
| 10 | Retention and file storage | open (phase 1) | Tenant-configurable; encrypted volume behind the artifact store | |
| 11 | What counts as lineage verification | open (phase 3) | Run event naming the flow = run_verified; reconciliation recorded separately | |
| 12 | Hub product interface order | open (phase 4) | Data Studio and Semantics first | |
| 13 | Audit before copying INSYGHT code | decided | Security and licence review per module at the recorded commits | Yashaswi, 23 Nov 2026 |
| 14 | Portfolio wording | open (before external use) | See design | |
| 15 | Numeric acceptance thresholds | decided | Provisional; replace with measured baselines after phase 1 | Yashaswi, 23 Nov 2026 |
| 16 | What the ID agent stores | open (phase 3) | Fields, formats, matches, keyed fingerprints; never raw values | |
| 17 | Tracing individual ID values | open (phase 3) | Paths in profiler mode; specific values live, on request | |
| 18 | Which IDs are tracked | open (phase 3) | Detect all; customer marks important IDs first | |
| 19 | Pricing by connector type | open (before launch) | Count by type so either answer works | |
| 20 | Collating groups | decided | Profiler proposes, customer adjusts, one group per source | 18 Nov 2026 |
| 21 | Single login, no personas | decided | No role switcher; personal agent has no role field | 18 Nov 2026 |
| 22 | Answer feedback | decided | Thumbs up / thumbs down with correction | 18 Nov 2026 |
| 23 | Review inbox name | decided | "Approval matrix" | 18 Nov 2026 |
| 24 | Scope location | decided | "Controls" page under Platform, plus a scope step when adding a connector | 18 Nov 2026 |
| 25 | Dictionary page | decided | First-class page per connector (see CLAUDE.md 10.2) | 18 Nov 2026 |
