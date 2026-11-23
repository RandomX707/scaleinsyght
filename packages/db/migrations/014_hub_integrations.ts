import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE SCHEMA hub AUTHORIZATION si_migrate;

    CREATE TABLE hub.adapters (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      adapter_id uuid NOT NULL DEFAULT gen_random_uuid(),
      product text NOT NULL CHECK(product IN ('data_studio','semantics')),
      connected boolean NOT NULL DEFAULT false,
      current_version integer NOT NULL CHECK(current_version>0),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,product),
      UNIQUE(tenant_id,adapter_id)
    );
    CREATE TABLE hub.adapter_versions (
      tenant_id text NOT NULL,
      product text NOT NULL,
      version integer NOT NULL CHECK(version>0),
      fixture_key text NOT NULL CHECK(fixture_key ~ '^[a-z0-9-]{1,100}$'),
      capabilities jsonb NOT NULL CHECK(jsonb_typeof(capabilities)='array'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,product,version),
      FOREIGN KEY(tenant_id,product) REFERENCES hub.adapters(tenant_id,product)
    );
    ALTER TABLE hub.adapters ADD CONSTRAINT hub_adapter_current_version_fk
      FOREIGN KEY(tenant_id,product,current_version) REFERENCES hub.adapter_versions(tenant_id,product,version) DEFERRABLE INITIALLY DEFERRED;

    CREATE TABLE hub.certified_metrics (
      tenant_id text NOT NULL,
      metric_id text NOT NULL CHECK(metric_id ~ '^[a-z][a-z0-9_]{0,99}$'),
      adapter_product text NOT NULL DEFAULT 'semantics' CHECK(adapter_product='semantics'),
      adapter_version integer NOT NULL CHECK(adapter_version>0),
      name text NOT NULL,
      description text NOT NULL,
      dimensions jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(dimensions)='array'),
      unit text NOT NULL,
      certified boolean NOT NULL,
      fixture_key text NOT NULL CHECK(fixture_key ~ '^[a-z0-9-]{1,100}$'),
      source_asset text NOT NULL,
      PRIMARY KEY(tenant_id,metric_id),
      FOREIGN KEY(tenant_id,adapter_product,adapter_version) REFERENCES hub.adapter_versions(tenant_id,product,version)
    );
    CREATE TABLE hub.metric_results (
      tenant_id text NOT NULL,
      run_id uuid NOT NULL,
      metric_id text NOT NULL,
      adapter_version integer NOT NULL,
      result_value numeric NOT NULL,
      unit text NOT NULL,
      evidence_metadata jsonb NOT NULL CHECK(jsonb_typeof(evidence_metadata)='object'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,run_id,metric_id),
      FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id),
      FOREIGN KEY(tenant_id,metric_id) REFERENCES hub.certified_metrics(tenant_id,metric_id)
    );

    CREATE TABLE hub.flowspecs (
      tenant_id text NOT NULL,
      flowspec_id uuid NOT NULL DEFAULT gen_random_uuid(),
      owner_id uuid NOT NULL,
      latest_version integer NOT NULL DEFAULT 0 CHECK(latest_version>=0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,flowspec_id),
      FOREIGN KEY(tenant_id,owner_id) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE hub.flowspec_versions (
      tenant_id text NOT NULL,
      flowspec_id uuid NOT NULL,
      version integer NOT NULL CHECK(version>0),
      payload jsonb NOT NULL CHECK(jsonb_typeof(payload)='object'),
      subject_hash text NOT NULL CHECK(subject_hash ~ '^[a-f0-9]{64}$'),
      source_snapshot_ids jsonb NOT NULL CHECK(jsonb_typeof(source_snapshot_ids)='array'),
      policy_version text NOT NULL,
      created_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,flowspec_id,version),
      UNIQUE(tenant_id,flowspec_id,version,subject_hash),
      FOREIGN KEY(tenant_id,flowspec_id) REFERENCES hub.flowspecs(tenant_id,flowspec_id),
      FOREIGN KEY(tenant_id,created_by) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE hub.flowspec_approvals (
      tenant_id text NOT NULL,
      approval_id uuid NOT NULL DEFAULT gen_random_uuid(),
      flowspec_id uuid NOT NULL,
      version integer NOT NULL,
      subject_hash text NOT NULL,
      source_snapshot_hash text NOT NULL CHECK(source_snapshot_hash ~ '^[a-f0-9]{64}$'),
      policy_version text NOT NULL,
      requested_by uuid NOT NULL,
      approved_by uuid,
      status text NOT NULL CHECK(status IN ('pending','approved','rejected','expired')),
      expires_at timestamptz NOT NULL,
      decided_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,approval_id),
      UNIQUE(tenant_id,flowspec_id,version,subject_hash),
      FOREIGN KEY(tenant_id,flowspec_id,version,subject_hash) REFERENCES hub.flowspec_versions(tenant_id,flowspec_id,version,subject_hash),
      FOREIGN KEY(tenant_id,requested_by) REFERENCES core.users(tenant_id,user_id),
      FOREIGN KEY(tenant_id,approved_by) REFERENCES core.users(tenant_id,user_id),
      CHECK((status='pending' AND approved_by IS NULL AND decided_at IS NULL) OR (status<>'pending' AND decided_at IS NOT NULL))
    );
    CREATE TABLE hub.handoff_grants (
      tenant_id text NOT NULL,
      grant_id uuid NOT NULL DEFAULT gen_random_uuid(),
      approval_id uuid NOT NULL,
      flowspec_id uuid NOT NULL,
      version integer NOT NULL,
      subject_hash text NOT NULL,
      single_use boolean NOT NULL DEFAULT true CHECK(single_use),
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      idempotency_key text NOT NULL CHECK(length(idempotency_key) BETWEEN 1 AND 200),
      PRIMARY KEY(tenant_id,grant_id),
      UNIQUE(tenant_id,approval_id),
      UNIQUE(tenant_id,idempotency_key),
      FOREIGN KEY(tenant_id,approval_id) REFERENCES hub.flowspec_approvals(tenant_id,approval_id),
      FOREIGN KEY(tenant_id,flowspec_id,version,subject_hash) REFERENCES hub.flowspec_versions(tenant_id,flowspec_id,version,subject_hash)
    );
    CREATE TABLE hub.handoffs (
      tenant_id text NOT NULL,
      handoff_id uuid NOT NULL DEFAULT gen_random_uuid(),
      grant_id uuid NOT NULL,
      flowspec_id uuid NOT NULL,
      version integer NOT NULL,
      run_id uuid,
      step_id uuid,
      outbox_message_id uuid,
      idempotency_key text NOT NULL,
      payload_hash text NOT NULL CHECK(payload_hash ~ '^[a-f0-9]{64}$'),
      status text NOT NULL CHECK(status IN ('pending','confirmed','unknown','reconciled','rejected')),
      receiver_ref text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      confirmed_at timestamptz,
      PRIMARY KEY(tenant_id,handoff_id),
      UNIQUE(tenant_id,idempotency_key),
      FOREIGN KEY(tenant_id,grant_id) REFERENCES hub.handoff_grants(tenant_id,grant_id),
      FOREIGN KEY(tenant_id,flowspec_id,version) REFERENCES hub.flowspec_versions(tenant_id,flowspec_id,version),
      FOREIGN KEY(tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id),
      FOREIGN KEY(tenant_id,run_id,step_id) REFERENCES runs.steps(tenant_id,run_id,step_id),
      FOREIGN KEY(tenant_id,outbox_message_id) REFERENCES runs.outbox(tenant_id,message_id),
      CHECK((status IN ('confirmed','reconciled') AND confirmed_at IS NOT NULL AND receiver_ref IS NOT NULL)
         OR status NOT IN ('confirmed','reconciled'))
    );

    CREATE INDEX hub_metrics_certified ON hub.certified_metrics(tenant_id,certified,metric_id);
    CREATE INDEX hub_flow_approval_queue ON hub.flowspec_approvals(tenant_id,status,expires_at);
    CREATE INDEX hub_handoffs_reconcile ON hub.handoffs(tenant_id,status,created_at) WHERE status IN ('pending','unknown');

    CREATE FUNCTION hub.reject_immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Hub history is append only'; END $$;
    CREATE TRIGGER hub_adapter_versions_immutable BEFORE UPDATE OR DELETE ON hub.adapter_versions FOR EACH ROW EXECUTE FUNCTION hub.reject_immutable_history();
    CREATE TRIGGER hub_metric_results_immutable BEFORE UPDATE OR DELETE ON hub.metric_results FOR EACH ROW EXECUTE FUNCTION hub.reject_immutable_history();
    CREATE TRIGGER hub_flowspec_versions_immutable BEFORE UPDATE OR DELETE ON hub.flowspec_versions FOR EACH ROW EXECUTE FUNCTION hub.reject_immutable_history();
    CREATE TRIGGER hub_approvals_immutable BEFORE DELETE ON hub.flowspec_approvals FOR EACH ROW EXECUTE FUNCTION hub.reject_immutable_history();
    CREATE TRIGGER hub_grants_immutable BEFORE DELETE ON hub.handoff_grants FOR EACH ROW EXECUTE FUNCTION hub.reject_immutable_history();

    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['adapters','adapter_versions','certified_metrics','metric_results','flowspecs','flowspec_versions','flowspec_approvals','handoff_grants','handoffs'] LOOP
        EXECUTE format('ALTER TABLE hub.%I ENABLE ROW LEVEL SECURITY',table_name);
        EXECUTE format('ALTER TABLE hub.%I FORCE ROW LEVEL SECURITY',table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON hub.%I USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),''''))) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'',true),'''')))',table_name);
      END LOOP;
    END $$;
    GRANT USAGE ON SCHEMA hub TO si_app,si_worker;
    GRANT SELECT,INSERT,UPDATE ON hub.adapters,hub.certified_metrics,hub.flowspecs,hub.flowspec_approvals,hub.handoff_grants,hub.handoffs TO si_app;
    GRANT SELECT,INSERT ON hub.adapter_versions,hub.metric_results,hub.flowspec_versions TO si_app;
    GRANT SELECT ON hub.adapters,hub.adapter_versions,hub.certified_metrics,hub.flowspecs,hub.flowspec_versions,hub.flowspec_approvals,hub.handoff_grants,hub.handoffs TO si_worker;
    GRANT INSERT ON hub.metric_results TO si_worker;
    GRANT UPDATE ON hub.adapters,hub.handoff_grants,hub.handoffs TO si_worker;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP SCHEMA hub CASCADE;
  `);
}
