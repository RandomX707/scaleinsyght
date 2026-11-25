# Controls

Status: built 25 Nov 2026 on `controls-finish` (Claude Code), from Codex's `controls-prototype` WIP (`9301081`). Decision 55, assumed, pending Yashaswi; leaving scope decided by Yashaswi (keep history, marked out of scope; never delete).

## Rules

- Per connector: effective scope totals and the measured time of the last completed nightly refresh.
- Each object's scope: an exact per-object override, else the first matching ordered name rule, else its group default (object type). Scope is enforced before counts, samples or analytic queries; Controls can only narrow what the read-only login can see.
- New objects found in a nightly run: "Send to the Approval matrix" (default; listed only until approved), "Apply name rules automatically" (no match: listed only), or "Ignore until added by hand" (listed only, nothing else; a name rule can still exclude).
- Column rules: **mask** (the column is treated as tagged `personal`: never sampled, no statistics, values never sent to the model; it can still be a join key, compared inside the source) or **exclude** (not recorded or queryable).
- Changes need approval (on by default): saving creates an Approval matrix item; an approved change applies from the next refresh. A queued typed query is checked against the current scope again before any source is opened.
- Leaving scope: history is kept. Each refresh records the object by name and type with scope `exclude` and no profile; its graph assets become inactive and stay queryable for past dates (contract 6). It is not reported as a dropped table.

## The excluded-table walkthrough (it ended PARTIAL)

S10 saves "How many patients are in the PostgreSQL testbed?", excludes `public.patients` in Controls, approves it, and starts the saved question again. Codex saw the run end **PARTIAL**. That was a bug, not the right outcome:

- The run's only step was refused before any source was opened (correct), so the run produced nothing. `finalizeAnalyticRun` treated "some step did not succeed" as PARTIAL, and runs from saved questions skip answer composition, so an all-failed run was recorded as PARTIAL with an empty answer.
- Fixed: a run in which no step succeeded ends **FAILED** with the steps' reason. The scope check now has its own reason, `object_out_of_scope`, and names the objects (metadata only). The conversation says "public.patients is excluded in Controls, so it was not queried. An admin can change this in Controls." instead of the generic "I couldn't answer this question from the selected sources."

## Acceptance

- `tests/e2e/real-product-s10-controls.spec.ts`: grouped scope, an override, a name rule and a column rule; the sticky bar lists the three changes; Send for approval; approve in the Approval matrix; the saved question then fails with the plain explanation and no analytic results; a refresh records `public.patients` as excluded and skipped, and its asset becomes inactive.
- `tests/testbed/c6_scope_source_reads.test.ts`: scope is applied before any column metadata or count query on PostgreSQL.
- `tests/unit/control-scope.test.ts`: ordering of overrides, rules and group defaults, and new-object handling.
- Screens: `docs/ui/screens/controls.png` (app and prototype), differences in `docs/ui/ui-report.md`.
