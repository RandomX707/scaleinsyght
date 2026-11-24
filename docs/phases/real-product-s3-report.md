# S3 Excel workbook report

**Status:** implemented on `real-product-s3`
**Spec:** [`real-product-s3.md`](real-product-s3.md)

## Built

- An Excel workbook connector (`packages/connectors/src/excel.ts`) on the shared read-only connector contract. Each sheet with a header row is a table, and types are inferred from cell values. Header text is shown exactly as written ("Patient ID") in Profile, Dictionary, ER and answers; the normalised identifier (`patient_id`) is used only in SQL.
- Sensitivity (decision 41): a `sensitivity:<tag>` header note is a declared tag, and a detector shared by all connectors adds tags from column names and value formats. It can only add tags. Each tag records whether it was declared or inferred, and why; Profile and Dictionary show inferred tags with their reason.
- Profiling: row counts, null rates and distinct counts per column, withheld for tagged columns. Sheet relationships are inferred from a matching unique, non-null column with at least 98% coverage and are always labelled inferred.
- Questions: the validated typed intent compiles to SQL with the same compiler as PostgreSQL (now shared) and runs in an in-memory DuckDB copy inside the worker, discarded after the step. The workbook is decrypted only for that step.
- Add connector offers **Excel workbook**: name, styled file input, **Upload and test**, then the usual scope and profiling steps. Non-`.xlsx` uploads are refused before anything is stored.
- Dictionary columns now show null rates and distinct counts, and mark tagged columns "statistics withheld".
- Testbed: `testbed/excel/generate.ts` builds a four-sheet workbook (Patients, Visits, Charges, and Registrations with no header notes) from the same seeded rows as the databases; `testbed/excel/truth.ts` reads it independently into `testbed/truth.json`.

## Fixed along the way

- `group_by` accepts optional ordering and a limit (decision 40), so a single-sheet top 5 needs no join. PostgreSQL previously ordered grouped values as text.
- Cross-source comparisons failed when the model stated the difference between two sources, because the answer check forbids numbers the model computed. The difference is now computed in code and disclosed.
- A failed run now records a safe reason code on its terminal event (for example `model_answer_validation_failed`).
- The planner sometimes refused a question naming a category value ("cancelled", 2 in 20) or joined a table to itself to add a filter (2 in 40). The planning instructions now say how to use a named category and that a single condition is a filtered count; both measured 40 of 40 afterwards.
- The gap audit is one table with one row per item; `tests/unit/gap-audit.test.ts` fails on duplicates.

## Assumptions

- Decisions 40 and 41, decided by Yashaswi on 24 Nov 2026. Review of inferred tags in the Approval matrix is built with that screen in S6.
- DuckDB (`@duckdb/node-api`, MIT) runs in memory inside the worker process, as the stack in CLAUDE.md section 5 describes. It adds no service.
