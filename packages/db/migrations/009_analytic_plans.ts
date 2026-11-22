import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE runs.analytic_plans (
    tenant_id text NOT NULL, run_id uuid NOT NULL, plan jsonb NOT NULL,
    plan_hash text NOT NULL CHECK(plan_hash ~ '^[a-f0-9]{64}$'),
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,run_id), FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id)
  );
  ALTER TABLE runs.analytic_plans ENABLE ROW LEVEL SECURITY;
  ALTER TABLE runs.analytic_plans FORCE ROW LEVEL SECURITY;
  CREATE POLICY analytic_plans_tenant ON runs.analytic_plans
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),''))
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),''));
  GRANT SELECT,INSERT ON runs.analytic_plans TO si_app,si_worker;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql('DROP TABLE runs.analytic_plans;');
}
