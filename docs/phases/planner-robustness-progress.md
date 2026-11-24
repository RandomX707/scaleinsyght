# Planner robustness progress

Worktree is `../scaleinsyght-eval`, branch `planner-robustness`, based on
`planner-eval` at `299649d`. The application is isolated in `si_test` on
ports 3340, 3341 and 4290. The review app uses port 4284 and must be left alone.

## Step 1

Decision 42 shows zero and withholds only counts from 1 through 10. Grouped
answers show every group cell, using “<11” for small cells and omitting group
summaries and charts when any cell is hidden. Nonsensitive equality filters
resolve case against source categories. When a category is absent, the answer
lists the source categories from a bounded read-only query.

The original zeros were real. The seeded order statuses are completed, placed
and cancelled. Q04 and Q21 now use placed (359 each). H08's independent truth
is now 529. Q28 remains unavailable and requires a planning refusal.

Baseline scores remain the latest measured values. Questions 23/30 acceptable
(19 correct, 4 correct refusals, 2 wrong, 5 failed). Held-out 9/10 acceptable
(8 correct, 1 correct refusal, 0 wrong, 1 failed). The post-change full eval is
pending. Typecheck and the focused analytic executor unit test are the local
checks for this checkpoint.

## Next

Step 2 adds catalog-constrained schema planning, two validation repairs,
attempt provenance, subject grounding, and correct count and date semantics.
Then move planning into the durable runner (step 3), compare both models
(step 4), and verify gates and three consecutive testbed runs (step 5).

The stock testbed setup rotates credentials and rebuilds shared sources. Do
not run it against the review app's sources. Before the three full testbed
runs, isolate the source setup or arrange a safe path with the user. Do not
read held-out wording or turn-level outputs for tuning.

## Step 2 checkpoint

The API now supplies a strict catalog-derived JSON response schema, including
source, table, qualified columns, original headers, valid join pairs, and
operators. It decodes the response into the existing typed intent, tries up to
two repairs when decoding or validation fails, and records attempts for accepted
plans. It also supports inclusive-start, exclusive-end same-column date
filters on all three connectors. Refusal for absent subjects is currently
instructed in the planner. Its live reliability has yet to be measured.

The baseline is still the latest full evaluation. Run the live evaluation after
the async changes. Check refusal reliability and provenance for terminal
planning refusals in the durable planning work.

## Step 3 checkpoint

Live POST /api/runs now writes a planning request and a pending runner step in
one transaction, then returns the run ID. The worker claims that step through
the existing lease and fencing mechanism. Successful planning attaches the
plan and schedules query steps inside the fenced transaction. Refusal and
source choice are terminal outcomes with a safe reason and attempt provenance.
Home polls for Planning, Querying, and Writing answer, and source choice now
arrives after submission. Browser POST timeouts are back to 15 seconds.

Migration 027 was applied only to si_test. A live smoke query went from the
async POST through hosted planning, PostgreSQL query and answer composition.
The first batch attempt exposed mixed uuid/text inference on the planning-step
INSERT and never reached the model. The cast is fixed and the smoke query
passed after that fix. The full two-model results and gates are still pending.

## Step 4 in progress

A diagnostic Luna run after the async change scored 27/30 acceptable on
development (23 correct, 4 correct refusals, 1 wrong, 2 failed) and 10/10
acceptable on held-out. The development failures showed that the disclosure
scrubber treated title-cased exact workbook headers as names. Catalog-matched
headers now reach the planner in lowercase with the original label in the
schema. A direct named count now requires its subject to exist in the catalog
or tenant glossary. Targeted development verification passed Q12 and Q15 and
correctly refused Q28. The complete comparison is running on both models.

The testbed command now reuses initialized sources. SQL Server writer-refusal
tests use a disposable writer rather than granting write access to the
shared reader. The four SQL Server connector contract cases passed. Local
lint, typecheck, SQL parsing and golden evaluation also passed at prior
checkpoints. Three full testbed gates and PR/CI are still pending.

A later Luna diagnostic had 27/30 acceptable on development and 9/10 on
held-out, with 2 and 1 wrong respectively. Only the development failures were
inspected. The subject guard now separates source qualifiers from the subject
and rejects a dimension-table count when the named fact table is present.
Q21 now explicitly says “status placed” to distinguish the lifecycle state
from the act of placing any order. A status count must retain that filter.
The live development check passed Q09, Q16 and Q21. Both full comparisons
have restarted with this version. Local dbt compile and SQL parser tests
passed with Python 3.11, matching CI.
