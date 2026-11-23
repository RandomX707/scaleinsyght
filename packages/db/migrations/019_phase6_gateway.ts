import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE SCHEMA gateway;
    CREATE TABLE gateway.enrollments (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      enrollment_id uuid NOT NULL DEFAULT gen_random_uuid(),
      source_connection_id uuid NOT NULL,
      token_hash bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,enrollment_id),
      UNIQUE (tenant_id,token_hash),
      FOREIGN KEY (tenant_id,source_connection_id) REFERENCES registry.connections(tenant_id,connection_id),
      FOREIGN KEY (tenant_id,created_by) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE gateway.clients (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      gateway_id uuid NOT NULL DEFAULT gen_random_uuid(),
      source_connection_id uuid NOT NULL,
      credential_hash bytea NOT NULL,
      last_seen_at timestamptz,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,gateway_id),
      UNIQUE (tenant_id,credential_hash)
      ,FOREIGN KEY (tenant_id,source_connection_id) REFERENCES registry.connections(tenant_id,connection_id)
    );
    CREATE TABLE gateway.requests (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      request_id uuid NOT NULL DEFAULT gen_random_uuid(),
      gateway_id uuid NOT NULL,
      source_connection_id uuid NOT NULL,
      plan jsonb NOT NULL,
      state text NOT NULL DEFAULT 'queued' CHECK(state IN ('queued','leased','completed','failed','expired')),
      lease_token uuid,
      lease_expires_at timestamptz,
      attempts integer NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
      result jsonb,
      result_hash bytea,
      safe_failure_code text CHECK(safe_failure_code IS NULL OR safe_failure_code ~ '^[a-z0-9_]{1,64}$'),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,request_id),
      FOREIGN KEY (tenant_id,gateway_id) REFERENCES gateway.clients(tenant_id,gateway_id)
      ,FOREIGN KEY (tenant_id,source_connection_id) REFERENCES registry.connections(tenant_id,connection_id)
    );
    CREATE INDEX gateway_requests_poll ON gateway.requests(tenant_id,gateway_id,state,created_at);
    CREATE TABLE gateway.events (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      gateway_id uuid,
      request_id uuid,
      event_type text NOT NULL CHECK(event_type IN ('gateway_enrollment_created','gateway_claimed','gateway_revoked','gateway_request_claimed','gateway_request_completed','gateway_request_failed','gateway_request_expired')),
      safe_status text NOT NULL CHECK(safe_status ~ '^[a-z0-9_]{1,64}$'),
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,event_id)
    );
    CREATE FUNCTION gateway.reject_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'gateway events are append only'; END $$;
    CREATE TRIGGER gateway_events_immutable BEFORE UPDATE OR DELETE ON gateway.events FOR EACH ROW EXECUTE FUNCTION gateway.reject_event_mutation();
    DO $$ DECLARE t text; BEGIN
      FOREACH t IN ARRAY ARRAY['enrollments','clients','requests','events'] LOOP
        EXECUTE format('ALTER TABLE gateway.%I ENABLE ROW LEVEL SECURITY',t);
        EXECUTE format('ALTER TABLE gateway.%I FORCE ROW LEVEL SECURITY',t);
        EXECUTE format('CREATE POLICY %I ON gateway.%I USING (tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),''''))) WITH CHECK (tenant_id=(SELECT nullif(current_setting(''app.tenant_id'',true),'''')))',t||'_tenant',t);
      END LOOP;
    END $$;
    GRANT USAGE ON SCHEMA gateway TO si_app;
    GRANT SELECT,INSERT,UPDATE ON gateway.enrollments,gateway.clients,gateway.requests TO si_app;
    GRANT SELECT,INSERT ON gateway.events TO si_app;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP SCHEMA gateway CASCADE;`);
}
