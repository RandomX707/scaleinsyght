# Phase 5 — Saved questions and reports

**Status:** approved by agent, pending review.

## Outcome and scope

Deliver the Phase 5 outcome in system design §2.5: a person can reuse an accepted question as the starting point for a related investigation, and export an evidence pack whose figures exactly match its completed run. Add governed report definitions and scheduled runs of already approved governed agents. Exports contain only the aggregate answer, cited evidence and safe plan metadata; they never serialize raw source rows, restricted fields, credentials or identifier values.

All demo journeys use `tests/golden/` and native PostgreSQL. Scheduling uses the existing worker process and PostgreSQL queue; no new service or external account is introduced. Decisions 33 and 34 in `docs/decisions.md` record the reversible defaults for daily UTC schedules and personal lexical saved-question matching.

## Routes

| Route | Behavior | Contract |
|---|---|---|
| `GET /api/me/saved-questions` | List the authenticated person's accepted saved questions and immutable source plan summaries | 1 (tenant/person isolation), 3 (validated plans) |
| `POST /api/me/saved-questions/:planId/start` | Start a new run from the person's saved plan after rechecking current source authorization and plan validity | 1, 3, 5 |
| `DELETE /api/me/saved-questions/:planId` | Remove the plan from the authenticated person's memory | 1 |
| `POST /api/runs/:runId/evidence-pack` | Build/download a reproducible safe evidence pack in PDF, XLSX or PPTX for a completed run | 1, 4 (evidence), 7 (disclosure boundary) |
| `GET /api/me/reports` | List the person's governed report definitions | 1, 4 |
| `POST /api/me/reports` | Create a draft report bound to an approved governed definition version and output format | 1, 3, 5 |
| `POST /api/me/reports/:reportId/run` | Execute the pinned approved version and persist a report snapshot | 1, 3, 4, 5 |
| `GET /api/me/reports/:reportId/exports/:format` | Export a persisted report snapshot as PDF, XLSX or PPTX | 1, 4, 7 |
| `POST /api/me/schedules` | Create or update a daily UTC schedule for an approved governed definition version | 1, 3, 5 |
| `DELETE /api/me/schedules/:scheduleId` | Disable a schedule; never deletes run or report history | 1, 5 |

All routes require a verified session. Writes are tenant scoped and owner scoped where personal. The saved-question start route reauthorizes sources and validates the pinned plan rather than trusting browser state. Report and schedule routes bind to an exact immutable governed version; every scheduled execution rechecks approval, entitlement, source state and READ-only capability before creating a run.

## Tables

New tenant-owned tables use `tenant_id`, `ENABLE ROW LEVEL SECURITY`, `FORCE ROW LEVEL SECURITY`, a tenant policy, and `si_migrate` ownership; runtime roles own nothing.

| Table | Purpose and key constraints | Contract |
|---|---|---|
| `reports.definitions` | Owner, name, governed definition id/version, format, active state; immutable version reference | 1, 3, 5 |
| `reports.snapshots` | Run id, safe answer/evidence envelope, plan hash, exact figure payload hash, creation time; append-only | 1, 4, 5, 7 |
| `reports.schedules` | Owner, governed id/version, UTC time, next/last slot, enabled | 1, 3, 5 |
| `reports.schedule_slots` | Durable tenant/schedule/UTC-slot key, deterministic run id, pending/started/skipped state and safe revocation reason | 1, 3, 5 |
| `reports.export_events` | Append-only safe export metadata: snapshot, format, artifact hash, actor and timestamp | 1, 4, 5, 7 |

Saved question membership stays in the existing owner-only `registry.personal_memories.saved_plan_ids`; plans remain immutable in `runs.analytic_plans`. No result rows or raw identifiers enter personal memory or report snapshots.

## Events

Append-only `runs.events` use the existing per-run sequence and safe payload rules (Contract 5):

- `saved_question_started`: saved plan id and new run id.
- `report_run_created` / `report_snapshot_created`: report id, exact governed version, run id and snapshot hash.
- `scheduled_run_enqueued`: schedule id, exact version and UTC slot; no question text or result values.
- `evidence_pack_exported`: snapshot id, format and content hash.

No event contains answer rows, identifier values, credentials or unrestricted SQL.

## UI

- **My agent:** accepted-answer list with question, save time, Start from this plan and Remove actions; related saved questions are suggested using only that person's saved questions.
- **Reports:** list/create/run governed reports, show the pinned version and latest snapshot, download PDF/XLSX/PPTX, and configure/disable a daily UTC schedule.
- **Run answer:** export evidence pack controls appear only after a completed run; each pack carries the exact displayed figures, claims, evidence references and plan hash.
- **Accessibility:** keyboard reachable controls, visible focus, named icon buttons, status/error announcements; colour is not the only signal.

## Acceptance tests

| Named test case | Acceptance | Contract |
|---|---|---|
| `c1_saved_questions_are_private_deletable_and_revalidated_before_reuse` | Only the run owner sees a saved question; deletion removes it; reuse rechecks source authorization and starts a new run from the immutable plan | 1, 3, 5 |
| `c4_evidence_pack_{pdf,xlsx,pptx}_reproduces_safe_run_figures` | Each format contains the completed run's aggregate figures and evidence references and creates an export audit row | 4 |
| `c7_evidence_pack_rejects_identifier_values_in_cited_summaries` | Email, identifier-like values and credential-like values in claims, summaries or locators are rejected before rendering | 7 |
| `c5_daily_schedule_claim_dispatches_at_most_once_per_utc_slot` | A pending slot survives retry with the same deterministic run id; run events are idempotent; revoked entitlement is recorded as a safe skipped slot | 3, 5 |
| `c1_scheduled_report_checks_owner_and_tenant` | Schedule list, update and disable are isolated by tenant and owner | 1 |
| `c4_report_export_requires_evidence_backed_snapshot` | Draft, failed or unsupported report exports are rejected; completed report output cites its run evidence | 4 |
| `c1_saved_question_requires_accepted_answer_and_can_be_reused_or_removed` | Browser flow saves only useful feedback, reuses the plan, and removes it from the owner's list | 1, 3, 5 |
| `c5_governed_report_exports_evidence_and_has_an_owner_scoped_daily_schedule` | Browser flow separates owner/reviewer approval, exports a completed snapshot, and creates/disables a UTC schedule | 1, 3, 4, 5, 7 |
| `c6_graph_benchmark_stays_below_one_second_p95` | 50 random depth-four traversals on the 100k synthetic graph stay below 1 second p95, retaining Decision 9 | 6 |

