import type { MigrationBuilder } from 'node-pg-migrate';

export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE registry.connection_controls (
      tenant_id text NOT NULL, connection_id uuid NOT NULL,
      policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
      known_objects text[] NOT NULL,
      revision integer NOT NULL CHECK (revision>0),
      PRIMARY KEY(tenant_id,connection_id),
      FOREIGN KEY(tenant_id,connection_id) REFERENCES registry.connections(tenant_id,connection_id)
    );
    CREATE TABLE registry.control_changes (
      tenant_id text NOT NULL, change_id uuid NOT NULL DEFAULT gen_random_uuid(), connection_id uuid NOT NULL,
      base_revision integer NOT NULL CHECK (base_revision>=0),
      proposed_by uuid, proposed_at timestamptz NOT NULL DEFAULT now(),
      policy jsonb NOT NULL CHECK (jsonb_typeof(policy)='object'),
      overrides jsonb NOT NULL CHECK (jsonb_typeof(overrides)='array'),
      known_objects text[] NOT NULL,
      status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
      decided_by uuid, decided_at timestamptz,
      CHECK ((status='pending')=(decided_at IS NULL AND decided_by IS NULL)),
      PRIMARY KEY(tenant_id,change_id),
      FOREIGN KEY(tenant_id,connection_id) REFERENCES registry.connections(tenant_id,connection_id),
      FOREIGN KEY(tenant_id,proposed_by) REFERENCES core.users(tenant_id,user_id),
      FOREIGN KEY(tenant_id,decided_by) REFERENCES core.users(tenant_id,user_id)
    );
    ALTER TABLE registry.connection_controls ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registry.connection_controls FORCE ROW LEVEL SECURITY;
    ALTER TABLE registry.control_changes ENABLE ROW LEVEL SECURITY;
    ALTER TABLE registry.control_changes FORCE ROW LEVEL SECURITY;
    CREATE POLICY controls_tenant ON registry.connection_controls
      USING (tenant_id=(SELECT current_setting('app.tenant_id',true)))
      WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
    CREATE POLICY control_changes_tenant ON registry.control_changes
      USING (tenant_id=(SELECT current_setting('app.tenant_id',true)))
      WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
    GRANT SELECT,INSERT,UPDATE ON registry.connection_controls,registry.control_changes TO si_app;
    GRANT SELECT ON registry.connection_controls TO si_worker;
    GRANT SELECT,INSERT ON registry.control_changes TO si_worker;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE registry.control_changes,registry.connection_controls');
}
