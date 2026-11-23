import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE core.oidc_providers (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      provider_id uuid NOT NULL DEFAULT gen_random_uuid(),
      issuer text NOT NULL,
      client_id text NOT NULL,
      client_secret_ref text NOT NULL,
      allowed_email_domains text[] NOT NULL DEFAULT '{}',
      enabled boolean NOT NULL DEFAULT false,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, provider_id),
      UNIQUE (tenant_id),
      CHECK (issuer ~ '^https://[^[:space:]]+$'),
      CHECK (client_secret_ref ~ '^[A-Z][A-Z0-9_]{2,127}$')
    );

    CREATE TABLE core.external_identities (
      tenant_id text NOT NULL,
      issuer text NOT NULL,
      subject_hash bytea NOT NULL,
      user_id uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, issuer, subject_hash),
      FOREIGN KEY (tenant_id, user_id) REFERENCES core.users(tenant_id, user_id)
    );

    CREATE TABLE core.oidc_login_states (
      tenant_id text NOT NULL,
      state_hash bytea NOT NULL,
      provider_id uuid NOT NULL,
      expires_at timestamptz NOT NULL,
      consumed_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id, state_hash),
      FOREIGN KEY (tenant_id, provider_id) REFERENCES core.oidc_providers(tenant_id, provider_id)
    );

    ALTER TABLE core.oidc_providers ENABLE ROW LEVEL SECURITY;
    ALTER TABLE core.oidc_providers FORCE ROW LEVEL SECURITY;
    CREATE POLICY oidc_providers_tenant ON core.oidc_providers
      USING (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')))
      WITH CHECK (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
    ALTER TABLE core.external_identities ENABLE ROW LEVEL SECURITY;
    ALTER TABLE core.external_identities FORCE ROW LEVEL SECURITY;
    CREATE POLICY external_identities_tenant ON core.external_identities
      USING (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')))
      WITH CHECK (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
    ALTER TABLE core.oidc_login_states ENABLE ROW LEVEL SECURITY;
    ALTER TABLE core.oidc_login_states FORCE ROW LEVEL SECURITY;
    CREATE POLICY oidc_login_states_tenant ON core.oidc_login_states
      USING (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')))
      WITH CHECK (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));

    GRANT SELECT,INSERT,UPDATE ON core.oidc_providers,core.external_identities,core.oidc_login_states TO si_app;
    ALTER TABLE core.activity_events DROP CONSTRAINT activity_events_event_type_check;
    ALTER TABLE core.activity_events ADD CONSTRAINT activity_events_event_type_check
      CHECK (event_type IN ('user_active','connector_activated','connector_retired','sso_provider_configured','sso_login_succeeded','sso_login_failed'));
    ALTER TABLE core.activity_events ADD COLUMN sso_provider_id uuid;
    ALTER TABLE core.activity_events ADD COLUMN safe_error_code text CHECK (safe_error_code IS NULL OR safe_error_code ~ '^[a-z0-9_]{1,64}$');
    CREATE FUNCTION core.reject_activity_event_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'activity events are append only'; END $$;
    CREATE TRIGGER activity_events_immutable BEFORE UPDATE OR DELETE ON core.activity_events FOR EACH ROW EXECUTE FUNCTION core.reject_activity_event_mutation();
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE core.activity_events DROP CONSTRAINT activity_events_event_type_check;
    ALTER TABLE core.activity_events ADD CONSTRAINT activity_events_event_type_check
      CHECK (event_type IN ('user_active','connector_activated','connector_retired'));
    ALTER TABLE core.activity_events DROP COLUMN safe_error_code;
    ALTER TABLE core.activity_events DROP COLUMN sso_provider_id;
    DROP TRIGGER activity_events_immutable ON core.activity_events;
    DROP FUNCTION core.reject_activity_event_mutation();
    DROP TABLE core.oidc_login_states;
    DROP TABLE core.external_identities;
    DROP TABLE core.oidc_providers;
  `);
}
