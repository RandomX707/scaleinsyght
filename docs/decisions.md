# Decision log

Each entry records one decision: what was decided, the alternatives, who approved it and when. Numbers 1–20 follow `system-design-v3.2.md` ("Decisions requiring approval"). Add new decisions from 27 onward.

Status values: **decided**, **open** (with the phase it is needed by), or **assumed, pending Yashaswi**.

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
| 9 | Graph store | decided | Keep PostgreSQL as the graph store. On the synthetic 100,000-asset graph, 50 random depth-4 traversals measured p50 103.7 ms, p95 104.7 ms and max 107.6 ms; no graph infrastructure is needed. | Yashaswi, 23 Nov 2026 |
| 10 | Retention and file storage | decided | Each tenant's uploaded workbooks are stored on a dedicated encrypted local volume and deleted when their connector is removed. Retention periods for other records will be set later. | Yashaswi, 23 Nov 2026 |
| 11 | What counts as lineage verification | assumed, pending Yashaswi | A run event naming the specific input and output marks that exact flow run_verified; reconciliation is recorded separately as reconciled | Agent assumption, 23 Nov 2026 |
| 12 | Hub product interface order | assumed, pending Yashaswi | Data Studio and Semantics first; BI inventory stays read-only, while Data Lake and Weave remain disconnected | Agent assumption, 23 Nov 2026 |
| 13 | Audit before copying INSYGHT code | decided | Security and licence review per module at the recorded commits | Yashaswi, 23 Nov 2026 |
| 14 | Portfolio wording | open (before external use) | See design | |
| 15 | Numeric acceptance thresholds | decided | Provisional; replace with measured baselines after phase 1 | Yashaswi, 23 Nov 2026 |
| 16 | What the ID agent stores | assumed, pending Yashaswi | Identifier fields, formats, SAME_AS matches and keyed fingerprints; never raw values | Agent assumption, 23 Nov 2026 |
| 17 | Tracing individual ID values | assumed, pending Yashaswi | Build field paths during profiler mode; trace a specific value live only when a person explicitly asks | Agent assumption, 23 Nov 2026 |
| 18 | Which IDs are tracked | assumed, pending Yashaswi | Detect all identifier fields; let a tenant mark important business IDs to trace first | Agent assumption, 23 Nov 2026 |
| 19 | Pricing by connector type | open (before launch) | Count by type so either answer works | |
| 20 | Collating groups | decided | Profiler proposes, customer adjusts, one group per source | 18 Nov 2026 |
| 21 | Single login, no personas | decided | No role switcher; personal agent has no role field | 18 Nov 2026 |
| 22 | Answer feedback | decided | Thumbs up / thumbs down with correction | 18 Nov 2026 |
| 23 | Review inbox name | decided | "Approval matrix" | 18 Nov 2026 |
| 24 | Scope location | decided | "Controls" page under Platform, plus a scope step when adding a connector | 18 Nov 2026 |
| 25 | Dictionary page | decided | First-class page per connector (see CLAUDE.md 10.2) | 18 Nov 2026 |
| 26 | Local development without Docker | decided | Native PostgreSQL 16, Node 22 with pnpm via Corepack, Python venv; Docker only for deployment packaging in phase 6. Contract tests still use real PostgreSQL. The local golden seed uses synthetic-only demo accounts, never production credentials. | Yashaswi, 23 Nov 2026 |
| 27 | Phase 1 connector and profiler baseline | assumed, pending Yashaswi | Exercise SQL Server, PostgreSQL, Snowflake and Excel flows only through deterministic fixtures in `tests/golden`; measure the 500-object profiler target against the local synthetic fixture, with no vendor systems or credentials. | Agent assumption, 23 Nov 2026 |
| 28 | Phase 2 model and analytic demo provider | assumed, pending Yashaswi | Keep the phase-2 analytic demo deterministic and local, using the golden question set and typed plan/result envelopes; make no hosted model calls and require no model credentials. | Agent assumption, 23 Nov 2026 |
| 29 | Governed definition approval separation | assumed, pending Yashaswi | A governed definition version must be approved by an authenticated member of the same tenant who is not its owner; approval is bound to the exact immutable version. | Agent assumption, 23 Nov 2026 |
| 30 | Connector owner analytic access | assumed, pending Yashaswi | Activating a connector grants its activating user the read-only analytic capability for that connection only; access remains revocable and never expands to another tenant member or source. | Agent assumption, 23 Nov 2026 |
| 31 | Phase 3 tool metadata inputs | assumed, pending Yashaswi | dbt manifests/catalogs and Tableau/Power BI report metadata are supplied as synthetic local fixtures; no vendor API or credentials are required for this phase. | Agent assumption, 23 Nov 2026 |
| 32 | Phase 4 Hub adapter environment | assumed, pending Yashaswi | Implement versioned Data Studio and Semantics adapters with deterministic local fixtures only; no external product endpoints or credentials. Preserve Data Studio's authority by requiring confirmed receiver status for every accepted hand-off. | Agent assumption, 23 Nov 2026 |
| 33 | Governed report schedule cadence | assumed, pending Yashaswi | Phase 5 schedules run once daily at a tenant-selected UTC time, using a unique UTC slot for retry safety and the existing PostgreSQL worker queue. | Agent assumption, 23 Nov 2026 |
| 34 | Saved-question similarity | assumed, pending Yashaswi | Suggest saved questions using lexical token similarity over the authenticated person's own saved questions; no embeddings, vector store or cross-person memory. | Agent assumption, 23 Nov 2026 |
