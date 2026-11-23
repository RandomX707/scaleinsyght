# Phase 5 report — Saved questions and reports

**Decisions — Yashaswi, 23 Nov 2026:** Decision 33 is extended in Phase 5b to tenant-local daily and weekly schedules stored as UTC instants, with tenant time zone default `Asia/Kolkata`. Decision 34 uses lexical similarity over only the signed-in person's own saved questions.

## Built

- Added owner-scoped saved-question list, reuse and removal routes. Reuse validates the immutable plan and rechecks current entitlement and source state before starting a new run.
- Added My agent saved-question UI with useful-answer feedback, reuse and removal actions.
- Added governed report definitions pinned to an exact approved version, report run routes, and immutable safe snapshots after completed runs.
- Added PDF, XLSX and PPTX evidence-pack renderers. Packs carry the completed run's aggregate figures, claims, cited evidence and plan hash; sensitive-value scanning blocks email, identifier-like and credential-like values in user-facing text before rendering.
- Added tenant/owner RLS, audit records for exports, report and schedule pages, and a database-backed schedule-slot queue. A deterministic run id makes dispatch safe to retry after a worker crash. Current authorization is checked before a run starts; revoked entitlement or approval is recorded as a safe skipped slot.
- Added isolated Phase 5 browser fixtures in `tests/golden/phase5-e2e.json`; each stateful browser journey provisions its own tenant and signs in as its own synthetic users.
- Added an optional tenant filter to worker step claims. This keeps parallel PostgreSQL contracts from consuming another test tenant's queued work while preserving the existing global production claim behavior.
- Added a 1-second p95 graph benchmark regression guard. Decision 9 remains PostgreSQL.

## Demo

Run `pnpm db:setup`, `pnpm db:migrate`, `pnpm db:seed:golden`, and `pnpm dev`; open `http://127.0.0.1:5173`. Use the synthetic owner and reviewer from one golden tenant. In **Agents**, the owner creates a governed draft and the reviewer approves that exact version in **Approval matrix**. Return as the owner, open **Reports**, save the approved definition, run it, and download its PDF, Excel or PowerPoint evidence pack. The completed snapshot and export hash are retained in PostgreSQL. The owner can also schedule a daily UTC run and disable it without deleting history.

## Verification

All local gates passed using native PostgreSQL 16 and synthetic golden fixtures:

| Gate | Result |
|---|---|
| `pnpm lint` | Passed |
| `pnpm typecheck` | Passed |
| `pnpm test` | 11 files, 38 tests passed |
| `pnpm test:sqlparse` | 3 tests passed |
| `pnpm test:integration` | 2 files, 2 tests passed |
| `pnpm test:contracts` | 28 files, 72 tests passed |
| `pnpm test:e2e` | 10 tests passed |

The graph benchmark used the same 100,000-asset golden seed and the same RLS-enabled index plan as Phases 3 and 4. The seed has average fan-out 2.100 and maximum 50; the traversal used tenant/source and tenant/destination index-only scans with the lineage assertion filter. This final run measured plan execution at 0.061 ms and, over 50 random depth-four starts, p50 103.3 ms, p95 105.8 ms and max 203.9 ms, with zero lock waits. The Phase 4 p95 of 206.5 ms was timing noise: the seed and plan did not change, and the Phase 5 p95 returned to the Phase 3 range. The 1-second regression guard passed.

## Assumptions and limits

- No real data, credentials, external systems, hosted models or additional infrastructure were used.
- Scheduled report processing uses the existing PostgreSQL worker. A revoked schedule slot keeps only a safe reason code; it does not include question text or answer values.
- The original Phase 5 implementation supported daily UTC schedules; Phase 5b owns the tenant-local daily/weekly extension and its verification.
