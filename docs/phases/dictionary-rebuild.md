# Dictionary rebuild: spec

Status: **approved 25 Nov 2026 with Option A** (section 4; decision 53). Requirements are from CLAUDE.md section 10.2 and Yashaswi's brief of 25 Nov 2026. The reference is `docs/prototype/index.html` (route `#dictionary`). Contracts touched: 4 (evidence), 6 (graph), 7 (classification and disclosure), 1 (tenancy and audit).

## 1. What exists today

- `GET /api/connections/:id/dictionary` returns every table with every field in one response: 4.7 MB on the 5,000-table scale catalog.
- Procedure and function SQL is **fetched live from the source on every request**. Nothing is stored, so there is no SQL search across objects and no offline export.
- The page has Overview, Standard, Custom and Procedures tabs. There's no object tab strip, no per-object cards and no landing summary as in the prototype.
- Imported dictionaries (`graph.dictionary_descriptions`) hold descriptions per table and column, with `imported_at` but no file name.
- dbt imports keep names, dependencies and types only (no descriptions or tests). Tableau imports keep no formulas (decision 50).
- Markdown and Word exports exist (S7).

## 2. Scope

### 2.1 Source dropdown: every connector, content by type

| Type | Left panel: Standard | Left panel: Custom | Object tabs |
|---|---|---|---|
| PostgreSQL, SQL Server (Snowflake later) | Tables | Procedures grouped by kind (fact loaders, report, data checks, archive, utilities), Functions, Materialized views, Views, SSIS packages | Table; View, Procedure, Package: Overview, Parameters, Tables and columns, Calls, SQL |
| Excel | Sheets read as tables, with original headers | none (explained) | Table (sheet) |
| dbt | Sources, with descriptions, tests and columns from manifest and catalog | Models | Table (model) with tests; dbt descriptions count as documented |
| Tableau | Data sources | Worksheets; Calculated fields | Data source; Worksheet; Calculated field with formula |

**Standard and custom** (as built, decision 64, which replaces decisions 62 and this spec's original wording). Decided by object type from the catalog, for every source, automatically: Standard is base tables (and sheets, dbt sources, Tableau data sources); Custom is views, materialized views, procedures, functions and packages (and dbt models, Tableau worksheets and calculated fields). No naming convention, rules or vendor-dictionary comparison. A near-identical copy of another routine carries an informational "Copy" badge.

### 2.2 Landing summary (opens first)

- Imported dictionary file name and date.
- Table counts: standard, custom, total.
- **Objects newer than the dictionary:** assets first seen after the import.
- **Described versus harvested coverage**, for tables and for columns. Imported descriptions, dbt descriptions and drafts all count; drafts are shown and used as "Drafted", and the landing says how many are still drafted, with Approve all (decision 64).
- "How agents use it": fixed copy describing the planner's use of descriptions and glossary (descriptive metadata, scrubbed).

### 2.3 Left panel

- Standard and Custom tabs.
- **One search**, run on the server, covering:
  - object names;
  - column names (shown as "N col" on the object);
  - an **"In SQL code"** group listing each object with matching lines (line number and snippet).
- Results are paged (first 200 per group, "Show more"), so 5,000-table sources stay fast.

### 2.4 Right side

- **Pill tabs** for open objects, plus Collapse all and Expand all.
- **Header card:**
  - Description: drafted from metadata only, under contract 7 (names, types, keys, lineage; no data values). It has Approve and Edit unless it was imported (dbt descriptions count as imported). Approvals and edits are stored with who and when.
  - Details and stats: rows, last profiled, dependent reports, built by.
  - Open in Lineage, Show in ER diagram, Ask about this.
  - Export: Markdown, Word (.docx), Copy.
- **Collapsible cards:**
  - **Columns:** key columns first, then Show all. Each column shows its sensitivity tag, nulls and distinct (withheld for tagged fields per contract 7, with the reason), "Used by N" with drill-down, and a Lineage link.
  - **Used by.**
  - **Keys and indexes.**
  - **Joins to other tables** (declared and inferred, the latter labelled probable).
- **Procedure, view and package tabs:**
  - **Overview:** what it writes and how (truncate-insert, merge, insert, delete), what it reads, parsed logic.
  - **Parameters:** marked declared.
  - **Tables and columns:** columns used highlighted, dropped columns struck through.
  - **Calls:** calls, called by, run by.
  - **SQL:** highlighted, with copy, and an explicit "Encrypted" state when the source withholds the definition.

### 2.5 New: "Export as interactive HTML"

- A single self-contained `.html` file (inline CSS and JavaScript, no external requests) that works offline. It covers the chosen source or all sources, with search, filters, expandable tables and columns, procedure SQL and relationships.
- **Metadata only:**
  - no row data;
  - statistics withheld in the product stay withheld;
  - out-of-scope objects are listed by name and type only (non-negotiable 11).
- A short notice is shown before export (what is and isn't included, and that the file leaves the product).
- Each export is recorded in the audit log: `core.activity_events` gets a new event type `dictionary_exported` with source count and object count (migration 037).
- Test: Playwright opens the downloaded file in a browser context with the network blocked and checks search, expand, filters and the absence of any request.

### 2.6 Storage and API changes

- **Migration 037:**
  - `graph.definitions` (versioned per asset: definition text per the decision in section 4, kind, encrypted flag, parameters, parsed reads and writes, calls);
  - dictionary import metadata (file name, imported by, imported at);
  - description drafts and approvals;
  - dbt test counts and descriptions on import;
  - Tableau calculated-field formulas per section 4;
  - the `dictionary_exported` event type.
- Definitions are captured at profile and nightly time (new versions, history kept), not fetched on page load.
- **API:**
  - `GET /api/dictionary/sources`
  - `GET /api/connections/:id/dictionary/summary`
  - `GET /api/connections/:id/dictionary/objects?tab=&q=&cursor=`
  - `GET /api/connections/:id/dictionary/objects/:assetId`
  - `POST /api/connections/:id/dictionary/objects/:assetId/description` (approve or edit)
  - `POST /api/dictionary/export-html`
  - The current single-response route stays until the page no longer uses it.

### 2.7 Tests

- **Contract tests:**
  - c7: export contains no row data or withheld statistics, and out-of-scope objects appear by name only;
  - c7: stored definitions follow section 4;
  - c1: tenant isolation of the new tables (row-level security catalogue check);
  - c6: description approval is recorded with person and time.
- **Unit tests:** Standard and Custom by object type, routine arguments split from returned columns, object titles, search snippets, the HTML export template.
- **Walkthrough** `real-product-s9-dictionary.spec.ts`: for PostgreSQL, SQL Server, Excel, dbt and Tableau testbed sources, compares the Dictionary with testbed truth (object counts, columns, keys, joins, procedure reads and writes, dbt descriptions and tests, Tableau formulas), plus the offline export check. Three consecutive passes.
- **Screens:** 1440×900 app and prototype pairs for every state. Landing summary, Standard, Custom, table object, view, procedure (Overview and SQL), package, search with SQL hits, export notice, and the Excel, dbt and Tableau sources. Each remaining difference is listed with its reason in `docs/ui/ui-report.md`. The testbed has no SSIS package or encrypted procedure, so those states are shown from the synthetic golden dataset; if it lacks them, they're recorded as differences.

### 2.8 Scale targets (added at approval)

- **Dictionary loads lazily.** The object list is paged and searched on the server; an object's details load only when it is opened.
- **ER explorer at scale.** It opens on one table and its neighbours, with search and "Expand neighbours", and never draws the whole catalog at once. It defaults to the most-connected table, or the table it was opened from. The ER endpoint takes `focus` and `depth` and returns that neighbourhood only, plus a search endpoint for tables.
- **Targets on the 5,000-table scale catalog**, for both the Dictionary and the ER explorer: first view **under 1.5 s and under 300 KB** (data transferred for the first view, excluding the app's static assets). Measured by `pnpm test:scale`, which reports both numbers per page.

## 3. Out of scope

- Snowflake content: no Snowflake source exists yet.
- Editing source objects.
- Imported vendor dictionary formats beyond CSV and Excel (`.chm` is later).

## 4. Decision (approved: Option A)

**Procedure, view and Tableau formula text in storage.** Non-negotiable 6 forbids raw identifier values in storage, and contract 7 requires descriptive metadata to be scrubbed before any model input. Definitions and formulas can hard-code identifier values (for example `WHERE patient_id = 104233`).

- **Option A (recommended).** Store the definition with literals replaced by typed placeholders, using the same scrubber as the model boundary. The SQL card and HTML export show the scrubbed text, with a note "Literal values hidden"; "Show original" fetches the live definition from the source on demand and never stores it. Formulas follow the same rule, but an uploaded workbook isn't kept, so Tableau formulas would be scrubbed only.
- **Option B.** Store raw text, classify it as RESTRICTED when it contains literals, and scrub only before model input. This breaks non-negotiable 6 when a literal is an identifier, so it would need an approved exception.

**Approved: Option A** (decision 53). Stored text is scrubbed; "Show original" fetches the live definition and stores nothing. Tableau formulas are shown scrubbed only.

## 5. As built (25 Nov 2026)

**API, differences from 2.6.**
- Objects are addressed by qualified name, not asset ID, because procedures, functions and Tableau calculated fields are stored definitions, not graph assets:
  - `GET /api/connections/:id/dictionary/objects?tab=standard|custom&q=&group=&offset=` (200 per group, "Show more" pages one group);
  - `GET /api/connections/:id/dictionary/object?name=`;
  - `POST /api/connections/:id/dictionary/description` with `{ name, action: 'approve'|'edit', text? }`;
  - `GET /api/connections/:id/dictionary/original?name=` ("Show original"; live, `cache-control: no-store`, nothing stored);
  - ER: `GET /api/connections/:id/er/neighbourhood?focus=&depth=1|2&possible=` (at most 40 tables drawn, the rest counted) and `GET /api/connections/:id/er/tables?q=`.
- `GET .../dictionary/export?object=` exports one table in Markdown or Word; without it, the whole source (S7, unchanged).

**Storage.** Migration 037 as planned, plus `graph.relationships` index `graph_relationships_structural_to` for field-to-table lookups at 5,000 tables. Definitions are captured during every profile and nightly run (`captureDefinitions`); unchanged text keeps its version. Draft descriptions are written by code from names, keys and parsed SQL (no model, no data values) the first time an object is opened, and are refreshed while still unapproved.

**Scrubbing (decision 53), one addition.** `scrubDefinition` replaces strings and numbers and also hides comment text (`-- <comment>`, `/* <comment> */`, Tableau `// <comment>`), keeping line breaks so SQL-search line numbers still match. Comments are free text and can name people or values; this is stricter than the decision, not a change to it.

**Testbed.** `pnpm testbed:dictionary` builds `si_testbed_dictionary` on the SQL Server testbed (standard tables, X_ tables, a loader, MERGE, report, data check, archive, a procedure calling another, an encrypted procedure, a custom view, a hard-coded identifier literal). It maps the existing read-only login into the new database without changing its password, and is part of `pnpm testbed:up`. The dbt testbed has a `schema.yml` with descriptions and tests; `pnpm testbed:dbt -- --docs-only` regenerates the artifacts without rebuilding schemas. Truth: `testbed/dictionary/truth.json`.

**Measured on the 5,000-table catalog** (`pnpm test:scale -- --no-planner`, first view = navigation to network idle, bytes = API response bodies):

| Page | Before | After | Target |
|---|---|---|---|
| Dictionary | 4.7 MB in one response | 633 ms, 14.5 KB over 9 calls | under 1.5 s and 300 KB |
| ER explorer | 5.3 MB (whole catalog) plus 5.1 MB of lineage assets | 739 ms, 40 KB over 8 calls | under 1.5 s and 300 KB |

The ER page also stopped loading the Lineage workspace's asset, report and snapshot lists, which only the impact, compare and BI reports views use.

**Tests.** Unit `tests/unit/dictionary.test.ts`, `scrub-definition.test.ts`; contract `tests/contracts/c7_dictionary_export_and_definitions.test.ts` (c7 storage and export, c1 isolation); testbed `tests/testbed/c7_dictionary_sqlserver.test.ts` (including c6 approval with person and time); walkthrough `tests/e2e/real-product-s9-dictionary.spec.ts` (all five connector types and the offline export with every request refused). S1, S2, S3 and S7 were updated for the new page and the neighbourhood ER view.

**Not built (recorded in docs/ui/ui-report.md):** primary keys and indexes, SQL Agent/SSIS/SSRS "Run by", dependencies of encrypted procedures from the catalog, SSIS packages (no testbed source), and the ER grid layout.
