import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE SCHEMA core AUTHORIZATION si_migrate;
    CREATE SCHEMA registry AUTHORIZATION si_migrate;
    CREATE SCHEMA runs AUTHORIZATION si_migrate;

    CREATE TABLE core.tenants (
      tenant_id text PRIMARY KEY,
      name text NOT NULL,
      connector_allowance integer NOT NULL DEFAULT 10 CHECK (connector_allowance >= 0),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp()
    );
    CREATE TABLE core.users (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      user_id uuid NOT NULL DEFAULT gen_random_uuid(),
      email text NOT NULL,
      password_hash text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, user_id),
      UNIQUE (tenant_id, email)
    );
    CREATE TABLE core.sessions (
      tenant_id text NOT NULL,
      session_id uuid NOT NULL DEFAULT gen_random_uuid(),
      user_id uuid NOT NULL,
      token_hash bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      revoked_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, session_id),
      UNIQUE (token_hash),
      FOREIGN KEY (tenant_id, user_id) REFERENCES core.users(tenant_id, user_id)
    );
    CREATE TABLE core.entitlements (
      tenant_id text NOT NULL,
      entitlement_id uuid NOT NULL DEFAULT gen_random_uuid(),
      principal_id uuid NOT NULL,
      capability_id text NOT NULL,
      resource_id text,
      allowed boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, entitlement_id),
      FOREIGN KEY (tenant_id, principal_id) REFERENCES core.users(tenant_id, user_id)
    );
    CREATE TABLE core.activity_events (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      event_type text NOT NULL CHECK (event_type IN ('user_active', 'connector_activated', 'connector_retired')),
      principal_id uuid,
      connector_id uuid,
      connector_type text,
      occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, event_id)
    );

    CREATE TABLE registry.capabilities (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      capability_id text NOT NULL,
      active_version integer NOT NULL,
      effect_class text NOT NULL CHECK (effect_class IN ('READ','MUTATION','DEPLOY','RELEASE','IRREVERSIBLE')),
      effect_safety text NOT NULL CHECK (effect_safety IN ('not_applicable','idempotent_key','status_lookup','none')),
      enabled boolean NOT NULL DEFAULT false,
      PRIMARY KEY (tenant_id, capability_id)
    );
    CREATE TABLE registry.capability_versions (
      tenant_id text NOT NULL,
      capability_id text NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      input_schema jsonb NOT NULL,
      output_schema jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, capability_id, version),
      FOREIGN KEY (tenant_id, capability_id) REFERENCES registry.capabilities(tenant_id, capability_id)
    );
    CREATE TABLE registry.agents (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      agent_id uuid NOT NULL DEFAULT gen_random_uuid(),
      agent_type text NOT NULL CHECK (agent_type IN ('personal','orchestrator','collating','connector','id','id_trace','governed','action_executor')),
      active_version integer NOT NULL DEFAULT 1,
      status text NOT NULL CHECK (status IN ('draft','approved','active','retired')),
      owner_id uuid,
      connection_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id),
      FOREIGN KEY (tenant_id, owner_id) REFERENCES core.users(tenant_id, user_id)
    );
    CREATE TABLE registry.agent_versions (
      tenant_id text NOT NULL,
      agent_id uuid NOT NULL,
      version integer NOT NULL CHECK (version > 0),
      capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
      bindings jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, agent_id, version),
      FOREIGN KEY (tenant_id, agent_id) REFERENCES registry.agents(tenant_id, agent_id)
    );
    CREATE TABLE registry.connections (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      connection_id uuid NOT NULL DEFAULT gen_random_uuid(),
      connector_type text NOT NULL CHECK (connector_type IN ('sql_server','postgres','snowflake','excel','dbt','tableau','power_bi')),
      status text NOT NULL CHECK (status IN ('draft','active','retired')),
      connector_agent_id uuid,
      source_group_id uuid,
      source_group_version integer,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, connection_id),
      UNIQUE (tenant_id, connector_agent_id),
      FOREIGN KEY (tenant_id, connector_agent_id) REFERENCES registry.agents(tenant_id, agent_id)
    );
    CREATE TABLE registry.source_groups (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      source_group_id uuid NOT NULL DEFAULT gen_random_uuid(),
      version integer NOT NULL DEFAULT 1 CHECK (version > 0),
      proposed_by text NOT NULL CHECK (proposed_by IN ('profiler','person')),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, source_group_id, version)
    );
    CREATE TABLE registry.source_group_members (
      tenant_id text NOT NULL,
      source_group_id uuid NOT NULL,
      group_version integer NOT NULL,
      connection_id uuid NOT NULL,
      valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
      valid_to timestamptz,
      PRIMARY KEY (tenant_id, source_group_id, group_version, connection_id),
      FOREIGN KEY (tenant_id, source_group_id, group_version) REFERENCES registry.source_groups(tenant_id, source_group_id, version),
      FOREIGN KEY (tenant_id, connection_id) REFERENCES registry.connections(tenant_id, connection_id)
    );
    CREATE UNIQUE INDEX source_group_one_current_membership
      ON registry.source_group_members(tenant_id, connection_id) WHERE valid_to IS NULL;

    CREATE TABLE runs.runs (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      run_id uuid NOT NULL DEFAULT gen_random_uuid(),
      principal_id uuid NOT NULL,
      parent_run_id uuid,
      state text NOT NULL CHECK (state IN ('CREATED','PLANNING','PLAN_VALIDATED','RUNNING','AWAITING_APPROVAL','FINALISING','COMPLETED','PARTIAL','FAILED','CANCELLED','EXPIRED','POLICY_BLOCKED')),
      state_version integer NOT NULL DEFAULT 0,
      plan_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, run_id),
      FOREIGN KEY (tenant_id, principal_id) REFERENCES core.users(tenant_id, user_id),
      FOREIGN KEY (tenant_id, parent_run_id) REFERENCES runs.runs(tenant_id, run_id)
    );
    CREATE TABLE runs.steps (
      tenant_id text NOT NULL,
      run_id uuid NOT NULL,
      step_id uuid NOT NULL DEFAULT gen_random_uuid(),
      step_order integer NOT NULL,
      capability_id text NOT NULL,
      capability_version integer NOT NULL,
      agent_id uuid NOT NULL,
      state text NOT NULL CHECK (state IN ('PENDING','CLAIMED','RUNNING','SUCCEEDED','FAILED','BLOCKED','CANCELLED','OUTCOME_UNKNOWN')),
      attempt integer NOT NULL DEFAULT 0,
      fencing_token bigint NOT NULL DEFAULT 0,
      lease_owner text,
      lease_expires_at timestamptz,
      idempotency_key text NOT NULL,
      result_ref text,
      reused_from_run_id uuid,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, run_id, step_id),
      UNIQUE (tenant_id, run_id, step_order),
      FOREIGN KEY (tenant_id, run_id) REFERENCES runs.runs(tenant_id, run_id),
      FOREIGN KEY (tenant_id, agent_id) REFERENCES registry.agents(tenant_id, agent_id)
    );
    CREATE TABLE runs.authz_decisions (
      tenant_id text NOT NULL,
      decision_id uuid NOT NULL DEFAULT gen_random_uuid(),
      run_id uuid,
      principal_id uuid NOT NULL,
      capability_id text NOT NULL,
      outcome text NOT NULL CHECK (outcome IN ('allow','deny','require_approval')),
      policy_version text NOT NULL,
      reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, decision_id),
      FOREIGN KEY (tenant_id, run_id) REFERENCES runs.runs(tenant_id, run_id),
      FOREIGN KEY (tenant_id, principal_id) REFERENCES core.users(tenant_id, user_id)
    );
    CREATE TABLE runs.events (
      tenant_id text NOT NULL,
      run_id uuid NOT NULL,
      event_id uuid NOT NULL DEFAULT gen_random_uuid(),
      step_id uuid,
      sequence bigint NOT NULL CHECK (sequence > 0),
      event_type text NOT NULL,
      at timestamptz NOT NULL DEFAULT clock_timestamp(),
      fencing_token bigint,
      safe_payload jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(safe_payload) = 'object'),
      decision_id uuid,
      trace_id uuid NOT NULL DEFAULT gen_random_uuid(),
      PRIMARY KEY (tenant_id, run_id, sequence),
      UNIQUE (event_id),
      FOREIGN KEY (tenant_id, run_id) REFERENCES runs.runs(tenant_id, run_id),
      FOREIGN KEY (tenant_id, run_id, step_id) REFERENCES runs.steps(tenant_id, run_id, step_id),
      FOREIGN KEY (tenant_id, decision_id) REFERENCES runs.authz_decisions(tenant_id, decision_id)
    );
    CREATE TABLE runs.outbox (
      tenant_id text NOT NULL,
      message_id uuid NOT NULL DEFAULT gen_random_uuid(),
      run_id uuid NOT NULL,
      destination text NOT NULL,
      payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
      sent_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, message_id),
      FOREIGN KEY (tenant_id, run_id) REFERENCES runs.runs(tenant_id, run_id)
    );

    DO $$
    DECLARE table_row record;
    BEGIN
      FOR table_row IN
        SELECT schemaname, tablename FROM pg_tables
        WHERE schemaname IN ('core','registry','runs')
      LOOP
        EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', table_row.schemaname, table_row.tablename);
        EXECUTE format('ALTER TABLE %I.%I FORCE ROW LEVEL SECURITY', table_row.schemaname, table_row.tablename);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON %I.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',
          table_row.schemaname, table_row.tablename
        );
      END LOOP;
    END $$;

    CREATE FUNCTION runs.reject_event_mutation() RETURNS trigger
      LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'run events are append-only'; END $$;
    CREATE TRIGGER run_events_append_only BEFORE UPDATE OR DELETE ON runs.events
      FOR EACH ROW EXECUTE FUNCTION runs.reject_event_mutation();

    GRANT USAGE ON SCHEMA core, registry, runs TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA registry GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA runs GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA core GRANT USAGE, SELECT ON SEQUENCES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA registry GRANT USAGE, SELECT ON SEQUENCES TO si_app, si_worker;
    ALTER DEFAULT PRIVILEGES IN SCHEMA runs GRANT USAGE, SELECT ON SEQUENCES TO si_app, si_worker;
    REVOKE UPDATE, DELETE ON runs.events FROM si_app, si_worker;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP SCHEMA runs CASCADE; DROP SCHEMA registry CASCADE; DROP SCHEMA core CASCADE;`);
}
