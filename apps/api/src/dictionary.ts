import type { FastifyInstance } from 'fastify';
import type { Pool, PoolClient } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { scrubDefinition } from '@scaleinsyght/classification';
import { renderDictionaryHtml, type HtmlSource } from './dictionary-html.js';

/**
 * The Dictionary (docs/phases/dictionary-rebuild.md, decision 53). Everything is read from the graph and stored
 * definitions; nothing is fetched from a source on page load. The object list is paged and searched here, and an
 * object's details load only when it is opened, so a 5,000-table source stays fast.
 */
export const GROUP_PAGE = 200;
export const SQL_HIT_LIMIT = 50;

type Session = { tenantId: string; userId: string };
export type DictionaryDeps = {
  pool: Pool;
  session: (request: { headers: Record<string, string | string[] | undefined> }) => Promise<Session | null>;
  connector: (tenantId: string, connectionId: string) => Promise<ReadOnlyConnector>;
};

export type ObjectKind = 'table' | 'view' | 'materialized_view' | 'procedure' | 'function' | 'package' | 'sheet' | 'model' | 'source' | 'datasource' | 'worksheet' | 'calculated_field';
export type Origin = 'standard' | 'custom';
export type ListedObject = { name: string; kind: ObjectKind; procedureKind: string | null; columns: number | null; custom: boolean;
  origin: Origin; copyOf?: string; copySimilarity?: number };

/**
 * Decision 64: Standard and Custom are decided by object type from the catalog, for every source, automatically. Base
 * data is Standard: tables, workbook sheets, dbt sources and BI data sources. Everything built over it is Custom: views,
 * materialized views, procedures, functions, packages, dbt models, worksheets and calculated fields. No scoring, rules,
 * vendor-dictionary comparison or per-object approval. A near-identical copy of another routine is shown as a "Copy of"
 * badge for information only; it never changes the tab.
 */
export const STANDARD_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['table', 'sheet', 'source', 'datasource']);
export const originOf = (kind: ObjectKind): Origin => STANDARD_KINDS.has(kind) ? 'standard' : 'custom';

/** Kinds whose description Scale Insyght drafts from metadata; dbt and BI objects bring their own or none. */
export const DRAFTED_KINDS: ReadonlySet<ObjectKind> = new Set<ObjectKind>(['table', 'sheet', 'view', 'materialized_view', 'procedure', 'function', 'package']);

const PROCEDURE_GROUPS: Record<string, string> = { fact_loader: 'Fact loaders', report: 'Report procedures', data_check: 'Data checks', archive: 'Archive', utility: 'Utilities' };
const GROUP_ORDER = ['tables', 'sheets', 'sources', 'datasources', 'views', 'materialized_views', 'proc_fact_loader', 'proc_report', 'proc_data_check', 'proc_archive', 'proc_utility', 'functions', 'packages', 'models', 'worksheets', 'calculated_fields'];

/** The left-panel group an object belongs to, with its label. Procedures are grouped by what their parsed SQL does. */
export function groupFor(object: Pick<ListedObject, 'kind' | 'procedureKind'>): { key: string; label: string } {
  switch (object.kind) {
    case 'table': return { key: 'tables', label: 'Tables' };
    case 'sheet': return { key: 'sheets', label: 'Sheets' };
    case 'model': return { key: 'models', label: 'Models' };
    case 'source': return { key: 'sources', label: 'Sources' };
    case 'datasource': return { key: 'datasources', label: 'Data sources' };
    case 'view': return { key: 'views', label: 'Views' };
    case 'materialized_view': return { key: 'materialized_views', label: 'Materialized views' };
    case 'procedure': {
      const kind = object.procedureKind && PROCEDURE_GROUPS[object.procedureKind] ? object.procedureKind : 'utility';
      return { key: `proc_${kind}`, label: `Procedures · ${PROCEDURE_GROUPS[kind]}` };
    }
    case 'function': return { key: 'functions', label: 'Functions' };
    case 'package': return { key: 'packages', label: 'SSIS packages' };
    case 'worksheet': return { key: 'worksheets', label: 'Worksheets' };
    case 'calculated_field': return { key: 'calculated_fields', label: 'Calculated fields' };
  }
}

/** Lines of a stored (scrubbed) definition that contain the search text, numbered from 1, at most `limit`. */
export function sqlSnippets(text: string, query: string, limit = 3): Array<{ line: number; text: string }> {
  const needle = query.toLowerCase(); const hits: Array<{ line: number; text: string }> = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length && hits.length < limit; index++) {
    const line = lines[index]!; const at = line.toLowerCase().indexOf(needle);
    if (at < 0) continue;
    const start = Math.max(0, at - 60);
    hits.push({ line: index + 1, text: `${start > 0 ? '…' : ''}${line.slice(start, at + needle.length + 80).trim()}${at + needle.length + 80 < line.length ? '…' : ''}` });
  }
  return hits;
}

type Source = { connection_id: string; connector_type: string; name: string; source_ref: string | null; dbt_import: { objects?: Array<{ name: string; type: 'model' | 'source' }>; importedAt?: string } | null };

async function sourceFor(client: PoolClient, tenantId: string, connectionId: string): Promise<Source | null> {
  const row = await client.query<Source>(`SELECT connection_id,connector_type,coalesce(nullif(display_name,''),connector_type) AS name,source_ref,dbt_import
    FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2 AND status='active'`, [tenantId, connectionId]);
  return row.rows[0] ?? null;
}

/** The vendor dictionary's table names (lower case), or null when none was imported. */
async function importedTables(client: PoolClient, tenantId: string, connectionId: string): Promise<Set<string> | null> {
  const rows = await client.query<{ table_name: string }>(`SELECT DISTINCT lower(table_name) AS table_name FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$2 AND origin='imported'`, [tenantId, connectionId]);
  return rows.rows.length ? new Set(rows.rows.map((row) => row.table_name)) : null;
}

/** Every object of a source, names and kinds only (no columns), cheap enough for 5,000-table sources. */
export async function listObjects(client: PoolClient, tenantId: string, source: Source): Promise<ListedObject[]> {
  const copies = new Map((await client.query<{ qualified_name: string; copy_of: string; copy_similarity: string }>(
    'SELECT qualified_name,copy_of,copy_similarity::text FROM graph.object_origins WHERE tenant_id=$1 AND source_id=$2 AND copy_of IS NOT NULL', [tenantId, source.connection_id])).rows.map((row) => [row.qualified_name, row]));
  const classify = (name: string, kind: ObjectKind) => {
    const copy = copies.get(name); const origin = originOf(kind);
    return { custom: origin === 'custom', origin, ...(copy ? { copyOf: copy.copy_of, copySimilarity: Number(copy.copy_similarity) } : {}) };
  };
  if (source.connector_type === 'dbt') {
    const objects = source.dbt_import?.objects ?? [];
    return objects.map((object) => ({ name: object.name, kind: object.type, procedureKind: null, columns: null, ...classify(object.name, object.type) }));
  }
  const rows = await client.query<{ name: string; asset_type: string; object_type: string | null; columns: number | null; definition_kind: string | null; procedure_kind: string | null }>(
    `SELECT a.qualified_name AS name,a.asset_type,v.structural_attributes->>'object_type' AS object_type,
        CASE WHEN jsonb_typeof(v.structural_attributes->'columns')='array' THEN jsonb_array_length(v.structural_attributes->'columns') END AS columns,NULL AS definition_kind,NULL AS procedure_kind
       FROM graph.assets a LEFT JOIN LATERAL(SELECT structural_attributes FROM graph.asset_versions WHERE tenant_id=a.tenant_id AND asset_id=a.asset_id ORDER BY version DESC LIMIT 1)v ON true
       WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.active AND a.asset_type IN ('dataset','report')
     UNION ALL
     SELECT d.qualified_name,'definition',NULL,NULL,d.kind,d.analysis->>'kind' FROM graph.definitions d
       WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.kind NOT IN ('view','materialized_view')`, [tenantId, source.connection_id]);
  return rows.rows.map((row) => {
    let kind: ObjectKind;
    if (row.asset_type === 'report') kind = 'worksheet';
    else if (row.asset_type === 'definition') kind = row.definition_kind as ObjectKind;
    else if (source.connector_type === 'excel') kind = 'sheet';
    else if (source.connector_type === 'tableau') kind = 'datasource';
    else kind = row.object_type === 'view' ? 'view' : row.object_type === 'materialized_view' ? 'materialized_view' : 'table';
    return { name: row.name, kind, procedureKind: row.procedure_kind, columns: row.columns === null ? null : Number(row.columns), ...classify(row.name, kind) };
  });
}

/** A plain description drafted by code from metadata only: names, types, keys and parsed SQL. Never data values. */
export function draftDescription(input: { kind: ObjectKind; name: string; encrypted?: boolean; columns?: number; references?: string[]; builtBy?: Array<{ name: string; mode: string }>; readBy?: number;
  analysis?: { writes: Array<{ table: string; mode: string }>; reads: string[]; calls: string[] } }): string {
  const own = input.name.replace(/\(.*\)$/, '');
  // Names read better without the default schema (dbo, public); other schemas stay.
  const short = (value: string) => value.replace(/^(?:dbo|public|PUBLIC)\.(?=[^.]+$)/, '');
  const list = (raw: string[]) => { const items = raw.map(short); return items.length <= 2 ? items.join(' and ') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`; };
  if (input.encrypted) return `${input.kind === 'procedure' ? 'Procedure' : 'Routine'} whose SQL the source encrypts, so what it reads and writes is not known.`;
  if (input.analysis && ['procedure', 'function', 'package'].includes(input.kind)) {
    const how: Record<string, string> = { 'truncate-insert': 'empties and reloads', merge: 'merges into', insert: 'inserts into', update: 'updates', delete: 'deletes from' };
    const parts = input.analysis.writes.map((write) => `${how[write.mode] ?? 'writes'} ${short(write.table)}`);
    let text = parts.length ? `${input.kind === 'procedure' ? 'Procedure' : 'Routine'} that ${list(parts)}` : `${input.kind === 'procedure' ? 'Procedure' : 'Function'} that returns a result and changes no tables`;
    if (input.analysis.reads.length) text += `, reading ${list(input.analysis.reads.slice(0, 4))}${input.analysis.reads.length > 4 ? ` and ${input.analysis.reads.length - 4} more` : ''}`;
    if (input.analysis.calls.length) text += `. It runs ${list(input.analysis.calls)}`;
    return `${text}.`;
  }
  const columns = (count: number) => `${count} ${count === 1 ? 'column' : 'columns'}`;
  if (input.kind === 'view' || input.kind === 'materialized_view') return `View over ${input.analysis?.reads.length ? list(input.analysis.reads.slice(0, 4)) : 'other tables'}${input.columns ? `, with ${columns(input.columns)}` : ''}.`;
  let text = `${input.kind === 'sheet' ? 'Sheet' : 'Table'} ${short(own).split('.').at(-1)}${input.columns ? ` with ${columns(input.columns)}` : ''}`;
  if (input.references?.length) text += `, linked by declared keys to ${list(input.references.slice(0, 3))}`;
  text += '.';
  if (input.builtBy?.length) text += ` Loaded by ${list(input.builtBy.map((item) => item.name))}.`;
  if (input.readBy) text += ` Read by ${input.readBy} ${input.readBy === 1 ? 'object' : 'objects'}.`;
  return text;
}

/**
 * Drafted descriptions for many objects at once, from metadata only (names, column counts, declared keys and parsed
 * SQL), in a fixed number of queries whatever the source size. One path for the object view, single approval,
 * Approve all and the export, so what a person approves is exactly the text they were shown (decision 64).
 */
export async function draftDescriptions(client: PoolClient, tenantId: string, source: Source, objects: ListedObject[]): Promise<Map<string, string>> {
  const wanted = objects.filter((object) => DRAFTED_KINDS.has(object.kind));
  if (!wanted.length || source.connector_type === 'dbt' || source.connector_type === 'tableau') return new Map();
  const names = wanted.map((object) => object.name);
  const definitions = (await client.query<{ qualified_name: string; kind: string; encrypted: boolean; analysis: { writes?: Array<{ table: string; mode: string }>; reads?: string[]; calls?: string[] } }>(
    `SELECT qualified_name,kind,encrypted,analysis FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active AND kind<>'calculated_field' ORDER BY qualified_name`, [tenantId, source.connection_id])).rows;
  const columnCounts = new Map((await client.query<{ qualified_name: string; n: number }>(
    `SELECT d.qualified_name,count(f.asset_id)::int AS n FROM graph.assets d
       JOIN graph.relationships c ON c.tenant_id=d.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id
       JOIN graph.assets f ON f.tenant_id=c.tenant_id AND f.asset_id=c.to_asset_id AND f.active
     WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.asset_type='dataset' AND d.qualified_name=ANY($3::text[]) GROUP BY d.qualified_name`, [tenantId, source.connection_id, names])).rows.map((row) => [row.qualified_name, row.n]));
  // Tables this one is linked to by a declared foreign key (inferred links are probable and never described as keys).
  const references = new Map<string, string[]>();
  for (const row of (await client.query<{ from_table: string; to_table: string }>(
    `SELECT DISTINCT fd.qualified_name AS from_table,td.qualified_name AS to_table FROM graph.assets fd
       JOIN graph.relationships fc ON fc.tenant_id=fd.tenant_id AND fc.family='structural' AND fc.relationship_type='CONTAINS' AND fc.from_asset_id=fd.asset_id
       JOIN graph.relationships r ON r.tenant_id=fc.tenant_id AND r.family='structural' AND r.relationship_type='REFERENCES' AND r.from_asset_id=fc.to_asset_id
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id AND f.active JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active
       JOIN graph.relationships tc ON tc.tenant_id=r.tenant_id AND tc.family='structural' AND tc.relationship_type='CONTAINS' AND tc.to_asset_id=t.asset_id
       JOIN graph.assets td ON td.tenant_id=tc.tenant_id AND td.asset_id=tc.from_asset_id
     WHERE fd.tenant_id=$1 AND fd.source_id=$2 AND fd.active AND fd.asset_type='dataset' AND fd.qualified_name=ANY($3::text[])
       AND EXISTS(SELECT 1 FROM graph.assertions s WHERE s.tenant_id=r.tenant_id AND s.relationship_id=r.relationship_id AND s.valid_to IS NULL AND s.evidence_method='declared' AND s.review_status NOT IN ('rejected','stale','disputed'))
     ORDER BY 1,2`, [tenantId, source.connection_id, names])).rows) references.set(row.from_table, [...(references.get(row.from_table) ?? []), row.to_table]);
  const builtBy = new Map<string, Array<{ name: string; mode: string }>>(); const readBy = new Map<string, number>();
  for (const definition of definitions) {
    for (const write of definition.analysis.writes ?? []) {
      const key = write.table.toLowerCase(); const loaders = builtBy.get(key) ?? [];
      if (key !== definition.qualified_name.toLowerCase() && !loaders.some((item) => item.name === definition.qualified_name)) builtBy.set(key, [...loaders, { name: definition.qualified_name, mode: write.mode }]);
    }
    for (const read of new Set((definition.analysis.reads ?? []).map((item) => item.toLowerCase()))) if (read !== definition.qualified_name.toLowerCase()) readBy.set(read, (readBy.get(read) ?? 0) + 1);
  }
  const byName = new Map(definitions.map((definition) => [definition.qualified_name, definition]));
  const drafts = new Map<string, string>();
  for (const object of wanted) {
    const definition = byName.get(object.name); const lower = object.name.toLowerCase();
    const analysis = definition ? { writes: definition.analysis.writes ?? [], reads: definition.analysis.reads ?? [], calls: definition.analysis.calls ?? [] } : undefined;
    drafts.set(object.name, draftDescription({ kind: object.kind, name: object.name, encrypted: definition?.encrypted ?? false, columns: columnCounts.get(object.name) ?? 0,
      references: references.get(object.name) ?? [], builtBy: builtBy.get(lower) ?? [], readBy: readBy.get(lower) ?? 0, ...(analysis ? { analysis } : {}) }));
  }
  return drafts;
}

/** Objects whose description comes from an imported dictionary or dbt, or that a person approved or edited. */
async function describedNames(client: PoolClient, tenantId: string, connectionId: string): Promise<Set<string>> {
  return new Set((await client.query<{ name: string }>(
    `SELECT table_name AS name FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$2 AND column_name=''
     UNION SELECT qualified_name FROM graph.description_reviews WHERE tenant_id=$1 AND source_id=$2 AND field_name='' AND status<>'draft'`, [tenantId, connectionId])).rows.map((row) => row.name));
}

/** Objects still showing a drafted description: ones Scale Insyght drafts that nobody has approved, edited or imported. */
const stillDrafted = (objects: ListedObject[], described: Set<string>, source: Source) =>
  source.connector_type === 'dbt' || source.connector_type === 'tableau' ? [] : objects.filter((object) => DRAFTED_KINDS.has(object.kind) && !described.has(object.name));

/** The objects a tab and search show, with column-name match counts, shared by the list and by Approve all. */
async function objectsInView(client: PoolClient, tenantId: string, source: Source, objects: ListedObject[], view: { tab: Origin | null; search: string }) {
  // Column-name matches are counted per object so the list can show "N col".
  const columnHits = new Map<string, number>();
  if (view.search) {
    const datasetSource = source.connector_type === 'dbt' && source.source_ref?.startsWith('warehouse:') ? source.source_ref.slice('warehouse:'.length) : source.connection_id;
    const rows = await client.query<{ table_name: string; hits: number }>(
      `SELECT d.qualified_name AS table_name,count(*)::int AS hits FROM graph.assets f
         JOIN graph.relationships c ON c.tenant_id=f.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.to_asset_id=f.asset_id
         JOIN graph.assets d ON d.tenant_id=c.tenant_id AND d.asset_id=c.from_asset_id AND d.active
       WHERE f.tenant_id=$1 AND f.source_id=$2 AND f.active AND f.asset_type='field' AND split_part(f.qualified_name,'.',array_length(string_to_array(f.qualified_name,'.'),1)) ILIKE '%'||$3||'%'
       GROUP BY d.qualified_name`, [tenantId, datasetSource, view.search.replace(/[\\%_]/g, (character) => `\\${character}`)]);
    for (const row of rows.rows) columnHits.set(row.table_name, row.hits);
  }
  const shown = objects.filter((object) => !view.tab || object.origin === view.tab)
    .filter((object) => !view.search || object.name.toLowerCase().includes(view.search.toLowerCase()) || columnHits.has(object.name));
  return { shown, columnHits };
}

const q = (value: unknown, max = 200) => typeof value === 'string' ? value.trim().slice(0, max) : '';

export function registerDictionaryRoutes(app: FastifyInstance, deps: DictionaryDeps): void {
  const authed = async (request: { headers: Record<string, string | string[] | undefined> }, reply: { code: (status: number) => { send: (body: unknown) => unknown } }) => {
    const current = await deps.session(request); if (!current) { reply.code(401).send({ error: 'unauthorized' }); return null; } return current;
  };

  app.get('/api/dictionary/sources', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const rows = await withTenant(deps.pool, current.tenantId, (client) => client.query<{ connection_id: string; connector_type: string; name: string; objects: number; imported: boolean }>(
      `SELECT c.connection_id,c.connector_type,coalesce(nullif(c.display_name,''),c.connector_type) AS name,
         CASE WHEN c.connector_type='dbt' THEN coalesce(jsonb_array_length(c.dbt_import->'objects'),0) ELSE
           (SELECT count(*) FROM graph.assets a WHERE a.tenant_id=c.tenant_id AND a.source_id=c.connection_id AND a.active AND a.asset_type IN ('dataset','report'))
           +(SELECT count(*) FROM graph.definitions d WHERE d.tenant_id=c.tenant_id AND d.source_id=c.connection_id AND d.active AND d.kind NOT IN ('view','materialized_view')) END::int AS objects,
         EXISTS(SELECT 1 FROM graph.dictionary_descriptions dd WHERE dd.tenant_id=c.tenant_id AND dd.source_id=c.connection_id AND dd.origin='imported') AS imported
       FROM registry.connections c WHERE c.tenant_id=$1 AND c.status='active' ORDER BY c.created_at`, [current.tenantId]));
    return reply.send({ sources: rows.rows.map((row) => ({ connectionId: row.connection_id, type: row.connector_type, name: row.name, objects: row.objects, importedDictionary: row.imported })) });
  });

  app.get<{ Params: { connectionId: string } }>('/api/connections/:connectionId/dictionary/summary', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const body = await withTenant(deps.pool, current.tenantId, async (client) => {
      const source = await sourceFor(client, current.tenantId, request.params.connectionId); if (!source) return null;
      const objects = await listObjects(client, current.tenantId, source);
      const imported = await client.query<{ file_name: string; imported_at: Date; imported_by: string | null; table_count: number; column_count: number }>(
        `SELECT i.file_name,i.imported_at,u.display_name AS imported_by,i.table_count,i.column_count FROM graph.dictionary_imports i LEFT JOIN core.users u ON u.tenant_id=i.tenant_id AND u.user_id=i.imported_by
         WHERE i.tenant_id=$1 AND i.source_id=$2 ORDER BY i.imported_at DESC LIMIT 1`, [current.tenantId, source.connection_id]);
      const latest = imported.rows[0] ?? null;
      const datasetSource = source.connector_type === 'dbt' && source.source_ref?.startsWith('warehouse:') ? source.source_ref.slice('warehouse:'.length) : source.connection_id;
      const dbtNames = source.connector_type === 'dbt' ? objects.map((object) => object.name) : null;
      // Reviewed: an imported or dbt description, or a draft a person approved or edited. Drafts are used as they are
      // (decision 64), so the landing shows them as described, with how many are still drafted.
      const coverage = await client.query<{ tables: number; documented_tables: number; columns: number; documented_columns: number }>(
        `WITH datasets AS (SELECT a.asset_id,a.qualified_name FROM graph.assets a WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.active AND a.asset_type='dataset' AND ($4::text[] IS NULL OR a.qualified_name=ANY($4))),
           fields AS (SELECT d.qualified_name AS table_name,split_part(f.qualified_name,'.',array_length(string_to_array(f.qualified_name,'.'),1)) AS column_name FROM datasets d
             JOIN graph.relationships c ON c.tenant_id=$1 AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id JOIN graph.assets f ON f.tenant_id=$1 AND f.asset_id=c.to_asset_id AND f.active),
           documented AS (SELECT table_name,column_name FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$3
             UNION SELECT qualified_name,field_name FROM graph.description_reviews WHERE tenant_id=$1 AND source_id=$3 AND status<>'draft')
         SELECT (SELECT count(*) FROM datasets)::int AS tables,
           (SELECT count(*) FROM datasets d WHERE EXISTS(SELECT 1 FROM documented x WHERE x.table_name=d.qualified_name AND x.column_name=''))::int AS documented_tables,
           (SELECT count(*) FROM fields)::int AS columns,
           (SELECT count(*) FROM fields f WHERE EXISTS(SELECT 1 FROM documented x WHERE x.table_name=f.table_name AND x.column_name=f.column_name))::int AS documented_columns`,
        [current.tenantId, datasetSource, source.connection_id, dbtNames]);
      const newer = latest ? await client.query<{ qualified_name: string }>(
        `SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND active AND asset_type='dataset' AND first_seen_at>$3 ORDER BY first_seen_at DESC,qualified_name LIMIT 21`,
        [current.tenantId, source.connection_id, latest.imported_at]) : null;
      const newerCount = latest ? Number((await client.query<{ n: number }>(`SELECT count(*)::int AS n FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND active AND asset_type='dataset' AND first_seen_at>$3`, [current.tenantId, source.connection_id, latest.imported_at])).rows[0]!.n) : 0;
      const tests = source.connector_type === 'dbt' ? Number((await client.query<{ n: number }>('SELECT count(*)::int AS n FROM graph.dbt_tests WHERE tenant_id=$1 AND source_id=$2', [current.tenantId, source.connection_id])).rows[0]!.n) : null;
      const count = (kinds: ObjectKind[]) => objects.filter((object) => kinds.includes(object.kind)).length;
      const coverageRow = coverage.rows[0]!;
      const drafted = stillDrafted(objects, await describedNames(client, current.tenantId, source.connection_id), source);
      // Coverage counts every dataset, views included, so drafts are counted the same way.
      const draftedTables = drafted.filter((object) => ['table', 'sheet', 'view', 'materialized_view'].includes(object.kind)).length;
      // Information only: which tables an imported vendor dictionary lists. It never changes Standard or Custom.
      const vendor = await importedTables(client, current.tenantId, source.connection_id);
      return {
        source: { connectionId: source.connection_id, name: source.name, type: source.connector_type },
        importedDictionary: latest ? { fileName: latest.file_name, importedAt: latest.imported_at, importedBy: latest.imported_by, tables: latest.table_count, columns: latest.column_count } : null,
        hasVendorDictionary: (await importedTables(client, current.tenantId, source.connection_id)) !== null,
        counts: {
          standard: objects.filter((object) => object.origin === 'standard').length, custom: objects.filter((object) => object.origin === 'custom').length,
          tables: count(['table', 'sheet', 'model', 'source', 'datasource']),
          tablesNotInDictionary: vendor ? objects.filter((object) => object.kind === 'table' && !vendor.has(object.name.toLowerCase())).length : null,
          views: count(['view', 'materialized_view']), procedures: count(['procedure']), functions: count(['function']), packages: count(['package']),
          worksheets: count(['worksheet']), calculatedFields: count(['calculated_field']), dbtTests: tests,
        },
        coverage: { tables: { documented: coverageRow.documented_tables + draftedTables, drafted: draftedTables, total: coverageRow.tables }, columns: { documented: coverageRow.documented_columns, total: coverageRow.columns } },
        drafted: drafted.length,
        newerThanDictionary: latest ? { count: newerCount, names: newer!.rows.slice(0, 20).map((row) => row.qualified_name) } : null,
      };
    });
    if (!body) return reply.code(404).send({ error: 'connection_not_found' });
    return reply.send(body);
  });

  app.get<{ Params: { connectionId: string }; Querystring: { tab?: string; q?: string; group?: string; offset?: string } }>('/api/connections/:connectionId/dictionary/objects', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const asked = (['standard', 'custom'] as const).find((item) => item === request.query.tab);
    const search = q(request.query.q, 100); const onlyGroup = q(request.query.group, 60) || null;
    const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(request.query.offset ?? '0', 10) || 0));
    const body = await withTenant(deps.pool, current.tenantId, async (client) => {
      const source = await sourceFor(client, current.tenantId, request.params.connectionId); if (!source) return null;
      const objects = await listObjects(client, current.tenantId, source);
      const hasVendorDictionary = (await importedTables(client, current.tenantId, source.connection_id)) !== null;
      const counts = { standard: objects.filter((object) => object.origin === 'standard').length, custom: objects.filter((object) => object.origin === 'custom').length };
      // Decision 64: Standard first, unless a source has only Custom objects (a Tableau workbook's worksheets, say).
      const tab: Origin = asked ?? (counts.standard ? 'standard' : 'custom');
      const { shown: inTab, columnHits } = await objectsInView(client, current.tenantId, source, objects, { tab, search });
      // How many of the shown objects still have a drafted description, for "Approve all" on this tab or filter.
      const drafted = stillDrafted(inTab, await describedNames(client, current.tenantId, source.connection_id), source).length;
      const grouped = new Map<string, { key: string; label: string; items: ListedObject[] }>();
      for (const object of inTab) { const group = groupFor(object); const entry = grouped.get(group.key) ?? { ...group, items: [] }; entry.items.push(object); grouped.set(group.key, entry); }
      const groups = [...grouped.values()].sort((a, b) => GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key))
        .filter((group) => !onlyGroup || group.key === onlyGroup)
        .map((group) => {
          group.items.sort((a, b) => a.name.localeCompare(b.name));
          const start = onlyGroup ? offset : 0; const page = group.items.slice(start, start + GROUP_PAGE);
          return { key: group.key, label: group.label, total: group.items.length,
            items: page.map((object) => ({ name: object.name, kind: object.kind, columns: object.columns, ...(columnHits.has(object.name) ? { matchedColumns: columnHits.get(object.name) } : {}),
              ...(object.copyOf ? { copyOf: object.copyOf, copySimilarity: object.copySimilarity } : {}) })),
            nextOffset: start + page.length < group.items.length ? start + page.length : null };
        });
      let sqlHits: Array<{ name: string; kind: string; matches: number; lines: Array<{ line: number; text: string }> }> = [];
      if (search && !onlyGroup) {
        const rows = await client.query<{ qualified_name: string; kind: string; scrubbed_text: string }>(
          `SELECT qualified_name,kind,scrubbed_text FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active AND scrubbed_text ILIKE '%'||$3||'%' ORDER BY qualified_name LIMIT ${SQL_HIT_LIMIT}`,
          [current.tenantId, source.connection_id, search.replace(/[\\%_]/g, (character) => `\\${character}`)]);
        // "In SQL code" covers both tabs, as in the prototype.
        sqlHits = rows.rows.map((row) => ({ name: row.qualified_name, kind: row.kind, matches: row.scrubbed_text.toLowerCase().split(search.toLowerCase()).length - 1, lines: sqlSnippets(row.scrubbed_text, search) }));
      }
      // How much procedure SQL could be read here, as the prototype shows on the Custom tab.
      const coverage = (await client.query<{ routines: number; encrypted: number }>(`SELECT count(*)::int AS routines,count(*) FILTER (WHERE encrypted)::int AS encrypted FROM graph.definitions
        WHERE tenant_id=$1 AND source_id=$2 AND active AND kind IN ('procedure','function','package')`, [current.tenantId, source.connection_id])).rows[0]!;
      return { tab, hasVendorDictionary, counts, drafted, groups, sqlHits,
        sqlCoverage: coverage.routines ? { routines: coverage.routines, captured: coverage.routines - coverage.encrypted, encrypted: coverage.encrypted } : null };
    });
    if (!body) return reply.code(404).send({ error: 'connection_not_found' });
    return reply.send(body);
  });

  app.get<{ Params: { connectionId: string }; Querystring: { name?: string } }>('/api/connections/:connectionId/dictionary/object', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const name = q(request.query.name, 500); if (!name) return reply.code(400).send({ error: 'object_name_required' });
    const body = await withTenant(deps.pool, current.tenantId, (client) => objectDetail(client, current.tenantId, request.params.connectionId, name));
    if (!body) return reply.code(404).send({ error: 'object_not_found' });
    return reply.send(body);
  });

  app.post<{ Params: { connectionId: string }; Body: { name?: string; column?: string; action?: string; text?: string } }>('/api/connections/:connectionId/dictionary/description', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const name = q(request.body?.name, 500); const column = q(request.body?.column, 200); const action = request.body?.action;
    const text = typeof request.body?.text === 'string' ? request.body.text.trim() : '';
    if (!name || (action !== 'approve' && action !== 'edit') || (action === 'edit' && (!text || text.length > 2000))) return reply.code(400).send({ error: 'description_review_invalid' });
    const updated = await withTenant(deps.pool, current.tenantId, async (client) => {
      // Drafts are table-level only; a column has none to approve.
      if (column) return null;
      const source = await sourceFor(client, current.tenantId, request.params.connectionId); if (!source) return null;
      const listed = (await listObjects(client, current.tenantId, source)).find((object) => object.name === name); if (!listed) return null;
      const drafted = (await draftDescriptions(client, current.tenantId, source, [listed])).get(name); if (!drafted) return null;
      const status = action === 'approve' ? 'approved' : 'edited';
      return (await client.query<{ status: string; final_text: string; decided_at: Date }>(
        `INSERT INTO graph.description_reviews(tenant_id,source_id,qualified_name,field_name,drafted_text,drafted_by,status,final_text,decided_by,decided_at)
         VALUES($1,$2,$3,'',$4,'code',$5,$6,$7,clock_timestamp())
         ON CONFLICT(tenant_id,source_id,qualified_name,field_name) DO UPDATE SET drafted_text=EXCLUDED.drafted_text,drafted_at=clock_timestamp(),status=EXCLUDED.status,final_text=EXCLUDED.final_text,decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at
         RETURNING status,final_text,decided_at`, [current.tenantId, source.connection_id, name, drafted, status, status === 'edited' ? text : drafted, current.userId])).rows[0] ?? null;
    });
    if (!updated) return reply.code(404).send({ error: 'description_draft_not_found' });
    return reply.send({ status: updated.status, text: updated.final_text, decidedAt: updated.decided_at });
  });

  // Approve all (decision 64): every drafted description a tab, a search or the whole source shows, after one
  // confirmation in the page. Optional and never required: drafts are shown and used as they are. Each approved row
  // records who approved it and when, like a single approval.
  app.post<{ Params: { connectionId: string }; Body: { tab?: string; q?: string } }>('/api/connections/:connectionId/dictionary/descriptions/approve-all', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const tab = (['standard', 'custom'] as const).find((item) => item === request.body?.tab) ?? null;
    if (request.body?.tab !== undefined && !tab) return reply.code(400).send({ error: 'approve_all_invalid' });
    const search = q(request.body?.q, 100);
    const approved = await withTenant(deps.pool, current.tenantId, async (client) => {
      const source = await sourceFor(client, current.tenantId, request.params.connectionId); if (!source) return null;
      const objects = await listObjects(client, current.tenantId, source);
      const { shown } = await objectsInView(client, current.tenantId, source, objects, { tab, search });
      const pending = stillDrafted(shown, await describedNames(client, current.tenantId, source.connection_id), source);
      const drafts = await draftDescriptions(client, current.tenantId, source, pending);
      const names = pending.map((object) => object.name).filter((objectName) => drafts.has(objectName));
      for (let start = 0; start < names.length; start += 5_000) {
        const batch = names.slice(start, start + 5_000);
        await client.query(
          `INSERT INTO graph.description_reviews(tenant_id,source_id,qualified_name,field_name,drafted_text,drafted_by,status,final_text,decided_by,decided_at)
           SELECT $1,$2,n,'',t,'code','approved',t,$5,clock_timestamp() FROM unnest($3::text[],$4::text[]) AS u(n,t)
           ON CONFLICT(tenant_id,source_id,qualified_name,field_name) DO UPDATE SET drafted_text=EXCLUDED.drafted_text,drafted_at=clock_timestamp(),status='approved',final_text=EXCLUDED.final_text,decided_by=EXCLUDED.decided_by,decided_at=EXCLUDED.decided_at
           WHERE graph.description_reviews.status='draft'`,
          [current.tenantId, source.connection_id, batch, batch.map((objectName) => drafts.get(objectName)!), current.userId]);
      }
      return names.length;
    });
    if (approved === null) return reply.code(404).send({ error: 'connection_not_found' });
    return reply.send({ approved });
  });

  // "Show original": the definition exactly as the source holds it, fetched now and never stored or logged (decision 53).
  app.get<{ Params: { connectionId: string }; Querystring: { name?: string } }>('/api/connections/:connectionId/dictionary/original', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const name = q(request.query.name, 500);
    const stored = await withTenant(deps.pool, current.tenantId, (client) => client.query<{ kind: string; encrypted: boolean }>(
      `SELECT kind,encrypted FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3 AND active`, [current.tenantId, request.params.connectionId, name]));
    const row = stored.rows[0];
    if (!row || row.kind === 'calculated_field') return reply.code(404).send({ error: 'original_not_available' });
    if (row.encrypted) return reply.code(409).send({ error: 'definition_encrypted' });
    // Connectors are shared and cached by the server; this route never closes one.
    let connector: ReadOnlyConnector;
    try { connector = await deps.connector(current.tenantId, request.params.connectionId); } catch { return reply.code(503).send({ error: 'source_unavailable' }); }
    try {
      const found = row.kind === 'view' ? (await connector.viewDefinitions?.() ?? []).find((view) => view.qualifiedName === name)?.definition
        : (await connector.routines?.() ?? []).find((routine) => routine.qualifiedName === name)?.definition;
      if (!found) return reply.code(404).send({ error: 'original_not_found_in_source' });
      return reply.header('cache-control', 'no-store').send({ name, text: found });
    } catch { return reply.code(503).send({ error: 'source_unavailable' }); }
  });

  app.post<{ Body: { connectionIds?: unknown; acknowledged?: unknown } }>('/api/dictionary/export-html', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    if (request.body?.acknowledged !== true) return reply.code(400).send({ error: 'export_notice_not_acknowledged' });
    const requested = Array.isArray(request.body?.connectionIds) ? request.body.connectionIds.filter((id): id is string => typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)).slice(0, 50) : null;
    const result = await withTenant(deps.pool, current.tenantId, async (client) => {
      const ids = requested?.length ? requested : (await client.query<{ connection_id: string }>(`SELECT connection_id FROM registry.connections WHERE tenant_id=$1 AND status='active' ORDER BY created_at`, [current.tenantId])).rows.map((row) => row.connection_id);
      const sources: HtmlSource[] = [];
      for (const id of ids) { const source = await exportSource(client, current.tenantId, id); if (source) sources.push(source); }
      if (!sources.length) return null;
      const objectCount = sources.reduce((total, source) => total + source.objects.length + source.outOfScope.length, 0);
      await client.query(`INSERT INTO core.activity_events(tenant_id,event_type,principal_id,safe_details) VALUES($1,'dictionary_exported',$2,$3::jsonb)`,
        [current.tenantId, current.userId, JSON.stringify({ sources: sources.length, objects: objectCount, format: 'html' })]);
      return { sources, objectCount };
    });
    if (!result) return reply.code(404).send({ error: 'no_sources_to_export' });
    const html = renderDictionaryHtml({ generatedAt: new Date().toISOString(), sources: result.sources });
    const filename = `dictionary-${new Date().toISOString().slice(0, 10)}.html`;
    return reply.type('text/html; charset=utf-8').header('content-disposition', `attachment; filename="${filename}"`).header('cache-control', 'no-store').send(html);
  });

  // ER explorer at scale: one table and its neighbours, never the whole catalog (spec 2.8).
  app.get<{ Params: { connectionId: string }; Querystring: { q?: string } }>('/api/connections/:connectionId/er/tables', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const search = q(request.query.q, 100).replace(/[\\%_]/g, (character) => `\\${character}`);
    const rows = await withTenant(deps.pool, current.tenantId, (client) => client.query<{ qualified_name: string; links: number }>(
      `SELECT a.qualified_name,(SELECT count(*) FROM graph.relationships c JOIN graph.relationships r ON r.tenant_id=c.tenant_id AND r.family='structural' AND r.relationship_type='REFERENCES' AND (r.from_asset_id=c.to_asset_id OR r.to_asset_id=c.to_asset_id)
          WHERE c.tenant_id=a.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=a.asset_id)::int AS links
       FROM graph.assets a WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.active AND a.asset_type='dataset' AND a.qualified_name ILIKE '%'||$3||'%'
       ORDER BY a.qualified_name LIMIT 50`, [current.tenantId, request.params.connectionId, search]));
    return reply.send({ tables: rows.rows.map((row) => ({ name: row.qualified_name, links: row.links })) });
  });

  app.get<{ Params: { connectionId: string }; Querystring: { focus?: string; depth?: string; possible?: string } }>('/api/connections/:connectionId/er/neighbourhood', async (request, reply) => {
    const current = await authed(request, reply); if (!current) return;
    const depth = Math.max(1, Math.min(2, Number.parseInt(request.query.depth ?? '1', 10) || 1));
    const possible = request.query.possible === 'true';
    const body = await withTenant(deps.pool, current.tenantId, (client) => erNeighbourhood(client, { tenantId: current.tenantId, connectionId: request.params.connectionId, focus: q(request.query.focus, 500) || null, depth, possible }));
    if (!body) return reply.code(404).send({ error: 'table_not_found' });
    return reply.send(body);
  });
}

/** At most this many tables are drawn around the focus table; the rest are counted and reachable by "Expand neighbours". */
export const ER_NEIGHBOUR_LIMIT = 40;

export async function erNeighbourhood(client: PoolClient, input: { tenantId: string; connectionId: string; focus: string | null; depth: number; possible: boolean }) {
  // Default focus: the table with the most declared or inferred links.
  const focus = input.focus ?? (await client.query<{ qualified_name: string }>(
    `SELECT d.qualified_name FROM graph.assets d JOIN graph.relationships c ON c.tenant_id=d.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id
       JOIN graph.relationships r ON r.tenant_id=c.tenant_id AND r.family='structural' AND r.relationship_type='REFERENCES' AND (r.from_asset_id=c.to_asset_id OR r.to_asset_id=c.to_asset_id)
     WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.asset_type='dataset' GROUP BY d.qualified_name ORDER BY count(*) DESC,d.qualified_name LIMIT 1`, [input.tenantId, input.connectionId])).rows[0]?.qualified_name
    ?? (await client.query<{ qualified_name: string }>(`SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND active AND asset_type='dataset' ORDER BY qualified_name LIMIT 1`, [input.tenantId, input.connectionId])).rows[0]?.qualified_name;
  if (!focus) return null;
  const exists = await client.query(`SELECT 1 FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND active AND asset_type='dataset' AND qualified_name=$3`, [input.tenantId, input.connectionId, focus]);
  if (!exists.rowCount) return null;
  const links = async (tables: string[]) => (await client.query<{ relationship_id: string; from_table: string; to_table: string; from_name: string; to_name: string; evidence_method: string; review_status: string; verification: string | null; confidence_score: string | null; explanation: string | null; low_confidence: boolean }>(
    `WITH focus AS (SELECT c.to_asset_id AS field_id,d.qualified_name AS table_name FROM graph.assets d
        JOIN graph.relationships c ON c.tenant_id=d.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id
        WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.qualified_name=ANY($3::text[]))
     SELECT DISTINCT ON (r.relationship_id) r.relationship_id,fd.qualified_name AS from_table,td.qualified_name AS to_table,f.qualified_name AS from_name,t.qualified_name AS to_name,
        a.evidence_method,a.review_status,a.verification,a.confidence_score::text,a.explanation,(a.evidence_method='inferred' AND a.confidence_score<=0.90) AS low_confidence
     FROM focus JOIN graph.relationships r ON r.tenant_id=$1 AND r.family='structural' AND r.relationship_type='REFERENCES' AND (r.from_asset_id=focus.field_id OR r.to_asset_id=focus.field_id)
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id AND f.active AND f.source_id=$2
       JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active AND t.source_id=$2
       JOIN graph.relationships fc ON fc.tenant_id=r.tenant_id AND fc.family='structural' AND fc.relationship_type='CONTAINS' AND fc.to_asset_id=f.asset_id JOIN graph.assets fd ON fd.tenant_id=fc.tenant_id AND fd.asset_id=fc.from_asset_id
       JOIN graph.relationships tc ON tc.tenant_id=r.tenant_id AND tc.family='structural' AND tc.relationship_type='CONTAINS' AND tc.to_asset_id=t.asset_id JOIN graph.assets td ON td.tenant_id=tc.tenant_id AND td.asset_id=tc.from_asset_id
       JOIN LATERAL(SELECT evidence_method,review_status,verification,confidence_score,explanation FROM graph.assertions s WHERE s.tenant_id=r.tenant_id AND s.relationship_id=r.relationship_id AND s.valid_to IS NULL
         AND s.review_status NOT IN ('rejected','stale','disputed') AND (s.evidence_method='declared' OR (s.evidence_method='inferred' AND (s.confidence_score>0.90 OR $4::boolean)))
         ORDER BY CASE WHEN s.evidence_method='declared' THEN 0 ELSE 1 END,s.confidence_score DESC,s.captured_at DESC LIMIT 1)a ON true
     ORDER BY r.relationship_id`, [input.tenantId, input.connectionId, tables, input.possible])).rows;
  const tables = new Set([focus]); let frontier = [focus]; const relationships = new Map<string, Awaited<ReturnType<typeof links>>[number]>();
  let hidden = 0;
  for (let level = 0; input.depth > level && frontier.length; level++) {
    const next: string[] = [];
    for (const link of await links(frontier)) {
      relationships.set(link.relationship_id, link);
      for (const table of [link.from_table, link.to_table]) if (!tables.has(table)) {
        if (tables.size >= ER_NEIGHBOUR_LIMIT) { hidden++; continue; }
        tables.add(table); next.push(table);
      }
    }
    frontier = next;
  }
  const shown = [...relationships.values()].filter((link) => tables.has(link.from_table) && tables.has(link.to_table));
  const columns = await client.query<{ qualified_name: string; object_type: string | null; columns: Array<{ name: string; label: string; data_type: string | null; is_nullable: boolean | null }>; neighbours: number }>(
    `SELECT d.qualified_name,v.structural_attributes->>'object_type' AS object_type,
       coalesce((SELECT jsonb_agg(jsonb_build_object('name',f.qualified_name,'label',coalesce(p.display_name,split_part(f.qualified_name,'.',-1)),'data_type',p.data_type,'is_nullable',p.is_nullable) ORDER BY f.qualified_name)
         FROM graph.relationships c JOIN graph.assets f ON f.tenant_id=c.tenant_id AND f.asset_id=c.to_asset_id AND f.active
         LEFT JOIN LATERAL(SELECT data_type,is_nullable,display_name FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
         WHERE c.tenant_id=d.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id),'[]'::jsonb) AS columns,0 AS neighbours
     FROM graph.assets d LEFT JOIN LATERAL(SELECT structural_attributes FROM graph.asset_versions WHERE tenant_id=d.tenant_id AND asset_id=d.asset_id ORDER BY version DESC LIMIT 1)v ON true
     WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.asset_type='dataset' AND d.qualified_name=ANY($3::text[]) ORDER BY d.qualified_name`, [input.tenantId, input.connectionId, [...tables]]);
  // How many links each shown table has outside the view, so "Expand neighbours" can say what it would add.
  const outside = new Map<string, number>();
  for (const link of await links([...tables])) {
    if (tables.has(link.from_table) && tables.has(link.to_table)) continue;
    const inside = tables.has(link.from_table) ? link.from_table : link.to_table; outside.set(inside, (outside.get(inside) ?? 0) + 1);
  }
  return {
    focus, depth: input.depth, hiddenTables: hidden,
    tables: columns.rows.map((row) => ({ qualified_name: row.qualified_name, object_type: row.object_type, columns: row.columns, more_links: outside.get(row.qualified_name) ?? 0 })),
    relationships: shown.map((link) => ({ relationship_type: 'REFERENCES', granularity: 'field', from_name: link.from_name, to_name: link.to_name, from_table: link.from_table, to_table: link.to_table,
      evidence_method: link.evidence_method, review_status: link.review_status, verification: link.verification, confidence_score: link.confidence_score, explanation: link.explanation, low_confidence: link.low_confidence })),
  };
}

type ColumnRow = { name: string; label: string | null; data_type: string | null; is_nullable: boolean | null; statistics_estimated?: boolean | null; tags: string[] | null; tag_evidence: Array<{ tag: string; detection: string }> | null; null_rate: string | null; distinct_count: string | null; description: string | null; used_by: number; field_id: string };

async function objectDetail(client: PoolClient, tenantId: string, connectionId: string, name: string) {
  const source = await sourceFor(client, tenantId, connectionId); if (!source) return null;
  const objects = await listObjects(client, tenantId, source);
  const listed = objects.find((object) => object.name === name); if (!listed) return null;
  const datasetSource = source.connector_type === 'dbt' && source.source_ref?.startsWith('warehouse:') ? source.source_ref.slice('warehouse:'.length) : connectionId;
  const dataset = (await client.query<{ asset_id: string; asset_type: string; statistics: { row_count?: number; row_count_estimated?: boolean } | null; structural: { columns?: Array<{ name: string }>; primary_key?: string[]; indexes?: Array<{ name: string; columns: string[]; unique: boolean; primary: boolean }> } | null; first_seen_at: Date }>(
    `SELECT a.asset_id,a.asset_type,v.statistics,v.structural_attributes AS structural,a.first_seen_at FROM graph.assets a
       LEFT JOIN LATERAL(SELECT statistics,structural_attributes FROM graph.asset_versions WHERE tenant_id=a.tenant_id AND asset_id=a.asset_id ORDER BY version DESC LIMIT 1)v ON true
     WHERE a.tenant_id=$1 AND a.source_id=ANY($2::uuid[]) AND a.qualified_name=$3 AND a.active AND a.asset_type IN ('dataset','report','field')
     ORDER BY (a.source_id=$4) DESC LIMIT 1`, [tenantId, [datasetSource, connectionId], name, datasetSource])).rows[0] ?? null;
  const definition = (await client.query<{ kind: string; scrubbed_text: string | null; encrypted: boolean; parameters: Array<{ name: string; dataType: string; mode: string }>; returned_columns: Array<{ name: string; dataType: string }>; analysis: { writes?: Array<{ table: string; mode: string }>; reads?: string[]; calls?: string[]; steps?: string[]; kind?: string }; captured_at: Date; version: number }>(
    `SELECT kind,scrubbed_text,encrypted,parameters,returned_columns,analysis,captured_at,version FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3 AND active`, [tenantId, connectionId, name])).rows[0] ?? null;
  const lower = name.toLowerCase();
  // Stored definitions of this source that read, write or call this object (parsed from SQL).
  const related = (await client.query<{ qualified_name: string; kind: string; analysis: { writes?: Array<{ table: string; mode: string }>; reads?: string[]; calls?: string[] } }>(
    `SELECT qualified_name,kind,analysis FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active AND qualified_name<>$3 AND kind<>'calculated_field'
       AND (EXISTS(SELECT 1 FROM jsonb_array_elements_text(analysis->'reads') x WHERE lower(x)=$4) OR EXISTS(SELECT 1 FROM jsonb_array_elements(analysis->'writes') w WHERE lower(w->>'table')=$4)
         OR EXISTS(SELECT 1 FROM jsonb_array_elements_text(analysis->'calls') c WHERE lower(c)=lower(regexp_replace($3,'\\(.*\\)$',''))))
     ORDER BY qualified_name LIMIT 500`, [tenantId, connectionId, name, lower])).rows;
  const builtBy = related.flatMap((row) => (row.analysis.writes ?? []).filter((write) => write.table.toLowerCase() === lower).map((write) => ({ name: row.qualified_name, kind: row.kind, mode: write.mode })));
  const readBy = related.filter((row) => (row.analysis.reads ?? []).some((read) => read.toLowerCase() === lower)).map((row) => ({ name: row.qualified_name, kind: row.kind }));
  const calledBy = related.filter((row) => (row.analysis.calls ?? []).some((call) => call.toLowerCase() === name.replace(/\(.*\)$/, '').toLowerCase())).map((row) => row.qualified_name);

  let columns: Array<Record<string, unknown>> = []; let keys: Array<Record<string, unknown>> = []; let joins: Array<Record<string, unknown>> = [];
  let flowUsers: Array<{ name: string; source: string; type: string }> = []; let dependentReports = 0; let lastProfiled: Date | null = null;
  if (dataset) {
    const columnRows = (await client.query<ColumnRow>(
      `SELECT f.qualified_name AS name,p.display_name AS label,p.data_type,p.is_nullable,p.sensitivity_tags AS tags,p.sensitivity_evidence AS tag_evidence,p.null_rate::text,p.distinct_count::text,p.statistics_estimated,f.asset_id AS field_id,
         (SELECT description FROM graph.dictionary_descriptions dd WHERE dd.tenant_id=f.tenant_id AND dd.source_id=$3 AND dd.table_name=$4 AND dd.column_name=split_part(f.qualified_name,'.',array_length(string_to_array(f.qualified_name,'.'),1))) AS description,
         (SELECT count(*) FROM graph.relationships u WHERE u.tenant_id=f.tenant_id AND u.family='data_flow' AND u.from_asset_id=f.asset_id)::int AS used_by
       FROM graph.relationships c JOIN graph.assets f ON f.tenant_id=c.tenant_id AND f.asset_id=c.to_asset_id AND f.active
       LEFT JOIN LATERAL(SELECT display_name,data_type,is_nullable,sensitivity_tags,sensitivity_evidence,null_rate,distinct_count,statistics_estimated,captured_at FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
       WHERE c.tenant_id=$1 AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=$2`, [tenantId, dataset.asset_id, connectionId, name])).rows;
    // Columns in the order the source declares them; fields without a recorded order follow by name.
    const order = new Map((dataset.structural?.columns ?? []).map((column, index) => [column.name, index]));
    const own = (field: string) => field.slice(name.length + 1);
    columnRows.sort((a, b) => (order.get(own(a.name)) ?? 1e9) - (order.get(own(b.name)) ?? 1e9) || a.name.localeCompare(b.name));
    const references = (await client.query<{ from_name: string; to_name: string; from_table: string; to_table: string; evidence_method: string; review_status: string; verification: string | null; confidence_score: string | null }>(
      `SELECT DISTINCT ON (r.relationship_id) f.qualified_name AS from_name,t.qualified_name AS to_name,fd.qualified_name AS from_table,td.qualified_name AS to_table,a.evidence_method,a.review_status,a.verification,a.confidence_score::text
       FROM graph.relationships c JOIN graph.relationships r ON r.tenant_id=c.tenant_id AND r.family='structural' AND r.relationship_type='REFERENCES' AND (r.from_asset_id=c.to_asset_id OR r.to_asset_id=c.to_asset_id)
         JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id AND f.active JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active
         JOIN graph.relationships fc ON fc.tenant_id=r.tenant_id AND fc.family='structural' AND fc.relationship_type='CONTAINS' AND fc.to_asset_id=f.asset_id JOIN graph.assets fd ON fd.tenant_id=fc.tenant_id AND fd.asset_id=fc.from_asset_id
         JOIN graph.relationships tc ON tc.tenant_id=r.tenant_id AND tc.family='structural' AND tc.relationship_type='CONTAINS' AND tc.to_asset_id=t.asset_id JOIN graph.assets td ON td.tenant_id=tc.tenant_id AND td.asset_id=tc.from_asset_id
         JOIN LATERAL(SELECT evidence_method,review_status,verification,confidence_score FROM graph.assertions s WHERE s.tenant_id=r.tenant_id AND s.relationship_id=r.relationship_id AND s.valid_to IS NULL AND s.review_status NOT IN ('rejected','stale','disputed')
           ORDER BY CASE WHEN s.evidence_method='declared' THEN 0 ELSE 1 END,s.confidence_score DESC NULLS LAST LIMIT 1)a ON true
       WHERE c.tenant_id=$1 AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=$2 ORDER BY r.relationship_id`, [tenantId, dataset.asset_id])).rows;
    const keyed = new Set(references.filter((ref) => ref.evidence_method === 'declared').flatMap((ref) => [ref.from_name, ref.to_name]));
    const withheldReason = 'Withheld: this column is tagged sensitive, so its statistics are never collected (contract 7).';
    columns = columnRows.map((row) => {
      const tags = row.tags ?? []; const withheld = tags.length > 0;
      return { name: own(row.name) || row.name, label: row.label, dataType: row.data_type, nullable: row.is_nullable, tags, inferredTags: (row.tag_evidence ?? []).filter((item) => item.detection === 'inferred').map((item) => item.tag), key: keyed.has(row.name),
        statsWithheld: withheld, ...(withheld ? { withheldReason } : {}), nullRate: withheld || row.null_rate === null ? null : Number(row.null_rate), distinctCount: withheld || row.distinct_count === null ? null : Number(row.distinct_count),
        ...(!withheld && row.statistics_estimated ? { statisticsEstimated: true } : {}), description: row.description, usedBy: row.used_by };
    });
    keys = references.filter((ref) => ref.evidence_method === 'declared' && ref.from_table === name).map((ref) => ({ column: ref.from_name.slice(name.length + 1), references: ref.to_name, evidence: 'declared' }));
    joins = references.map((ref) => {
      const outgoing = ref.from_table === name;
      return { column: (outgoing ? ref.from_name : ref.to_name).slice(name.length + 1), otherTable: outgoing ? ref.to_table : ref.from_table, otherColumn: (outgoing ? ref.to_name : ref.from_name).split('.').at(-1),
        direction: outgoing ? 'references' : 'referenced_by', evidenceMethod: ref.evidence_method, reviewStatus: ref.review_status, verification: ref.verification,
        confidence: ref.confidence_score === null ? null : Number(ref.confidence_score), probable: ref.evidence_method === 'inferred' && ref.review_status !== 'approved' };
    });
    flowUsers = (await client.query<{ name: string; source: string; asset_type: string }>(
      `SELECT DISTINCT t.qualified_name AS name,coalesce(nullif(c.display_name,''),c.connector_type) AS source,t.asset_type FROM graph.relationships r
         JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active JOIN registry.connections c ON c.tenant_id=t.tenant_id AND c.connection_id=t.source_id
       WHERE r.tenant_id=$1 AND r.family='data_flow' AND r.from_asset_id=$2 AND r.granularity IN ('dataset','report') ORDER BY 1 LIMIT 200`, [tenantId, dataset.asset_id])).rows.map((row) => ({ name: row.name, source: row.source, type: row.asset_type }));
    dependentReports = Number((await client.query<{ n: number }>(
      `WITH RECURSIVE down(asset_id,depth) AS (SELECT $2::uuid,0 UNION SELECT r.to_asset_id,d.depth+1 FROM down d JOIN graph.relationships r ON r.tenant_id=$1 AND r.family='data_flow' AND r.from_asset_id=d.asset_id WHERE d.depth<8)
       SELECT count(DISTINCT a.asset_id)::int AS n FROM down JOIN graph.assets a ON a.tenant_id=$1 AND a.asset_id=down.asset_id AND a.asset_type='report' AND a.active`, [tenantId, dataset.asset_id])).rows[0]!.n);
    lastProfiled = (await client.query<{ at: Date | null }>(`SELECT max(captured_at) AS at FROM graph.asset_versions WHERE tenant_id=$1 AND asset_id=$2`, [tenantId, dataset.asset_id])).rows[0]?.at ?? null;
  }
  const tests = source.connector_type === 'dbt' ? (await client.query<{ column_name: string; test_name: string }>('SELECT column_name,test_name FROM graph.dbt_tests WHERE tenant_id=$1 AND source_id=$2 AND model=$3 ORDER BY column_name,test_name', [tenantId, connectionId, name])).rows.map((row) => ({ column: row.column_name || null, test: row.test_name })) : [];

  // Description: imported or dbt text wins; then one a person approved or edited; otherwise the code-drafted one,
  // shown and used as "Drafted" (decision 64). Approval is optional and never blocks anything.
  const documented = (await client.query<{ description: string; origin: string; imported_at: Date }>(
    `SELECT description,origin,imported_at FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$2 AND table_name=$3 AND column_name=''`, [tenantId, connectionId, name])).rows[0];
  let description: Record<string, unknown> | null = null;
  if (documented) description = { text: documented.description, origin: documented.origin, at: documented.imported_at };
  else {
    const review = (await client.query<{ status: string; final_text: string | null; decided_at: Date | null; decided_by: string | null }>(
      `SELECT r.status,r.final_text,r.decided_at,u.display_name AS decided_by FROM graph.description_reviews r LEFT JOIN core.users u ON u.tenant_id=r.tenant_id AND u.user_id=r.decided_by
       WHERE r.tenant_id=$1 AND r.source_id=$2 AND r.qualified_name=$3 AND r.field_name='' AND r.status<>'draft'`, [tenantId, connectionId, name])).rows[0];
    const drafted = review ? undefined : (await draftDescriptions(client, tenantId, source, [listed])).get(name);
    if (review) description = { text: review.final_text, origin: review.status, by: review.decided_by, at: review.decided_at };
    else if (drafted) description = { text: drafted, origin: 'drafted' };
  }

  // Tables and columns a definition touches: columns named in its SQL are marked used; a used column that an earlier
  // version of the table had and the current one lacks is marked dropped.
  let tablesAndColumns: Array<{ table: string; access: string; columns: Array<{ name: string; used: boolean; dropped: boolean }> }> = [];
  if (definition && definition.kind !== 'calculated_field') {
    const touched = [...new Set([...(definition.analysis.writes ?? []).map((write) => write.table), ...(definition.analysis.reads ?? [])])];
    const words = new Set((definition.scrubbed_text ?? '').toLowerCase().match(/[a-z_][\w$#]*/g) ?? []);
    const tableRows = touched.length ? (await client.query<{ qualified_name: string; current: string[] | null; previous: string[] | null }>(
      `SELECT a.qualified_name,(SELECT array_agg(c->>'name') FROM jsonb_array_elements(v.structural_attributes->'columns') c) AS current,
         (SELECT array_agg(DISTINCT c->>'name') FROM graph.asset_versions o,jsonb_array_elements(o.structural_attributes->'columns') c WHERE o.tenant_id=a.tenant_id AND o.asset_id=a.asset_id AND o.version<v.version) AS previous
       FROM graph.assets a JOIN LATERAL(SELECT version,structural_attributes FROM graph.asset_versions WHERE tenant_id=a.tenant_id AND asset_id=a.asset_id ORDER BY version DESC LIMIT 1)v ON true
       WHERE a.tenant_id=$1 AND a.source_id=$2 AND a.asset_type='dataset' AND lower(a.qualified_name)=ANY($3::text[])`, [tenantId, connectionId, touched.map((table) => table.toLowerCase())])).rows : [];
    tablesAndColumns = touched.map((table) => {
      const row = tableRows.find((candidate) => candidate.qualified_name.toLowerCase() === table.toLowerCase());
      const writes = (definition.analysis.writes ?? []).find((write) => write.table === table);
      const current = row?.current ?? []; const dropped = (row?.previous ?? []).filter((column) => !current.includes(column) && words.has(column.toLowerCase()));
      return { table: row?.qualified_name ?? table, access: writes ? `writes (${writes.mode})` : 'reads',
        columns: [...current.map((column) => ({ name: column, used: words.has(column.toLowerCase()), dropped: false })), ...dropped.map((column) => ({ name: column, used: true, dropped: true }))] };
    });
  }

  return {
    source: { connectionId, name: source.name, type: source.connector_type },
    name, kind: listed.kind, custom: listed.custom, origin: listed.origin, ...(listed.copyOf ? { copyOf: listed.copyOf, copySimilarity: listed.copySimilarity } : {}), procedureKind: listed.procedureKind,
    description,
    stats: dataset ? { rows: typeof dataset.statistics?.row_count === 'number' ? dataset.statistics.row_count : null, ...(dataset.statistics?.row_count_estimated ? { rowsEstimated: true } : {}), lastProfiled, dependentReports, builtBy: builtBy.map((item) => item.name) } : null,
    columns, keys, joins, tests,
    // Primary key and indexes from the catalog; null when this source or profile did not read them.
    indexes: dataset?.structural && Array.isArray(dataset.structural.indexes) ? { primaryKey: dataset.structural.primary_key ?? [], indexes: dataset.structural.indexes } : null,
    usedBy: [...readBy.map((item) => ({ name: item.name, kind: item.kind, how: 'reads', source: source.name })), ...builtBy.map((item) => ({ name: item.name, kind: item.kind, how: `writes (${item.mode})`, source: source.name })),
      ...flowUsers.map((item) => ({ name: item.name, kind: item.type === 'report' ? 'report' : 'dataset', how: 'data flows into it', source: item.source }))],
    definition: definition ? {
      kind: definition.kind, encrypted: definition.encrypted, text: definition.scrubbed_text, literalsHidden: true, version: definition.version, capturedAt: definition.captured_at,
      // Inputs (and a procedure's OUT parameters) apart from the columns a function returns (decision 64).
      parameters: definition.parameters.map((parameter) => ({ ...parameter, declared: true })), returns: definition.returned_columns,
      writes: definition.analysis.writes ?? [], reads: definition.analysis.reads ?? [], calls: definition.analysis.calls ?? [], steps: definition.analysis.steps ?? [],
      calledBy, runBy: [] as string[], tablesAndColumns,
      originalAvailable: !definition.encrypted && definition.kind !== 'calculated_field',
    } : null,
  };
}

/**
 * Every object's description for the exports (HTML, Markdown and Word): imported or dbt text, or one a person approved
 * or edited, or else the drafted one, marked drafted (decision 64). Null when the connection is not found.
 */
export async function sourceDescriptions(client: PoolClient, tenantId: string, connectionId: string): Promise<Map<string, { text: string; drafted: boolean }> | null> {
  const source = await sourceFor(client, tenantId, connectionId); if (!source) return null;
  const objects = await listObjects(client, tenantId, source);
  const rows = (await client.query<{ table_name: string; text: string }>(
    `SELECT table_name,description AS text FROM graph.dictionary_descriptions WHERE tenant_id=$1 AND source_id=$2 AND column_name=''
     UNION ALL SELECT qualified_name,final_text FROM graph.description_reviews WHERE tenant_id=$1 AND source_id=$2 AND field_name='' AND status<>'draft'`, [tenantId, connectionId])).rows;
  const described = new Map(rows.map((row) => [row.table_name, { text: row.text, drafted: false }]));
  const drafts = await draftDescriptions(client, tenantId, source, objects.filter((object) => !described.has(object.name)));
  for (const [name, text] of drafts) described.set(name, { text, drafted: true });
  return described;
}

/** One source for the offline export: names, types, descriptions, columns with withheld statistics left out,
 * scrubbed definitions and relationships. Out-of-scope objects by name and type only (non-negotiable 11). */
async function exportSource(client: PoolClient, tenantId: string, connectionId: string): Promise<HtmlSource | null> {
  const source = await sourceFor(client, tenantId, connectionId); if (!source) return null;
  const objects = await listObjects(client, tenantId, source);
  const datasetSource = source.connector_type === 'dbt' && source.source_ref?.startsWith('warehouse:') ? source.source_ref.slice('warehouse:'.length) : connectionId;
  const names = objects.map((object) => object.name);
  const columnRows = (await client.query<{ table_name: string; name: string; label: string | null; data_type: string | null; tags: string[] | null; null_rate: string | null; distinct_count: string | null; description: string | null }>(
    `SELECT d.qualified_name AS table_name,split_part(f.qualified_name,'.',array_length(string_to_array(f.qualified_name,'.'),1)) AS name,p.display_name AS label,p.data_type,p.sensitivity_tags AS tags,p.null_rate::text,p.distinct_count::text,dd.description
     FROM graph.assets d JOIN graph.relationships c ON c.tenant_id=d.tenant_id AND c.family='structural' AND c.relationship_type='CONTAINS' AND c.from_asset_id=d.asset_id
       JOIN graph.assets f ON f.tenant_id=c.tenant_id AND f.asset_id=c.to_asset_id AND f.active
       LEFT JOIN LATERAL(SELECT display_name,data_type,sensitivity_tags,null_rate,distinct_count FROM profiler.field_profiles WHERE tenant_id=f.tenant_id AND asset_id=f.asset_id ORDER BY profile_version DESC LIMIT 1)p ON true
       LEFT JOIN graph.dictionary_descriptions dd ON dd.tenant_id=d.tenant_id AND dd.source_id=$3 AND dd.table_name=d.qualified_name AND dd.column_name=split_part(f.qualified_name,'.',array_length(string_to_array(f.qualified_name,'.'),1))
     WHERE d.tenant_id=$1 AND d.source_id=$2 AND d.active AND d.qualified_name=ANY($4::text[]) ORDER BY d.qualified_name,f.qualified_name`, [tenantId, datasetSource, connectionId, names])).rows;
  const definitions = (await client.query<{ qualified_name: string; scrubbed_text: string | null; encrypted: boolean; analysis: { writes?: Array<{ table: string; mode: string }>; reads?: string[]; calls?: string[] } }>(
    `SELECT qualified_name,scrubbed_text,encrypted,analysis FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active`, [tenantId, connectionId])).rows;
  // Drafted descriptions are exported too, marked as drafted (decision 64).
  const byDescription = (await sourceDescriptions(client, tenantId, connectionId)) ?? new Map<string, { text: string; drafted: boolean }>();
  const relationships = (await client.query<{ from_name: string; to_name: string; evidence_method: string; review_status: string }>(
    `SELECT DISTINCT ON (r.relationship_id) f.qualified_name AS from_name,t.qualified_name AS to_name,a.evidence_method,a.review_status FROM graph.relationships r
       JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id AND f.active AND f.source_id=$2 JOIN graph.assets t ON t.tenant_id=r.tenant_id AND t.asset_id=r.to_asset_id AND t.active AND t.source_id=$2
       JOIN LATERAL(SELECT evidence_method,review_status FROM graph.assertions s WHERE s.tenant_id=r.tenant_id AND s.relationship_id=r.relationship_id AND s.valid_to IS NULL AND s.review_status NOT IN ('rejected','stale','disputed') ORDER BY CASE WHEN s.evidence_method='declared' THEN 0 ELSE 1 END LIMIT 1)a ON true
     WHERE r.tenant_id=$1 AND r.family='structural' AND r.relationship_type='REFERENCES' ORDER BY r.relationship_id LIMIT 20000`, [tenantId, datasetSource])).rows;
  const outOfScope = (await client.query<{ qualified_name: string; object_type: string }>(
    `SELECT qualified_name,object_type FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2 AND scope_mode IN ('list_only','exclude') ORDER BY qualified_name`, [tenantId, connectionId])).rows;
  const byTable = new Map<string, typeof columnRows>();
  for (const row of columnRows) byTable.set(row.table_name, [...(byTable.get(row.table_name) ?? []), row]);
  const byDefinition = new Map(definitions.map((row) => [row.qualified_name, row]));
  const excluded = new Set(outOfScope.map((row) => row.qualified_name));
  return {
    name: source.name, type: source.connector_type,
    // Out-of-scope objects appear only in the name-and-type list (non-negotiable 11).
    objects: objects.filter((object) => !excluded.has(object.name)).map((object) => {
      const definition = byDefinition.get(object.name);
      const described = byDescription.get(object.name);
      return { name: object.name, kind: object.kind, custom: object.custom, origin: object.origin, group: groupFor(object).label, description: described?.text ?? null, ...(described?.drafted ? { descriptionDrafted: true } : {}),
        columns: (byTable.get(object.name) ?? []).map((row) => {
          const withheld = (row.tags ?? []).length > 0;
          return { name: row.name, label: row.label, dataType: row.data_type, tags: row.tags ?? [], statsWithheld: withheld,
            nullRate: withheld || row.null_rate === null ? null : Number(row.null_rate), distinctCount: withheld || row.distinct_count === null ? null : Number(row.distinct_count), description: row.description };
        }),
        ...(definition ? { definition: { encrypted: definition.encrypted, text: definition.scrubbed_text === null ? null : scrubDefinition(definition.scrubbed_text), writes: definition.analysis.writes ?? [], reads: definition.analysis.reads ?? [], calls: definition.analysis.calls ?? [] } } : {}) };
    }),
    relationships: relationships.map((row) => ({ from: row.from_name, to: row.to_name, evidence: row.evidence_method, review: row.review_status })),
    outOfScope: outOfScope.map((row) => ({ name: row.qualified_name, type: row.object_type })),
  };
}
