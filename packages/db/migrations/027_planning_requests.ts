import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`CREATE TABLE runs.planning_requests (
    tenant_id text NOT NULL,
    run_id uuid NOT NULL,
    question text NOT NULL,
    sources jsonb NOT NULL,
    context jsonb NOT NULL,
    PRIMARY KEY(tenant_id,run_id),
    FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id)
  );
  ALTER TABLE runs.planning_requests ENABLE ROW LEVEL SECURITY;
  ALTER TABLE runs.planning_requests FORCE ROW LEVEL SECURITY;
  CREATE POLICY planning_request_tenant ON runs.planning_requests
    USING (tenant_id=(SELECT current_setting('app.tenant_id',true)))
    WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
  GRANT SELECT,INSERT ON runs.planning_requests TO si_app;
  GRANT SELECT ON runs.planning_requests TO si_worker;`);
}
export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE runs.planning_requests');
}
