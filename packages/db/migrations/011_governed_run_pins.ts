import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE runs.governed_run_pins (
    tenant_id text NOT NULL, run_id uuid NOT NULL, governed_id uuid NOT NULL, version integer NOT NULL,
    pinned_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(tenant_id,run_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id),
    FOREIGN KEY(tenant_id,governed_id,version) REFERENCES registry.governed_versions(tenant_id,governed_id,version)
  );
  ALTER TABLE runs.governed_run_pins ENABLE ROW LEVEL SECURITY; ALTER TABLE runs.governed_run_pins FORCE ROW LEVEL SECURITY;
  CREATE POLICY governed_run_pins_tenant ON runs.governed_run_pins
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),''));
  CREATE FUNCTION runs.reject_governed_run_pin_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'governed run pins are immutable'; END $$;
  CREATE TRIGGER governed_run_pins_immutable BEFORE UPDATE OR DELETE ON runs.governed_run_pins FOR EACH ROW EXECUTE FUNCTION runs.reject_governed_run_pin_mutation();
  GRANT SELECT,INSERT ON runs.governed_run_pins TO si_app,si_worker;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE runs.governed_run_pins; DROP FUNCTION runs.reject_governed_run_pin_mutation();`);
}
