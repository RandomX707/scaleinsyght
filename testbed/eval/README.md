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
MODEL_DAILY_COST_CAP_USD=1.50 MODEL_DAILY_TOKEN_CAP=3000000 API_PORT=3340 PUBLIC_APP_URL=http://127.0.0.1:4290 ARTIFACT_VOLUME_PATH=.local/planner-eval-artifacts pnpm exec tsx scripts/testbed-api-main.ts
MODEL_DAILY_COST_CAP_USD=1.50 MODEL_DAILY_TOKEN_CAP=3000000 WORKER_HEALTH_PORT=3341 ARTIFACT_VOLUME_PATH=.local/planner-eval-artifacts pnpm exec tsx scripts/testbed-worker-main.ts
API_PROXY_TARGET=http://127.0.0.1:3340 pnpm --filter @scaleinsyght/web dev --host 127.0.0.1 --port 4290 --strictPort
```

The default daily token cap (100,000 per tenant) runs out after about 20 cases, which then fail with `model_budget_daily_cap_reached`; raise it for the evaluation processes as shown. To compare planning models, set `MODEL_CHEAP` on the API and worker processes (planning uses the `cheap` alias); for the larger model raise `MODEL_DAILY_COST_CAP_USD` too. With the live gateway configured, run `pnpm eval:planner`. Run `pnpm eval:planner --set=heldout2` only once, after tuning is finished. It makes a fresh
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
