# S2 SQL Server report

**Status:** S2 implementation merged by PR #12; SQL-derived review answer truth extended on the S2 branch
**Spec:** [`real-product-s2.md`](real-product-s2.md)
**Demo:** [`real-product-s2-demo.md`](real-product-s2-demo.md)

## Assumption pending Yashaswi

- Decision 37: allow the testbed's self-signed SQL Server certificate only for loopback hosts. Remote connections keep normal certificate validation enabled.

## Built

- Added a fictional 2,430-row SQL Server 2022 hospital test source under Colima. It contains five tables, declared foreign keys, an undeclared patient relationship, two views, and two real stored procedures. Patient and encounter identifiers match the PostgreSQL testbed; only shared counts are saved into truth.
- Added SQL-derived SQL Server counts, column counts, foreign keys, routine/view names, null rates, sensitivity labels, and shared key counts to `testbed/truth.json`.
- Added SQL-derived answer checks for emergency encounters in 2025, the top five departments by order count, per-provider average encounters per patient, equal patient counts, and the shared-patient count.
- Added an encrypted SQL Server connector. It requires encrypted transport, defaults to certificate validation, rejects elevated or write-capable logins, limits metadata and analytic result sizes to 1,000 rows, and applies a 10-second driver timeout. Catalog discovery includes views, routines, declared edges, and statistically supported inferred references.
- Extended the existing API/worker lifecycle and Add Connector UI. Credentials are encrypted before persistence; activation refuses a writer role. Certificate trust override is accepted only for loopback hosts.
- Added a SQL Server empty-tenant browser walkthrough that checks writer refusal, remote certificate override refusal, encrypted credential storage, seven profiled tables/views, sensitive field labels, inferred ER, stored procedure SQL, and a real Home answer of 500 with query and source evidence.
- Updated the gap audit: SQL Server is now Real. SQL Server acceptance images and video are under [`../acceptance/s2/`](../acceptance/s2/).

## Run the demo

1. Run `pnpm testbed:up` to create both local synthetic source databases and refresh truth.
2. Run `pnpm db:migrate`.
3. Start the S2 app using the commands in [`real-product-s2-demo.md`](real-product-s2-demo.md).
4. Sign in to an admin-provisioned tenant, open **Connectors**, and choose **Add connector → SQL Server**.
5. Use `SQLSERVER_TESTBED_*` values from the ignored `.env` and enable the local test certificate option. Test the connection, start profiling, then inspect Profile, ER, Dictionary, and Home.

Ask “How many patients are in SQL Server hospital?” The checked answer is 500 patients. Evidence shows the bounded `COUNT_BIG` query against `[dbo].[patients]` and one returned aggregate row.

## Verification

| Gate | Result |
|---|---|
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | Passed, 28 files / 79 tests after adding the S2 truth-answer regression case |
| `pnpm test:sqlparse` | Passed, 3 tests |
| `pnpm test:integration` | Passed, 4 files / 4 tests |
| `pnpm test:contracts` | Passed, 37 files / 96 tests |
| `pnpm test:e2e` | Passed, 12 tests |
| `pnpm test:testbed` | Passed, 5 files / 9 source contracts and both S1/S2 Playwright walkthroughs |
| Secret scan on commits | Passed; no leaks found |

The graph benchmark also passed its 1-second p95 regression guard during integration verification (p50 103.2 ms, p95 104.2 ms, max 109.2 ms; 0 lock waits).

## Assumptions and limits

- Assumed, pending Yashaswi: this local testbed login uses an explicitly enabled loopback certificate-trust override because SQL Server Developer Edition serves a self-signed certificate. Remote hosts cannot use this override; they must pass normal certificate validation.
- SQL Server runs only as a test source under Colima/Rosetta. Application processes and the product database remain native. The testbed and its credentials are local-only and use fictional records.
- Tableau, Power BI, Excel, dbt, and Snowflake behavior remains as listed in the gap audit for later slices.
