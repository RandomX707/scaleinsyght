# Planner robustness progress

Worktree is `../scaleinsyght-eval`, branch `planner-robustness`, based on
`planner-eval` at `299649d`. The application is isolated in `si_test` on
ports 3340, 3341 and 4290. The review app uses port 4284 and must be left alone.

## Step 1

Decision 42 redacts small cells in structured answers before they can leave the
worker or reach the answer writer. Redacted sources retain their query evidence
and receive a deterministic privacy statement. For a grouped result with any
small cell, the entire grouped result for that source is withheld to prevent
inference from its summaries. The eval checks both the withheld marker and
whether withholding was expected. Held-out console output is aggregate only.

Reference values from independent truth are Q04 PostgreSQL 0, Q21 SQL Server 0,
Q28 unavailable, and H08 workbook 0. Q28's executed workbook query was for the
wrong subject. It requires a planning refusal even if its count is suppressed.

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
