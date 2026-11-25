import type { MigrationBuilder } from 'node-pg-migrate';

// S6 (decision 48): findings from each profile run compared with the previous state, audited review of inferred
// sensitivity tags, and per-connection nightly refresh schedules that the worker claims across tenants.
const tenantPolicy = (table: string, name: string) => `
  ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY; ALTER TABLE ${table} FORCE ROW LEVEL SECURITY;
  CREATE POLICY ${name} ON ${table} USING (tenant_id=(SELECT current_setting('app.tenant_id',true))) WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));`;

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`CREATE TABLE profiler.findings (
    tenant_id text NOT NULL,
    finding_id uuid NOT NULL DEFAULT gen_random_uuid(),
    connection_id uuid NOT NULL,
    job_id uuid NOT NULL,
    kind text NOT NULL CHECK (kind IN ('schema_change','data_anomaly','new_tables','probable_relationship','id_match','sensitive_column')),
    subject text NOT NULL CHECK (length(subject) BETWEEN 1 AND 500),
    detail jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(detail)='object'),
    asset_id uuid,
    assertion_id uuid,
    found_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','approved','rejected')),
    decided_by uuid,
    decided_at timestamptz,
    PRIMARY KEY (tenant_id,finding_id),
    FOREIGN KEY (tenant_id,connection_id) REFERENCES registry.connections(tenant_id,connection_id),
    FOREIGN KEY (tenant_id,decided_by) REFERENCES core.users(tenant_id,user_id),
    CHECK ((status='open')=(decided_by IS NULL AND decided_at IS NULL))
  );
  CREATE INDEX profiler_findings_recent ON profiler.findings(tenant_id,found_at DESC);
  CREATE UNIQUE INDEX profiler_findings_one_per_assertion ON profiler.findings(tenant_id,assertion_id) WHERE assertion_id IS NOT NULL;
  ${tenantPolicy('profiler.findings', 'findings_tenant')}
  GRANT SELECT,INSERT,UPDATE ON profiler.findings TO si_app, si_worker;

  CREATE TABLE profiler.tag_reviews (
    tenant_id text NOT NULL,
    asset_id uuid NOT NULL,
    tag text NOT NULL CHECK (tag IN ('personal','regulated','identifier')),
    decision text NOT NULL CHECK (decision IN ('confirmed','dismissed')),
    decided_by uuid NOT NULL,
    decided_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    finding_id uuid,
    PRIMARY KEY (tenant_id,asset_id,tag),
    FOREIGN KEY (tenant_id,asset_id) REFERENCES graph.assets(tenant_id,asset_id),
    FOREIGN KEY (tenant_id,decided_by) REFERENCES core.users(tenant_id,user_id)
  );
  ${tenantPolicy('profiler.tag_reviews', 'tag_reviews_tenant')}
  GRANT SELECT,INSERT,UPDATE ON profiler.tag_reviews TO si_app;
  GRANT SELECT ON profiler.tag_reviews TO si_worker;

  CREATE TABLE profiler.nightly_schedules (
    tenant_id text NOT NULL,
    connection_id uuid NOT NULL,
    next_run_at timestamptz NOT NULL,
    last_started_at timestamptz,
    PRIMARY KEY (tenant_id,connection_id),
    FOREIGN KEY (tenant_id,connection_id) REFERENCES registry.connections(tenant_id,connection_id)
  );
  CREATE INDEX profiler_nightly_due ON profiler.nightly_schedules(next_run_at);
  ${tenantPolicy('profiler.nightly_schedules', 'nightly_tenant')}
  CREATE POLICY nightly_worker_claim ON profiler.nightly_schedules FOR ALL TO si_worker USING (current_setting('app.worker_claim',true)='enabled') WITH CHECK (current_setting('app.worker_claim',true)='enabled');
  GRANT SELECT,INSERT,UPDATE ON profiler.nightly_schedules TO si_app, si_worker;
  -- Every active database or workbook connection gets a nightly refresh, starting a day from now.
  INSERT INTO profiler.nightly_schedules(tenant_id,connection_id,next_run_at)
    SELECT tenant_id,connection_id,clock_timestamp()+interval '1 day' FROM registry.connections WHERE status='active' AND connector_type IN ('postgres','sql_server','excel','snowflake');`);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE profiler.nightly_schedules; DROP TABLE profiler.tag_reviews; DROP TABLE profiler.findings;');
}
