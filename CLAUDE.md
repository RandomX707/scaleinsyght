# CLAUDE.md — Scale Insyght

This file is read at the start of every Claude Code session in this repository. It says what we are building, the rules that are never broken, how the code is laid out, and the order of work. The detail lives in `docs/`; this file tells you where.

---

## 1. What Scale Insyght is

Scale Insyght is a standalone, multi-tenant platform for enterprise data intelligence. A customer connects their databases, files, dbt project and BI tools. For each connection the platform creates a **connector agent**. These agents then do two jobs:

- **Profiler mode** (automatic). On connect, and every night, they find tables, views, procedures and packages, profile columns, build ER diagrams and map relationships and lineage across systems.
- **Analytic mode** (on demand). People ask questions in a chat. A plan is built and run read-only across sources, and the answer comes back with its SQL, sources, lineage and a trust badge.

Everything the agents learn is kept in one **metadata graph**. Release 1 reads, explains and proposes. It **never changes a client system**.

The product is **industry-agnostic and cloud-agnostic**. The prototype's hospital story is only example data (section 13).

---

## 2. Read these first

| File | What it is | When to read it |
|---|---|---|
| `docs/system-design-v3.2.md` | The approved system design: product architecture, Release 1 scope, the 8 frozen contracts with acceptance tests, and 20 decisions | Before starting any phase, and whenever you touch a contract |
| `docs/prototype/index.html` | The clickable prototype, one file. Open it in a browser. It is the reference for screens, layout, wording and behaviour | Before building any screen |
| `docs/decisions.md` | Decision log, seeded with decisions 1–25 and their status. Add new ones from 27 | Before assuming a default |
| `docs/phases/phase-N.md` | Per-phase spec: routes, tables, events, tests. Write it at the start of each phase, citing the contracts it implements | At the start of each phase |

**When documents disagree:**
1. This `CLAUDE.md` wins.
2. Then `docs/decisions.md`.
3. Then the prototype.
4. Then the system design.

The prototype reflects product decisions made after the design (section 10.1 lists them).

The prototype is a **visual and behavioural reference only**. It is a single vanilla-JS file with fictional data. Do not copy its code structure, its data or its inline state model.

---

## 3. Non-negotiables

These are never broken, in any phase, for any reason. If a task seems to need breaking one, stop and ask.

1. **INSYGHT is read-only to us.** The existing INSYGHT repository (`RandomX707/INSYGHT`) is never modified, and its database, services, credentials and deployment are never touched. Scale Insyght has its own repository, database, deployment, configuration, domains and secrets.
2. **Copy, never link.** Code reused from INSYGHT is copied into this repo. Each copied file starts with a provenance header: source path, commit (`main` at `56669ee`, `feat/payer-agents` at `53eec8b`) and date. Copied JavaScript gains TypeScript types and tests as it arrives. The reuse map is design section 2.4.
3. **Release 1 is read-only against client systems.** Capabilities in the effect classes MUTATION, DEPLOY, RELEASE and IRREVERSIBLE are registered but enabled for no tenant. A plan containing one ends POLICY_BLOCKED with zero tool calls. No analytical connector code path may load an action credential.
4. **Tenant isolation is enforced by PostgreSQL row-level security**, not by application code:
   - Every tenant-owned table has `tenant_id` and `FORCE ROW LEVEL SECURITY`.
   - The tenant comes from the verified session and is set per transaction (`SET LOCAL app.tenant_id`).
   - App and worker roles own no tables and cannot bypass RLS. Migrations run under a separate role.
   - A worker takes the tenant from the stored run record, never from a job payload.
5. **The model never sees data it should not** (contract 7):
   - Row-level data and restricted data (identifiers, regulated fields, credentials) never reach a model.
   - Descriptive metadata (comments, view and procedure SQL) is scrubbed first: literals become typed placeholders.
   - Statistics on tagged fields are withheld.
   - The boundary is enforced in code by classification and tag, never by column-name patterns or prompts.
6. **No raw identifier values in storage.** Identifiers are stored only as keyed fingerprints, using an HMAC with a per-tenant secret. A question naming a specific ID binds it as a query parameter and never sends it to the model.
7. **Lineage honesty** (contract 6):
   - An accepted inference is never shown as verified.
   - `evidence_method`, `review_status` and `verification` are independent fields; a reviewer can never set verification.
   - A path with a gap is never shown as complete.
   - A structural relationship (foreign key, ID match) is never shown as data flow.
   - Assets and assertions are never deleted; they become inactive or stale and stay queryable for past dates.
8. **The model never executes anything it wrote**, except as a plan in the typed plan schema that passed validation (contract 3). The model never does arithmetic; joins and aggregates run as SQL.
9. **Every material claim in an answer cites evidence** (contract 4). Unsupported statements appear as uncertainties, never blended into the answer. Result rows travel by reference and never appear in events, logs or model input.
10. **Durable runs** (contract 5):
    - A state change and its event are written in one transaction.
    - Events are append-only and numbered per run without gaps.
    - Every worker write carries a fencing token; stale writes are rejected.
    - A browser disconnecting never affects a run.
11. **Out-of-scope objects are recorded by name and type only**, and are never profiled, sampled, fingerprinted or queried. Scope is set in Controls.
12. **Personal agents remember, they are never trained.** A personal agent stores definitions, plans and preferences, never result rows or identifier values. Only its person can read it, and that person can edit or delete any of it. It never widens access.
13. **Single login, no personas.** No role switcher, no "engineer view" or "business view", and no answer variants by role.
14. **No new infrastructure without a demonstrated need.** Release 1 adds no workflow engine, policy engine, graph database, vector database, message broker or cache server. Each has a named trigger in design section 1.10. Propose one by writing a decision first.
15. **No real vendor or client names in code, fixtures or UI copy.** Use the fictional names in section 13. Never commit client data, client SQL or credentials.

---

## 4. How to work in this repo

- **Phase by phase.** Build only the current phase (section 12). A phase is done when its acceptance tests pass in CI and its outcome can be demonstrated. Do not start the next phase's features early, except interfaces the contracts require.
- **Spec before code.** At the start of a phase, write `docs/phases/phase-N.md`. It covers the routes, tables, events and UI it adds, each citing the contracts it implements, plus its acceptance tests as named test cases. Get it approved, then build.
- **One change at a time.** Each change is tested before the next. Keep pull requests small. Branch, then test, commit, push and open a PR. Never push to `main` directly.
- **Find the root cause.** When something fails, explain the cause before changing code. Do not paper over a failure with retries, sleeps or broad try/catch.
- **Tests come with the code.**
  - Unit tests: Vitest.
  - Integration tests run against a real PostgreSQL 16 server, never mocks, PGlite or SQLite for RLS or runner behaviour. Locally that is a native install (section 5.1); in CI it is the GitHub Actions PostgreSQL service. Docker is not available on the development machine and must not be required.
  - Contract tests live in `tests/contracts/` and are named after the contract and test they prove, e.g. `c1_tenant_isolation_no_cross_rows.test.ts`.
  - E2E: Playwright against the web app.
- **Label status honestly.** In docs, PRs and UI copy, every capability is existing, reusable, planned for Release 1 or later. Never claim a feature works until its test passes.
- **Record decisions.** Any choice that changes a contract, adds infrastructure or departs from the design goes in `docs/decisions.md` first, with the alternative considered.
- **Ask, don't guess, when:**
  - a contract seems to need changing;
  - a non-negotiable is in the way;
  - a requirement is ambiguous and expensive to redo;
  - a library adds a new service or licence concern.

---

## 5. Stack

| Component | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) on Node.js 22 LTS | Decision 3 |
| Monorepo | pnpm workspaces | |
| Web | React 18, TypeScript, Vite, React Router, TanStack Query | Plain CSS with design tokens as CSS variables (section 11). React Flow for the plan canvas; D3 or a custom SVG layout for lineage and ER |
| API | Fastify with Zod schemas | One modular application, not microservices. Server-sent events for run streams, resumable by `Last-Event-ID` |
| Workers | Same codebase, separate processes by job type: `discovery`, `profiling`, `lineage`, `analytic`, `reports` | Job queue in PostgreSQL (`FOR UPDATE SKIP LOCKED`) |
| Database | PostgreSQL 16 with RLS | One database, several schemas (section 7). SQL via `pg` and a thin typed query layer; migrations with `node-pg-migrate` |
| Cross-source compute | DuckDB in an isolated worker process, in memory only | Nothing persisted (contract 7) |
| SQL lineage parsing | Small Python service using SQLGlot (`services/sqlparse`, FastAPI) | Behind a typed client interface |
| Model access | One OpenAI-compatible gateway (`packages/model-gateway`) | Hosted or local by config; per-tenant routing and budgets; every request passes the contract-7 boundary |
| File storage | Artifact store interface. Phase 1: encrypted volume with per-tenant keys | Uploaded Excel only |
| Connectors | SQL Server (`mssql`), PostgreSQL (`pg`), Snowflake (`snowflake-sdk`), Excel (`exceljs`), dbt (`manifest.json` / `catalog.json` artifacts), Power BI (REST / scanner API), Tableau (Metadata API) | All read-only through the SQL guard |
| Auth | Email and password with secure sessions in phase 0; SSO in phase 6 | |
| Packaging | Native processes for development (no Docker). Dockerfiles and a Compose file are added in phase 6 for deployment, never needed to develop or test | Kubernetes only when a client requires it |
| CI | GitHub Actions: lint, typecheck, unit, integration (PostgreSQL service), contract suite, RLS catalogue check, Playwright | |

### 5.1 Local environment (no Docker)

The development machine has **no Docker**. Everything runs as native processes:

- **Node 22 and pnpm.** Enable pnpm with Corepack and pin the version in `package.json` (`"packageManager": "pnpm@<version>"`):
  `corepack enable && corepack prepare pnpm@latest --activate`
- **PostgreSQL 16, installed natively** and run as a local service:
  - macOS: `brew install postgresql@16 && brew services start postgresql@16`, or Postgres.app;
  - Ubuntu: `sudo apt install postgresql-16`;
  - Windows: the EDB installer.
- **Connection settings from `.env`.** The app reads `DATABASE_URL` (app role), `DATABASE_URL_WORKER` (worker role) and `DATABASE_URL_MIGRATE` (migration role), with no hard-coded host. `.env.example` lists them; `.env` is never committed.
- **`pnpm db:setup` prepares the local server.** It is a script that, as a local superuser, creates the database, the three roles (`si_migrate` owns the tables; `si_app` and `si_worker` own nothing and have no BYPASSRLS) and a separate `si_test` database. Tests reset `si_test` between suites; they never touch the dev database.
- **Python 3.11+ for `services/sqlparse`**, in a virtual environment (`python -m venv .venv`), started by `pnpm dev`.
- **DuckDB** comes from its npm package; no service is needed.
- **If PostgreSQL is not reachable**, a test must fail with a clear message naming `DATABASE_URL`. It is never silently skipped. Never fall back to mocks, PGlite, SQLite or an in-memory database for contract tests.

---

## 6. Repository layout

```
scale-insyght/
├─ CLAUDE.md
├─ docs/
│  ├─ system-design-v3.2.md
│  ├─ decisions.md
│  ├─ phases/phase-0.md …
│  └─ prototype/index.html          # visual reference only
├─ apps/
│  ├─ web/                          # React workspace
│  ├─ api/                          # Fastify app: auth, REST, SSE
│  └─ worker/                       # job runner entry points by job type
├─ packages/
│  ├─ contracts/                    # Zod schemas and types for contracts 1–8 (plan, envelopes, events, assertions, classes)
│  ├─ db/                           # migrations, RLS helpers, typed queries, tenant-scoped transaction helper
│  ├─ runner/                       # durable run engine: claims, leases, fencing, events, outbox, child runs
│  ├─ policy/                       # single authorise() interface, obligations, decision log
│  ├─ registry/                     # capability and agent registry, effect classes, versioning
│  ├─ graph/                        # metadata graph: assets, relationships, assertions, gaps, path queries
│  ├─ connectors/                   # shared connector contract plus one folder per connector
│  ├─ sql-guard/                    # parser-based read-only guard (copied from INSYGHT)
│  ├─ classification/               # classes, tags, scrubber, model boundary, disclosure control
│  ├─ model-gateway/                # OpenAI-compatible client, routing, budgets
│  ├─ agents/                       # orchestrator, collating, connector, personal, ID, ID trace, critic
│  ├─ compute/                      # DuckDB isolated worker client
│  └─ ui/                           # shared React components and tokens
├─ services/
│  └─ sqlparse/                     # Python + SQLGlot
├─ tests/
│  ├─ contracts/                    # one file per contract test
│  ├─ golden/                       # synthetic golden dataset and expected lineage
│  └─ e2e/
├─ scripts/db-setup.ts             # creates database, roles and test database on a local PostgreSQL
└─ .env.example
```

Keep this layout unless a decision changes it. Never import across packages through relative paths; use package names.

---

## 7. Architecture in one page

**Agent tiers** (design 1.5), all logical runtimes. No agent is a standing process.

| Agent | How many | Job |
|---|---|---|
| Personal agent | One per person | Applies that person's remembered vocabulary, default sources, answer style, saved questions and corrections. Grants no access |
| Orchestrator | One per tenant | Finds relevant assets in the graph, writes a typed plan, assembles one answer |
| Collating agent | One per source group | Holds the group's cross-source relationships and join keys; joins its connectors' results as SQL in DuckDB |
| Connector agent | One per connection | Created in the same transaction that activates the connection. Describes, profiles and queries its source in its own dialect; dbt and BI connectors read models, lineage and reports |
| ID agent | One per tenant | Finds identifier fields everywhere and matches the same ID across sources (SAME_AS assertions with fingerprint evidence) |
| ID trace agent | Sub-agent of the ID agent | Follows each identifier through tables, systems, dbt models and reports. Reads the graph only |
| Critic | Part of each analytic run | Checks results against the plan; may trigger one bounded re-plan |
| Governed agent | One per approved definition | Runs a saved, approved definition step by step with no model at run time |

Harvesting, profiling, ER inference, lineage collection and impact analysis are **capabilities**, not agents.

**How a question runs:**
1. **Resolve.** The personal agent rewrites the question.
2. **Locate.** The orchestrator searches the graph.
3. **Plan.** The orchestrator emits a typed plan, which must validate.
4. **Fan out.** Connector agents run read-only steps in parallel.
5. **Collate.** Collating agents join within each group; the orchestrator joins across groups. Joins run in DuckDB, keyed via the ID registry.
6. **Check.** The critic reviews the result.
7. **Answer.** The personal agent shapes it. The answer carries a trust badge, SQL, sources and lineage.

**Trust order:** certified metric, then approved semantic-pack operation, then glossary definition on guarded SQL, then guarded exploratory SQL. The answer says which route it used.

**Profiler mode:**
1. Connect.
2. The connection test passes.
3. The agent is created.
4. Choose scope.
5. Harvest the information schema.
6. Classify standard against custom objects.
7. Find procedures, materialized views, views and SSIS packages.
8. Read data types.
9. Profile columns.
10. Build the ER diagram.
11. Map probable relationships.
12. Propose source groups.
13. Notify.

**The nightly run** profiles only new and changed tables. It writes new asset versions and graph events, and never overwrites history. Its findings feed Notifications and the Approval matrix.

**PostgreSQL schemas** (proposal; finalise in each phase spec):
- `core`: tenants, users, sessions, entitlements, usage.
- `registry`: capabilities, agents, versions, source groups.
- `runs`: runs, steps, events, claims, outbox, approvals and grants.
- `graph`: assets and versions, relationships, assertions, evidence, gaps, ID registry and fingerprints.
- `conn`: connections, scope rules, controls, profiles.
- `memory`: personal memory, feedback, saved questions.
- `notify`: notifications, approval items.

---

## 8. The eight contracts, in brief

These are frozen. Full rules and acceptance tests are in design Part 3. Put their types in `packages/contracts`. Every contract test must exist in `tests/contracts/` by the end of the phase that first needs it.

1. **Identity, tenancy and authorisation.**
   - RLS everywhere; the tenant is set per transaction.
   - A run acts with its starter's entitlements, never more.
   - An admin role grants configuration rights, never data access.
   - Authorisation is checked at the API and again before every capability call, and each decision is stored with its policy version.
   - Usage (users, connectors by type) is counted from the event log.
2. **Agent registry and capability manifest.**
   - Immutable versions; plans pin versions.
   - Effect classes gate capabilities; an agent's allow-list is a ceiling.
   - Connector agent and connection activate atomically, with `agent_created` and `agent_retired` events.
   - Each connection belongs to exactly one versioned source group.
3. **Plan schema.**
   - Models propose only in this schema.
   - Validation checks schema, cycles, step input and output types, authorisation, effect classes, budgets, movement rules and scope.
   - `plan_hash` is computed over the canonical plan.
   - Each source step names its collating agent and pins the group version.
   - Each join key cites its assertion; probable keys are flagged in the answer.
4. **Envelopes and evidence.**
   - Structured results only; prose comes only from the collator.
   - Every material claim has evidence; interpretations are labelled.
   - Results travel by `result_ref`; each carries a classification and a fencing token.
5. **Durable runs.**
   - Fixed run and step state machines with a table of legal transitions.
   - Atomic claims, leases on the database clock, monotonically increasing fencing tokens.
   - Effects follow intent, then confirmed, failed or unknown; nothing unknown is retried blindly.
   - PARTIAL results; retries run as child runs; event streams are resumable.
6. **Metadata graph and lineage.**
   - Five relationship families; only data flow counts as lineage.
   - Assertions with evidence: `evidence_method` (declared, parsed, observed, inferred), `review_status`, `verification` (`run_verified`, `reconciled`).
   - Gaps are first-class; ID paths are derived from flow assertions.
   - Fingerprints are keyed per tenant.
7. **Classification and disclosure.**
   - Six classes: METADATA_STRUCTURAL, METADATA_DESCRIPTIVE, METADATA_STATISTICAL, AGGREGATE, ROW_LEVEL and RESTRICTED. Section 3 rule 5 covers what reaches a model.
   - Disclosure thresholds are set per tenant, with complementary suppression applied after joins.
   - Uploads are encrypted per tenant and deleted with their connector.
   - Unclassified sources send only structural metadata to the model.
8. **Approval and the action boundary.**
   - Approvals bind to subject hash, source snapshots, policy version and expiry.
   - A single-use grant is consumed with the step claim.
   - Hand-offs are effects under contract 5.
   - Approving a lineage assertion sets review status only.
   - The action classes are blocked in Release 1.

---

## 9. Reuse from INSYGHT

Read design section 2.4 for the full table, which was verified against the code. In short:
- **Reuse as is:** the SQL guard (`agents/sqlGuard.js`), crypto (`utils/crypto.js`, without the legacy CBC path), connection access checks, and the reports schema and export.
- **Refactor:** connectors, the governed-agent runtime, the profiler, disclosure, the LLM client, glossary and join hints, the feature resolver, chat and SSE.
- **Build new:** the graph, orchestrator and plan, lineage assertions, and the classification-driven model boundary.
- **Do not use:** `goldenCache.js`.

Before copying any module, do the security and licence review in decision 13, and record it in the provenance header. INSYGHT's profile packs contain industry-specific fields. Scale Insyght's pack schema must have none: industry content ships inside packs, never in core.

---

## 10. Product surface, from the prototype

Open `docs/prototype/index.html` and click through every screen before building UI. Match its layout, wording and behaviour. The data in it is fictional.

### 10.1 Product decisions that supersede the design doc

- Single login, no personas (section 3, rule 13). The personal agent has **no "role"** field.
- Answer feedback is **thumbs up and thumbs down**:
  - Thumbs up offers to save the question.
  - Thumbs down asks for the correct answer and saves it as a correction to that person's agent.
  - A thumbs down on a lineage answer creates an Approval matrix item instead.
- The design's "review inbox" is called the **Approval matrix**.
- **Scope** lives in **Controls**, a Platform page, plus a short scope step when adding a connector. There is no "Edit scope" button on connector cards.
- The ER explorer is not in the sidebar. It opens from a connector card and the Profile page.
- **The Dictionary is a first-class page.** It is not in the design doc; it is specified in 10.2.
- No migration view in Lineage for now. Migration-readiness ideas are later.
- There is no top search bar.

### 10.2 Screens

**App shell**
- Left sidebar:
  - At the top: logo and "Scale Insyght", the collapse button, **New chat** and **Notifications** (unread count, opens a side panel with New and Earlier).
  - **Workspace** group: Home, Connectors, Dictionary, Lineage.
  - **Platform** group, pinned to the bottom: Agents, BI reports, Approval matrix, Controls.
  - **Recent conversations.**
  - Profile button at the very bottom, opening a menu with My agent, Usage and Sign out.
- Each section header collapses its group; collapsed groups show their counts on the header. The open and closed state persists.
- The whole sidebar collapses to an icon strip, and that state persists.
- A **Back to …** button appears when a button jumps across pages, for example from a Dictionary table to Lineage. It names the origin page and object.

**Login**
- Shows the insyght logo, "Scale Data Hub", email and password, and single sign-on.
- Below the card sits a light "Powered by ScaleHealthTech" pill. Use the official ScaleHealthTech logo file; the prototype's is a low-resolution cut-out.

**Home (chat)**
- Layout follows INSYGHT: messages in the middle, the composer bar at the bottom with an "All sources" selector, attach and voice buttons, and an "Analytic mode · read-only" note.
- Greeting: "Good afternoon, {first name}". It shows the exact number of new updates, with the updates as cards, and earlier ones behind a "Show N earlier" button.
- Each run shows a live plan card ("How your question is being answered"): personal agent, orchestrator, collating agents, connector agents and critic, each with a state and a tick when done.
- The answer card has:
  - a summary, chart and table;
  - a "SQL, sources and lineage" drawer;
  - a trust badge and probable-link warnings;
  - thumbs up and down.
- Lineage questions such as "What is the lineage of TABLE.COLUMN?" return:
  - an end-to-end column flow diagram;
  - counts of evidence types;
  - a numbered step list;
  - buttons for Open in Lineage and "Alert me if this path changes".

**Connectors**
- Each card shows the connector's agent, type, table count, scope summary and last run.
- The add flow is a modal: choose type, enter connection details, test the connection (the agent is created on success), choose scope, start profiling.

**Profile** (per connector)
- A progress ring and step list. They are orange while profiling and turn **green with white ticks** when complete.
- A columns-profiled bar.
- Category cards: standard tables, custom tables, stored procedures, materialized views, views and SSIS packages. Each card has counts, names and a "Show ER diagram" toggle.
- Procedures and packages show what they read and write.
- "Standard" means delivered by the vendor's schema. "Custom" means built by the customer, found by naming convention plus comparison with the vendor schema.

**Dictionary** (per connector, picked from a Source dropdown)
- For a source with an imported vendor dictionary, the page opens first on a summary of it:
  - the file and when it was imported;
  - table counts, and objects newer than the dictionary;
  - how agents use it.
- Left panel:
  - **Standard** and **Custom** tabs. Custom groups custom tables, procedures grouped by kind (fact loaders, report, data checks, archive, utilities), materialized views, custom views and SSIS packages.
  - One search box covering names, column names and an "In SQL code" group with line snippets.
- Right side has open-object pill tabs, plus "Collapse all" and "Expand all".
- **Table header card:**
  - Description, drafted by Scale Insyght with Approve and Edit unless it comes from an imported dictionary.
  - Details and stats (rows, last profiled, dependent reports, built by).
  - Buttons: Open in Lineage, Show in ER diagram and Ask about this.
  - Export: Markdown, Word (.docx) and Copy.
- **Cards, each collapsible:**
  - Columns: key columns by default, show all; each with a PHI tag, nulls and distinct counts, "Used by N" with drill-down, and a Lineage link.
  - Used by.
  - Keys and indexes.
  - Joins to other tables.
- **Procedure, view or package tabs:**
  - Overview: what it writes and how (truncate-insert, merge, insert, delete), reads and parsed logic.
  - Parameters, marked declared.
  - Tables and columns: columns used highlighted, dropped columns struck through.
  - Calls: calls, called by and run by (SQL Agent, SSIS, SSRS).
  - SQL: highlighted, with copy, and an explicit "Encrypted" state.
- Imported vendor dictionaries (for example a `.chm` or CSV export) supply structure only. Descriptions shown in the product are written in plain language, never copied from licensed vendor text.

**Lineage**
- **Lineage tab:**
  - A full graph across systems in lanes: source system, then reporting DB, then warehouse, then reports.
  - Evidence filters: declared, parsed, observed, inferred, missing.
  - Find, and "Try" shortcuts.
  - Click a table to expand its columns. Click a column to highlight its full path; tables on that path auto-expand.
  - The detail panel shows each column on the path with how it gets its value.
  - Clicking an edge shows its evidence, review status and verification.
- **ID trace tab** (no graph):
  - At the top, look up one value: read-only and parameter-bound.
  - An ID picker: patient, encounter, account.
  - Match-rate stats.
  - A step path: created, kept, key changed, probable, counted only, dropped.
  - A table of every place the ID appears.

**Agents**
- The tier diagram: your agent, then the orchestrator, then collating groups proposed by the profiler (adjustable), then connector agents, plus the ID agent and ID trace agent.
- A governed agents table.

**BI reports**
- Each report with its tool, what it is built on, lineage status, and "Open ↗", which opens in the BI tool itself.

**Approval matrix**
- A "Last night's run" summary with open alerts.
- Tabs: From last night, Earlier, All.
- Rows show finding, kind, when found, what it affects, and Approve or Reject.
- Kinds include:
  - schema change, data anomaly, new tables, new custom table;
  - probable relationship, ID match, sensitive column;
  - lineage correction, controls change.
- Approving sets `review_status` only. Relationships stay "Approved · still unverified".

**Controls** (per connector)
- Totals: profiled, listed only, excluded, and the estimated nightly time.
- An access-boundary note: the read-only login is the real boundary, and controls only narrow it.
- **What to include:** groups, each set to Profile and query, List only, or Exclude, with per-object overrides.
- **Name rules**, ordered, first match wins.
- **Column rules:** mask or exclude.
- **New objects:** send to the Approval matrix (default), apply rules automatically, or ignore.
- **On leaving scope:** keep history marked out of scope (default), or delete.
- **Approval:** "Changes need approval" is on by default. A sticky bar lists unsaved changes; saving creates an Approval matrix item when approval is on.

**My agent**
- Answer style, default sources, vocabulary (add and delete), saved questions (saved only after a thumbs up), and corrections.
- States plainly: remembers, never trains.

**Usage**
- Active users and connectors by type, against the plan's allowance.

**Notifications**
- In-app only in Release 1.
- Kinds: discovery finished, nightly run changes, a schema change affecting a report or saved question, collating groups proposed.

---

## 11. Design system

- **Light mode only.** The font is Inter for UI and a monospace font for identifiers and SQL.
- **Brand:** INSYGHT indigo. Primary is `#5A67D8`; also define a darker ink shade and a light tint. Take the exact token values from the `:root` block of the prototype into `packages/ui/tokens.css`.
- **Semantic colours:**
  - good: green; warn: amber; bad: red.
  - profiler: orange while running, green when complete.
  - analytic: indigo.
- **Evidence colours** are fixed everywhere:
  - declared: solid green;
  - parsed: solid blue;
  - observed: solid violet;
  - inferred: dashed amber;
  - missing: dotted red.
- **Components** (build each once in `packages/ui`): card, chip, button (primary, default, small), segmented control, tabs, collapsible card, pill tabs, stat tile, table, notification card, toast, modal, side panel, plan-step row, trust badge, evidence chip, code block with highlighting and copy.
- **Logos:** copy `insyght-logo-transparent.png` and `insyght-logo-white.png` from INSYGHT `frontend/public/`, with provenance.
- **Accessibility:**
  - Every interactive element is keyboard reachable with a visible focus ring.
  - Icon buttons have labels.
  - Disclosure state uses `aria-expanded`.
  - Charts have text alternatives.
  - Colour is never the only signal.
  - Respect `prefers-reduced-motion`.
- **Copy style:** plain language, sentence case, no jargon in UI labels, and numbers with thousands separators.

---

## 12. Phases

The full outcomes and pass-or-fail criteria are in design section 2.5. The numeric thresholds are provisional (decision 15). Each phase also delivers its screens from section 10.

| Phase | Builds | Screens | Demonstrable outcome |
|---|---|---|---|
| **0. Foundation and contracts** | Repo scaffold, CI, tenancy and RLS, auth, capability and agent registry, durable runner and event log, model gateway, policy function, usage counting, contract test suite | App shell, login, empty Home, Usage | A scripted two-step run that survives its worker being killed, for two isolated tenants |
| **1. Profiler mode** | SQL Server, PostgreSQL and Snowflake connectors on the shared contract; Excel upload; agent creation; scope; harvest, classification, profiling, ER inference; nightly refresh; notifications; catalogue answers without a model | Connectors and add flow, Profile, ER explorer, Dictionary (structure and profile), Controls, Approval matrix (nightly findings), Notifications | Connect three databases and a workbook, see the agents created, browse ER diagrams, profiles and the dictionary; the next morning see what changed overnight |
| **2. Analytic mode** | Collating groups and agents, orchestrator, plan validator, critic, trust badges, personal agents, thumbs feedback and evaluation set, governed agents on the runner | Home answers and plan card, Agents, My agent | One question across two groups answered for two people in their own shape; a governed agent approved and re-run |
| **3. Lineage, IDs and tool connectors** | dbt, Tableau and Power BI connectors; declared and parsed collectors; SQLGlot service; inferred matching, review and verification, gaps; ID agent and ID trace agent; impact analysis; schema-change notifications; procedure parsing and SQL search | Lineage (table and column), ID trace, BI reports, Dictionary procedure tabs, SQL search, Used by, lineage answers in chat | A Power BI number traced to its source column with evidence on every hop and one honest gap; an ID traced across three systems |
| **4. Scale Data Hub integrations** | Data Studio and Semantics adapters first; certified-metric route; FlowSpec draft, approval and hand-off | Hand-off approvals in the Approval matrix | A certified metric answered via the semantic layer; a FlowSpec approved and accepted |
| **5. Saved questions and reports** | Saved questions, evidence packs, governed reports, Excel, PowerPoint and PDF export, Dictionary Markdown and DOCX export, scheduled governed agents | Exports, saved questions in My agent | A saved question reused as a starting plan; an evidence pack reproducing a run's figures |
| **6. Enterprise connectivity and hardening** | Customer-side gateway (outbound only), lake and CRM read connectors, SSO, evaluation suite, backup and restore, load and adversarial security tests | — | A private-network source answered through the gateway; a restore drill |

**Definition of done for every phase:**
- Its spec is approved.
- All of its acceptance and contract tests pass in CI.
- No earlier test regresses.
- The outcome demo has been recorded.
- `docs/decisions.md` is updated.
- INSYGHT shows no new commits and no new database connections.

**The first external demo** is the end of phase 3, on the synthetic golden dataset only.

---

## 13. Example data and naming

- **Core code is industry-agnostic.** No healthcare, payer or pharma terms in core schemas, prompts or UI labels. Industry vocabulary ships in packs and in the golden dataset.
- **The synthetic golden dataset** (`tests/golden/`) may reuse the prototype's fictional hospital. It needs:
  - several systems and a dbt project;
  - a Power BI report;
  - one seeded missing hop (expected as a gap) and one seeded conflicting mapping (expected as disputed);
  - one renamed ID between systems (expected as a probable SAME_AS);
  - a custom procedure, an encrypted procedure, an SSIS-style package and a dropped column that breaks a report.
- **Fictional names** — use only these, never real vendor product names:

| Role in the story | Fictional name |
|---|---|
| EHR vendor | Meridian |
| Operational database | Meridian Keystone |
| Reporting database | Meridian Lumen |
| Warehouse | Meridian Harbor |
| Cloud warehouse | Meridian Aurora Cloud |
| Vendor dictionary tool | Lumen Catalog |
| Reporting tools | Report Studio, SliceView, Beacon |
| Master-file codes | PTN (patients), HAC (accounts), ODR (orders), DPT (departments), PRV (providers) |
| Hospital | Riverside Health (example) |

- Customer-built objects use the `X_` prefix.
- Generic tools (SQL Server, PostgreSQL, Snowflake, Excel, dbt, Tableau, Power BI, SSIS, SSRS) may be named, since they are connectors we support.

---

## 14. Decisions

All nine decisions phase 0 needed were approved on 23 Nov 2026. Phase 0 can start. The full log is in `docs/decisions.md`.

| # | Decision | Approved answer |
|---|---|---|
| 1 | Contracts | The eight contracts in design Part 3 are frozen. A change needs a recorded decision |
| 2 | Tenancy | Shared control plane. A dedicated deployment for any regulated client that asks, so nothing may assume a single shared database |
| 3 | Language | TypeScript on Node.js 22 |
| 4 | Model | Hosted model by default; local models supported by configuration through the same gateway |
| 5 | First environment | Synthetic golden dataset (section 13). The customer-side gateway stays in phase 6 |
| 7 | Run engine | PostgreSQL-backed runner. Revisit only past 30-day waits or 50 concurrent runs with lease contention |
| 8 | Disclosure | No platform default. Each tenant sets its own threshold; tagged data is blocked, with a clear reason, until it does |
| 13 | Code reuse | Security and licence review of each INSYGHT module before copying, recorded in its provenance header |
| 15 | Test thresholds | The numbers in design 2.5 are provisional targets; replace them with measured baselines after phase 1 |

**Still open**, to be settled before the phase that needs them:
- Decision 10 (retention and file storage): before phase 1.
- Decisions 9, 11 and 16–18: before phase 3.
- Decision 12: before phase 4.
- Decision 14: before external use.
- Decision 19 (whether dbt, Tableau and Power BI are priced like data sources): before launch. Count connectors by type so either answer works.

Until a decision is approved, build to the design's recommendation and mark it "assumed" in your phase spec.

**Agent run budgets** (models, tokens) are per tenant and configurable. Do not hard-code a model name; read it from gateway config.

---

## 15. Commands

Fill these in during phase 0 and keep them current.

```
corepack enable          # once, provides pnpm
pnpm install
pnpm db:setup            # once: database, roles and test database on local PostgreSQL
pnpm dev                 # web + api + worker + sqlparse against local PostgreSQL
pnpm db:migrate          # runs as the migration role
pnpm test                # unit
pnpm test:integration    # requires local PostgreSQL (section 5.1)
pnpm test:contracts      # contract suite (CI gate)
pnpm test:e2e            # Playwright
pnpm lint && pnpm typecheck
```

---

## 16. Glossary

| Term | Meaning |
|---|---|
| **Connector agent** | The agent created for one connection when its test succeeds |
| **Source group / collating agent** | Related sources proposed by the profiler and adjusted by the customer, joined by one collating agent |
| **Profiler mode / analytic mode** | Automatic discovery and nightly refresh / answering questions |
| **Assertion** | A recorded relationship with evidence. `evidence_method`, `review_status` and `verification` are independent |
| **Gap** | A known missing hop in a path. Never hidden |
| **Probable** | Inferred and not yet approved. Always labelled |
| **Standard / custom** | Delivered by the vendor schema / built by the customer |
| **List only** | Name and type recorded; never profiled, sampled or queried |
| **Approval matrix** | Where people approve or reject findings and changes |
| **Controls** | Per-connector scope, name rules, column rules and change handling |
| **Trust badge** | The route an answer used: certified, pack, glossary or exploratory |
| **Fingerprint** | Keyed hash of an identifier value; the only form identifiers are stored in |
