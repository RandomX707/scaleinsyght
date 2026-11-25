import type { MigrationBuilder } from 'node-pg-migrate';

// Dictionary rebuild (docs/phases/dictionary-rebuild.md, decision 53).
// - graph.definitions: versioned, scrubbed definition text of views, procedures, functions, packages and Tableau
//   calculated fields, with the parsed analysis. Literals are never stored (non-negotiable 6).
// - graph.dictionary_imports: which vendor dictionary file was imported, when and by whom.
// - graph.description_reviews: descriptions drafted by Scale Insyght and their approval or edit, with who and when.
// - graph.dictionary_descriptions.origin: an imported vendor dictionary or a dbt project.
// - graph.dbt_tests: the tests a dbt project declares per model and column.
// - core.activity_events: dictionary_exported, with counts only in safe_details.
const tenantPolicy = (table: string, name: string) => `
  ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY ${name} ON ${table} USING (tenant_id=(SELECT current_setting('app.tenant_id',true))) WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
  GRANT SELECT,INSERT,UPDATE ON ${table} TO si_app, si_worker;`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
  CREATE TABLE graph.definitions (
    tenant_id text NOT NULL,
    source_id uuid NOT NULL,
    qualified_name text NOT NULL CHECK (length(qualified_name) BETWEEN 1 AND 500),
    version integer NOT NULL CHECK (version > 0),
    kind text NOT NULL CHECK (kind IN ('view','materialized_view','procedure','function','package','calculated_field')),
    scrubbed_text text CHECK (scrubbed_text IS NULL OR length(scrubbed_text) <= 1000000),
    encrypted boolean NOT NULL DEFAULT false,
    parameters jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(parameters)='array'),
    analysis jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(analysis)='object'),
    text_hash bytea,
    captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    active boolean NOT NULL DEFAULT true,
    PRIMARY KEY (tenant_id,source_id,qualified_name,version),
    FOREIGN KEY (tenant_id,source_id) REFERENCES registry.connections(tenant_id,connection_id),
    CHECK (NOT encrypted OR scrubbed_text IS NULL)
  );
  CREATE INDEX graph_definitions_current ON graph.definitions(tenant_id,source_id,kind,qualified_name) WHERE active;
  ${tenantPolicy('graph.definitions', 'definitions_tenant')}

  CREATE TABLE graph.dictionary_imports (
    tenant_id text NOT NULL,
    import_id uuid NOT NULL DEFAULT gen_random_uuid(),
    source_id uuid NOT NULL,
    file_name text NOT NULL CHECK (length(file_name) BETWEEN 1 AND 255),
    imported_by uuid,
    imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    table_count integer NOT NULL DEFAULT 0,
    column_count integer NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id,import_id),
    FOREIGN KEY (tenant_id,source_id) REFERENCES registry.connections(tenant_id,connection_id),
    FOREIGN KEY (tenant_id,imported_by) REFERENCES core.users(tenant_id,user_id)
  );
  CREATE INDEX graph_dictionary_imports_latest ON graph.dictionary_imports(tenant_id,source_id,imported_at DESC);
  ${tenantPolicy('graph.dictionary_imports', 'dictionary_imports_tenant')}

  CREATE TABLE graph.description_reviews (
    tenant_id text NOT NULL,
    source_id uuid NOT NULL,
    qualified_name text NOT NULL,
    field_name text NOT NULL DEFAULT '',
    drafted_text text NOT NULL CHECK (length(drafted_text) BETWEEN 1 AND 2000),
    drafted_by text NOT NULL CHECK (drafted_by IN ('code','model')),
    drafted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','edited')),
    final_text text CHECK (final_text IS NULL OR length(final_text) BETWEEN 1 AND 2000),
    decided_by uuid,
    decided_at timestamptz,
    PRIMARY KEY (tenant_id,source_id,qualified_name,field_name),
    FOREIGN KEY (tenant_id,source_id) REFERENCES registry.connections(tenant_id,connection_id),
    FOREIGN KEY (tenant_id,decided_by) REFERENCES core.users(tenant_id,user_id),
    CHECK ((status='draft')=(decided_by IS NULL AND decided_at IS NULL))
  );
  ${tenantPolicy('graph.description_reviews', 'description_reviews_tenant')}

  ALTER TABLE graph.dictionary_descriptions ADD COLUMN origin text NOT NULL DEFAULT 'imported' CHECK (origin IN ('imported','dbt'));

  CREATE TABLE graph.dbt_tests (
    tenant_id text NOT NULL,
    source_id uuid NOT NULL,
    model text NOT NULL,
    column_name text NOT NULL DEFAULT '',
    test_name text NOT NULL CHECK (length(test_name) BETWEEN 1 AND 200),
    PRIMARY KEY (tenant_id,source_id,model,column_name,test_name),
    FOREIGN KEY (tenant_id,source_id) REFERENCES registry.connections(tenant_id,connection_id)
  );
  ${tenantPolicy('graph.dbt_tests', 'dbt_tests_tenant')}
  GRANT DELETE ON graph.dbt_tests TO si_app;
  GRANT DELETE ON graph.dictionary_descriptions TO si_app;
  -- Field -> dataset and referenced-field lookups for the Dictionary and the ER neighbourhood at 5,000 tables.
  CREATE INDEX graph_relationships_structural_to ON graph.relationships(tenant_id,to_asset_id,relationship_type) WHERE family='structural';

  ALTER TABLE core.activity_events ADD COLUMN safe_details jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_details)='object');
  ALTER TABLE core.activity_events DROP CONSTRAINT activity_events_event_type_check;
  ALTER TABLE core.activity_events ADD CONSTRAINT activity_events_event_type_check CHECK (event_type IN ('user_active','connector_activated','connector_retired','sso_provider_configured','sso_login_succeeded','sso_login_failed','member_invited','member_joined','dictionary_exported'));
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql(`
  ALTER TABLE core.activity_events DROP CONSTRAINT activity_events_event_type_check;
  ALTER TABLE core.activity_events ADD CONSTRAINT activity_events_event_type_check CHECK (event_type IN ('user_active','connector_activated','connector_retired','sso_provider_configured','sso_login_succeeded','sso_login_failed','member_invited','member_joined'));
  ALTER TABLE core.activity_events DROP COLUMN safe_details;
  DROP INDEX graph.graph_relationships_structural_to;
  DROP TABLE graph.dbt_tests;
  ALTER TABLE graph.dictionary_descriptions DROP COLUMN origin;
  DROP TABLE graph.description_reviews;
  DROP TABLE graph.dictionary_imports;
  DROP TABLE graph.definitions;
  `);
}
