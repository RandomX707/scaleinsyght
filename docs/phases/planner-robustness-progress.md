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

## Step 3: done

POST /api/runs writes a planning request and a pending runner step in one
transaction and returns the run ID; the worker plans under the existing lease
and fencing. Refusal and source choice are terminal outcomes with a safe reason
and attempt provenance. The conversation view includes runs still planning, and
the thread row is locked and titled when its first run is queued. Home shows
Planning, Querying <source> and Writing answer from a tested label function
(`packages/ui/tests/run-status.test.ts`). The S1 walkthrough checks that the
POST returns within 3 seconds and the card shows Planning before the answer.
Browser POST waits are back to 15 seconds. Migration 027 is applied to si_test
only.

## Step 4: done

Full evaluation on revision `59692f6`, both sets, planning model switched with
`MODEL_CHEAP` on the eval API and worker only (the answer model is
gpt-6.2-sol in both). Held-out results are aggregates only.

| Planning model | Set | Correct | Refused correctly | Wrong | Failed | Avg latency | Avg cost per question |
|---|---|---|---|---|---|---|---|
| gpt-6-luna | questions (30) | 25 | 5 | 0 | 0 | 5.6 s | USD 0.0013 |
| gpt-6-luna | held-out (10) | 9 | 1 | 0 | 0 | 6.3 s | USD 0.0014 |
| gpt-6.2-sol | questions (30) | 25 | 5 | 0 | 0 | 5.7 s | USD 0.0087 |
| gpt-6.2-sol | held-out (10) | 9 | 1 | 0 | 0 | 6.4 s | USD 0.0096 |

Both models meet the targets with identical scores; gpt-6-luna is about seven
times cheaper at the same latency, so planning stays on the `cheap` alias. An
earlier attempt failed from Q22 onward with `model_budget_daily_cap_reached`:
the 100,000-token tenant cap ran out at about 3,500 tokens per question. The
eval processes now raise it (see `testbed/eval/README.md`), and the product
limit is being replaced by daily USD caps per tenant and per user.

heldout2 (`testbed/eval/heldout2.json`, 10 new questions, truth from
`testbed/eval/heldout2-truth.ts`) was written at `dd0c192`, before this final
evaluation and after the last planner or prompt change. It is run once, after
tuning is finished.

## Next (handover, 25 Nov 2026)

Done since step 4: USD daily caps per tenant and per user (decision 43,
migration 028); count-subject guard fix and a per-group check (both to be
removed, see below); S3 walkthrough aligned with decision 42; a `planning`
gateway alias set by `MODEL_PLANNING`, defaulting to `MODEL_DEFAULT`
(migration 029, purpose `verify`). Nothing uses the alias yet.

Remaining, in order (user decisions of 25 Nov):
1. Decision 44: plan with gpt-6.2-sol through the `planning` alias (Luna via
   `MODEL_PLANNING=gpt-6-luna`); record the decision.
2. Replace question-text checks (`hasNamedCountSubject`, `namedCountSubject`,
   `asksPerGroup`, the status and sum regexes in `structured-planner.ts`) with
   declared intent: a top-level declaration (subject, grouping, conditions,
   comparison, answerable) and a per-step declaration (subject_table,
   measure, measure_column, grouping_column, filter_columns). The decoder checks
   the executable plan against them. Then a verification call (alias
   `planning`, purpose `verify`, schema {answers_question, reason}). A "no"
   triggers a repair; no accepted plan after three attempts is a refusal.
3. Add Q31 to Q40 paraphrases to `testbed/eval/questions.json` with truth.
   Run both models and confirm 0 wrong.
4. The Usage test showed a 2.00 tenant cap because the worktree `.env` still
   sets `MODEL_DAILY_COST_CAP_USD=2` (the code default is 5). Update `.env`
   files and add a unit test for the defaults.
5. Gates, three `pnpm test:testbed` runs (ports 3340, 3341, 4290), heldout2
   once (`pnpm eval:planner --set=heldout2`), noting the planner changes after
   `dd0c192`, then PR and merge.
6. chat-threads branch: client request IDs (idempotent submit), one thread per
   chat, Recent conversations cleanup, titles, bar values, plurals. Delete
   empty and duplicate riverside-health conversations. Restart 4284.
