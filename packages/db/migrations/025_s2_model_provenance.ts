import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE runs.model_provenance (
    tenant_id text NOT NULL,
    provenance_id uuid NOT NULL DEFAULT gen_random_uuid(),
    run_id uuid NOT NULL,
    call_purpose text NOT NULL CHECK(call_purpose IN ('plan','answer')),
    model_name text NOT NULL,
    input_tokens integer NOT NULL CHECK(input_tokens>=0),
    output_tokens integer NOT NULL CHECK(output_tokens>=0),
    typed_plan jsonb,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,provenance_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id) ON DELETE CASCADE
  );
  ALTER TABLE runs.model_provenance ENABLE ROW LEVEL SECURITY;
  ALTER TABLE runs.model_provenance FORCE ROW LEVEL SECURITY;
  CREATE POLICY model_provenance_tenant_isolation ON runs.model_provenance
    USING(tenant_id=(SELECT current_setting('app.tenant_id',true)))
    WITH CHECK(tenant_id=(SELECT current_setting('app.tenant_id',true)));
  GRANT SELECT,INSERT ON runs.model_provenance TO si_app;
  GRANT SELECT,INSERT ON runs.model_provenance TO si_worker;
  CREATE INDEX model_provenance_by_run ON runs.model_provenance(tenant_id,run_id,created_at,provenance_id);`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE runs.model_provenance;');
}
