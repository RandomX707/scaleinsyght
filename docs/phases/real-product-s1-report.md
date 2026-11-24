# Real product S1 report

**Branch:** `real-product`  
**Status:** S1 implementation complete; PR/merge pending  
**Assumptions:** same-name non-primary columns with at least 98% value coverage are treated as inferred references. Same-named primary-key columns are excluded from inference to avoid false bidirectional edges.

## Built

- Removed fixture-backed connector, profile, metadata-import, analytic-result, Hub, and demo-seed behavior from product runtime paths. Deterministic providers and golden test records remain in test-only support. The default Playwright API uses the production server; the S1 local-only suite runs the production API and worker against `si_test`.
- Added first-user CLI provisioning, authenticated tenant login, and a UI for creating expiring single-use invite links and accepting them. Fixed the `/invites` route collision that displayed the invite acceptance page instead of the invite form.
- Added real PostgreSQL credential entry and connection testing in the UI. Credentials are encrypted in the existing secret store. Activation checks effective read-only privileges and creates the connector agent; profiles run against the connected database with a statement timeout and row ceiling.
- Added PostgreSQL profiling metadata for tables, columns, views, routines and their definitions; sensitivity classification; separate declared and inferred ER evidence; and CSV/XLSX dictionary import with documented coverage.
- Added typed query intents inside the existing plan input envelope for count, filtered count, group-by, within-source join aggregate, and separate aggregate comparison across two sources. The SQL compiler binds filter values and limits returned rows. The S1 live answer path is count; contract tests execute all five SQL shapes against local PostgreSQL.
- Fixed answer presentation to render the personalized response's nested answer data and include query text, source, and returned-row evidence.
- Added the isolated `pnpm demo:s1` and `pnpm tenant:create:test` click-through path, SQL-derived testbed truth, and local Playwright coverage. S1 does not add SQL Server, workbook, or cross-system integrations.

## Run the demo

See [real-product-s1-demo.md](./real-product-s1-demo.md). In short: run `pnpm demo:s1`, create a first user with `pnpm tenant:create:test`, sign in at `http://127.0.0.1:4184`, invite a second user, add `si_testbed_pg` with the read-only details in ignored `DATABASE_URL_TESTBED`, then inspect Profile, ER, Dictionary, and the Home answer.

## Acceptance artifacts

- Empty connector page: [empty-connectors.png](../acceptance/s1/empty-connectors.png)
- Profile and sensitivity tags: [profile.png](../acceptance/s1/profile.png)
- ER relationships: [er.png](../acceptance/s1/er.png)
- Dictionary import and coverage: [dictionary.png](../acceptance/s1/dictionary.png)
- Live answer and evidence: [home-answer.png](../acceptance/s1/home-answer.png)
- Browser walkthrough: [walkthrough.webm](../acceptance/s1/walkthrough.webm)

## Verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — 71 unit tests passed.
- `pnpm test:sqlparse` — 3 tests passed.
- `pnpm test:integration` — 4 integration tests passed.
- `pnpm test:contracts` — 96 product contract tests passed.
- `pnpm test:e2e` — 11 tests passed.
- `pnpm test:testbed` — 3 local PostgreSQL testbed contracts passed; the empty-tenant invite, real PostgreSQL profile, ER, dictionary import, and live answer Playwright walkthrough passed (99 contract cases across both commands).

All application database resets in this report target `si_test`; `testbed:up` resets only `si_testbed_pg`. The database tests use fictional hospital records and a local read-only testbed role. The approved real-model answer used the configured gateway credential, which remains only in ignored `.env`.

## Remaining work

S1 is ready for its pull request. The gap audit lists S2–S9 work as Missing until those slices pass their own acceptance tests. No later slice has started.
