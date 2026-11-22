import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE UNIQUE INDEX runs_run_id_global ON runs.runs(run_id);
    CREATE POLICY worker_stored_run_lookup ON runs.runs
      FOR SELECT TO si_worker
      USING (run_id::text = nullif(current_setting('app.worker_run_lookup', true), ''));

    ALTER TABLE registry.connections
      ADD CONSTRAINT active_connection_has_agent_and_group
      CHECK (status <> 'active' OR (connector_agent_id IS NOT NULL AND source_group_id IS NOT NULL AND source_group_version IS NOT NULL));
    ALTER TABLE registry.connections
      ADD CONSTRAINT connection_group_version_fk
      FOREIGN KEY (tenant_id, source_group_id, source_group_version)
      REFERENCES registry.source_groups(tenant_id, source_group_id, version);

    CREATE TABLE registry.events (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      event_type text NOT NULL CHECK (event_type IN ('agent_created','agent_retired')),
      agent_id uuid NOT NULL,
      connection_id uuid,
      safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_payload) = 'object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, event_id),
      FOREIGN KEY (tenant_id, agent_id) REFERENCES registry.agents(tenant_id, agent_id),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id)
    );
    ALTER TABLE registry.events ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registry.events FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_isolation ON registry.events
      USING (tenant_id = nullif(current_setting('app.tenant_id', true), ''))
      WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), ''));
    GRANT SELECT, INSERT ON registry.events TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA registry GRANT SELECT, INSERT ON TABLES TO si_app, si_worker;

    CREATE FUNCTION registry.reject_immutable_version_change() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registered versions are immutable'; END $$;
    CREATE TRIGGER capability_versions_immutable BEFORE UPDATE OR DELETE ON registry.capability_versions
      FOR EACH ROW EXECUTE FUNCTION registry.reject_immutable_version_change();
    CREATE TRIGGER agent_versions_immutable BEFORE UPDATE OR DELETE ON registry.agent_versions
      FOR EACH ROW EXECUTE FUNCTION registry.reject_immutable_version_change();

    CREATE FUNCTION registry.reject_event_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'registry events are append-only'; END $$;
    CREATE TRIGGER registry_events_append_only BEFORE UPDATE OR DELETE ON registry.events
      FOR EACH ROW EXECUTE FUNCTION registry.reject_event_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP TRIGGER registry_events_append_only ON registry.events;
    DROP FUNCTION registry.reject_event_mutation();
    DROP TRIGGER agent_versions_immutable ON registry.agent_versions;
    DROP TRIGGER capability_versions_immutable ON registry.capability_versions;
    DROP FUNCTION registry.reject_immutable_version_change();
    DROP TABLE registry.events;
    ALTER TABLE registry.connections DROP CONSTRAINT connection_group_version_fk;
    ALTER TABLE registry.connections DROP CONSTRAINT active_connection_has_agent_and_group;
    DROP POLICY worker_stored_run_lookup ON runs.runs;
    DROP INDEX runs_run_id_global;
  `);
}
