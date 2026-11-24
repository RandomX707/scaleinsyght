# Real product gap audit

> Updated for S1 on 24 Nov 2026. Statuses are based on the working tree and the passing local acceptance walkthrough, not the eventual target. `Real` means the listed path has run end to end against a tenant-connected source. Fixture implementations are confined to tests; no fixture runtime path is counted as product behavior.

## Screens and user workflows

| Prototype feature | Status | Evidence or remaining work |
|---|---|---|
| Tenant creation, login, and workspace membership | Real | `pnpm tenant:create`; database-backed sign-in and one-use, expiring invite link accepted in `tests/e2e/real-product-s1.spec.ts`. |
| Workspace shell, navigation, recent conversations | Missing | Authenticated user identity is shown; prototype-faithful shell and recent conversation history remain to be implemented. |
| Home chat and source selection | Real | Count question runs through selected real PostgreSQL source and typed plan; S1 Playwright test checks answer, SQL, source, and row-count evidence. Remaining query-shape coverage is S7. |
| Connectors list and PostgreSQL add flow | Real | UI credential entry, connection test, activation, and real profile are exercised by the S1 Playwright test. Credentials are encrypted and not returned after submission. |
| PostgreSQL profile and sensitive-field classification | Real | Real metadata/profile route exercised; test asserts MRN classification and compares profile to `testbed/truth.json`. |
| ER explorer | Real | Declared and inferred references are returned from the real graph; S1 checks the patient relationship from the live source. |
| Dictionary landing, import summary, tables and columns | Real | CSV importer adds descriptions to harvested metadata; UI reports documented coverage and the S1 walkthrough checks the real source. |
| Dictionary Standard/Custom tabs and procedure SQL interactions | Missing | Routine metadata and SQL are discovered and tested, but the full prototype interaction set is not yet complete. |
| Lineage table and column views | Missing | No seeded metadata route remains; real dbt and SQL lineage arrives in S4. |
| ID trace | Missing | Real cross-source fingerprints and matches arrive in S5. |
| BI reports | Missing | Real Tableau import is S8; Power BI remains missing pending a supplied `.pbit`. |
| Reports, saved questions, exports, evidence packs | Missing | Real-data report creation and PDF/XLSX/PPTX/Markdown/Word exports are S7. |
| Agents and My agent | Missing | Connector activation creates a real connector agent; prototype views and saved-question behavior are not yet complete. |
| Approval matrix, findings, notifications | Missing | Real nightly snapshot comparison and notification workflow are S6. |
| Controls and Usage | Missing | Empty-tenant and real-source product flows still need prototype-faithful screen completion. |
| Hub integrations | Real | Disconnected empty state is the approved behavior; no fixture adapter or sample metric is exposed. |
| Profile, Dictionary, ER empty states | Real | Empty tenant begins with no source content and directs the user to add a connector. |

## Sources and product capabilities

| Capability | Status | Evidence or remaining work |
|---|---|---|
| PostgreSQL connector and read-only activation | Real | Local testbed walkthrough creates connection from user-supplied credentials, verifies read-only access, activates it, and profiles it. |
| PostgreSQL profiling, procedures, and SQL metadata | Real | Real tables, columns, views, functions/procedures, SQL definitions, and profile values are read from `si_testbed_pg`. |
| PostgreSQL declared and inferred ER relationships | Real | The testbed truth oracle includes a relationship without a declared foreign key; profiler marks inferred edges separately. |
| Sensitive-column classification | Real | `testbed/truth.json` carries expected classifications; S1 acceptance verifies the live PostgreSQL metadata labels. |
| Dictionary CSV/XLSX import | Real | S1 imports a real testbed CSV dictionary and checks documented-versus-harvested coverage. |
| Typed analytic plan query shapes | Real | Contract test executes count, filtered count, group-by, within-source join, and two-source comparison against PostgreSQL and verifies SQL-derived truth. UI end-to-end coverage expands in S7. |
| Live OpenAI answer over PostgreSQL | Real | S1 Home walkthrough runs one aggregate question via configured gateway and checks value, executed SQL, source, and returned-row evidence. |
| SQL Server connector and testbed | Missing | S2 will add SQL Server 2022 under Colima; no server has been installed or run yet. |
| Excel workbook connector | Missing | S3 will add and profile the three-sheet overlapping workbook. |
| dbt manifest/catalog lineage | Missing | S4 will import real generated artifacts. |
| View/procedure SQL lineage | Missing | SQL is discovered in S1; graph lineage from parsed definitions is S4. |
| Cross-system ID trace | Missing | S5 will verify common patient and encounter fingerprints without storing raw identifiers. |
| Nightly refresh, change detection, approvals, notifications | Missing | S6 will mutate the testbed and verify snapshot-difference findings. |
| Saved questions, reports, exports | Missing | S7 will generate and check outputs against the truth oracle. |
| Tableau `.twb` parsing | Missing | S8 will parse a real published-format workbook. |
| Power BI `.pbit` parsing | Missing | No real export exists in `testbed/bi/real/`; the parser will become real when one is supplied and validated. |
| Snowflake connector and testbed | Missing — untested | Requires `SNOWFLAKE_*` credentials. No signup or credit-consuming action has been taken. |

## Product runtime fixture audit

S1 removed fixture-backed connector, profile, analytic-result, metadata-import, Hub-adapter, demo-seed, and demo-data runtime paths. Fixture implementations remain inside `tests/` and `tests/support/`; the `tests/unit/no-runtime-fixtures.test.ts` guard checks that runtime code does not import them. No product route can return seeded connector/profile/finding/question/approval/conversation records.

## S1 acceptance evidence

- `tests/contracts/c1_tenant_create_empty_workspace_and_single_use_invite.test.ts`: tenant creation and invite contract cases.
- `tests/contracts/c3_real_postgres_query_intents.test.ts`: five typed query shapes against real local PostgreSQL and SQL-derived truth.
- `tests/contracts/c6_real_postgres_metadata.test.ts`: source safety, profile metadata, inferred relationship, and routine metadata.
- `tests/e2e/real-product-s1.spec.ts`: empty tenant, UI invite, PostgreSQL connection, profile, ER, dictionary import, and real Home answer.
- Screenshots and video are saved under `docs/acceptance/s1/` by the local `pnpm test:testbed` command.
- The isolated click-through instructions and recorded gate results are in [`docs/phases/real-product-s1-demo.md`](phases/real-product-s1-demo.md) and [`docs/phases/real-product-s1-report.md`](phases/real-product-s1-report.md).
