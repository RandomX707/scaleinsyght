# Scale test: a 5,000-table catalog

25 Nov 2026. Run with `pnpm testbed:scale` (builds the catalog and its truth) and `pnpm test:scale` (needs the testbed API, worker and parser, and the web app). Local only; results are written to `testbed/scale/results/` (not committed).

## The catalog

`si_scale_pg`, its own database on the local testbed server, read through its own read-only login (`si_scale_reader`). It holds structure and only a few rows per table:

- 50 schemas (business domains) with 100 tables each: **5,000 tables, 24,250 columns, 4,750 declared foreign keys**.
- In each schema, 5 lookup tables (region, category, team, site, channel) and 19 entities in 5 variants (`invoice`, `invoice_line`, `invoice_history`, `invoice_audit`, `invoice_snapshot`, ...). Names overlap heavily within and across schemas.
- 2 to 8 rows per table, so a wrong table can give a right count by chance. A planner answer counts as correct only when the numbers match **and** the executed SQL reads the expected table.

## Results (final run, 25 Nov 2026 12:25 UTC, after the fixes below)

| What | Measured |
|---|---|
| Profiling through the product (Add connector → activate, all tables in scope) | **170 s** for 5,000 tables (167.9 to 178.4 s over three runs) |
| ER endpoint (`/api/connections/:id/er`) | 306 ms median, **5.3 MB** response |
| Dictionary endpoint (`/api/connections/:id/dictionary`) | 202 ms median, **4.7 MB** response |
| Lineage endpoint (`/api/lineage/graph`) | 3 ms; the catalog has no views or dbt models, so there is no lineage to draw (not a meaningful measurement) |
| ER page load (navigation to data loaded, Chromium) | 1.4 s, but **not usable**: all 5,000 tables are laid out on one canvas, so the view shows only connector lines |
| Dictionary page load | 1.3 s; lists all 5,000 tables and works |
| Lineage page load | 1.2 s (empty) |
| Planner accuracy, 10 questions (`testbed/scale/questions.json`) | **10 of 10 correct** (9 of 10 before the S09 fix below), each reading the expected table |
| Planner latency | 19 to 20 s per question, of which about 6 s is reading the 5,000-table catalog before the model call |
| Planner cost | about USD 0.019 per question (79,900 input tokens for 10 questions) |

## What broke, and what was fixed

The 5,000-table catalog could not be connected at all at first. Each finding is fixed, with a test:

1. **Activation failed: `postgres_connector_result_limit_exceeded`.** The 1,000-row limit for data reads also capped catalog listings. Any source with more than about 1,000 columns or foreign keys failed. Catalog listings now have their own ceiling (200,000), and data reads keep 1,000 rows. This applies to both PostgreSQL and SQL Server. Test: `tests/contracts/c2_connector_catalog_limit_is_separate_from_data_rows.test.ts`.
2. **Activation failed on a 10 s statement timeout** in the inferred-reference query. It joined `information_schema.columns` to itself, and a planner-chosen join over `pg_catalog` also took minutes, because catalog statistics underestimate large catalogs.
   - The catalog is now read with two plain queries and matched in code.
   - A column that already has a declared foreign key is not re-inferred.
   - A target in another schema is used only when the column has none in its own schema.
   - The result is identical on the sample source, the testbed and the testbed with dbt marts, and takes 240 ms on 5,000 tables.
   - Not measured: SQL Server's equivalent query has the same shape.
3. **Activation hung (over 7 minutes) in the ID agent's overlap query.** About 10,000 integer key fields all hold the values 1 to 8, so every shared value matched thousands of fields, even though there was no other source to match. The query is now skipped when no other connection has identifier fields, and filters on other connections inside the per-value probe. The ID trace and nightly truth suites still pass. **Residual risk:** with a second source that also has many low-cardinality integer keys, the overlap work still grows with the shared values. That needs a design change (for example, leaving low-cardinality integer fields out of cross-source matching).
4. **The planner could not plan: the model provider returned HTTP 400.** The response schema lists every column path as an enum, and the provider allows at most 1,000 enum values per schema. The whole catalog went to the planner, which would have been about 330,000 tokens of names per call.
   - A catalog over 30 tables is now narrowed in code to the tables the question's words point at, plus their joins.
   - It is then shrunk until the schema has at most 900 enum values by a count that over-counts the provider's.
   - Catalogs of 30 tables or fewer (every testbed source) are unchanged.
   - Tests: `tests/unit/catalog-selection.test.ts`.
5. **S09 was refused** because the narrowing counted the ordinary word "inspection" as naming all 50 `*.inspection` tables, which crowded out `quality.inspection_audit`. Only qualified names, or bare names with an underscore, now count as naming a table. A unit test covers this case. S09 is a question in this measurement set, so the 10 of 10 above comes after this fix.

## Not fixed (recommendations)

- **ER explorer at scale.** Draw a focus table and its neighbourhood instead of the whole catalog, and page the endpoint (currently 5.3 MB in one response).
- **Dictionary payload** (4.7 MB in one response). The Dictionary rebuild should page or search on the server.
- **Profiling time** (170 s) is table by table on one connection, with a per-table `information_schema.columns` lookup. Reading columns for all tables in one catalog query and profiling with a small pool would cut it.
- **Planner pre-model time** (about 6 s) is spent reading the full catalog, field profiles and statistics for 5,000 tables on every question; it could be cached per profile version.
