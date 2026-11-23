import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE SCHEMA reports AUTHORIZATION si_migrate;
    CREATE TABLE reports.definitions(
      tenant_id text NOT NULL, report_id uuid NOT NULL DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
      name text NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 120), governed_id uuid NOT NULL, version integer NOT NULL CHECK(version>0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,report_id), UNIQUE(tenant_id,owner_id,name),
      FOREIGN KEY(tenant_id,owner_id) REFERENCES core.users(tenant_id,user_id),
      FOREIGN KEY(tenant_id,governed_id,version) REFERENCES registry.governed_versions(tenant_id,governed_id,version)
    );
    CREATE TABLE reports.snapshots(
      tenant_id text NOT NULL, snapshot_id uuid NOT NULL DEFAULT gen_random_uuid(), report_id uuid NOT NULL,
      run_id uuid NOT NULL, plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
      content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), safe_pack jsonb NOT NULL CHECK(jsonb_typeof(safe_pack)='object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,snapshot_id), UNIQUE(tenant_id,report_id,run_id),
      FOREIGN KEY(tenant_id,report_id) REFERENCES reports.definitions(tenant_id,report_id),
      FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id)
    );
    CREATE TABLE reports.schedules(
      tenant_id text NOT NULL, schedule_id uuid NOT NULL DEFAULT gen_random_uuid(), report_id uuid NOT NULL,
      owner_id uuid NOT NULL, utc_time time NOT NULL, next_run_at timestamptz NOT NULL,
      last_slot timestamptz, enabled boolean NOT NULL DEFAULT true, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,schedule_id), UNIQUE(tenant_id,report_id),
      FOREIGN KEY(tenant_id,report_id) REFERENCES reports.definitions(tenant_id,report_id),
      FOREIGN KEY(tenant_id,owner_id) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE INDEX reports_schedules_due ON reports.schedules(next_run_at,schedule_id) WHERE enabled;
    CREATE TABLE reports.schedule_slots(
      tenant_id text NOT NULL, schedule_id uuid NOT NULL, due_slot timestamptz NOT NULL,
      report_id uuid NOT NULL, owner_id uuid NOT NULL, run_id uuid NOT NULL UNIQUE,
      state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','started','skipped')),
      safe_reason text CHECK(safe_reason IS NULL OR safe_reason IN ('governed_version_not_approved','governed_version_not_found','source_not_active','source_group_version_not_pinned','capability_not_available','principal_not_entitled')),
      started_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,schedule_id,due_slot),
      FOREIGN KEY(tenant_id,schedule_id) REFERENCES reports.schedules(tenant_id,schedule_id),
      FOREIGN KEY(tenant_id,report_id) REFERENCES reports.definitions(tenant_id,report_id),
      FOREIGN KEY(tenant_id,owner_id) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE reports.export_events(
      tenant_id text NOT NULL, export_id uuid NOT NULL DEFAULT gen_random_uuid(), run_id uuid NOT NULL,
      principal_id uuid NOT NULL, format text NOT NULL CHECK(format IN ('pdf','xlsx','pptx')),
      content_hash text NOT NULL CHECK(content_hash ~ '^[a-f0-9]{64}$'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,export_id),
      FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id),
      FOREIGN KEY(tenant_id,principal_id) REFERENCES core.users(tenant_id,user_id)
    );
    DO $$ BEGIN
      ALTER TABLE reports.definitions ENABLE ROW LEVEL SECURITY; ALTER TABLE reports.definitions FORCE ROW LEVEL SECURITY;
      CREATE POLICY reports_owner ON reports.definitions USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid);
      ALTER TABLE reports.schedules ENABLE ROW LEVEL SECURITY; ALTER TABLE reports.schedules FORCE ROW LEVEL SECURITY;
      CREATE POLICY reports_owner ON reports.schedules USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid);
      CREATE POLICY schedules_worker_claim ON reports.schedules FOR ALL TO si_worker USING(current_setting('app.worker_claim',true)='enabled') WITH CHECK(current_setting('app.worker_claim',true)='enabled');
      ALTER TABLE reports.schedule_slots ENABLE ROW LEVEL SECURITY; ALTER TABLE reports.schedule_slots FORCE ROW LEVEL SECURITY;
      CREATE POLICY schedule_slots_owner ON reports.schedule_slots USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid);
      CREATE POLICY schedule_slots_worker ON reports.schedule_slots FOR ALL TO si_worker USING(current_setting('app.worker_claim',true)='enabled') WITH CHECK(current_setting('app.worker_claim',true)='enabled');
      ALTER TABLE reports.export_events ENABLE ROW LEVEL SECURITY; ALTER TABLE reports.export_events FORCE ROW LEVEL SECURITY;
      CREATE POLICY reports_owner ON reports.export_events USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND principal_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND principal_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid);
      ALTER TABLE reports.snapshots ENABLE ROW LEVEL SECURITY; ALTER TABLE reports.snapshots FORCE ROW LEVEL SECURITY;
      CREATE POLICY reports_owner ON reports.snapshots USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND EXISTS(SELECT 1 FROM reports.definitions d WHERE d.tenant_id=reports.snapshots.tenant_id AND d.report_id=reports.snapshots.report_id AND d.owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid)) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')) AND EXISTS(SELECT 1 FROM reports.definitions d WHERE d.tenant_id=reports.snapshots.tenant_id AND d.report_id=reports.snapshots.report_id AND d.owner_id=(SELECT nullif(current_setting('app.principal_id',true),''))::uuid));
    END $$;
    GRANT USAGE ON SCHEMA reports TO si_app,si_worker;
    GRANT SELECT,INSERT,UPDATE ON reports.definitions,reports.schedules TO si_app;
    GRANT SELECT ON reports.definitions TO si_worker;
    GRANT SELECT,INSERT ON reports.snapshots,reports.export_events TO si_app,si_worker;
    GRANT SELECT,UPDATE ON reports.schedules TO si_worker;
    GRANT SELECT,INSERT,UPDATE ON reports.schedule_slots TO si_worker;
    CREATE FUNCTION reports.reject_export_history_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Report export history is append only'; END $$;
    CREATE TRIGGER export_events_immutable BEFORE UPDATE OR DELETE ON reports.export_events FOR EACH ROW EXECUTE FUNCTION reports.reject_export_history_change();
    CREATE TRIGGER snapshots_immutable BEFORE UPDATE OR DELETE ON reports.snapshots FOR EACH ROW EXECUTE FUNCTION reports.reject_export_history_change();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP SCHEMA reports CASCADE;');
}
