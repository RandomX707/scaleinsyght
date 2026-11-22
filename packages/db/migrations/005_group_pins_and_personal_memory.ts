import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm:MigrationBuilder):Promise<void>{
 pgm.sql(`
  ALTER TABLE runs.steps ADD COLUMN source_group_id uuid;
  ALTER TABLE runs.steps ADD COLUMN source_group_version integer;
  ALTER TABLE runs.steps ADD CONSTRAINT run_step_source_group_fk
    FOREIGN KEY(tenant_id,source_group_id,source_group_version)
    REFERENCES registry.source_groups(tenant_id,source_group_id,version);
  CREATE TABLE registry.personal_memories(
    tenant_id text NOT NULL,
    person_id uuid NOT NULL,
    role_template text CHECK(role_template IN ('analyst','engineer','researcher','executive')),
    vocabulary jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(vocabulary)='object'),
    default_sources jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(default_sources)='array'),
    saved_plan_ids jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(saved_plan_ids)='array'),
    answer_style text CHECK(answer_style IN ('concise','detailed','sql_first','lineage_first')),
    corrections jsonb NOT NULL DEFAULT '[]'::jsonb CHECK(jsonb_typeof(corrections)='array'),
    updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
    PRIMARY KEY(tenant_id,person_id),
    FOREIGN KEY(tenant_id,person_id) REFERENCES core.users(tenant_id,user_id)
  );
  ALTER TABLE registry.personal_memories ENABLE ROW LEVEL SECURITY;
  ALTER TABLE registry.personal_memories FORCE ROW LEVEL SECURITY;
  CREATE POLICY personal_memory_owner ON registry.personal_memories
    USING(tenant_id=nullif(current_setting('app.tenant_id',true),'') AND person_id::text=nullif(current_setting('app.principal_id',true),''))
    WITH CHECK(tenant_id=nullif(current_setting('app.tenant_id',true),'') AND person_id::text=nullif(current_setting('app.principal_id',true),''));
  GRANT SELECT,INSERT,UPDATE,DELETE ON registry.personal_memories TO si_app;
 `);
}
export async function down(pgm:MigrationBuilder):Promise<void>{
 pgm.sql(`DROP TABLE registry.personal_memories; ALTER TABLE runs.steps DROP CONSTRAINT run_step_source_group_fk; ALTER TABLE runs.steps DROP COLUMN source_group_id; ALTER TABLE runs.steps DROP COLUMN source_group_version;`);
}
