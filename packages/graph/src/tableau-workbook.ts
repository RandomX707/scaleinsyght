import { createHash } from 'node:crypto';
import { withTenant, type Pool, type PoolClient } from '@scaleinsyght/db';
import { readTableauWorkbook, type TableauDatasource, type TableauField } from '@scaleinsyght/tableau';
import { openGap, parseStatementLineage, SqlParserUnavailable, writeFlowEdge, type LineageDialect, type StatementLineage } from './sql-lineage.js';

export type TableauImportSummary = {
  datasources: number; worksheets: number; fields: number; calculatedFields: number;
  tableEdges: number; columnEdges: number; reportEdges: number; gaps: number;
};

const COLLECTOR = 'tableau-twb-v1';
const DIALECTS: Record<string, LineageDialect> = { postgres: 'postgres', sql_server: 'sql_server', snowflake: 'snowflake' };
/** Tableau's connection class for each warehouse type the product connects to. */
const TABLEAU_CLASS: Record<string, string> = { postgres: 'postgres', sql_server: 'sqlserver', snowflake: 'snowflake' };
const DEFAULT_SCHEMA: Partial<Record<LineageDialect, string>> = { postgres: 'public', sql_server: 'dbo' };

/** Graph names split a field from its table at the last dot, so dots inside Tableau captions become a one-dot leader. */
const safeName = (value: string) => value.replaceAll('.', '․').trim() || 'Untitled';

/**
 * Imports a Tableau workbook's lineage into the graph against the warehouse connection its data sources read.
 *
 * Each data source becomes a dataset with its fields; each worksheet becomes a report. Edges:
 * - warehouse column -> data source field, declared by the workbook's metadata records;
 * - warehouse column -> custom SQL field, parsed from the SQL (in memory only);
 * - field -> calculated field, parsed from the formula's field references (the formula is never stored);
 * - data source field -> worksheet, declared by the worksheet's field dependencies.
 * Every hop that cannot be resolved ends in an explicit gap. Models of dbt projects linked to the same warehouse count
 * as warehouse tables, so a report on a dbt mart reaches the operational columns through the dbt lineage.
 */
export async function importTableauWorkbook(pool: Pool, input: {
  tenantId: string; tableauConnectionId: string; warehouseConnectionId: string; warehouseType: string; workbookName: string; workbook: string | Buffer;
  /** The warehouse connection's database name, compared in memory with each data source's; never stored. */
  warehouseDatabase?: string | null;
}): Promise<TableauImportSummary> {
  const workbook = readTableauWorkbook(input.workbook);
  const dialect = DIALECTS[input.warehouseType];
  if (!dialect) throw new Error('tableau_warehouse_unsupported');
  const workbookName = safeName(input.workbookName);
  const workbookHash = createHash('sha256').update(input.workbook).digest('hex');

  // Warehouse tables and columns, plus models of dbt projects that build into the warehouse.
  const known = await withTenant(pool, input.tenantId, (client) => client.query<{ dataset: string; field: string | null; dataset_id: string; field_id: string | null; owner: string }>(
    `SELECT d.qualified_name AS dataset,f.qualified_name AS field,d.asset_id AS dataset_id,f.asset_id AS field_id,CASE WHEN d.source_id=$2 THEN 'warehouse' ELSE 'dbt' END AS owner
     FROM graph.assets d
     LEFT JOIN graph.relationships c ON c.tenant_id=d.tenant_id AND c.from_asset_id=d.asset_id AND c.relationship_type='CONTAINS'
     LEFT JOIN graph.assets f ON f.tenant_id=c.tenant_id AND f.asset_id=c.to_asset_id AND f.active AND f.asset_type='field'
     WHERE d.tenant_id=$1 AND d.asset_type='dataset' AND d.active AND (d.source_id=$2 OR d.source_id IN (
       SELECT connection_id FROM registry.connections WHERE tenant_id=$1 AND connector_type='dbt' AND status='active' AND source_ref='warehouse:'||$2::text))`,
    [input.tenantId, input.warehouseConnectionId]));
  const warehouseDatasets = new Map<string, string>(); const warehouseFields = new Map<string, string>();
  const tables: Record<string, Record<string, string>> = {};
  // The warehouse's own assets win over a dbt connection's copy of the same name.
  for (const row of [...known.rows].sort((a, b) => Number(a.owner === 'warehouse') - Number(b.owner === 'warehouse'))) {
    warehouseDatasets.set(row.dataset, row.dataset_id);
    tables[row.dataset] ??= {};
    if (row.field && row.field_id) { warehouseFields.set(row.field, row.field_id); tables[row.dataset]![row.field.slice(row.dataset.length + 1)] = 'unknown'; }
  }
  // An unqualified table is read from the dialect's default schema only, never matched by name elsewhere.
  const resolveTable = (schema: string | null, table: string): string | null => {
    const qualified = schema ?? DEFAULT_SCHEMA[dialect];
    return qualified && warehouseDatasets.has(`${qualified}.${table}`) ? `${qualified}.${table}` : null;
  };

  // Custom SQL is parsed before the transaction opens, in memory, and dropped afterwards.
  const parsedSql = new Map<string, StatementLineage | string>();
  for (const datasource of workbook.datasources) for (const relation of datasource.relations) {
    if (relation.kind !== 'custom_sql') continue;
    const key = `${datasource.name}\0${relation.name}`;
    if (!relation.sql) { parsedSql.set(key, 'its custom SQL is empty'); continue; }
    try { parsedSql.set(key, await parseStatementLineage({ sql: relation.sql, dialect, tables, ...(DEFAULT_SCHEMA[dialect] ? { default_schema: DEFAULT_SCHEMA[dialect] } : {}) })); }
    catch (error) { parsedSql.set(key, error instanceof SqlParserUnavailable ? 'the SQL parser was unavailable, so its custom SQL was not read' : `its custom SQL could not be parsed (${error instanceof Error ? error.message.replaceAll('_', ' ') : 'parse failed'})`); }
  }

  return withTenant(pool, input.tenantId, async (client) => {
    const evidence = await client.query<{ evidence_id: string }>(
      `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'tableau_workbook',$2::jsonb) RETURNING evidence_id`,
      [input.tenantId, JSON.stringify({ collector: COLLECTOR, connection_id: input.tableauConnectionId, workbook_hash: workbookHash, datasources: workbook.datasources.length, worksheets: workbook.worksheets.length })]);
    const evidenceId = evidence.rows[0]!.evidence_id;
    const seen = new Set<string>(); const written = new Map<string, Set<string>>(); // relationship -> methods
    const raised = new Set<string>(); // `${asset}\0${reason}`
    const totals = { tableEdges: 0, columnEdges: 0, reportEdges: 0, gaps: 0, fields: 0, calculatedFields: 0 };
    // Names are unique per connection across types; a name already held by another type gets the type appended.
    const ensure = async (name: string, type: 'dataset' | 'field' | 'report') => {
      for (const candidate of [name, `${name} (${type})`]) {
        const asset = await client.query<{ asset_id: string }>(
          `INSERT INTO graph.assets(tenant_id,source_id,asset_type,qualified_name,fingerprint) VALUES($1,$2,$3,$4,$5)
           ON CONFLICT(tenant_id,source_id,qualified_name) DO UPDATE SET active=true,last_seen_at=clock_timestamp() WHERE graph.assets.asset_type=EXCLUDED.asset_type RETURNING asset_id`,
          [input.tenantId, input.tableauConnectionId, type, candidate, createHash('sha256').update(`${input.tableauConnectionId}\0${candidate}`).digest()]);
        if (!asset.rows[0]) continue;
        seen.add(asset.rows[0].asset_id);
        return asset.rows[0].asset_id;
      }
      throw new Error('tableau_asset_name_conflict');
    };
    const edge = async (fromId: string, toId: string, granularity: 'dataset' | 'field' | 'report', method: 'parsed' | 'declared', explanation: string, transformation: Record<string, unknown> | null) => {
      const relationshipId = await writeFlowEdge(client, { tenantId: input.tenantId, fromId, toId, granularity, method, explanation, transformation, collector: COLLECTOR, evidenceId });
      written.set(relationshipId, (written.get(relationshipId) ?? new Set()).add(method));
      if (granularity === 'dataset') totals.tableEdges++; else if (granularity === 'field') totals.columnEdges++; else totals.reportEdges++;
    };
    const gap = async (assetId: string, reason: string) => { await openGap(client, input.tenantId, assetId, reason); raised.add(`${assetId}\0${reason}`); totals.gaps++; };

    const datasetNames = new Set<string>();
    const formulas = new Map<string, string | null>(); // calculated field asset name -> scrubbed formula
    const fieldAssets = new Map<string, string>(); // `${datasource.name}\0${field.name}` -> asset id
    for (const datasource of workbook.datasources) {
      let datasetName = safeName(datasource.caption);
      for (let copy = 2; datasetNames.has(datasetName); copy++) datasetName = `${safeName(datasource.caption)} (${copy})`;
      datasetNames.add(datasetName);
      const datasetId = await ensure(datasetName, 'dataset');
      const fieldNames = new Set<string>();
      for (const field of datasource.fields) {
        // Two fields with the same caption stay two assets: the second is named with its Tableau field name too.
        let fieldName = safeName(field.caption);
        if (fieldNames.has(fieldName)) fieldName = `${fieldName} (${safeName(field.name)})`;
        fieldNames.add(fieldName);
        const fieldId = await ensure(`${datasetName}.${fieldName}`, 'field');
        fieldAssets.set(`${datasource.name}\0${field.name}`, fieldId);
        await client.query(`INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'structural','CONTAINS',$2,$3,'field') ON CONFLICT DO NOTHING`, [input.tenantId, datasetId, fieldId]);
        totals.fields++; if (field.source.kind === 'calculated') totals.calculatedFields++;
        if (field.source.kind === 'calculated') formulas.set(`${datasetName}.${fieldName}`, field.source.scrubbedFormula);
      }
      await importDatasource(datasource, datasetId);
    }

    async function importDatasource(datasource: TableauDatasource, datasetId: string) {
      const caption = safeName(datasource.caption);
      const fieldId = (field: TableauField) => fieldAssets.get(`${datasource.name}\0${field.name}`)!;
      const expectedClass = TABLEAU_CLASS[input.warehouseType];
      const warehouseDatabase = input.warehouseDatabase?.toLowerCase();
      const otherDatabase = Boolean(warehouseDatabase && datasource.databases.length && !datasource.databases.some((name) => name.toLowerCase() === warehouseDatabase));
      if (datasource.connectionClass !== expectedClass || otherDatabase || datasource.databases.length > 1) {
        const reads = datasource.connectionClass === 'multiple' || datasource.databases.length > 1 ? 'joins tables from more than one database'
          : datasource.connectionClass !== expectedClass ? (datasource.connectionClass ? `connects to ${datasource.connectionClass}` : 'has no database connection')
          : 'reads a different database';
        const reason = `${caption} ${reads}, not the linked warehouse, so its fields are not traced`;
        await gap(datasetId, reason);
        for (const field of datasource.fields) if (field.source.kind !== 'calculated') await gap(fieldId(field), reason);
      }
      const traced = datasource.connectionClass === expectedClass && !otherDatabase && datasource.databases.length <= 1;
      const relations = new Map(datasource.relations.map((relation) => [relation.name, relation]));
      if (traced) for (const relation of datasource.relations) {
        if (relation.kind === 'table') {
          const table = resolveTable(relation.schema, relation.table);
          if (table) await edge(warehouseDatasets.get(table)!, datasetId, 'dataset', 'declared', 'Table read by the Tableau data source', null);
          else await gap(datasetId, `${caption} reads ${relation.schema ? `${relation.schema}.` : ''}${relation.table}, which no connected source exposes`);
        } else if (relation.kind === 'custom_sql') {
          const lineage = parsedSql.get(`${datasource.name}\0${relation.name}`)!;
          if (typeof lineage === 'string') { await gap(datasetId, `In ${caption}, ${lineage}`); continue; }
          for (const read of lineage.reads) { const id = warehouseDatasets.get(read); if (id) await edge(id, datasetId, 'dataset', 'parsed', 'Table read by the data source\'s parsed custom SQL', null); }
          for (const missing of lineage.missing_tables) await gap(datasetId, `${caption} reads ${missing} in custom SQL, which no connected source exposes`);
        } else {
          await gap(datasetId, `${caption} uses a ${relation.type} relation, which is not traced`);
        }
      }
      const byName = new Map(datasource.fields.map((field) => [field.name, field]));
      for (const field of datasource.fields) {
        const target = fieldId(field);
        const label = `${caption}.${safeName(field.caption)}`;
        const source = field.source;
        if (source.kind === 'calculated') {
          for (const reference of source.references) {
            // A reference to another data source's field resolves there, never to a same-named field here.
            const referencedId = reference.datasource === null
              ? (byName.has(reference.field) ? fieldId(byName.get(reference.field)!) : undefined)
              : fieldAssets.get(`${reference.datasource}\0${reference.field}`);
            if (referencedId) await edge(referencedId, target, 'field', 'parsed', 'Calculated field computed from this field', { kind: 'derived' });
            else await gap(target, reference.datasource === null || reference.datasource === datasource.name
              ? `${label} refers to ${reference.field}, which the data source does not define`
              : `${label} refers to ${reference.field} in another data source the workbook does not define`);
          }
          continue;
        }
        if (!traced) continue;
        if (source.kind === 'unmapped') { await gap(target, `Tableau did not record which column ${label} reads`); continue; }
        const relation = relations.get(source.relation);
        if (!relation) { await gap(target, `${label} reads ${source.relation}, which the data source does not define`); continue; }
        if (relation.kind === 'table') {
          const table = resolveTable(relation.schema, relation.table);
          if (!table) { await gap(target, `${label} reads ${relation.schema ? `${relation.schema}.` : ''}${relation.table}.${source.column}, which no connected source exposes`); continue; }
          const column = warehouseFields.get(`${table}.${source.column}`);
          if (column) await edge(column, target, 'field', 'declared', 'Field mapped to the column by the Tableau data source', { kind: 'direct' });
          else await gap(target, `${label} reads ${table}.${source.column}, which ${table} no longer has`);
        } else if (relation.kind === 'custom_sql') {
          const lineage = parsedSql.get(`${datasource.name}\0${relation.name}`)!;
          if (typeof lineage === 'string') { await gap(target, `${label} comes from custom SQL that was not read: ${lineage}`); continue; }
          const output = lineage.columns.find((item) => item.column.toLowerCase() === source.column.toLowerCase());
          let resolved = 0;
          for (const from of output?.sources ?? []) {
            const column = warehouseFields.get(`${from.table}.${from.column}`);
            if (column) { await edge(column, target, 'field', 'parsed', output!.kind === 'direct' ? 'Column copied by the data source\'s parsed custom SQL' : 'Column computed by the data source\'s parsed custom SQL', { kind: output!.kind }); resolved++; }
          }
          if (!resolved) await gap(target, output?.sources.length
            ? `${label} comes from ${[...new Set(output.sources.map((item) => item.table))].join(', ')}, which no connected source exposes`
            : `The source of ${label} could not be resolved from the custom SQL`);
        } else {
          await gap(target, `${label} comes from a ${relation.type} relation, which is not traced`);
        }
      }
    }

    const datasourceNames = new Set(workbook.datasources.map((datasource) => datasource.name));
    const reportNames = new Set<string>();
    for (const worksheet of workbook.worksheets) {
      let name = `${workbookName} / ${safeName(worksheet.name)}`;
      for (let copy = 2; reportNames.has(name); copy++) name = `${workbookName} / ${safeName(worksheet.name)} (${copy})`;
      reportNames.add(name);
      const reportId = await ensure(name, 'report');
      const link = await client.query('SELECT 1 FROM graph.evidence WHERE tenant_id=$1 AND evidence_type=\'report_link\' AND safe_metadata->>\'asset_id\'=$2', [input.tenantId, reportId]);
      if (!link.rowCount) await client.query(`INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,'report_link',$2::jsonb)`,
        [input.tenantId, JSON.stringify({ asset_id: reportId, tool: 'tableau', safe_path: `${workbookName}/${safeName(worksheet.name)}` })]);
      for (const used of worksheet.fields) {
        const fieldId = fieldAssets.get(`${used.datasource}\0${used.field}`);
        if (fieldId) await edge(fieldId, reportId, 'report', 'declared', 'Field placed on the Tableau worksheet', null);
        else if (datasourceNames.has(used.datasource)) await gap(reportId, `${name} uses ${used.field}, which its data source does not define`);
        else await gap(reportId, `${name} uses a data source that is not in the workbook`);
      }
    }

    const pairs = [...written].flatMap(([relationship, methods]) => [...methods].map((method) => [relationship, method] as const));
    await retireUnseen(client, input.tenantId, input.tableauConnectionId, [...seen], pairs.map((pair) => pair[0]), pairs.map((pair) => pair[1]));
    // A gap this import no longer raises, on an object that now has current lineage, is closed by that lineage.
    const open = await client.query<{ gap_id: string; asset_id: string; reason: string; assertion_id: string | null }>(
      `SELECT g.gap_id,x.asset_id,g.reason,(SELECT a.assertion_id FROM graph.relationships r JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id
          WHERE r.tenant_id=g.tenant_id AND r.to_asset_id=x.asset_id AND r.family='data_flow' AND a.collector_version=$3 AND a.valid_to IS NULL ORDER BY a.captured_at DESC LIMIT 1) AS assertion_id
       FROM graph.gaps g CROSS JOIN LATERAL unnest(g.between_asset_ids) AS x(asset_id) JOIN graph.assets s ON s.tenant_id=g.tenant_id AND s.asset_id=x.asset_id
       WHERE g.tenant_id=$1 AND s.source_id=$2 AND g.closed_by_assertion_id IS NULL`, [input.tenantId, input.tableauConnectionId, COLLECTOR]);
    for (const row of open.rows) if (row.assertion_id && !raised.has(`${row.asset_id}\0${row.reason}`)) await client.query('UPDATE graph.gaps SET closed_by_assertion_id=$3 WHERE tenant_id=$1 AND gap_id=$2', [input.tenantId, row.gap_id, row.assertion_id]);
    // Scrubbed formulas are kept for the Dictionary as versioned definitions (decision 53); a re-upload replaces them.
    const current = new Map((await client.query<{ qualified_name: string; version: number; scrubbed_text: string | null }>(`SELECT qualified_name,version,scrubbed_text FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND kind='calculated_field' AND active`, [input.tenantId, input.tableauConnectionId])).rows.map((row) => [row.qualified_name, row]));
    for (const [name, formula] of formulas) {
      const previous = current.get(name); current.delete(name);
      if (previous && previous.scrubbed_text === formula) continue;
      if (previous) await client.query('UPDATE graph.definitions SET active=false WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3 AND active', [input.tenantId, input.tableauConnectionId, name]);
      await client.query(`INSERT INTO graph.definitions(tenant_id,source_id,qualified_name,version,kind,scrubbed_text)
        SELECT $1,$2,$3,coalesce(max(version),0)+1,'calculated_field',$4 FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3`, [input.tenantId, input.tableauConnectionId, name, formula]);
    }
    if (current.size) await client.query(`UPDATE graph.definitions SET active=false WHERE tenant_id=$1 AND source_id=$2 AND kind='calculated_field' AND active AND qualified_name=ANY($3::text[])`, [input.tenantId, input.tableauConnectionId, [...current.keys()]]);
    return { datasources: workbook.datasources.length, worksheets: workbook.worksheets.length, fields: totals.fields, calculatedFields: totals.calculatedFields,
      tableEdges: totals.tableEdges, columnEdges: totals.columnEdges, reportEdges: totals.reportEdges, gaps: totals.gaps };
  });
}

/** After a re-upload, edges the workbook no longer proves are closed and objects it no longer has become inactive.
 * Nothing is deleted, so earlier dates stay queryable (contract 6). */
async function retireUnseen(client: PoolClient, tenantId: string, connectionId: string, seen: string[], relationships: string[], methods: string[]): Promise<void> {
  // Closed per relationship and evidence method, so a mapping that moved from declared to parsed closes the declared one.
  await client.query(
    `UPDATE graph.assertions a SET valid_to=clock_timestamp() FROM graph.relationships r, graph.assets t
     WHERE a.tenant_id=$1 AND r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id AND t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id
       AND t.source_id=$2 AND a.collector_version=$3 AND a.valid_to IS NULL
       AND NOT EXISTS (SELECT 1 FROM unnest($4::uuid[],$5::text[]) AS w(relationship_id,method) WHERE w.relationship_id=r.relationship_id AND w.method=a.evidence_method)`,
    [tenantId, connectionId, COLLECTOR, relationships, methods]);
  await client.query('UPDATE graph.assets SET active=false WHERE tenant_id=$1 AND source_id=$2 AND active AND NOT (asset_id=ANY($3::uuid[]))', [tenantId, connectionId, seen]);
}
