import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE registry.connections ADD COLUMN source_ref text;
    CREATE SCHEMA graph AUTHORIZATION si_migrate;
    CREATE SCHEMA profiler AUTHORIZATION si_migrate;
    CREATE SCHEMA artifacts AUTHORIZATION si_migrate;

    CREATE TABLE registry.connection_secrets (
      tenant_id text NOT NULL,
      connection_id uuid NOT NULL,
      secret_version integer NOT NULL DEFAULT 1 CHECK (secret_version > 0),
      ciphertext bytea NOT NULL,
      nonce bytea NOT NULL,
      auth_tag bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, connection_id, secret_version),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id)
    );

    CREATE TABLE registry.connection_scopes (
      tenant_id text NOT NULL,
      connection_id uuid NOT NULL,
      qualified_name text NOT NULL,
      object_type text NOT NULL CHECK (object_type IN ('database','schema','table','view','column','procedure','package','sheet')),
      scope_mode text NOT NULL CHECK (scope_mode IN ('profile','list_only','exclude')),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, connection_id, qualified_name),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id)
    );

    CREATE TABLE graph.assets (
      tenant_id text NOT NULL,
      asset_id uuid NOT NULL DEFAULT gen_random_uuid(),
      source_id uuid NOT NULL,
      asset_type text NOT NULL CHECK (asset_type IN ('system','container','dataset','field')),
      qualified_name text NOT NULL,
      fingerprint bytea NOT NULL,
      sensitivity_tags text[] NOT NULL DEFAULT '{}',
      active boolean NOT NULL DEFAULT true,
      first_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      last_seen_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, asset_id),
      UNIQUE (tenant_id, source_id, qualified_name),
      FOREIGN KEY (tenant_id, source_id) REFERENCES registry.connections(tenant_id, connection_id)
    );
    CREATE TABLE graph.asset_versions (
      tenant_id text NOT NULL,
      asset_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      structural_attributes jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(structural_attributes) = 'object'),
      statistics jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(statistics) = 'object'),
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, asset_id, version),
      FOREIGN KEY (tenant_id, asset_id) REFERENCES graph.assets(tenant_id, asset_id)
    );
    CREATE TABLE graph.relationships (
      tenant_id text NOT NULL,
      relationship_id uuid NOT NULL DEFAULT gen_random_uuid(),
      family text NOT NULL CHECK (family IN ('structural','data_flow','semantic','responsibility','succession')),
      relationship_type text NOT NULL,
      from_asset_id uuid NOT NULL,
      to_asset_id uuid NOT NULL,
      granularity text NOT NULL CHECK (granularity IN ('system','dataset','field','metric','report')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, relationship_id),
      UNIQUE (tenant_id, family, relationship_type, from_asset_id, to_asset_id, granularity),
      FOREIGN KEY (tenant_id, from_asset_id) REFERENCES graph.assets(tenant_id, asset_id),
      FOREIGN KEY (tenant_id, to_asset_id) REFERENCES graph.assets(tenant_id, asset_id),
      CHECK ((family = 'structural' AND relationship_type IN ('CONTAINS','REFERENCES','SAME_AS')) OR
             (family = 'data_flow' AND relationship_type IN ('READS','WRITES','DERIVES_FROM','MAPS_TO')) OR
             family NOT IN ('structural','data_flow'))
    );
    CREATE TABLE graph.evidence (
      tenant_id text NOT NULL,
      evidence_id uuid NOT NULL DEFAULT gen_random_uuid(),
      evidence_type text NOT NULL,
      safe_metadata jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_metadata) = 'object'),
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, evidence_id)
    );
    CREATE TABLE graph.assertions (
      tenant_id text NOT NULL,
      assertion_id uuid NOT NULL DEFAULT gen_random_uuid(),
      relationship_id uuid NOT NULL,
      evidence_method text NOT NULL CHECK (evidence_method IN ('observed','declared','parsed','inferred')),
      review_status text NOT NULL CHECK (review_status IN ('unreviewed','accepted','disputed','rejected','stale')) DEFAULT 'unreviewed',
      verification text NOT NULL CHECK (verification IN ('unverified','run_verified','reconciled')) DEFAULT 'unverified',
      evidence_ids uuid[] NOT NULL CHECK (cardinality(evidence_ids) > 0),
      confidence_score numeric(4,3) CHECK (confidence_score BETWEEN 0 AND 1),
      explanation text,
      transformation jsonb,
      collector_version text NOT NULL,
      reviewer_id uuid,
      reviewed_at timestamptz,
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, assertion_id),
      FOREIGN KEY (tenant_id, relationship_id) REFERENCES graph.relationships(tenant_id, relationship_id),
      FOREIGN KEY (tenant_id, reviewer_id) REFERENCES core.users(tenant_id, user_id)
    );
    CREATE TABLE graph.gaps (
      tenant_id text NOT NULL,
      gap_id uuid NOT NULL DEFAULT gen_random_uuid(),
      between_asset_ids uuid[] NOT NULL CHECK (cardinality(between_asset_ids) > 0),
      reason text NOT NULL,
      detected_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      closed_by_assertion_id uuid,
      PRIMARY KEY (tenant_id, gap_id),
      FOREIGN KEY (tenant_id, closed_by_assertion_id) REFERENCES graph.assertions(tenant_id, assertion_id)
    );

    CREATE TABLE profiler.jobs (
      tenant_id text NOT NULL,
      job_id uuid NOT NULL DEFAULT gen_random_uuid(),
      connection_id uuid NOT NULL,
      job_type text NOT NULL CHECK (job_type IN ('discovery','profile','nightly')),
      state text NOT NULL CHECK (state IN ('QUEUED','RUNNING','COMPLETED','PARTIAL','FAILED','CANCELLED')) DEFAULT 'QUEUED',
      state_version integer NOT NULL DEFAULT 0,
      listed_count integer NOT NULL DEFAULT 0 CHECK (listed_count >= 0),
      profiled_count integer NOT NULL DEFAULT 0 CHECK (profiled_count >= 0),
      inaccessible_count integer NOT NULL DEFAULT 0 CHECK (inaccessible_count >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, job_id),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id)
    );
    CREATE TABLE profiler.job_objects (
      tenant_id text NOT NULL,
      job_id uuid NOT NULL,
      object_name text NOT NULL,
      object_type text NOT NULL,
      scope_mode text NOT NULL CHECK (scope_mode IN ('profile','list_only','exclude')),
      state text NOT NULL CHECK (state IN ('PENDING','RUNNING','COMPLETED','INACCESSIBLE','SKIPPED','FAILED')) DEFAULT 'PENDING',
      asset_id uuid,
      error_code text,
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, job_id, object_name),
      FOREIGN KEY (tenant_id, job_id) REFERENCES profiler.jobs(tenant_id, job_id),
      FOREIGN KEY (tenant_id, asset_id) REFERENCES graph.assets(tenant_id, asset_id)
    );
    CREATE TABLE profiler.events (
      tenant_id text NOT NULL,
      job_id uuid NOT NULL,
      sequence bigint NOT NULL CHECK (sequence > 0),
      event_type text NOT NULL,
      safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_payload) = 'object'),
      at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, job_id, sequence),
      FOREIGN KEY (tenant_id, job_id) REFERENCES profiler.jobs(tenant_id, job_id)
    );
    CREATE TABLE profiler.field_profiles (
      tenant_id text NOT NULL,
      asset_id uuid NOT NULL,
      profile_version integer NOT NULL CHECK (profile_version > 0),
      field_name text NOT NULL,
      data_type text NOT NULL,
      is_nullable boolean NOT NULL,
      sensitivity_tags text[] NOT NULL DEFAULT '{}',
      null_rate numeric(6,5) CHECK (null_rate BETWEEN 0 AND 1),
      distinct_count bigint CHECK (distinct_count >= 0),
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, asset_id, profile_version, field_name),
      FOREIGN KEY (tenant_id, asset_id, profile_version) REFERENCES graph.asset_versions(tenant_id, asset_id, version)
    );

    CREATE TABLE artifacts.workbooks (
      tenant_id text NOT NULL,
      artifact_id uuid NOT NULL DEFAULT gen_random_uuid(),
      connection_id uuid NOT NULL,
      opaque_file_id uuid NOT NULL DEFAULT gen_random_uuid(),
      content_sha256 bytea NOT NULL,
      key_salt bytea NOT NULL,
      encrypted_size bigint NOT NULL CHECK (encrypted_size >= 0),
      key_version integer NOT NULL CHECK (key_version > 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, artifact_id),
      UNIQUE (tenant_id, opaque_file_id),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id)
    );

    CREATE TABLE core.notifications (
      tenant_id text NOT NULL,
      notification_id uuid NOT NULL DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      connection_id uuid NOT NULL,
      job_id uuid NOT NULL,
      notification_type text NOT NULL CHECK (notification_type IN ('discovery','nightly')),
      safe_summary jsonb NOT NULL CHECK (jsonb_typeof(safe_summary) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      read_at timestamptz,
      PRIMARY KEY (tenant_id, notification_id),
      UNIQUE (tenant_id, user_id, job_id, notification_type),
      FOREIGN KEY (tenant_id, user_id) REFERENCES core.users(tenant_id, user_id),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id),
      FOREIGN KEY (tenant_id, job_id) REFERENCES profiler.jobs(tenant_id, job_id)
    );

    DO $$
    DECLARE row record;
    BEGIN
      FOR row IN SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname IN ('graph','profiler','artifacts')
      LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', row.schemaname, row.tablename);
        EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', row.schemaname, row.tablename);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',
          row.schemaname, row.tablename);
      END LOOP;
    END $$;
    ALTER TABLE registry.connection_secrets ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registry.connection_secrets FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON registry.connection_secrets
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
    ALTER TABLE registry.connection_scopes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registry.connection_scopes FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON registry.connection_scopes
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
    ALTER TABLE core.notifications ENABLE ROW LEVEL SECURITY;
    ALTER TABLE core.notifications FORCE ROW LEVEL SECURITY;
    CREATE POLICY notification_owner ON core.notifications
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')
        AND user_id::text = nullif(current_setting('app.principal_id', true), ''))
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')
        AND user_id::text = nullif(current_setting('app.principal_id', true), ''));

    GRANT USAGE ON SCHEMA graph, profiler, artifacts TO si_app, si_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA graph, profiler, artifacts TO si_app, si_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA graph, profiler, artifacts TO si_app, si_worker;
    GRANT SELECT, INSERT, UPDATE, DELETE ON registry.connection_secrets, registry.connection_scopes, core.notifications TO si_app, si_worker;
    GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA registry, core TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA graph GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA profiler GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA artifacts GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA graph GRANT USAGE, SELECT ON SEQUENCES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA profiler GRANT USAGE, SELECT ON SEQUENCES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA artifacts GRANT USAGE, SELECT ON SEQUENCES TO si_app, si_worker;

    CREATE FUNCTION profiler.reject_event_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'profiler events are append-only'; END $$;
    CREATE TRIGGER profiler_events_append_only BEFORE UPDATE OR DELETE ON profiler.events
      FOR EACH ROW EXECUTE FUNCTION profiler.reject_event_mutation();
    CREATE FUNCTION graph.reject_asset_history_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'asset versions and evidence are append-only'; END $$;
    CREATE TRIGGER asset_versions_append_only BEFORE UPDATE OR DELETE ON graph.asset_versions
      FOR EACH ROW EXECUTE FUNCTION graph.reject_asset_history_mutation();
    CREATE TRIGGER graph_evidence_append_only BEFORE UPDATE OR DELETE ON graph.evidence
      FOR EACH ROW EXECUTE FUNCTION graph.reject_asset_history_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP SCHEMA artifacts CASCADE; DROP SCHEMA profiler CASCADE; DROP SCHEMA graph CASCADE;
    DROP TABLE registry.connection_scopes; DROP TABLE registry.connection_secrets; DROP TABLE core.notifications;`);
}
