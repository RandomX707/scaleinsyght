import type { MigrationBuilder } from 'node-pg-migrate';

export const id = '008_analytic_mode';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`ALTER TABLE registry.personal_memories DROP COLUMN role_template;
    CREATE SCHEMA memory;
    GRANT USAGE ON SCHEMA memory TO si_app;
    CREATE TABLE memory.feedback (
      feedback_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      principal_id uuid NOT NULL, run_id uuid, question_hash bytea NOT NULL,
      verdict text NOT NULL CHECK (verdict IN ('useful','not_useful')),
      correction jsonb CHECK (correction IS NULL OR (jsonb_typeof(correction)='object' AND correction ?& ARRAY['term','meaning'] AND correction - ARRAY['term','meaning'] = '{}'::jsonb)),
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id,principal_id) REFERENCES core.users(tenant_id,user_id),
      FOREIGN KEY (tenant_id,run_id) REFERENCES runs.runs(tenant_id,run_id)
    );
    CREATE TABLE memory.evaluation_cases (
      case_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      principal_id uuid NOT NULL, question_hash bytea NOT NULL, expected_claims jsonb NOT NULL DEFAULT '[]',
      created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id,principal_id) REFERENCES core.users(tenant_id,user_id)
    );
    ALTER TABLE memory.feedback ENABLE ROW LEVEL SECURITY; ALTER TABLE memory.feedback FORCE ROW LEVEL SECURITY;
    ALTER TABLE memory.evaluation_cases ENABLE ROW LEVEL SECURITY; ALTER TABLE memory.evaluation_cases FORCE ROW LEVEL SECURITY;
    CREATE POLICY feedback_owner ON memory.feedback USING (tenant_id=current_setting('app.tenant_id',true) AND principal_id=current_setting('app.principal_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND principal_id=current_setting('app.principal_id',true)::uuid);
    CREATE POLICY evaluation_owner ON memory.evaluation_cases USING (tenant_id=current_setting('app.tenant_id',true) AND principal_id=current_setting('app.principal_id',true)::uuid) WITH CHECK (tenant_id=current_setting('app.tenant_id',true) AND principal_id=current_setting('app.principal_id',true)::uuid);
    CREATE TABLE registry.governed_definitions (
      tenant_id text NOT NULL, governed_id uuid NOT NULL DEFAULT gen_random_uuid(), owner_id uuid NOT NULL,
      name text NOT NULL, latest_version integer NOT NULL DEFAULT 0, PRIMARY KEY (tenant_id,governed_id),
      FOREIGN KEY (tenant_id,owner_id) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE registry.governed_versions (
      tenant_id text NOT NULL, governed_id uuid NOT NULL, version integer NOT NULL,
      plan jsonb NOT NULL, plan_hash text NOT NULL CHECK (plan_hash ~ '^[a-f0-9]{64}$'),
      created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,governed_id,version),
      FOREIGN KEY (tenant_id,governed_id) REFERENCES registry.governed_definitions(tenant_id,governed_id),
      FOREIGN KEY (tenant_id,created_by) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE registry.governed_approvals (
      tenant_id text NOT NULL, governed_id uuid NOT NULL, version integer NOT NULL,
      approved_by uuid NOT NULL, approved_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,governed_id,version),
      FOREIGN KEY (tenant_id,governed_id,version) REFERENCES registry.governed_versions(tenant_id,governed_id,version),
      FOREIGN KEY (tenant_id,approved_by) REFERENCES core.users(tenant_id,user_id)
    );
    CREATE TABLE registry.governed_events (
      event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL,
      governed_id uuid NOT NULL, version integer NOT NULL, event_type text NOT NULL CHECK(event_type IN ('draft_created','version_approved')),
      principal_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      FOREIGN KEY (tenant_id,governed_id,version) REFERENCES registry.governed_versions(tenant_id,governed_id,version)
    );
    CREATE FUNCTION registry.reject_governed_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'governed versions are immutable'; END $$;
    CREATE TRIGGER governed_version_immutable BEFORE UPDATE OR DELETE ON registry.governed_versions FOR EACH ROW EXECUTE FUNCTION registry.reject_governed_version_mutation();
    CREATE FUNCTION registry.reject_governed_append_mutation() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'governed history is append only'; END $$;
    CREATE TRIGGER governed_approval_immutable BEFORE UPDATE OR DELETE ON registry.governed_approvals FOR EACH ROW EXECUTE FUNCTION registry.reject_governed_append_mutation();
    CREATE TRIGGER governed_event_immutable BEFORE UPDATE OR DELETE ON registry.governed_events FOR EACH ROW EXECUTE FUNCTION registry.reject_governed_append_mutation();
    ALTER TABLE registry.governed_definitions ENABLE ROW LEVEL SECURITY; ALTER TABLE registry.governed_definitions FORCE ROW LEVEL SECURITY;
    ALTER TABLE registry.governed_versions ENABLE ROW LEVEL SECURITY; ALTER TABLE registry.governed_versions FORCE ROW LEVEL SECURITY;
    ALTER TABLE registry.governed_approvals ENABLE ROW LEVEL SECURITY; ALTER TABLE registry.governed_approvals FORCE ROW LEVEL SECURITY;
    ALTER TABLE registry.governed_events ENABLE ROW LEVEL SECURITY; ALTER TABLE registry.governed_events FORCE ROW LEVEL SECURITY;
    CREATE POLICY governed_definitions_tenant ON registry.governed_definitions USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY governed_versions_tenant ON registry.governed_versions USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY governed_approvals_tenant ON registry.governed_approvals USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
    CREATE POLICY governed_events_tenant ON registry.governed_events USING (tenant_id=current_setting('app.tenant_id',true)) WITH CHECK (tenant_id=current_setting('app.tenant_id',true));
    GRANT SELECT,INSERT,UPDATE,DELETE ON memory.feedback,memory.evaluation_cases,registry.governed_definitions,registry.governed_versions,registry.governed_approvals,registry.governed_events TO si_app;`);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE registry.governed_events,registry.governed_approvals,registry.governed_versions,registry.governed_definitions;
    DROP FUNCTION registry.reject_governed_append_mutation(); DROP FUNCTION registry.reject_governed_version_mutation();
    DROP SCHEMA memory CASCADE; ALTER TABLE registry.personal_memories ADD COLUMN role_template text;`);
}
