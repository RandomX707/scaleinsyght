import { createHash } from 'node:crypto';
import type { PoolClient } from '@scaleinsyght/db';

/** Column lineage of one SELECT, as returned by the SQLGlot service (services/sqlparse, POST /lineage). */
export type StatementLineage = {
  reads: string[];
  missing_tables: string[];
  columns: Array<{ column: string; kind: 'direct' | 'derived'; sources: Array<{ table: string; column: string }> }>;
  unresolved: string[];
};
export type LineageDialect = 'postgres' | 'sql_server' | 'snowflake';

export class SqlParserUnavailable extends Error { constructor() { super('sql_parser_unavailable'); } }

/** Calls the SQL parser service. Only names come back; literals and SQL text are not returned or stored. */
export async function parseStatementLineage(input: { sql: string; dialect: LineageDialect; tables: Record<string, Record<string, string>>; default_schema?: string },
  url = process.env.SQLPARSE_URL ?? 'http://127.0.0.1:8011'): Promise<StatementLineage> {
  let response: Response;
  try {
    response = await fetch(new URL('/lineage', url), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), signal: AbortSignal.timeout(15_000) });
  } catch { throw new SqlParserUnavailable(); }
  if (response.status === 400) {
    const detail = ((await response.json().catch(() => ({}))) as { detail?: unknown }).detail;
    throw new Error(typeof detail === 'string' && /^[a-z_]+$/.test(detail) ? detail : 'sql_parse_failed');
  }
  if (!response.ok) throw new SqlParserUnavailable();
  return await response.json() as StatementLineage;
}

type Assets = { dataset(name: string): string | undefined; field(name: string): string | undefined };

/** Writes the data-flow edges one statement proves, with evidence on every edge, and records a gap for every read or
 * column the statement's sources cannot account for. No edge is written without a parsed or declared source. */
export async function writeStatementLineage(client: PoolClient, input: {
  tenantId: string; target: string; lineage: StatementLineage; assets: Assets;
  evidenceMethod: 'parsed' | 'declared'; collector: string; evidenceType: string; statementHash: string;
  /** Table-level dependencies declared outside the SQL (dbt depends_on); when absent, the parsed reads are used. */
  declaredReads?: string[]; missingReason?: (table: string) => string;
}): Promise<{ tableEdges: number; columnEdges: number; gaps: number }> {
  const targetId = input.assets.dataset(input.target);
  if (!targetId) throw new Error('lineage_target_not_found');
  const evidence = await client.query<{ evidence_id: string }>(
    `INSERT INTO graph.evidence(tenant_id,evidence_type,safe_metadata) VALUES($1,$2,$3::jsonb) RETURNING evidence_id`,
    [input.tenantId, input.evidenceType, JSON.stringify({ collector: input.collector, statement_hash: input.statementHash, target: input.target })]);
  const evidenceId = evidence.rows[0]!.evidence_id;
  const written = new Set<string>();
  const edge = async (fromId: string, toId: string, granularity: 'dataset' | 'field', method: 'parsed' | 'declared', explanation: string, transformation: Record<string, unknown> | null) => {
    written.add(await writeFlowEdge(client, { tenantId: input.tenantId, fromId, toId, granularity, method, explanation, transformation, collector: input.collector, evidenceId }));
  };
  let gaps = 0;
  const gap = async (assetId: string, reason: string) => { await openGap(client, input.tenantId, assetId, reason); gaps++; };
  const missing = new Set<string>();
  let tableEdges = 0; let columnEdges = 0;
  const tableMethod = input.declaredReads ? input.evidenceMethod : 'parsed';
  for (const table of input.declaredReads ?? input.lineage.reads) {
    const fromId = input.assets.dataset(table);
    if (!fromId) { missing.add(table); continue; }
    await edge(fromId, targetId, 'dataset', tableMethod, tableMethod === 'declared' ? 'Dependency declared by the dbt project' : 'Table read by the parsed SQL', null);
    tableEdges++;
  }
  for (const table of input.lineage.missing_tables) missing.add(table);
  for (const table of missing) await gap(targetId, input.missingReason?.(table) ?? `Reads ${table}, which no connected source exposes`);
  for (const column of input.lineage.columns) {
    const toId = input.assets.field(`${input.target}.${column.column}`);
    if (!toId) continue;
    let resolved = 0;
    for (const source of column.sources) {
      const fromId = input.assets.field(`${source.table}.${source.column}`);
      if (!fromId) continue;
      await edge(fromId, toId, 'field', 'parsed', column.kind === 'direct' ? 'Column copied by the parsed SQL' : 'Column computed by the parsed SQL',
        { kind: column.kind });
      resolved++; columnEdges++;
    }
    if (!resolved) await gap(toId, `${column.column} comes from ${column.sources.map(source => source.table).filter((table, index, all) => all.indexOf(table) === index).join(', ')}, which no connected source exposes`);
  }
  for (const name of input.lineage.unresolved) {
    const toId = input.assets.field(`${input.target}.${name}`);
    if (toId) await gap(toId, `The source of ${name} could not be resolved from the SQL`);
  }
  // Edges this collector wrote earlier for the same target and no longer proves are closed, never deleted (contract 6).
  await client.query(
    `UPDATE graph.assertions a SET valid_to=clock_timestamp() FROM graph.relationships r
     WHERE a.tenant_id=$1 AND r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id AND a.collector_version=$2 AND a.valid_to IS NULL
       AND NOT (r.relationship_id=ANY($4::uuid[]))
       AND (r.to_asset_id=$3 OR r.to_asset_id IN (SELECT c.to_asset_id FROM graph.relationships c WHERE c.tenant_id=$1 AND c.from_asset_id=$3 AND c.relationship_type='CONTAINS'))`,
    [input.tenantId, input.collector, targetId, [...written]]);
  return { tableEdges, columnEdges, gaps };
}

/** Writes one DERIVES_FROM data-flow edge and its assertion for a collector, or adds the evidence to the collector's
 * current assertion on that edge. Returns the relationship id. Assertions are never deleted or overwritten (contract 6). */
export async function writeFlowEdge(client: PoolClient, input: {
  tenantId: string; fromId: string; toId: string; granularity: 'dataset' | 'field' | 'report'; method: 'parsed' | 'declared';
  explanation: string; transformation: Record<string, unknown> | null; collector: string; evidenceId: string;
}): Promise<string> {
  const relationship = await client.query<{ relationship_id: string }>(
    `INSERT INTO graph.relationships(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) VALUES($1,'data_flow','DERIVES_FROM',$2,$3,$4)
     ON CONFLICT(tenant_id,family,relationship_type,from_asset_id,to_asset_id,granularity) DO UPDATE SET relationship_type=EXCLUDED.relationship_type RETURNING relationship_id`,
    [input.tenantId, input.fromId, input.toId, input.granularity]);
  const relationshipId = relationship.rows[0]!.relationship_id;
  const existing = await client.query<{ assertion_id: string }>(
    `SELECT assertion_id FROM graph.assertions WHERE tenant_id=$1 AND relationship_id=$2 AND evidence_method=$3 AND collector_version=$4 AND valid_to IS NULL LIMIT 1`,
    [input.tenantId, relationshipId, input.method, input.collector]);
  if (existing.rows[0]) {
    await client.query('UPDATE graph.assertions SET evidence_ids=array_append(evidence_ids,$3::uuid) WHERE tenant_id=$1 AND assertion_id=$2 AND NOT ($3::uuid=ANY(evidence_ids))', [input.tenantId, existing.rows[0].assertion_id, input.evidenceId]);
    return relationshipId;
  }
  await client.query(
    `INSERT INTO graph.assertions(tenant_id,relationship_id,evidence_method,evidence_ids,confidence_score,explanation,transformation,collector_version) VALUES($1,$2,$3,$4,1,$5,$6::jsonb,$7)`,
    [input.tenantId, relationshipId, input.method, [input.evidenceId], input.explanation, input.transformation === null ? null : JSON.stringify(input.transformation), input.collector]);
  return relationshipId;
}

/** Records an open gap on an asset unless the same gap is already open. Gaps are never hidden (contract 6). */
export async function openGap(client: PoolClient, tenantId: string, assetId: string, reason: string): Promise<void> {
  const open = await client.query('SELECT 1 FROM graph.gaps WHERE tenant_id=$1 AND between_asset_ids=$2::uuid[] AND reason=$3 AND closed_by_assertion_id IS NULL', [tenantId, [assetId], reason]);
  if (!open.rowCount) await client.query('INSERT INTO graph.gaps(tenant_id,between_asset_ids,reason) VALUES($1,$2,$3)', [tenantId, [assetId], reason]);
}

export const statementHash = (sql: string) => createHash('sha256').update(sql).digest('hex');
