import { createHash } from 'node:crypto';
import { withTenant, type Pool } from '@scaleinsyght/db';
import { parseStatementLineage, statementHash, writeStatementLineage, SqlParserUnavailable, type LineageDialect, type StatementLineage } from './sql-lineage.js';

type Node = { resource_type?: unknown; name?: unknown; alias?: unknown; schema?: unknown; identifier?: unknown; compiled_code?: unknown; depends_on?: { nodes?: unknown }; description?: unknown; columns?: Record<string, { name?: unknown; description?: unknown }>; attached_node?: unknown; column_name?: unknown; test_metadata?: { name?: unknown } };
type CatalogEntry = { metadata?: { schema?: unknown; name?: unknown }; columns?: Record<string, { type?: unknown; name?: unknown }> };
export type DbtImportSummary = { models: number; tests: number; sources: number; tableEdges: number; columnEdges: number; gaps: number; modelsNotInWarehouse: string[] };

const NAME = /^[A-Za-z0-9_$]+$/;
const relation = (schema: unknown, name: unknown) => typeof schema === 'string' && typeof name === 'string' && NAME.test(schema) && NAME.test(name) ? `${schema}.${name}` : null;

/** Reads dbt's manifest.json and catalog.json (as uploaded) without keeping them. Only names, dependencies and column
 * types are used; compiled SQL is parsed for column lineage in memory and never stored (contract 7). */
export function readDbtArtifacts(manifest: unknown, catalog: unknown) {
  const m = manifest as { metadata?: { dbt_schema_version?: unknown; dbt_version?: unknown }; nodes?: Record<string, Node>; sources?: Record<string, Node> } | null;
  const c = catalog as { metadata?: { dbt_schema_version?: unknown }; nodes?: Record<string, CatalogEntry>; sources?: Record<string, CatalogEntry> } | null;
  if (!m || typeof m !== 'object' || typeof m.metadata?.dbt_schema_version !== 'string' || !m.metadata.dbt_schema_version.includes('/manifest/') || !m.nodes || !m.sources) throw new Error('dbt_manifest_invalid');
  if (!c || typeof c !== 'object' || typeof c.metadata?.dbt_schema_version !== 'string' || !c.metadata.dbt_schema_version.includes('/catalog/') || !c.nodes || !c.sources) throw new Error('dbt_catalog_invalid');
  const relations = new Map<string, string>();
  const models: Array<{ id: string; relation: string; sql: string | null; dependsOn: string[] }> = [];
  for (const [id, source] of Object.entries(m.sources)) { const name = relation(source.schema, source.identifier ?? source.name); if (name) relations.set(id, name); }
  for (const [id, node] of Object.entries(m.nodes)) {
    if (node.resource_type !== 'model') continue;
    const name = relation(node.schema, node.alias ?? node.name); if (!name) continue;
    relations.set(id, name);
    models.push({ id, relation: name, sql: typeof node.compiled_code === 'string' && node.compiled_code.trim() ? node.compiled_code : null,
      dependsOn: Array.isArray(node.depends_on?.nodes) ? node.depends_on.nodes.map(String) : [] });
  }
  if (!models.length || models.length > 10_000) throw new Error('dbt_manifest_has_no_models');
  const columns: Record<string, Record<string, string>> = {};
  for (const entry of [...Object.values(c.nodes), ...Object.values(c.sources)]) {
    const name = relation(entry.metadata?.schema, entry.metadata?.name); if (!name || !entry.columns) continue;
    columns[name] = Object.fromEntries(Object.values(entry.columns).filter((column) => typeof column.name === 'string' && NAME.test(column.name)).map((column) => [String(column.name), String(column.type ?? 'unknown')]));
  }
  // Descriptions and tests are descriptive metadata from the project (documented, not drafted); kept for the Dictionary.
  const descriptions: Array<{ relation: string; column: string; text: string }> = [];
  for (const [id, node] of [...Object.entries(m.nodes), ...Object.entries(m.sources)]) {
    const name = relations.get(id); if (!name) continue;
    if (typeof node.description === 'string' && node.description.trim()) descriptions.push({ relation: name, column: '', text: node.description.trim().slice(0, 2000) });
    for (const column of Object.values(node.columns ?? {})) if (typeof column.name === 'string' && NAME.test(column.name) && typeof column.description === 'string' && column.description.trim())
      descriptions.push({ relation: name, column: column.name, text: column.description.trim().slice(0, 2000) });
  }
  const testList: Array<{ relation: string; column: string; test: string }> = [];
  for (const node of Object.values(m.nodes)) {
    if (node.resource_type !== 'test' || typeof node.attached_node !== 'string') continue;
    const attached = relations.get(node.attached_node); if (!attached) continue;
    const test = typeof node.test_metadata?.name === 'string' ? node.test_metadata.name : typeof node.name === 'string' ? node.name : null;
    if (test && /^[\w.-]{1,200}$/.test(test)) testList.push({ relation: attached, column: typeof node.column_name === 'string' && NAME.test(node.column_name) ? node.column_name : '', test });
  }
  // Names and kinds of every model and source, for the Dictionary's dbt source (names only).
  const modelIds = new Set(models.map((model) => model.id));
  const objects = [...relations].map(([id, name]) => ({ name, type: modelIds.has(id) ? 'model' as const : 'source' as const })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    descriptions, testList, objects,
    dbtVersion: String(m.metadata.dbt_version ?? 'unknown'), tests: Object.values(m.nodes).filter(node => node?.resource_type === 'test').length, sources: Object.keys(m.sources).length, columns,
    models: models.map((model) => ({ ...model, declaredReads: model.dependsOn.map((id) => relations.get(id)).filter((name): name is string => Boolean(name)) })),
  };
}

/** Imports a dbt project's lineage into the graph against the warehouse connection it builds into.
 * Table edges come from dbt's declared dependencies; column edges from parsing each model's compiled SQL. Anything the
 * warehouse connection does not expose ends in an explicit gap. */
export async function importDbtArtifacts(pool: Pool, input: { tenantId: string; dbtConnectionId: string; warehouseConnectionId: string; warehouseType: string; manifest: unknown; catalog: unknown }): Promise<DbtImportSummary> {
  const artifacts = readDbtArtifacts(input.manifest, input.catalog);
  const dialect: LineageDialect | undefined = ({ postgres: 'postgres', sql_server: 'sql_server', snowflake: 'snowflake' } as Record<string, LineageDialect>)[input.warehouseType];
  if (!dialect) throw new Error('dbt_warehouse_unsupported');
  const parsed = new Map<string, StatementLineage | string>();
  for (const model of artifacts.models) {
    if (!model.sql) { parsed.set(model.relation, 'The manifest has no compiled SQL for this model; run dbt compile or dbt docs generate before uploading'); continue; }
    try { parsed.set(model.relation, await parseStatementLineage({ sql: model.sql, dialect, tables: artifacts.columns })); }
    catch (error) { parsed.set(model.relation, error instanceof SqlParserUnavailable ? 'The SQL parser was unavailable, so this model\'s column lineage was not collected' : `The model's compiled SQL could not be parsed (${error instanceof Error ? error.message.replaceAll('_', ' ') : 'parse failed'})`); }
  }
  return withTenant(pool, input.tenantId, async (client) => {
    const known = await client.query<{ asset_id: string; qualified_name: string; asset_type: string; source_id: string }>(
      `SELECT asset_id,qualified_name,asset_type,source_id FROM graph.assets WHERE tenant_id=$1 AND source_id=ANY($2::uuid[]) AND active AND asset_type IN ('dataset','field')`,
      [input.tenantId, [input.warehouseConnectionId, input.dbtConnectionId]]);
    const datasets = new Map<string, string>(); const fields = new Map<string, string>();
    // The warehouse's own profiled assets win; the dbt connection holds only models the warehouse connection cannot see.
    for (const row of [...known.rows].sort((a, b) => Number(a.source_id === input.warehouseConnectionId) - Number(b.source_id === input.warehouseConnectionId))) (row.asset_type === 'dataset' ? datasets : fields).set(row.qualified_name, row.asset_id);
    const ensure = async (name: string, type: 'dataset' | 'field') => {
      const asset = await client.query<{ asset_id: string }>(
        `INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT(tenant_id,source_id,qualified_name) DO UPDATE SET active=true,last_seen_at=clock_timestamp() RETURNING asset_id`,
        [input.tenantId, input.dbtConnectionId, type, name, createHash('sha256').update(`${input.dbtConnectionId}\0${name}`).digest()]);
      return asset.rows[0]!.asset_id;
    };
    const notInWarehouse: string[] = [];
    for (const model of artifacts.models) {
      if (datasets.has(model.relation) && known.rows.some((row) => row.qualified_name === model.relation && row.source_id === input.warehouseConnectionId)) continue;
      notInWarehouse.push(model.relation);
      const datasetId = await ensure(model.relation, 'dataset'); datasets.set(model.relation, datasetId);
      for (const column of Object.keys(artifacts.columns[model.relation] ?? {})) {
        const fieldId = await ensure(`${model.relation}.${column}`, 'field'); fields.set(`${model.relation}.${column}`, fieldId);
        await client.query(`INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'structural','CONTAINS',$2,$3,'field') ON CONFLICT DO NOTHING`, [input.tenantId, datasetId, fieldId]);
      }
    }
    const totals = { tableEdges: 0, columnEdges: 0, gaps: 0 };
    for (const model of artifacts.models) {
      const lineage = parsed.get(model.relation)!;
      const usable: StatementLineage = typeof lineage === 'string' ? { reads: [], missing_tables: [], columns: [], unresolved: [] } : lineage;
      const written = await writeStatementLineage(client, { tenantId: input.tenantId, target: model.relation, lineage: usable,
        assets: { dataset: (name) => datasets.get(name), field: (name) => fields.get(name) }, declaredReads: model.declaredReads,
        evidenceMethod: 'declared', collector: 'dbt-artifacts-v1', evidenceType: 'dbt_manifest', statementHash: model.sql ? statementHash(model.sql) : '',
        missingReason: (table) => `dbt reads ${table}, which no connected source exposes` });
      totals.tableEdges += written.tableEdges; totals.columnEdges += written.columnEdges; totals.gaps += written.gaps;
      if (typeof lineage === 'string') {
        const targetId = datasets.get(model.relation)!;
        const open = await client.query('SELECT 1 FROM graph.gaps WHERE tenant_id=$1 AND between_asset_ids=$2::uuid[] AND reason=$3 AND closed_by_assertion_id IS NULL', [input.tenantId, [targetId], lineage]);
        if (!open.rowCount) await client.query('INSERT INTO graph.gaps(tenant_id,between_asset_ids,reason) VALUES($1,$2,$3)', [input.tenantId, [targetId], lineage]);
        totals.gaps++;
      }
    }
    // The project's descriptions and tests replace the previous upload's (decision 53, Dictionary).
    await client.query(`DELETE FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$2 AND origin='dbt'`, [input.tenantId, input.dbtConnectionId]);
    for (const item of artifacts.descriptions) await client.query(
      `INSERT INTO graph.dictionary_descriptions(tenant_id,source_id,table_name,column_name,description,origin) VALUES($1,$2,$3,$4,$5,'dbt')
       ON CONFLICT(tenant_id,source_id,table_name,column_name) DO UPDATE SET description=EXCLUDED.description,origin='dbt',imported_at=clock_timestamp()`,
      [input.tenantId, input.dbtConnectionId, item.relation, item.column, item.text]);
    await client.query('DELETE FROM graph.dbt_tests WHERE tenant_id=$1 AND source_id=$2', [input.tenantId, input.dbtConnectionId]);
    for (const item of artifacts.testList) await client.query('INSERT INTO graph.dbt_tests(tenant_id,source_id,model,column_name,test_name) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
      [input.tenantId, input.dbtConnectionId, item.relation, item.column, item.test]);
    await client.query(
      `UPDATE registry.connections SET dbt_import=jsonb_build_object(
        'importedAt',clock_timestamp(),'models',$3::integer,'tests',$4::integer,'objects',$5::jsonb)
        WHERE tenant_id=$1 AND connection_id=$2 AND connector_type='dbt'`,
      [input.tenantId,input.dbtConnectionId,artifacts.models.length,artifacts.tests,JSON.stringify(artifacts.objects)]);
    return { models: artifacts.models.length, tests: artifacts.tests, sources: artifacts.sources, ...totals, modelsNotInWarehouse: notInWarehouse.sort() };
  });
}
