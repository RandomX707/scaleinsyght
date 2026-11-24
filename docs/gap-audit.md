# Real product gap audit

> Audit baseline: `main` at `20f6e6c` (24 Nov 2026). Reviewed against `docs/prototype/index.html`, `apps/web/src/main.tsx`, `apps/api/src/server.ts`, connector/profiler/graph/analytic packages, migrations, and `scripts/`. Statuses describe the current product, not the target state. `Real` means the full user path completes using a real external source. A database containing fabricated hospital records is still an acceptable testbed, but fixture-backed product paths are `Fake`.

## Screen and interaction audit

| Prototype feature or screen | Status | Current evidence / gap |
|---|---|---|
| Sign-in and tenant workspace | Missing | Password login authenticates a caller from a fixture-derived allowlist in `apps/api/src/main.ts`; there is no tenant registration or first-user onboarding. OIDC is implemented but is a Phase 6 capability and is not the requested source onboarding path. |
| Workspace shell, sidebar, recent conversations | Fake | React shell uses a literal `S`, generic workspace profile, hardcoded navigation, and “No recent conversations”; no signed-in user identity or saved recent runs are wired into it. |
| Home conversation and answer | Fake | `AnalyticWorkspace` invokes `/api/runs`, but `packages/analytic/src/executor.ts` reads `tests/golden/phase2.json`; displayed answer results are deterministic fixture aggregates. The page also displays internal source ids and raw role/type labels. |
| Home source selection | Fake | Active connections are selected from the API, but available sources include built-in golden connectors; the user can select sources that do not connect to an external system. |
| Connectors list | Fake | The API returns the fixture source catalogue from `listGoldenSources()` plus a fixed local sample-source entry. Connector cards only represent these fixed source references. |
| Connector add and credential entry | Missing | Add flow selects a predefined `sourceId`; it has no host/database/user/password fields for PostgreSQL, SQL Server, or Snowflake. Workbook route accepts artifacts, but no end-to-end file selection flow is exposed here. |
| Connection test and activation | Fake | UI invokes test/activate routes, but those routes resolve a fixed source id through `connectorFor`; most are `createGoldenConnector`, not user-supplied external endpoints. |
| Connector agent creation | Fake | Connection activation persists an agent id, but it is bound to fixed fixture sources and does not establish arbitrary real connector credentials. |
| Profile and profiling progress | Fake | Profile API reads persisted profiler rows, but activation calls `runGoldenProfile` against golden connector implementations for the built-in sources. The configured `local-hospital` is a special environment URL, not a user-added connection. |
| ER explorer | Fake | ER UI reads the graph API; most available graph content is produced by golden profiler connectors and fixture structural references. No unrestricted real-source add path exists. |
| Dictionary landing summary | Missing | The React landing page lists active connector type strings and has no imported dictionary/source summary. |
| Dictionary tables and columns | Fake | Per-connection dictionary API reflects the graph, but the ordinary add flow fills it from fixture-backed profiling. |
| Dictionary Standard and Custom tabs | Missing | Current React Dictionary renders a plain table list. Prototype tabs, grouped cards, procedure tabs, expand/collapse details, and source dictionary imports are absent. |
| Dictionary views and stored procedures with SQL | Missing | Profiler metadata contract currently centers on tables/fields; the user-visible route does not display view/procedure definitions or parsed lineage from them. |
| Lineage table view | Fake | Graph queries are database-backed, but the normal UI offers “Import synthetic …” actions that invoke `importGoldenMetadata` and fixtures. |
| Lineage column view | Missing | Prototype’s column-grain lineage view is not implemented as a distinct React screen. |
| ID trace | Fake | API graph trace can query stored keyed fingerprints, but the only readily available matches originate from seeded/fixture metadata; no real-source fingerprint harvest is completed through the UI. |
| BI reports | Fake | Report records can be read from the graph, but Power BI/Tableau entries are created by fixture metadata import. No real `.twb`/`.pbit` import is implemented. |
| Reports and evidence packs | Fake | Report APIs persist user reports, but product demonstration content and report sources include fixture-generated items; report composition has not been audited end-to-end against an unseeded tenant. |
| Agents | Fake | Connector agents reflect registered fixed-source connections; the page also has no demonstrated real-source agent executing a completed profiling lifecycle. |
| My agent and saved questions | Fake | Personal memory/saved-question APIs are database-backed, but this session’s seed path populated prototype questions; empty-tenant behavior and true-source answer reuse are unverified. |
| Approval matrix | Fake | Approval routes are backed by persisted records, but the prototype run/findings and current seeded approval items are not produced by a real nightly profile on a user-connected source. |
| Notifications | Fake | Notification panel reads API records, but the product currently obtains its demo notifications from seeded/prototype profiler activity. |
| Controls and scope | Fake | Scope API persists controls, but selected connections come from fixed source definitions; the page requires a connection and does not provide a clear empty first-connector action. |
| Usage | Real | Usage is computed from persisted activity and model-usage events. It can render an empty tenant without fixture data, although tenant onboarding is currently missing. |
| Hub integrations and certified metrics | Fake | Default Hub adapters are `createGoldenHubAdapters(getGoldenHubFixtures())`; metrics and results are fixtures, not connected external products. |
| FlowSpec and handoff | Missing | An API-backed prototype path exists, but the current default `dataStudio` adapter is fixture-backed. This is not a real product integration and must not be represented as real. |

## Source and feature audit

| Feature | Status | Current evidence / gap |
|---|---|---|
| PostgreSQL connector through arbitrary UI credentials | Missing | `createPostgresConnector` accepts a connection string, but `/api/connections` only accepts a catalog `sourceId`; it cannot accept or securely persist a user's connection parameters. |
| PostgreSQL profiler against a live database | Real | `packages/connectors/src/postgres.ts` introspects a configured PostgreSQL URL; `local-hospital` provides a narrow environment-configured real database path. The product UI cannot create that connection from credentials yet. |
| SQL Server connector | Missing | No real SQL Server driver/credential setup is connected to the current user-facing connector route. |
| Snowflake connector | Missing | No user-configurable real Snowflake connector path or credentials are present. |
| Excel `.xlsx` connector | Missing | Artifact storage primitives exist, but the required user-facing workbook upload, real ExcelJS harvest and profile flow is not exposed end to end. |
| dbt manifest/catalog import | Fake | Import route supports real manifest-shaped payloads, but current UI/source catalogue invokes golden fixture keys; real user file upload and end-to-end model profiling are missing. |
| Tableau `.twb` metadata import | Missing | Current Tableau path is fixture import only; there is no documented-format parser/import path. |
| Power BI `.pbit` metadata import | Missing | Current Power BI path is fixture import only; there is no `.pbit` parser/import path. |
| View/procedure SQL parsing into lineage | Missing | SQLGlot service exists, but no complete real-source discovery-to-parse-to-graph user workflow is wired for these objects. |
| Cross-source ID fingerprinting and trace | Fake | Storage/query mechanisms exist, but no UI-configured real systems with shared testbed identifiers are harvested and matched. |
| OpenAI model answers through planner/validator/runner | Fake | Planner and durable runner exist, but execution delegates to the deterministic `executeGoldenStep` corpus. It is not real-source SQL execution. |
| Source-constrained planning | Fake | Selected source ids reach `/api/runs`; a contract test exists, but the answer path is still golden execution and the end-to-end real-source behavior is absent. |
| Answer evidence: executed query, source, row counts | Fake | The UI shows evidence fields from the result envelope, but the ordinary answer flow uses golden result references rather than queries executed on connected real sources. |
| Empty tenant behavior | Missing | No sign-up/bootstrap flow exists. Several views show empty values, but initial setup cannot create a tenant and add its first real connector. |
| PostgreSQL testbed and truth oracle | Missing | No `testbed/` build or `testbed/truth.json` workflow exists. |
| Local SQL Server 2022 testbed | Missing | No Colima-based source setup or real connector acceptance walkthrough exists. |
| Snowflake testbed | Missing | No setup SQL/load script; must stay marked untested until `SNOWFLAKE_*` is supplied. |
| Excel overlap workbook | Missing | No real testbed workbook generator. |
| dbt testbed project and artifacts | Missing | A generated sample dbt helper exists, but not the specified isolated `testbed/` project/artifact contract. |
| Tableau and Power BI published-format test files | Missing | No real `.twb` or `.pbit` artifacts and parsers for the testbed marts. |
| End-to-end testbed walkthrough/video/screenshots | Missing | Playwright suites currently seed golden tenants and do not start from empty tenant, connect each source through UI, compare against SQL truth, or save the required acceptance artifacts. |

## Fixture-backed product paths found

These are product imports or routes outside `tests/` that must be removed or replaced with real connector implementations. Golden fixtures may remain under `tests/` for CI only.

- `apps/api/src/main.ts`: loads `tests/golden/phase*.json` to construct allowed login accounts.
- `apps/api/src/server.ts`: imports `createGoldenConnector`, `listGoldenSources`, `runGoldenProfile`, `importGoldenMetadata`, and `createGoldenHubAdapters(getGoldenHubFixtures())`; exposes fixed source and fixture import routes.
- `packages/connectors/src/index.ts` and `packages/connectors/src/metadata.ts`: runtime golden connectors, source catalogue, structural references, and metadata fixture loaders.
- `packages/profiler/src/index.ts`: runtime `runGoldenProfile` and golden structural-reference fallback.
- `packages/graph/src/index.ts`: runtime `importGoldenMetadata`.
- `packages/analytic/src/executor.ts` and `packages/analytic/src/index.ts`: deterministic golden result executor exported into the application runtime.
- `packages/hub-adapters/src/index.ts`: default fixture adapters and metrics.
- `scripts/seed-golden.ts`, `scripts/demo-phase0.ts`, `scripts/test-live.ts`, plus `package.json` scripts: seed/demo paths; seed commands must remain test-only or be deleted from product use as appropriate.
- `apps/web/src/main.tsx`: synthetic import buttons, fixture language, seeded evaluation display, static demo FlowSpec payload, and seeded-source-oriented empty-state wording.

## Acceptance status

The target is for every applicable screen and feature above to become `Real`; source setup requiring unavailable Snowflake credentials remains `Missing — untested` until credentials are configured. This audit will be updated as each end-to-end test passes. A feature is not relabelled `Real` based only on a driver, parser, route, or screenshot existing.
