import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE core.users ADD COLUMN display_name text NOT NULL DEFAULT '';

    CREATE TABLE core.tenant_invites (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      invite_id uuid NOT NULL DEFAULT gen_random_uuid(),
      email text NOT NULL CHECK (email=lower(email)),
      token_hash bytea NOT NULL,
      expires_at timestamptz NOT NULL,
      accepted_at timestamptz,
      accepted_by uuid,
      created_by uuid NOT NULL,
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,invite_id),
      UNIQUE (tenant_id,token_hash),
      FOREIGN KEY (tenant_id,created_by) REFERENCES core.users(tenant_id,user_id),
      FOREIGN KEY (tenant_id,accepted_by) REFERENCES core.users(tenant_id,user_id),
      CHECK ((accepted_at IS NULL)=(accepted_by IS NULL))
    );
    CREATE INDEX tenant_invites_pending_by_email ON core.tenant_invites(tenant_id,email,expires_at) WHERE accepted_at IS NULL;

    ALTER TABLE core.tenant_invites ENABLE ROW LEVEL SECURITY;
    ALTER TABLE core.tenant_invites FORCE ROW LEVEL SECURITY;
    CREATE POLICY tenant_invites_tenant ON core.tenant_invites
      USING (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')))
      WITH CHECK (tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
    GRANT SELECT,INSERT,UPDATE ON core.tenant_invites TO si_app;

    ALTER TABLE core.activity_events DROP CONSTRAINT activity_events_event_type_check;
    ALTER TABLE core.activity_events ADD CONSTRAINT activity_events_event_type_check
      CHECK (event_type IN ('user_active','connector_activated','connector_retired','sso_provider_configured','sso_login_succeeded','sso_login_failed','member_invited','member_joined'));
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    ALTER TABLE core.activity_events DROP CONSTRAINT activity_events_event_type_check;
    ALTER TABLE core.activity_events ADD CONSTRAINT activity_events_event_type_check
      CHECK (event_type IN ('user_active','connector_activated','connector_retired','sso_provider_configured','sso_login_succeeded','sso_login_failed'));
    DROP TABLE core.tenant_invites;
    ALTER TABLE core.users DROP COLUMN display_name;
  `);
}
