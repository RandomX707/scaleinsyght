# Planner evaluation

Run in a separate worktree with the three existing local test sources. Keep
`.env` ignored. Confirm the test source credentials are current. The standard
`testbed:up` command replaces the shared test sources and may invalidate
credentials for other local tenants using them.

Recompute the reference answers with
`pnpm exec tsx testbed/eval/collect-truth.ts`. The collector reads PostgreSQL
with a read-only transaction, runs SELECTs directly on the local SQL Server,
and reads cells directly from the workbook. A null expectation means the
required data is absent. Reference SQL and workbook operations are keyed by
case ID.

Run migrations with `pnpm db:migrate:test`. Start these three processes from
the worktree root:

```sh
MODEL_DAILY_COST_CAP_USD=1.50 API_PORT=3340 PUBLIC_APP_URL=http://127.0.0.1:4290 ARTIFACT_VOLUME_PATH=.local/planner-eval-artifacts pnpm exec tsx scripts/testbed-api-main.ts
MODEL_DAILY_COST_CAP_USD=1.50 WORKER_HEALTH_PORT=3341 ARTIFACT_VOLUME_PATH=.local/planner-eval-artifacts pnpm exec tsx scripts/testbed-worker-main.ts
API_PROXY_TARGET=http://127.0.0.1:3340 pnpm --filter @scaleinsyght/web dev --host 127.0.0.1 --port 4290 --strictPort
```

`pnpm eval:planner` talks to the API on `TESTBED_API_PORT` (3340 by default). With `--warehouse`, the PostgreSQL
source is connected through `si_testbed_dw_reader` (`pnpm testbed:warehouse-login`), which also reads the dbt
`analytics` schema (staging views and marts), so table selection can be compared with and without overlapping
warehouse objects (known issue K2). `--questions=Q01,Q02,...` runs only those development questions and skips the
held-out set. Q46 to Q55 are PostgreSQL questions over objects that also exist as dbt staging views and marts.
A full 55-question run with `--warehouse` costs about USD 0.9 for one eval user, close to the default per-user daily
cap of USD 1 (`MODEL_DAILY_USER_COST_CAP_USD`); on 25 Nov the last seven questions stopped at that cap. Raise the cap on
the testbed API for full runs, or rerun the stopped questions as a fresh eval user.

Model spend is capped per day in USD per tenant and per person (decision 43); a full run costs about USD 0.05 with gpt-6-luna planning and USD 0.36 with gpt-6.2-sol, within the defaults. To compare planning models, set `MODEL_CHEAP` on the API and worker processes (planning uses the `cheap` alias). With the live gateway configured, run `pnpm eval:planner`. heldout2 is retired (it was run three times; known issue K5). heldout3 (`testbed/eval/heldout3.json`, truth from `testbed/eval/heldout3-truth.ts`) replaces it: run `pnpm eval:planner -- --set=heldout3` without changes in between for its first scores (once with and once without `--warehouse` for known issue K2), never tune against it, and keep its output aggregate only. It makes a fresh
tenant in local `si_test`, loads all three sources through the API, and runs
one case at a time. Follow-ups reuse the conversation. Scoring checks the final
turn's source identities, numeric values, group labels, and the presence of a
claim and evidence. It records the prose for inspection. An explicit
unsupported response is correct only when the reference expectation is null.
A completed answer with different data or sources is wrong. Other refusals,
validation errors, and execution errors are failed cases. The score awards one
point for a correct answer or correct refusal, subtracts one for a failed
case, and subtracts two for a wrong answer.

Latency and gateway ledger cost include every turn. Each case is checkpointed
under `results/` with its plan, claims, aggregate outputs, and available SQL.
Held-out cases are referenced by ID in reports. Their wording is submitted
only as the ordinary live question for that case and belongs only in
`heldout.json` in the branch.
