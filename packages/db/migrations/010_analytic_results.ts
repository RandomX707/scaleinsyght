import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE runs.analytic_results (
    tenant_id text NOT NULL, run_id uuid NOT NULL, step_id uuid NOT NULL,
    result jsonb NOT NULL CHECK(jsonb_typeof(result)='object'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,run_id,step_id),
    FOREIGN KEY(tenant_id,run_id,step_id) REFERENCES runs.steps(tenant_id,run_id,step_id)
  );
  CREATE TABLE runs.analytic_answers (
    tenant_id text NOT NULL, run_id uuid NOT NULL, status text NOT NULL CHECK(status IN ('COMPLETED','PARTIAL')),
    answer jsonb NOT NULL CHECK(jsonb_typeof(answer)='object'), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id)
  );
  ALTER TABLE runs.analytic_results ENABLE ROW LEVEL SECURITY; ALTER TABLE runs.analytic_results FORCE ROW LEVEL SECURITY;
  ALTER TABLE runs.analytic_answers ENABLE ROW LEVEL SECURITY; ALTER TABLE runs.analytic_answers FORCE ROW LEVEL SECURITY;
  CREATE POLICY analytic_results_tenant ON runs.analytic_results USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),''));
  CREATE POLICY analytic_answers_tenant ON runs.analytic_answers USING(tenant_id=nullif(current_setting('app.tenant_id',true),'')) WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),''));
  GRANT SELECT,INSERT ON runs.analytic_results,runs.analytic_answers TO si_app,si_worker;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE runs.analytic_answers,runs.analytic_results;');
}
