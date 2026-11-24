import type { MigrationBuilder } from 'node-pg-migrate';

// Idempotent question submission: each send carries a client-generated request id. The first send claims the id;
// a duplicate (double click, retry, network replay) gets the same run and conversation instead of new ones.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`CREATE TABLE runs.run_requests (
    tenant_id text NOT NULL,
    principal_id uuid NOT NULL,
    request_id uuid NOT NULL,
    run_id uuid,
    conversation_id uuid,
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,principal_id,request_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id)
  );
  ALTER TABLE runs.run_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE runs.run_requests FORCE ROW LEVEL SECURITY;
  CREATE POLICY run_request_tenant ON runs.run_requests
    USING (tenant_id=(SELECT current_setting('app.tenant_id',true)))
    WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
  GRANT SELECT,INSERT,UPDATE,DELETE ON runs.run_requests TO si_app;`);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE runs.run_requests');
}
