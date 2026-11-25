import { createHash } from 'node:crypto';
import { withTenant, type Pool } from '@scaleinsyght/db';
import { parseStatementLineage, statementHash, writeStatementLineage, SqlParserUnavailable, type LineageDialect, type StatementLineage } from './sql-lineage.js';

type Node = { resource_type?: unknown; name?: unknown; alias?: unknown; schema?: unknown; identifier?: unknown; compiled_code?: unknown; depends_on?: { nodes?: unknown } };
type CatalogEntry = { metadata?: { schema?: unknown; name?: unknown }; columns?: Record<string, { type?: unknown; name?: unknown }> };
export type DbtImportSummary = { models: number; sources: number; tableEdges: number; columnEdges: number; gaps: number; modelsNotInWarehouse: string[] };

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
  return {
    dbtVersion: String(m.metadata.dbt_version ?? 'unknown'), sources: Object.keys(m.sources).length, columns,
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
    return { models: artifacts.models.length, sources: artifacts.sources, ...totals, modelsNotInWarehouse: notInWarehouse.sort() };
  });
}
