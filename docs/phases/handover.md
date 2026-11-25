# Handover, 25 Nov 2026 (13:45 IST)

Stopped at Yashaswi's request after S6 merged. S7 is saved as work in progress on its branch. Nothing else is running.

## Merged to `main` today

| PR | Merge | What it does |
|---|---|---|
| #17 | 465f5cb | Planner robustness: async planning, declared intent plus a verification call, Sol planning (decision 44), USD budget caps (decision 43). Q31 logged as known issue K1 |
| #18 | 5fd856d | Chat threads: one thread per chat, idempotent sends by request id, Recent conversations |
| #19 | b108015 | Display labels for key columns, chosen by code from profile facts (decision 45); column statistics for PostgreSQL and SQL Server; `pnpm tenant:reset-password` |
| #20 | 5f1930b | ER "Show possible relationships" toggle (decision 38 addition); column statistics versioned with each field |
| #21 | d17611c | S4 lineage: parsed view SQL, dbt artifact upload, Lineage graph screen, lineage questions in chat (decision 46) |
| #22 | f0570d7 | S5 ID agent and ID trace screen (decision 47) |
| #23 | 849255f | S6 nightly refresh, findings, audited tag review, Approval matrix findings (decision 48); connector pools survive closed connections |

So **#17 and #18 are both merged.**

## Review app on 4284 and riverside-health

- **4284 does not run the latest `main`.** It runs 5f1930b (after #20), started from the main checkout (`../scaleinsyght`) with API 3000, worker 3001, web 4284 and sqlparse 8011; `scale_insyght` was migrated to 031. To bring it to 849255f: in `../scaleinsyght` run `git pull --ff-only`, `pnpm install`, `pnpm db:migrate` (adds 032), then restart the four processes. The script I used is `restart-review.sh` in my scratchpad (not in the repo); its steps are those four plus starting `apps/api/src/main.ts`, `apps/worker/src/main.ts`, the web dev server on 4284 and `pnpm dev:sqlparse`. Until it restarts, 4284 also lacks the pool fix from #23, so a source database that drops connections can crash its API.
- **riverside-health password:** Yashaswi's password (`yashaswi@riverside-health.test`) was reset with `pnpm tenant:reset-password` at about 06:40 IST and given to Yashaswi once in the chat at handover. It is not in the repo. If it is lost, reset it again with the same command.
- **riverside-health sources:** PostgreSQL (`pgs`) and SQL Server (`sql`) were already connected by Yashaswi; the Operations workbook was added through Add connector, and PostgreSQL and SQL Server were re-profiled so display labels work. No dbt project, no Tableau and no nightly refresh have been run there yet (`profiler.nightly_schedules` is backfilled by migration 032 when 4284 is migrated). Drafts Yashaswi created were left alone.
- `../scaleinsyght/.env` was changed: `MODEL_DAILY_COST_CAP_USD=5`, `MODEL_DAILY_USER_COST_CAP_USD=1`, token cap removed (backup in my scratchpad as `main-env-backup`).

## S7 state (branch `s7-saved-exports`, commit 4323e76, WIP, no PR)

Base: `s6-nightly` before its final lockfile and resilience commits. **First merge `origin/main` into it and run `pnpm install`.** Decision 49 is drafted in `docs/decisions.md` on the branch.

Done (written and typechecked, lint clean; not yet run against si_test):
- Save from a thumbs up: `POST /api/runs/:runId/save` (`apps/api/src/server.ts`); "Save this question" button after Useful (`apps/web/src/main.tsx`, `saveQuestion`).
- Starting from a saved question reuses its typed steps (query intents or lineage requests) with no model call, in a new conversation (`/api/me/saved-questions/:planId/start`); My agent navigates to `/conversations/:id`. Previously it built a plan with no typed steps that no real source could run.
- Governed draft from a saved question: `POST /api/governed-agents` with `planId` pins the saved typed steps (same bug as above, fixed for this path only).
- Evidence packs include the question and every group row (withheld cells stay `<11`) and lineage links: `packages/reports/src/index.ts` (`figureLines`, `safeEvidencePack`, PDF, XLSX, PPTX).
- Dictionary export: `packages/reports/src/dictionary.ts` (Markdown and Word via jszip), route `GET /api/connections/:connectionId/dictionary/export?format=markdown|docx` (shares `DICTIONARY_SQL` with the dictionary route), buttons Export Markdown, Export Word (.docx) and Copy on the Dictionary page; `jszip` added to `packages/reports/package.json`.
- Test helper to open exports: `tests/support/document-text.ts` (PDF text from pdfkit streams, XLSX rows, PPTX and DOCX text).
- Walkthrough written: `tests/e2e/real-product-s7-saved-exports.spec.ts` (ask, save, three exports checked against `testbed/truth.json`, reuse with zero model calls, governed report approved by a second person, run, export, scheduled run, Dictionary Markdown and Word).

Half-done:
- The walkthrough has never run; expect fixes (selectors, the second user's entitlements, scheduler timing). The scheduled run depends on the testbed worker's `dispatchDueSchedule` picking up `reports.schedules` within 90 seconds.
- `tests/contracts/c1_saved_questions_reports.test.ts` and `c2_governed_agent.test.ts` may expect the old start and draft behaviour; run `pnpm test:contracts`.
- No UI yet to make a governed agent from a saved question (API only); the Reports page was not reviewed against the prototype.

Not started:
- Gap audit row "Saved questions, reports, exports and evidence packs" (still Missing until the walkthrough passes).
- Eval questions for S7 (none needed unless planning changes).
- S8 (Tableau `.twb` reader and upload, Power BI `.pbit` reader that stays Missing without a real file, Snowflake skipped: no `SNOWFLAKE_*` in `.env`), Part 3 prototype fidelity, Part 4 final check, and updating `docs/overnight-report.md` for today.

## Open problems and known issues

- `docs/known-issues.md` on `main`: K1 (Q31 summary view, fixed by #19), K2 (held-out planner refusals when a PostgreSQL source exposes dbt staging views and marts; the testbed now hides the `analytics` schema from the product login; undiagnosed because held-out questions are not read), K3 (one held-out run failed instead of refusing on S4; later full evals were back to 9 correct and 1 refused), K4 (flaky `c8_single_use_grant_race_delivers_exactly_once`). Also seen once and passing on rerun: `c5_racing_workers_claim_step_once_and_fence_completion`.
- The testbed's `pnpm test:testbed` now runs `pnpm testbed:dbt` first, which rebuilds the dbt `analytics` and `billing` schemas in `si_testbed_pg` and revokes the read-only login's access to them.
- Running anything against `si_test` while another suite is using it breaks both (one collision today). Run suites one at a time.
- Model spend today: USD 12.91 of the USD 20 cap.
- Worktrees: `../scaleinsyght-eval` is on `s6-nightly` (merged); `../scaleinsyght-chat` is on `s7-saved-exports`. Testbed ports 3340, 3341, 4290 and parser 8021; eval parser 8041.

## Codex continuation

- Review restarted from origin/main `849255f` in the separate `../scaleinsyght-review` worktree. Frozen install and local migration 032 succeeded. The main checkout was left alone.
- Riverside dbt import and nightly refresh need an authenticated product session. Password unchanged.
- Today's model cap is USD 30, with USD 12.91 already spent at handover. No model calls were made during the restart.
- Resume with the Riverside import and nightly refresh, then K2, K4, S7, S8 and the fidelity pass.
- Riverside login verified through port 4284. Imported the testbed dbt project through the product API and ran nightly refresh on both databases. SQL Server produced four findings and PostgreSQL eleven, including seven ID matches. Workbook refresh returned HTTP 500 after relocating the app. Check the encrypted artifact volume path before retrying.
- Seven review fixes requested before S7. The first is on branch `review-feedback` at `/tmp/scaleinsyght-review-feedback`, commit `4f9f8bf`. Active runs show progress instead of cards. Three status tests and typecheck passed. Remaining review fixes cover privacy refusals, groupable schema options and one-call refusal, attempt summaries, grouped prose, result headers and hidden keys, and notification names and menu duplication.
- Review feedback checkpoint `7afb4ff`. Grouping schema excludes tagged columns. A validated privacy refusal terminates the planning loop before repair or verification. All 22 structured planner unit tests and typecheck passed. Still need the one-call end-to-end assertion, the refusal card and summaries, result and notification fixes, and the Excel nightly regression. No redeployment or new model spend.
