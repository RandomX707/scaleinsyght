# Real Product S3: Excel workbook connector

**Status:** in progress under the approved real-product design (S3 row: "Real `.xlsx` upload with three overlapping sheets and profile/dictionary integration"). Started 24 Nov 2026 on the user's instruction after S2 was accepted.
**Branch:** `real-product-s3`
**Scope:** A person uploads a real `.xlsx` workbook through the Connectors add flow. The workbook is encrypted per tenant, profiled, shown in Profile, ER and Dictionary, and can answer questions through the same typed-plan path as the database sources. Everything is checked against `testbed/truth.json`.

## Routes and API

S3 extends the existing connector lifecycle; it adds no fixture route and no new tables.

- `POST /api/connections` accepts `connectorType: "excel"` with a connection name and no credential. It creates a draft connection.
- `POST /api/connections/:id/workbooks` (existing, `application/octet-stream`) now accepts a draft Excel connection. The bytes are stored with the existing per-tenant encrypted artifact store (contract 7: uploads are encrypted per tenant and deleted with their connector). Only `.xlsx` (a ZIP container with a workbook part) up to 20 MB is accepted.
- `POST /api/connections/:id/test` parses the latest uploaded workbook and reports its sheets. A workbook without a sheet that has a header row fails with a clear reason.
- `POST /api/connections/:id/activate` creates the connector agent in the same transaction as activation (contract 2) and runs real profiling.
- Existing Profile, ER, Dictionary, analytic-plan and evidence routes return workbook metadata and query results under the authenticated tenant.

## Connector behaviour

`packages/connectors/src/excel.ts` implements the shared `ReadOnlyConnector` contract.

- Each worksheet with a header row becomes a table. The header text is shown exactly as written in Profile, Dictionary, ER and answers; a normalised identifier (`Patient ID` becomes `patient_id`) is used only in SQL and appears only in the evidence SQL. Empty trailing rows are ignored.
- Column types are inferred from the cell values: integer, decimal, date, timestamp, boolean or text. A column with mixed types is text.
- Sensitivity: a note on the header cell (`sensitivity:personal`, `sensitivity:regulated`, `sensitivity:identifier`) is a declared tag, like a database column comment. The detector in decision 41 adds tags from the header text and the values for every connector; it can only add tags. Each tag records whether it was declared or inferred, and why.
- Profiling computes row counts, null rates and distinct counts. Statistics on tagged columns follow the same withholding rules as the database connectors.
- Relationships between sheets are inferred when a column matches a unique, non-null column of the same name and type on another sheet with at least 98% coverage. They are labelled inferred with their measured confidence and match counts; a workbook has no declared keys (contract 6).
- Questions run as SQL compiled from the validated typed intent (contract 3) in an in-memory DuckDB database inside the worker process, loaded from the decrypted workbook for that step and discarded afterwards. Nothing is persisted (contract 7). The workbook file is never modified.

## UI

The Add connector modal offers **Excel workbook** next to PostgreSQL and SQL Server. Its form asks for a connection name and a `.xlsx` file (the styled file input). **Upload and test** creates the draft, uploads and checks the workbook, then continues to the scope step and profiling, as for the databases. Profile, ER and Dictionary show sheets as tables. Home answers questions on a selected workbook with the same plan card, source line, evidence and grouped-result table and chart.

## Testbed and truth

`testbed/excel/generate.ts` writes `testbed/excel/hospital-operations.xlsx` from the same seeded rows as the database testbed, so patient and visit identifiers overlap with both databases. It has four overlapping sheets:

- **Patients**: patients who had a visit in 2025, with sensitive columns noted.
- **Visits**: the 2025 encounters, with department name and some blank discharge dates.
- **Charges**: the orders for those visits, with amounts and status.
- **Registrations**: a subset of those patients with no header notes. Name, date of birth, MRN and phone must still be classified.

`testbed/excel/truth.ts` reads the workbook independently with `exceljs` (not through the connector) and records sheet and column counts, null rates, sensitive columns, inferred sheet relationships and the S3 answer checks in `testbed/truth.json` under `excel`.

## Acceptance cases

- `c6_excel_connector_profiles_sheets_columns_and_null_rates_matching_truth`: sheets, columns, types, row counts, null rates and sensitivity tags match truth; contracts 6 and 7.
- `c6_excel_connector_infers_sheet_relationships_with_coverage`: inferred relationships and confidence match truth; none are labelled declared; contract 6.
- `c3_excel_connector_runs_typed_intents_in_memory_matching_truth`: count, filtered count, grouped sum, per-group average and patient count compile to DuckDB SQL and match truth; contracts 3 and 7.
- `c7_excel_upload_rejects_non_workbook_files`: a non-`.xlsx` upload fails with a clear reason; contract 7.
- `s3_empty_tenant_uploads_workbook_profiles_and_answers_with_evidence` (Playwright, local testbed): empty tenant, upload through the UI, agent created, Profile/ER/Dictionary checked against truth, five questions and one follow-up answered with model, tokens, SQL and values matching truth; contracts 2, 3, 4, 6 and 7.

The connector unit cases run in CI against the committed workbook. The walkthrough runs in `pnpm test:testbed` only.

## Out of scope

Cross-system identifier fingerprinting and ID trace (S5), `.xls`/`.csv` workbooks, formulas recalculation (cached values are read), pivot tables, and editing a workbook.
