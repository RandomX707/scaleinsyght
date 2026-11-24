# Real Product: No Seeded Results Design

**Date:** 24 Nov 2026  
**Branch:** `real-product`  
**Status:** Approved by Yashaswi, 24 Nov 2026; S1 plan in progress.

## Intent

Turn Scale Insyght from a fixture-backed demonstration into a product that works against systems a tenant actually connects. A tenant begins empty. A provisioned first user adds real source credentials, tests the connection, creates a connector agent through activation, and waits for a real profiler job. Every screen presents API data from that tenant's connected sources and durable product records. Golden fixtures remain inside tests only.

The exception to CLAUDE.md section 3.15 is limited to technical connector/protocol names required to implement and label PostgreSQL, SQL Server, Snowflake, Tableau, and Power BI. Customer names, imported business data, credentials, and realistic test values remain out of source, test names, and product copy; fake hospital records live only in the isolated testbed.

## Goals

- Remove fixture-backed sources, seeded tenant records, canned answers, demo buttons, and prototype/example badges from runtime product paths.
- Make first-user creation an operator action (`pnpm tenant:create`); provide no public signup. A tenant member creates an expiring, single-use invite link in the app and sends it out of band.
- Allow credential-backed PostgreSQL, SQL Server, and Snowflake connections, uploaded Excel workbooks, dbt manifest/catalog imports, Tableau `.twb`, and Power BI `.pbit` imports. Secrets stay encrypted at rest and never appear in logs or responses after submission.
- Profile connected SQL systems through real read-only database sessions. Persist discovered metadata, profiles, relationships, parsed SQL lineage, run state, and evidence; connector activation creates its agent atomically.
- Use the configured OpenAI-compatible model gateway, typed planner/validator, and durable runner for real-source answers. Query only sources named/selected by the user. The deterministic provider is test-only. Show each answer's executed query, source, and row counts as evidence.
- Port the prototype's actual layout, CSS tokens, structure, class names, copy intent, and interactions into React. Do not port its example records or hardcoded state.
- Provide realistic fake hospital records only in `testbed/`, not the product. Prove behavior against database-derived `testbed/truth.json` with a local-only Playwright walkthrough, screenshots, and video.
- Maintain `docs/gap-audit.md`: change an item to `Real` only when its end-to-end test passes. Snowflake remains explicitly untested until tenant credentials are supplied.

## Non-goals

- Phase 6, deployment packaging, public self-service signup, outbound email delivery, or use of real patient/customer data.
- Changes to the frozen contracts or weakening/skipping an existing test.
- Adding a graph database, workflow engine, cache, or other product infrastructure.
- Live Hub integrations and live Tableau/Power BI service APIs. The Hub page is an accurate disconnected/empty state only; only the requested published files are in scope.

## Approaches considered

1. **Incremental vertical slices (selected):** preserve the current contracts and database-backed functionality, replace one fixture path end to end at a time, and demonstrate each connector from UI submission through profiler data. This allows the gap audit and acceptance tests to stay truthful during migration and reduces regression risk.
2. **Broad replacement:** rebuild connectors, screens, and API surfaces together. This could make the product look consistent sooner but would duplicate existing DB-backed functionality and create a large contract-risky change.
3. **Thin facade over current demo routes:** keep runtime golden routes and layer real connectors around them. Rejected because seeded results would remain accessible in product paths and the target forbids them entirely.

The user selected incremental vertical slices, technical connector names permitted, CLI-provisioned first user plus app-created copyable invite links, no public signup, a disconnected empty Hub state, and documented-format Power BI template generation. Each slice must merge independently with a click-through demo, its part of `pnpm test:testbed`, and a current gap-audit update.

## Slice order and independent completion

Every slice has its own branch/PR/merge, a runnable click-through demo using connected testbed data (or an honest empty state while a required external credential is absent), a growing part of local-only `pnpm test:testbed`, and a gap-audit update. A slice changes its audit status only after its own end-to-end acceptance passes.

| Slice | Scope | Demo and testbed acceptance |
|---|---|---|
| **S1** | `pnpm tenant:create`, login, one-time invites, remove all fixture-backed runtime paths, credential-based PostgreSQL connector through UI, real profiling, ER, Dictionary, and one real Home answer. Create the testbed harness and SQL truth base; classify sensitive fields; import a real testbed dictionary file; infer one undeclared relationship. | Start from an empty tenant, provision/login/invite, add PostgreSQL through the UI, verify read-only activation creates an agent, compare profile/ER/Dictionary to SQL truth, and answer a real count question with query/source/row-count evidence. Verify classified fields and inferred-vs-declared relationship evidence. |
| **S2** | SQL Server 2022 source in Colima; real credential entry, validation, profiling, ER, Dictionary, and source-safe answer. | Add SQL Server through the UI; compare shared IDs/schema/counts with SQL truth. |
| **S3** | Real `.xlsx` upload with three overlapping sheets and profile/dictionary integration. | Upload through the UI and compare sheet/column counts, null rates, and shared-ID discovery against truth. |
| **S4** | Real dbt-postgres project and manifest/catalog import; parse view and procedure SQL into lineage. | Build/run dbt locally; validate manifest/catalog nodes and view/procedure lineage hops against truth. |
| **S5** | Cross-system identifier fingerprinting and ID trace. | Trace shared patient and encounter identifiers through connected DBs and workbook; prove raw values are not persisted. |
| **S6** | Scheduled nightly refresh, previous-snapshot comparison, findings, Approval matrix, notifications, and actual un-declared ER inference completeness. | Modify testbed source by adding a column, dropping a table, and changing counts; run the scheduled profile and assert exact findings and notifications. Check declared/inferred relationship labels. |
| **S7** | Saved questions, reports, evidence packs, PDF/XLSX/PPTX, Dictionary Markdown and Word exports on real data. | Add the five plan-question shapes and verify all exported content and values against SQL-derived truth. |
| **S8** | Tableau `.twb`; Power BI parsing is conditional on a real export. | Parse Tableau from its documented XML format. Read `.pbit` files under `testbed/bi/real/` when present. Until one exists, Power BI remains `Missing` with the explicit reason that no real export has been supplied. |
| **S9** | Snowflake connector/testbed setup, real profile, query and cross-source use. | Run setup SQL and load script only after `SNOWFLAKE_*` is present; Snowflake remains `Missing — untested` until then. Configure a small warehouse with auto-suspend and a short statement timeout. |

S1–S8 can proceed without Snowflake credentials; S9 must not be represented as complete or `Real` until it has run. A missing Power BI export does not block S8's Tableau portion but keeps Power BI marked `Missing`.

## Analytic plan support

The current contract schema has an open `inputs` record, but the current runtime only creates a `question_hash` input and the deterministic executor recognizes a small set of canned metrics. The validator rejects any other input shape. Therefore the current product does **not** semantically support the required real query shapes. Preserve the frozen outer `AnalyticPlanSchema`/contract envelope and add a typed, validated query-intent form inside the existing step input record, with a compiler that emits guarded SQL. The supported shapes are: (1) count, (2) filtered count, (3) group-by aggregate, (4) a join within one source using a declared/inferred graph relationship, and (5) compare aggregates from two explicitly selected sources. Cross-source comparison runs bounded aggregates independently in each source and compares the aggregate outputs; it does not join raw rows across sources. The deterministic implementation remains injected only in tests. S1 supports and verifies count; S7's five-question walkthrough verifies all five shapes.

## Architecture and slices

### A. Remove fixture-backed runtime behavior and provision tenants

- Replace fixture-derived `goldenAccounts` login with database-backed identity and sessions. Keep test account setup in test helpers only.
- Add `pnpm tenant:create` with interactive tenant name, first user's email, and password input that does not echo or enter shell history. Create a truly empty tenant and grant only the initial required entitlements.
- Add tenant invite creation/redeem endpoints and UI: high-entropy hashed token, expiry, one use, tenant-scoped acceptance, and a copyable link. Do not send email.
- Remove `demo:seed`, demo launch path, product golden account allowlists, default fixture Hub adapters, synthetic import buttons, evaluation/demo displays, static FlowSpec examples, and runtime connector/result fallback. Keep fixtures in `tests/` and test-only setup.
- Preserve migration compatibility: do not delete historical real records or change frozen contracts. Existing dev/test seed tenants may be cleaned only by test reset or an explicitly isolated test database.

### B. Real database connectors and profiling

- Extend the connector interface and credential submission to accept PostgreSQL, SQL Server, and Snowflake endpoints. Validate connection and read-only access before activation. Store credentials in `registry.connection_secrets` using authenticated encryption and a deployment key; send no secret back after creation.
- Every source query must run read-only with a statement timeout and row limit. Refuse activation if the supplied account can write. Snowflake uses a small warehouse with auto-suspend and a statement timeout. Profile tables, fields, views, and procedures; classify sensitive columns under contract 7; preserve view/procedure SQL only after contract-7 scrubbing. Parse SQL definitions without executing them. Persist profiler jobs/events and show actual counts/errors.
- Build `testbed/` generators and orchestration in slices: PostgreSQL `si_testbed_pg`; SQL Server 2022 via Colima on macOS; Snowflake setup SQL/load script pending `SNOWFLAKE_*`; overlapping three-sheet `.xlsx`; isolated dbt-postgres staging/mart project and generated artifacts. The testbed must not be included in product builds. Use the same fake patient/encounter keys in each source.
- Use shared fake patient/encounter identifiers across test systems. Compute `testbed/truth.json` directly via SQL for row/column counts, foreign-key pairs, the undeclared relationship, sensitive-column classifications, null rates, and metric values. Include at least `name`, date of birth, MRN, and phone as sensitive columns.

### C. Real metadata files and lineage

- Implement upload/import flows for dbt `manifest.json` plus `catalog.json`, Tableau `.twb` XML, and Power BI `.pbit` with its documented data model schema. Parse actual published formats and connect source/mart/report nodes using their declared references. Do not infer success from filenames alone.
- Feed discovered view/procedure SQL through the existing SQL parser and make each graph edge evidence-backed with explicit gaps where lineage cannot be established.
- Perform ID fingerprint discovery/matching across real DB connectors and the uploaded workbook. Raw IDs are discarded after keyed fingerprinting per contract 6/7. Import a CSV or XLSX dictionary with table, column, and description; add descriptions to harvested metadata and show harvested-vs-documented coverage on the Dictionary landing page.

### D. Real analytic execution

- Configure OpenAI-compatible models from environment and route all requests through the existing gateway and disclosure boundary.
- Fix planning so only explicitly selected/named sources are considered. Validation binds every step to an active authorized source. The runner executes guarded SQL via the live connector and never executes model-written SQL outside the validated typed plan.
- Evidence includes the executed query (scrubbed where necessary), source identity, row count, and result reference. No raw result rows go to model input, event logs, or answer claims except approved aggregate claims. The supported query shapes and limits are specified in “Analytic plan support.”
- Keep deterministic plan/model/connector providers in test-only injection points; make production startup fail clearly if live configuration is missing instead of falling back.

### E. Prototype-faithful React UI

- Translate prototype CSS and markup into React components using the same class structure, spacing, typography, colors, and interactions; bind every displayed count/name/list to API responses.
- Cover all prototype screens: Home chat; Connectors/onboarding; Profile; ER; Dictionary landing and Standard/Custom/procedure tabs; Lineage table/column; ID trace; BI reports; Reports; Agents; My agent; Hub integrations; Approval matrix; Controls; Usage; notifications and sidebar/recent conversations.
- Empty states state what the page does and link to add a connector. Fix sidebar recent-conversation clipping. Do not render internal IDs, roles, fixture language, or sample data as product results.

### F. Testbed acceptance and audit closure

- `pnpm testbed:up` builds/fills local sources. `pnpm testbed:truth` records DB-computed expected results. `pnpm test:testbed` is local-only and starts from an empty tenant created for the test.
- Playwright signs in, adds every currently testable source through UI with real credentials, tests and activates it, waits for profiling and validates every screen against truth. It asks five questions and checks result values and evidence against SQL truth. It saves each app screenshot next to its prototype counterpart and records video under `docs/acceptance/`.
- With no `SNOWFLAKE_*`, the walkthrough reports Snowflake as untested and the audit retains that status; no test silently skips an available configured source. Read Power BI `.pbit` artifacts only from `testbed/bi/real/`; until a real exported artifact is supplied, that audit row remains `Missing` with the reason.
- Nightly refresh schedules a re-profile for each active connection, compares its graph/profile snapshot with the preceding snapshot, and creates findings and notifications from actual differences. The S6 test changes one column, drops one table, and changes row counts, then verifies exact findings.
- Exports (PDF, XLSX, PPTX, Dictionary Markdown, Word) must be produced from real testbed metadata and verified against `truth.json`.
- CI continues running unit, lint, typecheck, sqlparse, integration, contract, and normal E2E suites against PostgreSQL 16. Testbed and live model tests never run in CI.

## Constraints

- CLAUDE.md section 3 contracts and read-only boundaries remain in force. No actual customer or real patient data.
- PostgreSQL 16 is local native; SQL Server test source only uses Colima/Docker per this request. The Scale Insyght product itself remains native. No other platform service is introduced.
- Secrets are never printed, logged, snapshotted, committed, or returned. `.env` remains ignored; `.env.example` contains placeholders only.
- Each commit goes to `real-product` and is pushed immediately. Open a PR when the work is reviewable; merge only after required CI is green. Do not push to `main` directly.
- Do not start Phase 6.

## Acceptance gates

1. Product runtime search and tests prove no golden fixture source, seed operation, canned result, or example-data badge can be used from API/UI runtime. A brand-new tenant has zero connections, profiles, findings, saved questions, approvals, conversations, and reports.
2. `pnpm tenant:create` creates an empty first-user tenant; the user signs in, creates and redeems a single-use invite, and can add a connector.
3. Each database connector completes UI credential entry → test → activation/agent creation → real profile → ER/Dictionary data. Invalid credentials and permissions fail clearly without leaking secrets.
4. Excel, dbt, Tableau, and Power BI imports use valid files and produce verifiable metadata/lineage. View/procedure SQL lineage is parsed with evidence and explicit gaps. Power BI stays `Missing` until a real export is placed in `testbed/bi/real/`.
5. ID trace finds matching shared testbed identifiers across available systems without persisting raw values.
6. Real model answers query only selected sources, match `truth.json` for five question shapes (count, filtered count, group-by, within-source join, cross-source comparison), and show SQL/source/row-count evidence. CI remains deterministic through test-only provider injection.
7. UI comparison shows prototype-matched structure and interactions at 1440×900 for every screen; captured artifacts are saved in `docs/acceptance/`.
8. `docs/gap-audit.md` has no `Fake` items. Remaining `Missing` items are only Snowflake without credentials and Power BI without a real `.pbit` export, each with its reason; each `Real` has a passing end-to-end test reference.

## Decisions fixed by the user

- Technical connector/protocol names are permitted as required; client/business names and real data remain prohibited.
- First tenant user is created by `pnpm tenant:create`; no public signup.
- Tenant members create expiring, single-use invite links in-app and copy/send them out of band.
- Incremental vertical slices are the implementation approach.

## Decisions left to the implementer

- Use the existing encrypted connection-secret table with a dedicated credential-encryption key, and keep key configuration separate from workbook artifact encryption.
- Use test-only provider/connector injection without product runtime fixture branches.
- Treat the Hub screen as a real disconnected/empty state with no fixture adapters or metrics; Hub integration is out of scope.
- Generate `.pbit` only through documented Power BI template behavior and validate it; read real exports only from `testbed/bi/real/`. Microsoft documents export via Power BI Desktop and the template contents in [its report-template guide](https://learn.microsoft.com/en-us/power-bi/create-reports/desktop-templates). If no real export exists, Power BI remains `Missing`; do not fabricate a package.

## Approved design amendments — 24 Nov 2026

- Keep the agreed S1–S9 order as independent merges. Each slice includes its click-through demo, the corresponding `pnpm test:testbed` coverage, and an updated `docs/gap-audit.md`; do not proceed to the next slice before the current one is merged.
- S1 covers CLI tenant creation, login and UI invite acceptance as well as fixture-path removal and a real PostgreSQL connection/profile/ER/Dictionary/Home-answer path. The testbed truth oracle includes one undeclared relationship, the expected personal/regulated classifications for name, date of birth, MRN and phone, and a real CSV/XLSX dictionary. S6 adds refresh/change detection and exact findings checks; S7 adds real-data exports and the full five-question walkthrough.
- The frozen outer plan contract can carry the typed intent variants `count`, `filtered_count`, `group_by`, `join_aggregate` and `compare_aggregates`. Their SQL compilation and contract validation are exercised against local PostgreSQL; the real UI-answer walkthrough grows by slice and covers every shape by S7. This wording does not claim that a shape has passed its real answer acceptance before its slice does.
- Every connector query is read-only, statement-limited and row-limited. Activation fails if credentials can write. Snowflake must use a small auto-suspending warehouse and a statement timeout before any test can run.
- Power BI source artifacts are read only from `testbed/bi/real/`. Until a real `.pbit` is supplied and parsed, Power BI stays `Missing` with that reason; Tableau remains S8's deliverable.
