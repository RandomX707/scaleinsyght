import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    CREATE TABLE graph.dictionary_descriptions (
      tenant_id text NOT NULL REFERENCES core.tenants(tenant_id),
      source_id uuid NOT NULL,
      table_name text NOT NULL,
      column_name text NOT NULL,
      description text NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 2000),
      imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY(tenant_id,source_id,table_name,column_name),
      FOREIGN KEY(tenant_id,source_id) REFERENCES registry.connections(tenant_id,connection_id)
    );
    ALTER TABLE graph.dictionary_descriptions ENABLE ROW LEVEL SECURITY;
    ALTER TABLE graph.dictionary_descriptions FORCE ROW LEVEL SECURITY;
    CREATE POLICY dictionary_descriptions_tenant ON graph.dictionary_descriptions
      USING(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')))
      WITH CHECK(tenant_id=(SELECT nullif(current_setting('app.tenant_id',true),'')));
    GRANT SELECT,INSERT,UPDATE,DELETE ON graph.dictionary_descriptions TO si_app,si_worker;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`DROP TABLE graph.dictionary_descriptions;`);
}
