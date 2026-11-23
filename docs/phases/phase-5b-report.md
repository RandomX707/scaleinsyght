# Phase 5b report — Real connections

**Status:** built and verified; PR #7 awaits merge
**Branch:** `phase-5b`

## Assumptions applied

- The configured models use OpenAI standard processing rates, with no regional-processing uplift or prompt-cache discount. The local gateway prices are $0.10/$0.50 per million input/output tokens for `gpt-6-luna` and $2/$10 for `gpt-6.2-sol`.
- The synthetic hospital source and locally generated dbt manifest are sufficient for the live analytic and lineage demonstration. SQL Server, Snowflake, Tableau, and Power BI remain fixture/documentation-only for this phase.

## What was built

- A local PostgreSQL 16 hospital source containing 42,132 deterministic fake rows across patients, encounters, orders, departments, and providers. The connector uses a dedicated read-only role and runs harvest, profiling, ER inference, dictionary generation, and nightly refresh.
- A generated local dbt project and manifest imported through the metadata API. Tableau and Power BI remain fixture-backed.
- An OpenAI-compatible gateway using `.env` model configuration, contract 7 metadata disclosure, tenant-keyed identifier fingerprints, a per-tenant USD 2 daily cost cap, token cap, append-only RLS usage ledger, and Usage screen.
- A local-only `pnpm test:live` flow that exercises the synthetic analytic aggregate and API-derived dbt lineage through `gpt-6-luna` and `gpt-6.2-sol`.
- Tenant self-approval and time-zone settings, including daily and weekly schedules in tenant-local time with UTC persistence.
- A secret scanner in the pre-commit hook and CI, in addition to Gitleaks. The scanner rejects OpenAI-style values in staged files and the tracked CI working tree, including `.env.example`, without printing matches.
- SQL Server and Snowflake setup requirements in [phase-5b-vendor-prerequisites.md](phase-5b-vendor-prerequisites.md).

## Live model results

The first live run returned the correct lineage object but the harness rejected the analytic answer because it compared exact numeric substrings. That run used 325 provider-reported tokens and cost USD 0.000782. The validator now parses numeric tokens and compares numeric values; the prompt requests a JSON object without thousands separators.

The passing rerun observed analytic values `12000`, `12`, and `1000`, matching the deterministic baseline `encounter_count=12000`, `department_count=12`, and `average_per_department=1000.00`. The lineage answer named `dbt.department_monthly_encounters`. The rerun used 310 provider-reported tokens and cost USD 0.000790.

Across both attempts, the live test used 635 provider-reported tokens (427 input, 208 output) and cost USD 0.001572, well below the USD 2 daily tenant cap. No prompt or model answer is stored in the usage ledger.

## Leak check

- A non-empty `OPENAI_API_KEY` was briefly present in the local, uncommitted `.env.example` working-tree edit and was printed by an earlier local `git diff` command. It was restored to the empty placeholder before staging and was never committed.
- The audit found no OpenAI-style key pattern in any local or fetched origin commit, PR #7 diff or comments, or any of the 13 available `phase-5b` Actions logs. No Actions run needs deletion.
- The gap was that the original hook scanned staged content only, while the accidental value was an unstaged working-tree edit. CI's history scan likewise had no uncommitted working-tree content to inspect. The new scanner checks staged files in the hook and tracked working-tree files in CI; `secret_scanner_rejects_openai_style_key_in_env_example` covers a synthetic `.env.example` canary and confirms the value is not printed.
- `.env.example` contains an empty `OPENAI_API_KEY=` placeholder. `.env` remains ignored and was checked by reporting only whether the variable was set and its length.

## How to run the demo

1. Install dependencies and prepare the local native PostgreSQL environment as described in `CLAUDE.md` section 5.1.
2. Run `pnpm db:setup:sample` to seed the synthetic hospital source and `pnpm dbt:sample` to generate the local dbt manifest.
3. In the ignored `.env`, set `MODEL_CHEAP=gpt-6-luna`, `MODEL_DEFAULT=gpt-6.2-sol`, the standard model prices above, `LIVE_MODEL_TEST=1`, and a valid local `OPENAI_API_KEY`.
4. Run `pnpm test:live`. It creates an isolated synthetic tenant and reports only aggregate baselines, model names, match status, token totals, and cost.

## Verification

- `pnpm lint` — passed.
- `pnpm typecheck` — passed.
- `pnpm test` — passed, 48 tests across 15 files.
- `pnpm test:sqlparse` — passed, 3 tests.
- `pnpm test:integration` — passed.
- `pnpm test:contracts` — passed, 77 tests across 30 files.
- `pnpm test:e2e` — passed, 10 tests.
- `pnpm test:live` — passed on rerun; the initial comparison mismatch and successful fix are recorded above.
- GitHub Actions for PR #7 — green for secret scanning, lint, typecheck, unit, sqlparse, integration, contracts, and E2E.
