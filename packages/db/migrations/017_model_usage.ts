import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm:MigrationBuilder):Promise<void>{
  pgm.sql(`CREATE TABLE core.model_usage(
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      request_id uuid NOT NULL,
      model_alias text NOT NULL CHECK(model_alias IN ('cheap','default')),
      model_name text NOT NULL,
      input_tokens integer NOT NULL CHECK(input_tokens>=0),
      output_tokens integer NOT NULL CHECK(output_tokens>=0),
      cost_usd numeric(14,8) NOT NULL CHECK(cost_usd>=0),
      outcome text NOT NULL CHECK(outcome IN ('completed','failed','budget_rejected')),
      safe_error_code text,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,request_id)
    );
    CREATE INDEX model_usage_tenant_day ON core.model_usage(tenant_id,created_at);
    CREATE TABLE core.model_budget_reservations(
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      request_id uuid NOT NULL,
      estimated_tokens integer NOT NULL CHECK(estimated_tokens>0),
      reserved_cost_usd numeric(14,8) NOT NULL CHECK(reserved_cost_usd>=0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,request_id)
    );
    DO $$ BEGIN
      ALTER TABLE core.model_usage ENABLE ROW LEVEL SECURITY;ALTER TABLE core.model_usage FORCE ROW LEVEL SECURITY;
      CREATE POLICY model_usage_tenant ON core.model_usage USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),''))) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
      ALTER TABLE core.model_budget_reservations ENABLE ROW LEVEL SECURITY;ALTER TABLE core.model_budget_reservations FORCE ROW LEVEL SECURITY;
      CREATE POLICY model_reservations_tenant ON core.model_budget_reservations USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),''))) WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
    END $$;
    GRANT SELECT,INSERT ON core.model_usage TO si_app;
    GRANT SELECT,INSERT,DELETE ON core.model_budget_reservations TO si_app;
    CREATE FUNCTION core.reject_model_usage_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'model usage is append only'; END $$;
    CREATE TRIGGER model_usage_immutable BEFORE UPDATE OR DELETE ON core.model_usage FOR EACH ROW EXECUTE FUNCTION core.reject_model_usage_mutation();`);
}

export async function down(pgm:MigrationBuilder):Promise<void>{
  pgm.sql(`DROP TABLE core.model_budget_reservations,core.model_usage;DROP FUNCTION core.reject_model_usage_mutation();`);
}
