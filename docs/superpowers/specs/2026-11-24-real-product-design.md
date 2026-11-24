# Real Product: No Seeded Results Design

**Date:** 24 Nov 2026  
**Branch:** `real-product`  
**Status:** Proposed for review; no product implementation has started.

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

The user selected incremental vertical slices, technical connector names permitted, CLI-provisioned first user plus app-created copyable invite links, no public signup, a disconnected empty Hub state, and documented-format Power BI template generation.

## Architecture and slices

### A. Remove fixture-backed runtime behavior and provision tenants

- Replace fixture-derived `goldenAccounts` login with database-backed identity and sessions. Keep test account setup in test helpers only.
- Add `pnpm tenant:create` with interactive tenant name, first user's email, and password input that does not echo or enter shell history. Create a truly empty tenant and grant only the initial required entitlements.
- Add tenant invite creation/redeem endpoints and UI: high-entropy hashed token, expiry, one use, tenant-scoped acceptance, and a copyable link. Do not send email.
- Remove `demo:seed`, demo launch path, product golden account allowlists, default fixture Hub adapters, synthetic import buttons, evaluation/demo displays, static FlowSpec examples, and runtime connector/result fallback. Keep fixtures in `tests/` and test-only setup.
- Preserve migration compatibility: do not delete historical real records or change frozen contracts. Existing dev/test seed tenants may be cleaned only by test reset or an explicitly isolated test database.

### B. Real database connectors and profiling

- Extend the connector interface and credential submission to accept PostgreSQL, SQL Server, and Snowflake endpoints. Validate connection and read-only access before activation. Store credentials in `registry.connection_secrets` using authenticated encryption and a deployment key; send no secret back after creation.
- Ensure all live SQL is read-only and source access is tenant-authorized. Profile tables, fields, views, and procedures; preserve view/procedure SQL only after contract-7 scrubbing. Parse SQL definitions without executing them. Persist profiler jobs/events and show actual counts/errors.
- Build `testbed/` generators and orchestration: PostgreSQL `si_testbed_pg`; SQL Server 2022 via Colima on macOS; Snowflake setup SQL/load script pending `SNOWFLAKE_*`; overlapping three-sheet `.xlsx`; isolated dbt-postgres staging/mart project and generated artifacts.
- Use shared fake patient/encounter identifiers across test systems. Compute `testbed/truth.json` directly via SQL for counts, keys, null rates, and metrics.

### C. Real metadata files and lineage

- Implement upload/import flows for dbt `manifest.json` plus `catalog.json`, Tableau `.twb` XML, and Power BI `.pbit` with its documented data model schema. Parse actual published formats and connect source/mart/report nodes using their declared references. Do not infer success from filenames alone.
- Feed discovered view/procedure SQL through the existing SQL parser and make each graph edge evidence-backed with explicit gaps where lineage cannot be established.
- Perform ID fingerprint discovery/matching across real DB connectors and the uploaded workbook. Raw IDs are discarded after keyed fingerprinting per contract 6/7.

### D. Real analytic execution

- Configure OpenAI-compatible models from environment and route all requests through the existing gateway and disclosure boundary.
- Fix planning so only explicitly selected/named sources are considered. Validation binds every step to an active authorized source. The runner executes guarded SQL via the live connector and never executes model-written SQL outside the validated typed plan.
- Evidence includes the executed query (scrubbed where necessary), source identity, row count, and result reference. No raw result rows go to model input, event logs, or answer claims except approved aggregate claims.
- Keep deterministic plan/model/connector providers in test-only injection points; make production startup fail clearly if live configuration is missing instead of falling back.

### E. Prototype-faithful React UI

- Translate prototype CSS and markup into React components using the same class structure, spacing, typography, colors, and interactions; bind every displayed count/name/list to API responses.
- Cover all prototype screens: Home chat; Connectors/onboarding; Profile; ER; Dictionary landing and Standard/Custom/procedure tabs; Lineage table/column; ID trace; BI reports; Reports; Agents; My agent; Hub integrations; Approval matrix; Controls; Usage; notifications and sidebar/recent conversations.
- Empty states state what the page does and link to add a connector. Fix sidebar recent-conversation clipping. Do not render internal IDs, roles, fixture language, or sample data as product results.

### F. Testbed acceptance and audit closure

- `pnpm testbed:up` builds/fills local sources. `pnpm testbed:truth` records DB-computed expected results. `pnpm test:testbed` is local-only and starts from an empty tenant created for the test.
- Playwright signs in, adds every currently testable source through UI with real credentials, tests and activates it, waits for profiling and validates every screen against truth. It asks five questions and checks result values and evidence against SQL truth. It saves each app screenshot next to its prototype counterpart and records video under `docs/acceptance/`.
- With no `SNOWFLAKE_*`, the walkthrough reports Snowflake as untested and the audit retains that status; no test silently skips an available configured source.
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
4. Excel, dbt, Tableau, and Power BI imports use valid files and produce verifiable metadata/lineage. View/procedure SQL lineage is parsed with evidence and explicit gaps.
5. ID trace finds matching shared testbed identifiers across available systems without persisting raw values.
6. Real model answers query only selected sources, match `truth.json` for five questions, and show SQL/source/row-count evidence. CI remains deterministic through test-only provider injection.
7. UI comparison shows prototype-matched structure and interactions at 1440×900 for every screen; captured artifacts are saved in `docs/acceptance/`.
8. `docs/gap-audit.md` has no `Fake` or `Missing` items except Snowflake while credentials are absent, and each `Real` has a passing end-to-end test reference.

## Decisions fixed by the user

- Technical connector/protocol names are permitted as required; client/business names and real data remain prohibited.
- First tenant user is created by `pnpm tenant:create`; no public signup.
- Tenant members create expiring, single-use invite links in-app and copy/send them out of band.
- Incremental vertical slices are the implementation approach.

## Decisions left to the implementer

- Use the existing encrypted connection-secret table with a dedicated credential-encryption key, and keep key configuration separate from workbook artifact encryption.
- Use test-only provider/connector injection without product runtime fixture branches.
- Treat the Hub screen as a real disconnected/empty state with no fixture adapters or metrics; Hub integration is out of scope.
- Generate `.pbit` only through documented Power BI template behavior and validate it; Microsoft documents export via Power BI Desktop and the template contents in [its report-template guide](https://learn.microsoft.com/en-us/power-bi/create-reports/desktop-templates). If this cannot be done on macOS with available tooling, report the supported requirement rather than fabricating a package.
