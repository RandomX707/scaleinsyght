# Handover, 25 Nov 2026 (evening IST)

Updated by Claude Code after #35. S7 (Codex) and S8 (Claude Code) are merged. The review app on 4284 runs `main` at `de5daa6`.

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
| #25 | bec8e94 | `SI_TEST_DATABASE` and E2E ports configurable per worktree |
| #24 | 6806471 | Codex's review feedback (merged by Claude Code after rerunning gates on the newer main) |
| #27 | 7ef50e0 | Absolute `ARTIFACT_VOLUME_PATH` required; a missing workbook file returns "Workbook file not found, upload it again"; K5 (heldout2 reuse) |
| #26 | a9d1eab | K4: FlowSpec handoff race fixed; c5 tests isolated; ID fingerprint queries no longer time out |
| #28 | f6fb67a | S8 backend: Tableau `.twb` reader and report-to-column lineage (decision 50) |
| #29 | be946bc | S8 UI: Tableau in Add connector and its card; CI prints slow query plans on contract failures |
| #30 | 7575981 | Claims never take a step whose run has ended (migration 035, claims); mixed-tenant queue test; parser wrapper stops its child |
| #31 | 5231515 | S7 saved questions, reports and exports (Codex; migration 035, saved reuse) |
| #32 | e7937d5 | K2 (not reproduced; warehouse login and Q46 to Q55) and the 5,000-table scale test with its fixes (decision 51; `docs/phases/scale-test.md`) |
| #33 | d435b7e | CI on pull requests and pushes to main only |
| #34 | adf1cfe | Agents checked when a step runs; ID and ID trace agents per tenant (migration 036, decision 52) |
| #35 | de5daa6 | heldout2 retired; heldout3 added (first runs 9/0/0/1 with and without warehouse marts); K2 closed |
| #36 | c765e00 | Handover update |
| #37, #38 | 63584bd | Dictionary spec (decision 53) and the Dictionary rebuild: stored scrubbed definitions (migration 037), lazy Dictionary API and page, HTML export, ER neighbourhood; `docs/phases/dictionary-rebuild.md` section 5 |

## Review app on 4284 and riverside-health

- **4284 runs `main` at `63584bd`** (redeployed 25 Nov, about 22:00 IST) from `../scaleinsyght-review` (detached): API 3000, worker 3001, web 4284, sqlparse 8011, started with `nohup` by Claude Code (logs in its scratchpad). `scale_insyght` is migrated to 037; backups were taken before the 035, 036 and 037 migrations (Claude Code's scratchpad). Riverside-health's procedure and view SQL appears in the Dictionary after its next profile or nightly refresh, which captures definitions. Riverside-health now has its ID and ID trace agents. Its workbook refresh and ID trace (3 systems) were checked by running the same code; a browser check needs the riverside-health password.
- **riverside-health password:** Yashaswi's password (`yashaswi@riverside-health.test`) was reset with `pnpm tenant:reset-password` at about 06:40 IST and given to Yashaswi once in the chat at handover. It is not in the repo. If it is lost, reset it again with the same command.
- **riverside-health sources:** PostgreSQL (`pgs`) and SQL Server (`sql`) were already connected by Yashaswi; the Operations workbook was added through Add connector, and PostgreSQL and SQL Server were re-profiled so display labels work. No dbt project, no Tableau and no nightly refresh have been run there yet (`profiler.nightly_schedules` is backfilled by migration 032 when 4284 is migrated). Drafts Yashaswi created were left alone.
- `../scaleinsyght/.env` was changed: `MODEL_DAILY_COST_CAP_USD=5`, `MODEL_DAILY_USER_COST_CAP_USD=1`, token cap removed (backup in my scratchpad as `main-env-backup`).

## S7 state

- Rebased `s7-saved-exports` on main through PR #29. Restored the merged review and Tableau UI while retaining S7 additions.
- Reports now submits a saved question for review. The S7 walkthrough uses Reports and Approval matrix to submit, approve, save, run, export and schedule.
- Failed count queries produce an unavailable count and cannot trigger a row-count change. Added a PostgreSQL slow-view regression.
- The slow-view regression passed on si_test. The browser walkthrough initially lacked a declared JSZip dependency. Added the already locked version and restarted the walkthrough.
- PR #31 is open. S7 browser walkthrough passed, including second-person approval, PDF download and scheduler dispatch. Lint, typecheck, unit, SQL parser, golden eval, integration, 108 contracts and 12 E2E tests passed. All three consecutive testbed passes cleared 24 data tests and nine browser cases each. The capped live evaluation is running in session 56781 with aggregate-only held-out output in /tmp/s7-live-eval.log. Merge and the 4284 redeployment remain gated on the live results and CI.
- After S7 merges, add tests and fixes for Approval matrix tab counts and default selection, snapshot-based change totals, separate warning and neutral counts, field-specific ID evidence checked against S5 truth, and deduplicated evidence sentences.

## Open problems and known issues

- `docs/known-issues.md`: K1 fixed; K2 closed, not reproduced (development and heldout3 score the same with and without dbt marts); K3 open; K4 partly fixed (an intermittent `c2_postgres_connection_credentials` timeout was seen once in CI after the fix; CI now prints slow plans when contracts fail); K5 heldout2 retired; K6 two conditions on one table is not a supported query shape (Q52).
- The testbed's `pnpm test:testbed` now runs `pnpm testbed:dbt` first, which rebuilds the dbt `analytics` and `billing` schemas in `si_testbed_pg` and revokes the read-only login's access to them.
- Running anything against `si_test` while another suite is using it breaks both. Each worktree can set `SI_TEST_DATABASE` (Claude Code uses `si_test_cc`) and its own ports (Claude Code: API 3350, worker 3351, web 4295, parser 8031).
- **Migrations:** `main` has two 035s (`035_claims_need_an_active_run`, `035_saved_reuse`); both are applied on `scale_insyght`, so neither may be renamed. The next migration is 038 (037 is the Dictionary). Migrations cannot see tenant rows (row security is forced even for the owner): 036 shows how to backfill with policies for the migration role that live only inside its transaction. 032's backfill of nightly schedules inserted nothing for this reason.
- Every worktree's `.env` sets `ARTIFACT_VOLUME_PATH=/Users/yashaswiram/.scaleinsyght/artifacts`.
- The model ledger (`core.model_usage`) lives in the test databases, which the gates reset, so spend has to be tracked from run logs (queue item 5 fixes this). 25 Nov: measured in `si_test_cc` about USD 0.3 per full testbed walkthrough run (S1 to S9 ask questions; the Dictionary itself uses no model); `si_test` showed USD 1.43 when checked.
- The testbed walkthroughs all honour `SI_TEST_DATABASE` now; S7 used to write to `si_test` regardless (two S7 tenants were added to `si_test` on 25 Nov before this was fixed; nothing was reset).
- Worktrees: `../scaleinsyght-review` serves 4284; `../scaleinsyght-cc` and `../scaleinsyght-cc-s8` are Claude Code's; `../scaleinsyght-chat` (S7, merged) and `../scaleinsyght-eval` are Codex's. Orphaned SQL parsers from before #30 may still hold ports 8032 and 8033 (in the chat and eval worktrees); `startSqlParser` treats any server on its port as its own, so stop them before relying on those ports.

## Claude Code queue (in the user's order)

1. Done: K4 follow-ups, K2 and the scale test, CI triggers, agents at execution, heldout3.
2. Done: **Dictionary rebuild** and the ER explorer at scale (above; Dictionary 633 ms and 14.5 KB, ER 739 ms and 40 KB on 5,000 tables).
3. **K6**: counts with two or more conditions on one table; development set only.
4. **Migration safety**: data backfills per tenant with the tenant setting, or through a reviewed function, and a check that fails loudly when a backfill that should change rows changes none.
5. **Model-spend ledger** kept where test resets don't wipe it, so the daily total is measured.
6. **Home chat spec and build** (moved from Codex): conversational layout; code picks sentence, small table (2 to 5 values), chart (6 to 20 groups), compact table with Show all (over 20 rows), flow diagram for lineage, or explanation plus a safe alternative for a refusal; never a chart and a full table by default; one collapsed "SQL, sources and lineage" drawer; plan collapsed after completion; follow-ups change the form without rerunning; screenshots and a walkthrough per rule.
7. From the scale test, still open: per-table profiling time and planner pre-model catalog reads.

## Codex continuation

- Review restarted from origin/main `849255f` in the separate `../scaleinsyght-review` worktree. Frozen install and local migration 032 succeeded. The main checkout was left alone.
- Riverside dbt import and nightly refresh need an authenticated product session. Password unchanged.
- Today's model cap is USD 30, with USD 12.91 already spent at handover. No model calls were made during the restart.
- Resume with the Riverside import and nightly refresh, then K2, K4, S7, S8 and the fidelity pass.
- Riverside login verified through port 4284. Imported the testbed dbt project through the product API and ran nightly refresh on both databases. SQL Server produced four findings and PostgreSQL eleven, including seven ID matches. Workbook refresh returned HTTP 500 because the copied environment used a relative artifact path and the new worktree volume lacked ciphertext. Copied only Riverside’s encrypted test workbook to the configured review volume. The product retry returned HTTP 200, profiled four sheets, and wrote 21 findings. The amended S3 walkthrough, including an Excel nightly refresh and its findings, passed.
- Seven review fixes requested before S7. The first is on branch `review-feedback` at `/tmp/scaleinsyght-review-feedback`, commit `4f9f8bf`. Active runs show progress instead of cards. Three status tests and typecheck passed. Remaining review fixes cover privacy refusals, groupable schema options and one-call refusal, attempt summaries, grouped prose, result headers and hidden keys, and notification names and menu duplication.
- Review feedback checkpoint `7afb4ff`. Grouping schema excludes tagged columns. A validated privacy refusal terminates the planning loop before repair or verification. All 22 structured planner unit tests and typecheck passed. Commit `723e5c0` adds the refusal card, attempt summaries, admin technical toggle, grouped answer and table presentation, named discovery notifications and menu cleanup. Lint, typecheck and summary unit test passed. The exact-question one-call unit regression passed in `f1ceb5a`. Unit, SQL parser, integration and contracts passed. A legacy browser test still expected the gateway controls; `87e50b0` checks the requested hidden state while the gateway contract tests continue exercising enrollment. All 12 E2E tests passed. Initial testbed passed 22 data checks and 6 of 7 browser cases; S1 still expected the removed planning card, corrected by `ea6d283`. S4 verified the new dbt card. Exact-question live refusal assertion added to S2 in `82fad36`, and group ranking copy now checks executed ordering in `72916cd`. All three consecutive testbed passes succeeded, each with 22 data checks and seven browser cases (logs /tmp/si-review-testbed-{1,2,3}.log). PR #24 is open. Latest review-feedback commit `d4766e0` only changes evaluation scoring for expected privacy refusals. Capped live evaluation is running in session 89195 (aggregate-only held-out output in /tmp/si-review-eval.log). Merge and redeploy remain pending.

### Additional review-feedback acceptance cases

- Commit `fba874c` joins both ID match endpoints to their connections and records the scheduled refresh flag in migration 033. Source formatting unit test passed. The updated manual refresh walkthrough and local database migration still need execution.
- Commit `8f0fbad` aligns both counts and moves the review note above the rows. Finding wording has a passing unit test. Browser coverage is pending.
- Commit `8f0fbad` adds Changes and Suggestions tabs and Approve all for the visible group. The classification unit test passed. Verify group scoping and audit records through the browser.
- Commit `7943de2` shows “Origin unclear” because matching values do not establish direction. Names have dot breakpoints and tooltips. A render test for equal coverage passed. Browser layout verification is pending.
- Commit `8b6945f` reserves separate space for badges and routes edges through lane gutters. Both path tests passed. Browser coverage for badge clipping and the full merge gates are pending.
- Connectors feedback: review-feedback commit `79ecdb8` shows specific connector type labels and hides gateway controls. Typecheck passed and the S4 walkthrough has regression assertions awaiting execution. Commit `bb4f5a2` adds the dedicated dbt card and import summary (migration 034), with re-upload to the existing connection. After redeploy, re-import the same artifacts into Riverside’s existing dbt connection to populate the summary. S4 browser assertions are pending.
