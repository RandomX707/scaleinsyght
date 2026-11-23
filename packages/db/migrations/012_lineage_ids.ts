import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE graph.assertions ADD COLUMN valid_from timestamptz;
    ALTER TABLE graph.assertions ADD COLUMN valid_to timestamptz;
    ALTER TABLE graph.assertions ADD CONSTRAINT assertions_valid_window CHECK(valid_to IS NULL OR valid_from IS NULL OR valid_to >= valid_from);
    ALTER TABLE core.notifications DROP CONSTRAINT notifications_notification_type_check;
    ALTER TABLE core.notifications ADD CONSTRAINT notifications_notification_type_check CHECK(notification_type IN ('discovery','nightly','report_impact'));
    ALTER TABLE core.notifications ALTER COLUMN connection_id DROP NOT NULL;
    ALTER TABLE core.notifications ALTER COLUMN job_id DROP NOT NULL;
    ALTER TABLE core.notifications ADD COLUMN report_asset_id uuid;
    ALTER TABLE core.notifications ADD CONSTRAINT notifications_report_asset_fk FOREIGN KEY(tenant_id,report_asset_id) REFERENCES graph.assets(tenant_id,asset_id);
    CREATE UNIQUE INDEX notifications_report_impact_unique ON core.notifications(tenant_id,user_id,report_asset_id,notification_type) WHERE notification_type='report_impact';
    ALTER TABLE graph.assets DROP CONSTRAINT assets_asset_type_check;
    ALTER TABLE graph.assets ADD CONSTRAINT assets_asset_type_check CHECK(asset_type IN ('system','container','dataset','field','report','metric'));
    CREATE INDEX graph_relationships_from_lineage ON graph.relationships(tenant_id,from_asset_id,relationship_id) WHERE family='data_flow';
    CREATE INDEX graph_relationships_to_lineage ON graph.relationships(tenant_id,to_asset_id,relationship_id) WHERE family='data_flow';

    CREATE TABLE graph.id_fields (
      tenant_id text NOT NULL, asset_id uuid NOT NULL, field_name text NOT NULL,
      entity_hint text, format_pattern text NOT NULL, detection text NOT NULL CHECK(detection IN ('declared','inferred')),
      confidence numeric(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1), assertion_id uuid,
      detected_at timestamptz NOT NULL DEFAULT clock_timestamp(), active boolean NOT NULL DEFAULT true,
      PRIMARY KEY(tenant_id,asset_id,field_name),
      FOREIGN KEY(tenant_id,asset_id) REFERENCES graph.assets(tenant_id,asset_id),
      FOREIGN KEY(tenant_id,assertion_id) REFERENCES graph.assertions(tenant_id,assertion_id)
    );
    CREATE TABLE graph.id_fingerprints (
      tenant_id text NOT NULL, asset_id uuid NOT NULL, field_name text NOT NULL, fingerprint bytea NOT NULL CHECK(octet_length(fingerprint)=32), key_version integer NOT NULL CHECK(key_version>0),
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,asset_id,field_name,fingerprint),
      FOREIGN KEY(tenant_id,asset_id,field_name) REFERENCES graph.id_fields(tenant_id,asset_id,field_name)
    );
    CREATE INDEX id_fingerprints_lookup ON graph.id_fingerprints(tenant_id,fingerprint);
    CREATE TABLE graph.id_path_steps (
      tenant_id text NOT NULL, path_id uuid NOT NULL DEFAULT gen_random_uuid(), sequence integer NOT NULL CHECK(sequence>0),
      asset_id uuid NOT NULL, assertion_id uuid, change_type text NOT NULL CHECK(change_type IN ('none','renamed','reformatted','combined','dropped')),
      confidence numeric(4,3) NOT NULL CHECK(confidence BETWEEN 0 AND 1), gap_id uuid,
      PRIMARY KEY(tenant_id,path_id,sequence),
      FOREIGN KEY(tenant_id,asset_id) REFERENCES graph.assets(tenant_id,asset_id),
      FOREIGN KEY(tenant_id,assertion_id) REFERENCES graph.assertions(tenant_id,assertion_id),
      FOREIGN KEY(tenant_id,gap_id) REFERENCES graph.gaps(tenant_id,gap_id)
    );
    CREATE TABLE graph.snapshots (
      tenant_id text NOT NULL, snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(), captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      event_cursor bigint NOT NULL CHECK(event_cursor>=0), asset_count integer NOT NULL CHECK(asset_count>=0),
      PRIMARY KEY(tenant_id,snapshot_id)
    );
    CREATE TABLE graph.events (
      tenant_id text NOT NULL, event_id bigint GENERATED ALWAYS AS IDENTITY, event_type text NOT NULL CHECK(event_type IN
        ('metadata_imported','asset_version_captured','assertion_proposed','assertion_reviewed','assertion_verification_changed','gap_detected','id_field_detected','id_match_proposed','id_path_updated','report_impacted')),
      asset_id uuid, assertion_id uuid, report_asset_id uuid, safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(safe_payload)='object'),
      at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,event_id),
      FOREIGN KEY(tenant_id,asset_id) REFERENCES graph.assets(tenant_id,asset_id),
      FOREIGN KEY(tenant_id,assertion_id) REFERENCES graph.assertions(tenant_id,assertion_id),
      FOREIGN KEY(tenant_id,report_asset_id) REFERENCES graph.assets(tenant_id,asset_id)
    );
    CREATE INDEX graph_events_asset_at ON graph.events(tenant_id,asset_id,at);
    CREATE INDEX graph_events_report_at ON graph.events(tenant_id,report_asset_id,at);
    CREATE FUNCTION graph.reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'graph events are immutable'; END $$;
    CREATE TRIGGER graph_events_immutable BEFORE UPDATE OR DELETE ON graph.events FOR EACH ROW EXECUTE FUNCTION graph.reject_event_mutation();
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['id_fields','id_fingerprints','id_path_steps','snapshots','events'] LOOP
        EXECUTE format('ALTER TABLE graph.%I ENABLE ROW LEVEL SECURITY',table_name);
        EXECUTE format('ALTER TABLE graph.%I FORCE ROW LEVEL SECURITY',table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON graph.%I USING (tenant_id=nullif(current_setting(''app.tenant_id'',true),'''')) WITH CHECK (tenant_id=nullif(current_setting(''app.tenant_id'',true),''''))',table_name);
      END LOOP;
    END $$;
    GRANT SELECT,INSERT,UPDATE ON graph.id_fields,graph.id_fingerprints,graph.id_path_steps,graph.snapshots TO si_app,si_worker;
    GRANT SELECT,INSERT ON graph.events TO si_app,si_worker;
    GRANT USAGE,SELECT ON SEQUENCE graph.events_event_id_seq TO si_app,si_worker;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE graph.events; DROP FUNCTION graph.reject_event_mutation(); DROP TABLE graph.snapshots; DROP TABLE graph.id_path_steps; DROP TABLE graph.id_fingerprints; DROP TABLE graph.id_fields; DROP INDEX graph_relationships_from_lineage; DROP INDEX graph_relationships_to_lineage; ALTER TABLE graph.assets DROP CONSTRAINT assets_asset_type_check; ALTER TABLE graph.assets ADD CONSTRAINT assets_asset_type_check CHECK(asset_type IN ('system','container','dataset','field')); ALTER TABLE core.notifications DROP CONSTRAINT notifications_notification_type_check; ALTER TABLE core.notifications ADD CONSTRAINT notifications_notification_type_check CHECK(notification_type IN ('discovery','nightly')); ALTER TABLE graph.assertions DROP CONSTRAINT assertions_valid_window; ALTER TABLE graph.assertions DROP COLUMN valid_to; ALTER TABLE graph.assertions DROP COLUMN valid_from;`);
}
