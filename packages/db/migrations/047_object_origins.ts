import type { MigrationBuilder } from 'node-pg-migrate';

// Decision 62: Standard means vendor-delivered and Custom customer-built. To tell them apart without a vendor dictionary,
// each object's owner and creation order are recorded, and a procedure or function whose normalised SQL is
// near-identical to another is recorded as a copy of it (the later-created one is the copy), with the similarity.
// Metadata only: owners are database role names; no data values.
export function up(pgm: MigrationBuilder): void {
  pgm.sql(`
    CREATE TABLE graph.object_origins (
      tenant_id text NOT NULL,
      source_id uuid NOT NULL,
      qualified_name text NOT NULL CHECK (length(qualified_name) BETWEEN 1 AND 500),
      owner text CHECK (owner IS NULL OR length(owner) <= 200),
      created_order bigint,
      copy_of text CHECK (copy_of IS NULL OR length(copy_of) <= 500),
      copy_similarity numeric(4,3) CHECK (copy_similarity IS NULL OR copy_similarity BETWEEN 0 AND 1),
      captured_at timestamptz NOT NULL DEFAULT clock_timestamp(),
      PRIMARY KEY (tenant_id,source_id,qualified_name),
      FOREIGN KEY (tenant_id,source_id) REFERENCES registry.connections(tenant_id,connection_id),
      CHECK ((copy_of IS NULL) = (copy_similarity IS NULL))
    );
    ALTER TABLE graph.object_origins ENABLE ROW LEVEL SECURITY;
    ALTER TABLE graph.object_origins FORCE ROW LEVEL SECURITY;
    CREATE POLICY object_origins_tenant ON graph.object_origins USING (tenant_id=(SELECT current_setting('app.tenant_id',true))) WITH CHECK (tenant_id=(SELECT current_setting('app.tenant_id',true)));
    GRANT SELECT, INSERT, UPDATE, DELETE ON graph.object_origins TO si_app, si_worker;
  `);
}

export function down(pgm: MigrationBuilder): void {
  pgm.sql('DROP TABLE graph.object_origins;');
}
