# Phase 3 — Lineage, IDs and tool connectors

**Status:** approved by agent, pending review.

## Assumptions (pending Yashaswi)

- **Decision 11:** only a run event naming the specific input and output verifies that flow; reconciliation remains a separate verification value.
- **Decision 16:** store identifier field metadata, formats, SAME_AS matches and tenant-keyed fingerprints; never store raw identifier values.
- **Decision 17:** build field paths in profiler mode; inspect a specific value only on an explicit, authenticated request, transiently and without persistence or logs.
- **Decision 18:** detect every eligible identifier field; tenants can mark important business IDs for priority tracing.
- **Decision 31:** dbt manifests/catalogs and Tableau/Power BI report metadata are local synthetic fixtures; no vendor endpoints or credentials.

## Outcome and constraints

Trace a synthetic Power BI metric through Snowflake and dbt to SQL Server, showing evidence at every known hop, one honest missing hop and one disputed mapping. Trace a renamed customer identifier across three systems without retaining the identifier value. Add dbt, Tableau and Power BI metadata connectors and report links using fixtures from `tests/golden/phase3.json`. **Contracts:** C1, C2, C4, C5, C6, C7; CLAUDE.md §§3.4–3.7, 3.11, 5, 7, 10–11; design §§1.6, 2.5 Phase 3, Part 3 C6–C7.

No contract changes, graph database, external vendor connection or credential is in scope. PostgreSQL is the graph store unless the named benchmark fails its target. All tenant graph tables retain history; records are marked inactive/stale, never deleted.

Decision 9 is decided by Yashaswi: keep PostgreSQL as the graph store. The synthetic 100,000-asset depth-4 benchmark measured p95 104.7 ms across 50 random starts, below the five-second threshold. Traversal is breadth-first, querying one frontier at a time and removing previously visited assets before the next level.

## Routes

| Route | Behavior | Contract |
|---|---|---|
| `POST /api/metadata/import/:connectionId` | Import only the selected synthetic dbt manifest/catalog or BI report fixture, scoped to its active source connection; repeated imports reuse facts and report-impact events. | C1, C6 rules 2, 8–9, 15; C7 rules 1, 3, 5 |
| `GET /api/lineage` | Tenant-scoped breadth-first graph query by asset, direction, evidence method, maximum depth and optional observation date. Each level only follows edges with a matching time-valid assertion. Returns assertions, evidence, gaps and coverage together. | C1; C6 rules 1–10 |
| `GET /api/lineage/:assetId/impact` | Traverse downstream report and saved-question dependencies with evidence and depth-limited impact paths. | C1; C6; C5 |
| `GET /api/lineage/snapshots` and `GET /api/lineage/snapshots/:from/compare/:to` | List captured graph snapshots and show additions, changes, stale assertions and impacts. | C1; C6 rules 8–9, 15 |
| `POST /api/lineage/assertions/:id/review` | Accept, dispute or reject an assertion; changes review state only and records reviewer/time. | C1; C6 rules 3, 7; C8 rule 6 |
| `POST /api/lineage/assertions/:id/verify` | Record run verification only when the successful run event names the exact source and target; record reconciliation separately. | C1; C6 rules 3–7; C5 |
| `GET /api/ids` | List detected identifier fields, format, entity hint, evidence and match status; never fingerprints or values. | C1; C6 rules 12–14; C7 rules 3, 5 |
| `GET /api/ids/:assetId/path` | Return field-level ID path, rename/reformat/combine/drop steps, gaps and weakest-hop confidence. | C1; C6 rules 10, 13 |
| `POST /api/ids/:assetId/trace` | Optionally compare one explicitly supplied value to tenant-keyed fingerprints in memory; bind it as a value, return matching field/path references, then discard it. Never log or persist the value. | C1; C6 rules 12–14; C7 rules 3, 5 |
| `GET /api/reports` | List BI reports, tool, source assets, lineage coverage and safe report link. | C1; C6; C7 |

All requests derive tenant and principal from the authenticated session. Import accepts an allowlisted fixture key, not a path, SQL statement or vendor URL. **Contracts:** C1, C6, C7.

## Tables and ownership

Tenant-owned rows have `tenant_id`, `ENABLE/FORCE ROW LEVEL SECURITY`, and tenant context bound with transaction-local settings. App and worker roles own no tables and cannot bypass RLS (C1; CLAUDE.md §3.4).

| Tables | Purpose | Contract |
|---|---|---|
| Existing `graph.assets`, `graph.asset_versions` | Immutable asset identity and captured structural versions; inactive assets remain queryable historically. | C1; C6 rules 8–9, 15 |
| Existing `graph.relationships`, `graph.assertions`, `graph.evidence`, `graph.gaps` | Structural and data-flow edges stay distinct; assertion method, review and verification remain independent; every assertion cites evidence. | C1; C6 rules 1–11 |
| `graph.id_fields` | Identifier field, format pattern, entity hint, detection method, confidence and optional assertion reference. | C1; C6 rules 12–14; C7 |
| `graph.id_fingerprints` | Tenant-specific HMAC fingerprint, key version and timestamp; no raw values. | C1; C6 rule 14; C7 rules 3, 5 |
| `graph.id_path_steps` | Derived field-path order and change kind (`none`, `renamed`, `reformatted`, `combined`, `dropped`) with assertion/gap references. | C1; C6 rules 10, 13 |
| `graph.snapshots` | Snapshot references and capture time for comparison; graph rows themselves are not copied or deleted. | C1; C6 rules 8–9, 15 |
| `graph.events` | Append-only safe asset/assertion/import/impact events used for history and notices. | C1; C5; C6 rule 15; C7 |
| Existing `core.notifications` | Extend typed safe notification kinds for report/saved-question impact; no rows, values or SQL. | C1; C5; C6 rule 15; C7 |

All new tenant-owned tables require catalogue coverage and forced RLS tests. **Contracts:** C1, C5–C7.

## Events

Append-only events: `metadata_imported`, `asset_version_captured`, `assertion_proposed`, `assertion_reviewed`, `assertion_verification_changed`, `gap_detected`, `id_field_detected`, `id_match_proposed`, `id_path_updated`, `report_impacted`. Payloads carry tenant-safe asset/assertion/report references, counts and status only; no raw values, result rows, credentials or unsanitized SQL. State and event commit together. **Contracts:** C1, C5–C7.

## UI

| Screen | Behavior | Contract |
|---|---|---|
| Lineage (`/lineage`) | Cross-system lanes, table/column expansion, evidence filters, selectable edges and a side panel with evidence, review, independent verification state and transformation. Missing hops are broken links, never invented edges. | C1; C6 rules 1–11; CLAUDE.md §10.2 Lineage |
| ID trace (`/lineage/ids`) | Identifier field picker, match-rate summary, named field path and gaps; optional explicit value lookup is read-only and never retained. | C1; C6 rules 12–14; C7 |
| Impact (`/lineage/impact/:assetId`) | Downstream tables, reports and impacted saved questions with bounded path and evidence. | C1; C6; CLAUDE.md §10.2 |
| Snapshot compare (`/lineage/compare`) | Compare two captured graph states; show new, changed, inactive and stale assets/assertions and affected reports. | C1; C6 rules 8–9, 15 |
| BI reports (`/bi-reports`) | Tool name, synthetic report, underlying assets, lineage status/coverage and safe local report link. | C1; C6; CLAUDE.md §10.2 BI reports |
| Approval matrix (`/approval-matrix`) | Review inferred ID/lineage assertions. Accept/reject/dispute changes review status only; “accepted” never implies verified. Show report-impact notifications once. | C1; C5; C6 rules 3, 7, 15; C8 rule 6 |

Controls are keyboard reachable, labeled and visibly focused (CLAUDE.md §§10–11).

## Acceptance tests — named cases

| Test case | Contract / criterion |
|---|---|
| `c6_identical_source_profiles_produce_identical_versions_and_foreign_keys_never_become_lineage` | C6 rule 1 and acceptance 1 |
| `c6_accepted_inference_stays_unverified_in_api_and_lineage_ui` | C6 rules 3, 11; acceptance 2 |
| `c6_transformation_change_stales_review_and_clears_verification` | C6 rule 7 and acceptance 6 |
| `c6_golden_missing_hop_is_gap_with_no_invented_edge` | C6 rules 2, 8–10; missing-hop, temporal filter and method-filter acceptance |
| `c6_lineage_traversal_stops_at_requested_depth` | C6 rules 1, 10; bounded traversal acceptance |
| `c6_schema_drop_marks_asset_inactive_and_assertions_stale_but_preserves_history` | C6 rule 9 and acceptance 10 |
| `c6_same_identifier_fingerprints_differ_between_tenants` | C1; C6 rule 14 and acceptance 13 |
| `c6_id_path_confidence_uses_weakest_hop_and_gaps_make_it_incomplete` | C6 rules 10, 13 and acceptance 14 |
| `c6_scope_excludes_and_list_only_objects_from_profiles_and_graph_assets` | C6 rule 16; CLAUDE.md §3.11 |
| `c6_dbt_tableau_power_bi_golden_imports_create_typed_assets_events_and_report_links` | C1; C5; C6; connector, safe report link, review/verification/reconciliation, and raw-value privacy acceptance |
| `c6_importing_the_same_fixture_twice_reuses_connection_and_keeps_fact_counts_unchanged` | C1; C6 fixture connection, asset, relationship, assertion, evidence, event and snapshot idempotency |
| `c6_metadata_import_owns_only_named_fixture_assets_and_repeats_without_duplicate_facts` | C1; C6 fixture ownership and idempotency |
| `c1_phase3_graph_tables_are_tenant_scoped_and_forced_rls` | C1 acceptance 4; CLAUDE.md §3.4 |
| `c5_report_impact_notifications_use_a_typed_safe_notification_kind` | C1; C5; C7 |
| `c6_assertions_expose_temporal_validity_and_graph_events_are_append_only` | C1; C6 rule 15; C7 |
| `c6_assertions_require_evidence_and_keep_review_and_verification_independent` | C6 rules 3, 11 |
| `c6_lineage_paths_preserve_gaps_and_events_reject_non_allowlisted_types` | C6; C7 rules 3, 5 |
| `c6_postgres_depth_four_traversal_on_100k_assets_meets_five_second_p95` | Decision 9; 50 random starts, p95 under five seconds |
| `phase3_lineage_id_trace_impact_reports_and_snapshot_compare_are_keyboard_accessible` | CLAUDE.md §§10–11; C1; C6 |
| `c6_accepted_inference_stays_unverified_in_api_and_lineage_ui` | C6 rules 3, 11; acceptance 2 |

Tests use only `tests/golden/phase3.json`, native PostgreSQL 16 and the isolated `si_test` database. Required phase gates: lint, typecheck, unit, integration, contract and E2E suites. No vendor credentials or live external systems are required.

## Demo

Import the golden dbt manifest and Tableau/Power BI metadata from their separate buttons, open the Power BI report in Lineage, inspect its evidence-backed hops and the explicit missing hop, review an assertion without promoting it to verified, then open the customer ID field path and inspect its rename across the synthetic systems. Use Snapshot Compare and BI Reports to inspect graph history and safe report links.
