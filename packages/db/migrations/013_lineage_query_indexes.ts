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
    CREATE UNIQUE INDEX graph_evidence_golden_import_key ON graph.evidence(tenant_id,evidence_type,safe_metadata)
      WHERE safe_metadata ? 'fixture_key';
    CREATE UNIQUE INDEX graph_assertions_golden_import_key ON graph.assertions(tenant_id,relationship_id,evidence_method,collector_version)
      WHERE collector_version='phase3-golden-v1';
    CREATE UNIQUE INDEX graph_gaps_stable_key ON graph.gaps(tenant_id,between_asset_ids,reason);
    CREATE UNIQUE INDEX graph_events_report_impact_key ON graph.events(tenant_id,asset_id,report_asset_id)
      WHERE event_type='report_impacted';
    CREATE UNIQUE INDEX graph_events_metadata_import_key ON graph.events(tenant_id,(safe_payload->>'fixture_key'))
      WHERE event_type='metadata_imported';
    CREATE UNIQUE INDEX graph_snapshots_event_cursor_key ON graph.snapshots(tenant_id,event_cursor);
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
    DROP INDEX graph.graph_snapshots_event_cursor_key;
    DROP INDEX graph.graph_events_metadata_import_key;
    DROP INDEX graph.graph_events_report_impact_key;
    DROP INDEX graph.graph_gaps_stable_key;
    DROP INDEX graph.graph_assertions_golden_import_key;
    DROP INDEX graph.graph_evidence_golden_import_key;
    DROP INDEX graph.graph_assertions_lineage_filter;
    DO $$ DECLARE table_name text; BEGIN
      FOREACH table_name IN ARRAY ARRAY['assets','relationships','assertions','evidence','gaps','id_fields','id_path_steps','events','snapshots'] LOOP
        EXECUTE format('DROP POLICY tenant_isolation ON graph.%I',table_name);
        EXECUTE format('CREATE POLICY tenant_isolation ON graph.%I USING (tenant_id = nullif(current_setting(''app.tenant_id'', true), '''')) WITH CHECK (tenant_id = nullif(current_setting(''app.tenant_id'', true), ''''))',table_name);
      END LOOP;
    END $$;
    DROP INDEX graph.graph_relationships_from_lineage;
    DROP INDEX graph.graph_relationships_to_lineage;
    CREATE INDEX graph_relationships_from_lineage ON graph.relationships(tenant_id,from_asset_id,relationship_id) WHERE family='data_flow';
    CREATE INDEX graph_relationships_to_lineage ON graph.relationships(tenant_id,to_asset_id,relationship_id) WHERE family='data_flow';
  `);
}
