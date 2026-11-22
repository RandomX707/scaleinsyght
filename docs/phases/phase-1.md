# Phase 1 — Profiler mode, ER diagrams and workspace shell

**Status:** approved by agent, pending review.

## Outcome

Connect synthetic SQL Server, PostgreSQL and Snowflake sources plus an uploaded Excel workbook; create a connector agent for each successful connection; select scope; harvest and classify schema metadata; profile tables; browse ER diagrams and the Dictionary; and show discovery and nightly-change notifications. Catalogue answers use stored metadata and make no model calls. **Contract basis:** C2, C6, C7; design §§1.6, 2.5 and 3; CLAUDE.md §§3, 5, 10–11.

## Routes and UI

| Route | Behavior | Contract |
|---|---|---|
| `GET/POST /api/connections` | List active tenant sources and create a tested connection draft. Connector secrets are write-only and encrypted; responses never return them. | C1; C2; C7 rule 13 |
| `POST /api/connections/:id/test` | Test only a synthetic golden adapter or a caller-configured local source; returns capabilities and scan coverage. | C2; C7 |
| `POST /api/connections/:id/activate` | Persist the selected scope, activate the connection, create exactly one connector agent, and append `agent_created` in one transaction. | C2 rule 5; C1 acceptance 10 |
| `GET/PUT /api/connections/:id/scope` | List discovered objects; update Profile, List only, or Exclude scope. Excluded entries retain only qualified name and type. | C3 rule 10; C6 rules 16; C7 |
| `POST /api/connections/:id/discover` | Start a scoped harvest/profile job and return a durable job id. | C5; C6 rules 14–16 |
| `GET /api/connections/:id/profile` | Return progress, coverage, inaccessible objects, table categories, field statistics, and profile version. | C6; C7 rules 2–3 |
| `GET /api/connections/:id/dictionary` | Browse tenant-scoped tables, fields, descriptions, keys, indexes, profile data, and SQL search results. | C6; C7 |
| `GET /api/connections/:id/er` | Return structural `REFERENCES` and probable inferred relationships, with evidence and review status. Never return structural links as data flow. | C6 rules 1–3, 15 |
| `GET /api/notifications` and `POST /api/notifications/:id/read` | List unread/earlier discovery and nightly summaries; mark one as read so it appears once as new. | C1; C5; CLAUDE.md §10.2 App shell |
| `/connectors`, `/profile/:connectionId`, `/dictionary`, `/controls`, `/approval-matrix` | Source cards and add flow, profile progress, first-class dictionary, scope controls, and discovery/nightly findings. | C2, C3, C6, C7; CLAUDE.md §10.2 |
| Home catalogue question | Search stored catalog metadata and render an evidence-backed text result without a model request. | C6; C7 rule 3; phase 1 outcome |

Shared shell follows CLAUDE.md §10.2: persistent Workspace/Platform groups, notification side panel, responsive layout, visible focus, keyboard behavior and reduced motion. The ER diagram opens from a connector card or Profile. The add flow tests, lets the user choose scope, then starts discovery. **Contract:** C1–C7 and CLAUDE.md §§10–11.

## Tables and ownership

All tenant-owned rows use `tenant_id`, `ENABLE/FORCE ROW LEVEL SECURITY`, transaction-local tenant binding and non-owner runtime roles (C1). Existing `registry.connections`, `registry.agents`, `registry.agent_versions`, `registry.events`, `registry.source_groups` and `core.activity_events` are extended/reused; no duplicate registry is created.

| Table | Purpose | Contract |
|---|---|---|
| `registry.connection_secrets` | AEAD-encrypted connector configuration, tenant key version, nonce and ciphertext; never returned by read APIs. | C1; C7 rules 10, 13 |
| `registry.connection_scopes` | Include/list-only/exclude rules and saved object names/types; excluded objects have no profile or fingerprint. | C3 rule 10; C6 rule 16; C7 |
| `graph.assets`, `graph.asset_versions` | Stable tenant-scoped source/container/dataset/field ids, qualified names, structural metadata and immutable profile snapshots. | C6 rules 1, 8–9, 15 |
| `graph.relationships`, `graph.assertions`, `graph.evidence`, `graph.gaps` | Structural ER links and evidence, with independent evidence method/review/verification facts; no invented flows. | C6 rules 1–11, 16 |
| `profiler.jobs`, `profiler.job_objects` | Durable discovery/profile/nightly job state and per-object work/coverage. | C5; C6 rules 14–15 |
| `profiler.field_profiles` | Safe structural/statistical profile values and sensitivity tags, never samples or raw values. | C7 rules 2–3, 10–11 |
| `artifacts.workbooks` | Tenant/connection keyed encrypted-volume path and ciphertext metadata only; no workbook contents in PostgreSQL. Connector removal deletes the ciphertext and row. | C1; C7 rules 10, 13 |
| `core.notifications` | Per-user discovery/nightly summary and read-once state. | C1; C5 |

## Events

Append-only events use tenant scope and safe payload schemas. `connection_tested`, `connection_activated`, `agent_created`, `profile_started`, `object_discovered`, `profile_completed`, `schema_changed`, `scope_changed`, `workbook_removed`, `notification_created`, `notification_read`. State and event commit together where they describe a state transition (C2 rule 5; C5 rules 1–2; C6 rule 15). Events contain ids and safe counts only, never source rows, workbook bytes, credentials or restricted values (C7).

## Scope and security boundaries

- SQL Server, PostgreSQL and Snowflake connector implementations use one read-only connector interface. Development and CI exercise only `tests/golden`; no real credentials or client systems are configured. (C2; C7.)
- Workbook bytes are AES-256-GCM encrypted with tenant-specific keys derived from a local master key; keys and file bytes never enter API responses or logs. Removing a connector removes the key reference and ciphertext. (C7 rule 13; decision 10.)
- Profile/list-only/exclude scope is enforced in the collector before issuing any per-object profiling query. Excluded objects are recorded by name/type only. (C3 rule 10; C6 rule 16.)
- Metadata class is explicit. Only structural metadata can be model eligible; phase 1 makes no model requests. Descriptions/comments and SQL remain stored as descriptive metadata and cannot be sent unsanitized to a model. (C7 rules 1, 3.)
- `METADATA_STATISTICAL` on tagged fields and small groups is withheld; phase 1 does not persist samples, distinct lists or row-level data. (C7 rules 2, 10–11.)

## Acceptance tests (named cases)

Every case cites the frozen requirement it implements. Contract cases live under `tests/contracts/`.

| Test case | Contract / criterion |
|---|---|
| `c2_successful_connection_activation_creates_one_agent_and_event_atomically` | C2 rule 5; C1 acceptance 10 |
| `c6_golden_500_table_schema_harvests_within_ten_minutes_without_model_calls` | C6 asset contract; phase 1 acceptance; design §2.5 |
| `c6_identical_source_profiles_produce_identical_versions` | C6 rules 8, 15; phase 1 acceptance |
| `c6_nightly_refresh_skips_unchanged_objects_and_profiles_only_changes` | C6 rules 14–15; phase 1 acceptance |
| `c6_foreign_keys_create_references_but_never_lineage_edges` | C6 rule 1 and acceptance 1 |
| `c6_inferred_er_links_remain_probable_until_reviewed` | C6 rules 1–3 and acceptance 15 |
| `c6_excluded_objects_keep_only_name_and_type_without_profile_queries` | C3 rule 10; C6 rule 16 and acceptance 16 |
| `c7_view_literals_and_sensitive_comments_are_scrubbed_before_model_boundary` | C7 rules 1, 11; mandatory metadata-boundary acceptances 1–2 |
| `c7_tagged_field_statistics_are_withheld_from_model_boundary` | C7 rules 2, 11; mandatory metadata-boundary acceptance 3 |
| `c7_small_group_statistics_are_withheld_from_model_boundary` | C7 rules 2, 11; mandatory metadata-boundary acceptance 4 |
| `c7_unclassified_source_exposes_structural_metadata_only` | C7 rule 3; mandatory metadata-boundary acceptance 5 |
| `c7_cross_tenant_workbook_ciphertext_is_unreadable_and_connector_removal_deletes_it` | C1; C7 rule 13 and acceptance 13; decision 10 |
| `c6_profile_scan_coverage_lists_inaccessible_objects` | C6 asset contract; phase 1 acceptance |
| `c6_nightly_change_creates_one_read_once_notification_per_user` | C5; C6 rule 15; CLAUDE.md §10.2 |
| `phase1_scope_controls_prevent_out_of_scope_discovery_and_query` | C3 rule 10; C6 rule 16 |
| `phase1_connector_profile_dictionary_and_er_navigation_is_keyboard_accessible` | C1; CLAUDE.md §§10–11 |
| `phase1_catalogue_question_uses_profile_without_model_request` | C6; C7 rule 3; phase 1 outcome |

The phase gate also requires all phase 0 tests, `pnpm lint`, `pnpm typecheck`, unit, PostgreSQL integration, contract and Playwright suites. PostgreSQL tests use native PostgreSQL 16 and reset only `si_test`.

## Demo

Use only the synthetic golden dataset. Create the four synthetic source connections, run discovery, inspect connector agents, scope coverage, Profiles, Dictionary and ER diagrams, then run an unchanged and changed nightly refresh and open the one-time notification. No external source systems, real credentials or client data are used.

## Assumptions

- Decision 10 is decided: tenant-specific encrypted local volume; workbook deleted with connector. Other record retention periods are deferred (decision 10; C7 rule 13).
- Use SQL Server, PostgreSQL and Snowflake connector defaults in the design. The adapters are exercised against synthetic fixtures only; no vendor service is needed during development (C2; CLAUDE.md §§3, 5).
- “Within 10 minutes” is measured on the local synthetic 500-table fixture at the phase 1 harness size; record the measured baseline in the phase report (design §2.5; decision 15).
- Workbook encryption uses the listed local volume and a local master secret; its concrete key derivation is an implementation detail and creates no external key-management dependency (C7 rule 13; decision 10).
