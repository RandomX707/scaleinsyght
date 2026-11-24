import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`CREATE TABLE runs.conversations (
    tenant_id text NOT NULL,
    conversation_id uuid NOT NULL DEFAULT gen_random_uuid(),
    principal_id uuid NOT NULL,
    title text NOT NULL DEFAULT 'New chat',
    created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,conversation_id),
    FOREIGN KEY(tenant_id,principal_id) REFERENCES core.users(tenant_id,user_id)
  );
  ALTER TABLE runs.conversations ENABLE ROW LEVEL SECURITY;
  ALTER TABLE runs.conversations FORCE ROW LEVEL SECURITY;
  CREATE POLICY conversations_tenant ON runs.conversations
    USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')))
    WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
  GRANT SELECT,INSERT,UPDATE ON runs.conversations TO si_app,si_worker;
  CREATE INDEX conversations_recent_by_owner ON runs.conversations(tenant_id,principal_id,updated_at DESC,conversation_id);
  ALTER TABLE runs.runs ADD COLUMN conversation_id uuid;
  ALTER TABLE runs.runs ADD CONSTRAINT runs_conversation_fk
    FOREIGN KEY(tenant_id,conversation_id) REFERENCES runs.conversations(tenant_id,conversation_id);
  CREATE INDEX runs_by_conversation ON runs.runs(tenant_id,conversation_id,created_at,run_id) WHERE conversation_id IS NOT NULL;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP INDEX runs.runs_by_conversation;
  ALTER TABLE runs.runs DROP CONSTRAINT runs_conversation_fk;
  ALTER TABLE runs.runs DROP COLUMN conversation_id;
  DROP TABLE runs.conversations;`);
}
