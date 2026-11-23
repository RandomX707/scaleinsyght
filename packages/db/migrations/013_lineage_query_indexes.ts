import type { MigrationBuilder } from 'node-pg-migrate';

export async function up(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DROP INDEX graph.graph_relationships_from_lineage;
    DROP INDEX graph.graph_relationships_to_lineage;
    CREATE INDEX graph_relationships_from_lineage ON graph.relationships(tenant_id,from_asset_id)
      INCLUDE(to_asset_id,relationship_id,relationship_type,granularity) WHERE family='data_flow';
    CREATE INDEX graph_relationships_to_lineage ON graph.relationships(tenant_id,to_asset_id)
      INCLUDE(from_asset_id,relationship_id,relationship_type,granularity) WHERE family='data_flow';
    CREATE INDEX graph_assertions_lineage_filter ON graph.assertions(tenant_id,relationship_id,evidence_method,captured_at);
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['assets','relationships','assertions','evidence','gaps','id_fields','id_path_steps','events','snapshots'] LOOP
        EXECUTE format('DROP POLICY tenant_isolation ON graph.%I',table_name);
        EXECUTE format(
          'CREATE POLICY tenant_isolation ON graph.%I USING (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'', true), ''''))) WITH CHECK (tenant_id = (SELECT nullif(current_setting(''app.tenant_id'', true), '''')))',
          table_name);
      END LOOP;
    END $$;
  `);
}

export async function down(pgm: MigrationBuilder): Promise<void> {
  pgm.sql(`
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['assets','relationships','assertions','evidence','gaps','id_fields','id_path_steps','events','snapshots'] LOOP
        EXECUTE format('DROP POLICY tenant_isolation ON graph.%I',table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON graph.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',table_name);
      END LOOP;
    END $$;
    DROP INDEX graph.graph_assertions_lineage_filter;
    DROP INDEX graph.graph_relationships_from_lineage;
    DROP INDEX graph.graph_relationships_to_lineage;
    CREATE INDEX graph_relationships_from_lineage ON graph.relationships(tenant_id,from_asset_id,relationship_id) WHERE family='data_flow';
    CREATE INDEX graph_relationships_to_lineage ON graph.relationships(tenant_id,to_asset_id,relationship_id) WHERE family='data_flow';
  `);
}
