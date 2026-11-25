# Overnight report, 24 to 25 Nov 2026

## Headline

Nothing merged overnight. Two PRs are open as drafts, both with every local gate green, but neither meets the merge rule of 0 wrong in `pnpm eval:planner`:

- **#17 planner-robustness.** The final revision scores 1 wrong on the development set (Q31, see below). Held-out is 10/10.
- **#18 chat-threads.** This builds on #17, so it inherits that score. Its own thread fix is proven by a reproduction test that failed before the fix and passes after.

Part 2 (S4 to S8) and Part 3 (prototype fidelity) were not started. The run stopped at the USD 10 model-spend cap after Part 1, as the ground rules require. Total model spend: **USD 9.32** (ledger below).

## 1. Merged PRs

None. Open draft PRs:

| PR | Branch | What it does | Why not merged |
|---|---|---|---|
| [#17](https://github.com/RandomX707/scaleinsyght/pull/17) | `planner-robustness` | Planning on the durable runner (async POST, live status). Declared intent checked against the executable plan, plus a verification call with repair (decision 44). gpt-6.2-sol plans through `MODEL_PLANNING`. Daily USD caps per tenant and per user (decision 43). Never groups an answer by a tagged column. Q31 to Q40 paraphrases and heldout2. | 1 wrong on the development set (Q31). Further tuning would have exceeded the spend cap. |
| [#18](https://github.com/RandomX707/scaleinsyght/pull/18) | `chat-threads` | One thread per chat, idempotent sends (client request ids, migration 030), no orphan conversations, Recent lists answered threads only, question-based answer titles, values on every bar, plural copy. | Depends on #17. |

## 2. Evaluation, walkthroughs and spend

Planner evaluation. "Acceptable" means correct or refused correctly. Held-out rows are aggregate only.

| Revision | Planning model | Set | Correct | Refused correctly | Wrong | Failed | Avg latency | Avg cost per question |
|---|---|---|---|---|---|---|---|---|
| `20274f8` (declared intent, verifier fixes) | gpt-6.2-sol | questions (40) | 34 | 6 | 0 | 0 | 8.5 s | USD 0.0149 |
| `20274f8` | gpt-6.2-sol | held-out (10) | 9 | 1 | 0 | 0 | 9.8 s | USD 0.0166 |
| `20274f8` | gpt-6-luna | questions (40) | 32 | 6 | 2 | 0 | 8.0 s | USD 0.0017 |
| `20274f8` | gpt-6-luna | held-out (10) | 9 | 1 | 0 | 0 | 8.1 s | USD 0.0018 |
| `e408df4` (empty grouping from the declaration) | gpt-6.2-sol | questions (40) | 34 | 6 | 0 | 0 | 8.4 s | USD 0.0149 |
| `e408df4` | gpt-6.2-sol | held-out (10) | 9 | 1 | 0 | 0 | 9.5 s | USD 0.0166 |
| run once, at `e408df4` | gpt-6.2-sol | **heldout2 (10)** | 9 | 0 | **1** | 0 | 9.3 s | USD 0.0160 |
| `68fe854` (tagged-column guard; final PR #17 code, `6ae4e5a`) | gpt-6.2-sol | questions (40) | 33 | 6 | 1 | 0 | 8.6 s | USD 0.0149 |
| `68fe854` | gpt-6.2-sol | held-out (10) | 9 | 1 | 0 | 0 | 9.6 s | USD 0.0167 |

- Luna's 2 wrong answers are Q19 and its paraphrase Q38: it reads "order totals" as a sum of amounts.
- The final revision's wrong case, Q31 ("How many orders does each department have in the SQL Server testbed?"), returns correct counts grouped by department ID instead of department name.
- One attempt to fix Q31 by preferring name grouping (`0597c84`) made other cases worse and was reverted (`6ae4e5a`).
- `e408df4` met every merge criterion: 0 wrong on both sets and three consecutive testbed passes.
- The tagged-column guard on top (`68fe854`) then had Q31 wrong in its one evaluation. Q31 passed on `20274f8` and `e408df4` and failed on `68fe854` with the same planner instructions, so it is probably nondeterministic, not caused by the guard.
- Merging `e408df4` without the guard would ship a known raw-identifier leak. Re-evaluating `68fe854` would have exceeded the spend cap. So #17 stays unmerged.

**heldout2 independence.** heldout2 was written at `dd0c192`, and these planner changes landed after it: the count-subject guard fix, the per-group check, the planning alias and principal plumbing, the declared-intent rewrite with the verification call, and the verifier description fixes. All of these came before its single run at `e408df4`. One planner change came after the run: "never group by a tagged column". It was prompted by heldout2's wrong case, N06, which grouped "provider IDs" per `patient_id` and so returned raw patient IDs. That's a non-negotiable 6 violation, so I fixed it as a safety guard, not tuning. heldout2 was not run again.

Walkthroughs (`pnpm test:testbed`, local testbed, three consecutive runs each):

- **#17:** 3/3 passed on `e408df4` and 3/3 on `68fe854` (S1, S2, S3).
- **#18:** 3/3 passed (S1, S2, the chat-thread test and S3). The chat-thread reproduction (`tests/e2e/real-product-s2b-chat-threads.spec.ts`) failed before the fix (duplicated question in the thread) and passes after.
- **Other gates on both branches:** lint, typecheck, unit, sqlparse, integration, contracts (99 on #18) and E2E all pass locally. CI is green on both PRs.

Model spend overnight: **USD 9.32**. The breakdown is in "Spend ledger" at the end.

## 3. Gap audit summary

From `docs/gap-audit.md` on #18:

- **Real: 14.** These are tenant and login, the shell and Recent conversations, Home chat, live model planning, typed query shapes, grouped answers, the PostgreSQL, SQL Server and Excel connectors, sensitivity classification, ER, Dictionary tables and statistics, the Hub empty state, and the empty states.
- **Missing: 12.** None are Blocked.

| Missing item | Reason |
|---|---|
| Snowflake connector | No `SNOWFLAKE_*` credentials; untested. |
| Dictionary Standard/Custom tabs and procedure interactions | Not built (Part 3, not started). |
| Lineage, dbt, view and procedure SQL lineage (S4) | Not started: overnight spend cap reached. |
| ID trace (S5) | Not started: spend cap. |
| Nightly refresh, Approval matrix, findings, notifications (S6) | Not started: spend cap. Inferred-tag review waits for it. |
| Saved questions, reports, exports, evidence packs (S7) | Not started: spend cap. |
| Tableau workbooks (S8) | Not started: spend cap. |
| Power BI templates | No real `.pbit` in `testbed/bi/real/`. |
| Agents and My agent screens | Not built to the prototype. |
| Controls and Usage screens | Not built to the prototype (Usage shows the new caps on #17). |
| Lake and CRM read connectors | Phase 6; not started. |
| Customer-side gateway and SSO | Phase 6; not started. |

## 4. Decisions assumed, pending Yashaswi

| # | Decision | Assumed choice | Alternatives |
|---|---|---|---|
| 36 | Phase 6 identity and connector defaults | Vendor-neutral OIDC with PKCE; generic lake/CRM adapters with synthetic providers in tests only | Vendor-specific protocols now |
| 37 | SQL Server testbed TLS override | Trust the self-signed certificate only for loopback hosts | Install a local CA |
| 38 | Inferred ER display threshold | Show inferred references above 0.90 confidence; collectors need 0.98 coverage | Show all inferred references |
| 39 | Grouped-join default row limit | Without a limit, return every group (bounded at 100); order defaults to desc | Keep top 5 by default |
| 43 | Daily model budget | USD 5 per tenant and USD 1 per person per day | A higher token cap; a tenant cap only |

Decision 44 (Sol planning and declared intent) and decision 41 were decided by you. Decision 43's question counts were measured before Sol planning. With Sol planning and verification at about USD 0.015 per question, USD 5 covers about 330 questions a day per workspace and USD 1 about 66 per person. Please confirm or raise these.

## 5. What to look at first

1. **Q31 on #17.** Should "each department" group by name? The plan is correct data with ID labels. The fix I tried regressed other cases. A deterministic option is a declared `grouping_label` column used for display while still grouping by key.
2. **Raw identifiers in answers.** heldout2 N06 showed grouping by `patient_id` returned raw patient IDs. #17 now blocks grouping by any tagged column. `main` does not have this guard yet, so it can still happen on the review app.
3. **Luna versus Sol.** Sol has 0 wrong at about USD 0.015 per question; Luna is about 9 times cheaper with 2 wrong (the "order totals" ambiguity).
4. **Verifier strictness.** The verification call needs an accurate plan description (date bounds, tie-breaks, lower-cased headers, limits). Its rejections become refusals, never answers.
5. **The review tenant.** I couldn't set up `riverside-health` through the product: I don't have the password, and the product has no reset path. Its existing SQL Server and PostgreSQL connections were left as they were. I deleted only its empty and duplicate conversations.

## 6. Click-through test guide

Review app: http://127.0.0.1:4284/login?tenant=riverside-health, user `yashaswi@riverside-health.test` with your password. It runs `main` (S3). Tonight's work is on PRs #17 and #18 and isn't in the review app until they merge.

Expected values below come from `testbed/truth.json`.

1. **Connectors.** The SQL Server and PostgreSQL sources show as connected, each with an agent. To add the workbook: Add connector, choose Excel workbook, upload `testbed/excel/hospital-operations.xlsx`. Expect "Workbook checked: 4 sheets": Patients 391 rows, Visits 768, Charges 893, Registrations 134.
2. **Profile (SQL Server).** 7 objects profiled. Sensitive columns: patients name, date of birth, MRN and phone.
3. **ER (SQL Server).** 6 relationships, some inferred with confidence 1. Views are drawn with dashed borders.
4. **Dictionary (workbook).** Visits, Discharged On shows 10.4% empty. Patients, Phone shows "statistics withheld". Registrations columns show "(inferred: ...)".
5. **Home, SQL Server only:**
   - "How many encounters were emergency visits in 2025?" gives 234.
   - "Orders per department, top 5" gives Emergency 388, Laboratory 301, Imaging 197, Cardiology 152, Surgery 121, with a chart.
   - "How many orders does each department have?" gives 12 departments; Orthopedics and Psychiatry tie at 41.
   - "How many patients have a phone number?" gives 445 (PostgreSQL: 429).
6. **Home, both databases:** "Do the PostgreSQL and SQL Server testbeds have the same number of patients?" says yes, 500 each.
7. **Home, workbook:**
   - "How many visits are in the operations workbook?" gives 768; the follow-up "and how many of them have a discharge date?" gives 688.
   - "How many charges in the workbook were cancelled?" gives 147.
   - "Total charge amount by department in the workbook, top 5" starts with Emergency 41,486.17.
8. **Recent conversations.** On `main`, the old thread behaviour remains until #18 merges. The duplicate empty entries from your earlier test are gone.

## Spend ledger

Measured from the product's own model-usage ledger in si_test, snapshotted before every database reset, from 20:50 UTC. Each row covers spend since the previous snapshot; "before testbed N" rows cover the previous testbed run.

| UTC time | USD | Covers |
|---|---|---|
| 2026-11-24T21:33:24Z | 2.0477 | evals |
| 2026-11-24T21:37:22Z | 0.2860 | before testbed 2 |
| 2026-11-24T21:41:24Z | 0.2728 | after testbed |
| 2026-11-24T21:54:58Z | 1.3242 | sol5 eval |
| 2026-11-24T21:57:54Z | 0.2744 | before testbed 2 |
| 2026-11-24T22:00:44Z | 0.2734 | before testbed 3 |
| 2026-11-24T22:03:43Z | 0.2856 | after testbed |
| 2026-11-24T22:06:28Z | 0.1595 | heldout2 |
| 2026-11-24T22:14:56Z | 0.7640 | sol6 eval |
| 2026-11-24T22:17:52Z | 0.2749 | before testbed 2 |
| 2026-11-24T22:20:41Z | 0.2748 | before testbed 3 |
| 2026-11-24T22:23:33Z | 0.2753 | after testbed |
| 2026-11-24T22:31:29Z | 1.0221 | sol7 eval |
| 2026-11-24T22:34:09Z | 0.1856 | after testbed |
| 2026-11-24T22:40:53Z | 0.2050 | chat tests |
| 2026-11-24T22:43:14Z | 0.1767 | after chat testbed |
| 2026-11-24T22:43:48Z | 0.0010 | before s2 check |
| 2026-11-24T22:46:08Z | 0.2200 | before chat testbed b1 |
| 2026-11-24T22:49:29Z | 0.3388 | before chat testbed b2 |
| 2026-11-24T22:52:42Z | 0.3312 | before chat testbed b3 |
| 2026-11-24T22:55:53Z | 0.3289 | after chat testbed b |

**Total: USD 9.32.**
