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
| PostgreSQL, SQL Server (Snowflake later) | Tables, Views | Custom tables, Procedures grouped by kind (fact loaders, report, data checks, archive, utilities), Materialized views, Custom views, SSIS packages | Table; View, Procedure, Package: Overview, Parameters, Tables and columns, Calls, SQL |
| Excel | Sheets read as tables, with original headers | none (explained) | Table (sheet) |
| dbt | Models and sources, with descriptions, tests and columns from manifest and catalog | none | Table (model) with tests; dbt descriptions count as documented |
| Tableau | Data sources | Worksheets; Calculated fields | Data source; Worksheet; Calculated field with formula |

**Standard and custom.** "Standard" means delivered by the vendor schema, which needs an imported vendor dictionary. Without one, the panel says so ("No vendor dictionary imported, so objects are grouped by type") and groups by object type. Custom detection is by naming convention (`X_` prefix and the prototype's patterns) plus absence from the imported dictionary.

### 2.2 Landing summary (opens first)

- Imported dictionary file name and date.
- Table counts: standard, custom, total.
- **Objects newer than the dictionary:** assets first seen after the import.
- **Documented versus harvested coverage**, for tables and for columns. Imported descriptions, dbt descriptions and approved drafts count as documented; unapproved drafts don't.
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
- **Unit tests:** custom detection, search snippets, the HTML export template.
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
