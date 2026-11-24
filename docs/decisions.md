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
| 9 | Graph store | decided | Keep PostgreSQL as the graph store. On the same synthetic 100,000-asset graph and index plan, Phase 3 measured p95 104.7 ms, Phase 4 measured 206.5 ms, and Phase 5 measured 106.1 ms across 50 random depth-4 traversals; the Phase 4 change was timing noise and no graph infrastructure is needed. | Yashaswi, 23 Nov 2026 |
| 10 | Retention and file storage | decided | Each tenant's uploaded workbooks are stored on a dedicated encrypted local volume and deleted when their connector is removed. Retention periods for other records will be set later. | Yashaswi, 23 Nov 2026 |
| 11 | What counts as lineage verification | decided | A run event naming the specific input and output marks that exact flow run_verified; reconciliation is recorded separately as reconciled | Yashaswi, 23 Nov 2026 |
| 12 | Hub product interface order | decided | Data Studio and Semantics first; BI inventory stays read-only, while Data Lake and Weave remain disconnected | Yashaswi, 23 Nov 2026 |
| 13 | Audit before copying INSYGHT code | decided | Security and licence review per module at the recorded commits | Yashaswi, 23 Nov 2026 |
| 14 | Portfolio wording | open (before external use) | See design | |
| 15 | Numeric acceptance thresholds | decided | Provisional; replace with measured baselines after phase 1 | Yashaswi, 23 Nov 2026 |
| 16 | What the ID agent stores | decided | Identifier fields, formats, SAME_AS matches and keyed fingerprints; never raw values | Yashaswi, 23 Nov 2026 |
| 17 | Tracing individual ID values | decided | Build field paths during profiler mode; trace a specific value live only when a person explicitly asks | Yashaswi, 23 Nov 2026 |
| 18 | Which IDs are tracked | decided | Detect all identifier fields; let a tenant mark important business IDs to trace first | Yashaswi, 23 Nov 2026 |
| 19 | Pricing by connector type | open (before launch) | Count by type so either answer works | |
| 20 | Collating groups | decided | Profiler proposes, customer adjusts, one group per source | 18 Nov 2026 |
| 21 | Single login, no personas | decided | No role switcher; personal agent has no role field | 18 Nov 2026 |
| 22 | Answer feedback | decided | Thumbs up / thumbs down with correction | 18 Nov 2026 |
| 23 | Review inbox name | decided | "Approval matrix" | 18 Nov 2026 |
| 24 | Scope location | decided | "Controls" page under Platform, plus a scope step when adding a connector | 18 Nov 2026 |
| 25 | Dictionary page | decided | First-class page per connector (see CLAUDE.md 10.2) | 18 Nov 2026 |
| 26 | Local development without Docker | decided | Native PostgreSQL 16, Node 22 with pnpm via Corepack, Python venv; Docker only for deployment packaging in phase 6. Contract tests still use real PostgreSQL. The local golden seed uses synthetic-only demo accounts, never production credentials. | Yashaswi, 23 Nov 2026 |
| 27 | Phase 1 connector and profiler baseline | decided | Synthetic fixtures remain the CI default. Phase 5b also exercises PostgreSQL against `si_sample_source` and dbt using a locally generated manifest; Tableau and Power BI remain fixture-based until real exports are available. | Yashaswi, 23 Nov 2026 |
| 28 | Phase 2 model and analytic demo provider | decided | Deterministic local provider and golden question set remain the CI default. Phase 5b adds an explicitly local live test using OpenAI through the model gateway. | Yashaswi, 23 Nov 2026 |
| 29 | Governed definition approval separation | decided | Another authenticated tenant user approves by default. A tenant setting `allow_self_approval` is off by default; when enabled, self-approval is allowed and recorded in the audit log as self-approved, bound to the exact immutable version. | Yashaswi, 23 Nov 2026 |
| 30 | Connector owner analytic access | decided | Activating a connector grants its activating user the read-only analytic capability for that connection only; access remains revocable and never expands to another tenant member or source. | Yashaswi, 23 Nov 2026 |
| 31 | Phase 3 tool metadata inputs | decided | Synthetic dbt/Tableau/Power BI fixtures remain the CI default. Phase 5b imports a real locally generated dbt manifest from `si_sample_source`; Tableau and Power BI remain fixture-based until real exports are available. | Yashaswi, 23 Nov 2026 |
| 32 | Phase 4 Hub adapter environment | decided | Versioned Data Studio and Semantics adapters use deterministic local fixtures in the test suite; no external endpoints or credentials. Data Studio remains authoritative and every accepted hand-off requires confirmed receiver status. | Yashaswi, 23 Nov 2026 |
| 33 | Governed report schedule cadence and time zone | decided | Schedule instants and slots are stored in UTC. Users choose and see local time in the tenant time zone, configured per tenant and defaulting to `Asia/Kolkata`. Daily and weekly cadence are supported by the existing PostgreSQL queue. | Yashaswi, 23 Nov 2026 |
| 34 | Saved-question similarity | decided | Suggest saved questions using lexical token similarity over the authenticated person's own saved questions; no embeddings, vector store or cross-person memory. | Yashaswi, 23 Nov 2026 |
| 35 | Model provider | decided | Use OpenAI through the OpenAI-compatible model gateway. The model names, credentials, disclosure checks and spend limits are configuration; calls never bypass the gateway. | Yashaswi, 23 Nov 2026 |
| 36 | Phase 6 identity and connector defaults | assumed, pending Yashaswi | Use vendor-neutral OIDC authorization-code with PKCE and generic read-only lake/CRM adapters with synthetic local providers; select vendor-specific protocols and drivers only when target systems are supplied. | Agent, 23 Nov 2026 |
| 37 | SQL Server local test source TLS override | assumed, pending Yashaswi | The self-signed SQL Server testbed may trust its certificate only for loopback hosts. All remote SQL Server connections keep certificate validation enabled. | Agent, 24 Nov 2026 |
