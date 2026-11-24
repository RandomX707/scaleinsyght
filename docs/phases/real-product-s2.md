# Real Product S2: SQL Server

**Status:** approved and implemented under the real-product design (Yashaswi, 24 Nov 2026)
**Branch:** `real-product-s2`
**Scope:** Add a real SQL Server 2022 source path. The application remains native; Colima is used only for the local test source.

## Routes and API

S2 extends the existing connector lifecycle without adding a fixture route:

- `POST /api/connections`: accepts `connectorType: "sql_server"`, display name, host, port, database, username, password, and an explicit local certificate trust override. Credentials are encrypted before storage.
- `POST /api/connections/:id/test`: verifies connectivity and refuses effective write or elevated privileges.
- `POST /api/connections/:id/activate`: persists the encrypted credential, creates the connector agent, and starts real profiling.
- Existing profile, ER, Dictionary, analytic-plan and evidence routes return SQL Server metadata and query results under the authenticated tenant.

The product PostgreSQL database reuses the existing `registry.connections` and encrypted `registry.connection_secrets` tables. The isolated source database is `si_testbed_sqlserver`, with `dbo.patients`, `dbo.encounters`, `dbo.orders`, `dbo.departments`, and `dbo.providers`, declared keys, one undeclared shared patient key, a view, and a stored procedure. It contains only fictional testbed data and shares patient/encounter identifiers with `si_testbed_pg`.

## Events and source safety

Activation and profiling use the existing connector and profiler events; S2 adds no event types or frozen contract changes. Every source query runs with a 10-second statement timeout, a 1,000-row result ceiling, parameter binding, and least-privilege read-only credentials. Connection testing rejects write-capable or elevated credentials before activation. The SQL Server test login has SELECT only. No source values or credentials enter model requests, UI logs, or snapshots.

## UI

The Connectors add flow offers SQL Server alongside PostgreSQL. Its form collects a connection name, host, port, database, username, password, and encryption setting with labels above each field. Test connection shows a clear success/read-only result or a safe failure. Activation starts profiling. Profile, ER, and Dictionary render the actual SQL Server tables, columns, counts, declared/inferred references, view and routine metadata. Home can run a bounded question against only the selected SQL Server source and shows executed SQL, source, and returned row count as evidence.

## Acceptance cases

- `c6_sqlserver_testbed_data_matches_sql_derived_truth` — counts, column counts, declared FKs, views, routines and classifications match direct SQL; Contract 6 (source metadata identity and evidence).
- `c6_sqlserver_and_postgres_share_patient_and_encounter_keys_without_persisting_values` — shared identifier counts and the undeclared relationship match truth while raw identifier values are not stored; Contracts 6 and 7 (lineage evidence and disclosure boundary).
- `sqlserver_connector_rejects_effective_write_permissions` — a reader login passes, while a real testbed account temporarily granted `db_datawriter` is rejected; Contract 2 (read-only source access).
- `sqlserver_catalog_discovery_includes_views_and_routines` — real catalog discovery includes SQL Server views and routine definitions; Contract 6.
- `sqlserver_structural_references_label_declared_and_inferred` — declared FK edges and the un-declared patient relationship have distinct evidence labels; Contracts 6 and 7.
- `sqlserver_connector_limits_query_time_and_rows` — typed aggregate and filtered-count queries run with a 10-second driver timeout and a 1,000-row ceiling; Contracts 2 and 6.
- `s2_empty_tenant_adds_real_sql_server_profiles_and_relationships` — Playwright provisions an empty tenant, proves API refusal of a writer, adds SQL Server through the UI, waits for profiling, checks Profile/ER/Dictionary and a real answer of 500 with its executed SQL evidence; Contracts 2, 6, and 7.

`pnpm test:testbed` grows to start SQL Server 2022 through Colima, compute its truth from the database, run source-safety/metadata contracts, and exercise the UI walkthrough. It remains local-only; CI must not require SQL Server or Docker. `docs/gap-audit.md` changes SQL Server from Missing to Real only when the S2 UI acceptance passes. Screenshots and a video belong in `docs/acceptance/s2/`.

## Out of scope

Excel, dbt lineage, ID trace, nightly refresh, exports, Tableau, Snowflake, deployment containers, and changes to the PostgreSQL source or frozen contract envelopes remain for later slices.
