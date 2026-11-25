import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { scrubDefinition } from '@scaleinsyght/classification';
import { withTenant } from '@scaleinsyght/db';

/**
 * Reads what a procedure, function, view or package does from its scrubbed definition text: the tables it writes and how,
 * the tables it reads, the routines it calls, and a plain step list. Deterministic, code only, no model. Everything here
 * is "parsed from SQL" evidence and is labelled so; it is never presented as declared.
 */
export type WriteMode = 'truncate-insert' | 'merge' | 'insert' | 'update' | 'delete';
export type ProcedureKind = 'fact_loader' | 'report' | 'data_check' | 'archive' | 'utility';
export type DefinitionAnalysis = {
  writes: Array<{ table: string; mode: WriteMode }>;
  reads: string[];
  calls: string[];
  steps: string[];
  kind: ProcedureKind;
};

const NAME = String.raw`((?:\[[^\]]+\]|"[^"]+"|[A-Za-z_#][\w$#]*)(?:\.(?:\[[^\]]+\]|"[^"]+"|[A-Za-z_#][\w$#]*)){0,2})`;
const KEYWORDS = new Set(['select', 'where', 'set', 'values', 'as', 'on', 'using', 'when', 'then', 'begin', 'end', 'exists', 'lateral', 'unnest', 'generate_series']);

/** Removes comments so commented-out statements are not read as logic. */
function withoutComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/--[^\n]*/g, ' ');
}

export function normaliseName(raw: string, defaultSchema: string): string {
  const parts = raw.split('.').map((part) => part.replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''));
  const tail = parts.slice(-2);
  return tail.length === 1 ? `${defaultSchema}.${tail[0]}` : tail.join('.');
}

export function analyseDefinition(input: { name: string; text: string | null; defaultSchema: string }): DefinitionAnalysis {
  const text = withoutComments(input.text ?? '');
  const name = (raw: string) => normaliseName(raw, input.defaultSchema);
  const all = (pattern: string) => [...text.matchAll(new RegExp(pattern, 'gi'))].map((match) => match[1]!).filter((raw) => !KEYWORDS.has(raw.toLowerCase()));
  const truncated = new Set(all(String.raw`\bTRUNCATE\s+TABLE\s+${NAME}`).map(name));
  const inserted = new Set(all(String.raw`\bINSERT\s+(?:INTO\s+)?${NAME}`).map(name));
  const merged = new Set(all(String.raw`\bMERGE\s+(?:INTO\s+)?${NAME}`).map(name));
  // "WHEN MATCHED THEN UPDATE SET" names no table; a real UPDATE is followed by a table name and then SET.
  const updated = new Set(all(String.raw`\bUPDATE\s+${NAME}\s+(?:AS\s+\w+\s+)?SET\b`).map(name));
  const deleted = new Set(all(String.raw`\bDELETE\s+(?:FROM\s+)?${NAME}`).map(name));
  const writes = new Map<string, WriteMode>();
  for (const table of merged) writes.set(table, 'merge');
  for (const table of inserted) if (!writes.has(table)) writes.set(table, truncated.has(table) ? 'truncate-insert' : 'insert');
  for (const table of updated) if (!writes.has(table)) writes.set(table, 'update');
  for (const table of deleted) if (!writes.has(table)) writes.set(table, 'delete');
  for (const table of truncated) if (!writes.has(table)) writes.set(table, 'delete');
  // The target of DELETE FROM is written, not read; its other appearances (INSERT ... SELECT FROM it) are reads.
  const readText = text.replace(new RegExp(String.raw`\bDELETE\s+FROM\s+${NAME}`, 'gi'), 'DELETE');
  const readNames = [...readText.matchAll(new RegExp(String.raw`(?<![@\w])(?:FROM|JOIN|USING)\s+${NAME}`, 'gi'))].map((match) => match[1]!)
    .filter((raw) => !KEYWORDS.has(raw.toLowerCase())).map(name).filter((table) => !/^(?:dbo|public)\.(?:inserted|deleted)$/i.test(table));
  const reads = [...new Set(readNames)].filter((table) => !(merged.has(table) && writes.get(table) === 'merge' && !readNames.includes(table)) && table !== name(input.name)).sort();
  const calls = [...new Set([...all(String.raw`\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?${NAME}`), ...all(String.raw`\bCALL\s+${NAME}`), ...all(String.raw`\bPERFORM\s+${NAME}\s*\(`)].map(name))]
    .filter((call) => !/^(?:dbo|public)\.sp_executesql$/i.test(call)).sort();
  const steps: string[] = [];
  for (const statement of text.split(/;|\bBEGIN\b|\bEND\b/i).map((part) => part.trim()).filter(Boolean)) {
    const lower = statement.toLowerCase();
    const first = (pattern: string) => { const match = new RegExp(pattern, 'i').exec(statement); return match ? name(match[1]!) : null; };
    const sources = [...new Set([...statement.matchAll(new RegExp(String.raw`(?<![@\w])(?:FROM|JOIN|USING)\s+${NAME}`, 'gi'))].map((match) => name(match[1]!)))];
    if (/^\s*truncate\b/i.test(statement)) steps.push(`Empty ${first(String.raw`TRUNCATE\s+TABLE\s+${NAME}`)}`);
    else if (/\bmerge\b/.test(lower)) steps.push(`Merge into ${first(String.raw`MERGE\s+(?:INTO\s+)?${NAME}`)} from ${sources.join(', ') || 'its input'}, updating matches and inserting new rows`);
    else if (/\binsert\b/.test(lower)) { const target = first(String.raw`INSERT\s+(?:INTO\s+)?${NAME}`); const from = sources.filter((source) => source !== target); steps.push(`Insert into ${target}${from.length ? ` from ${from.join(', ')}` : ''}`); }
    else if (/^\s*delete\b/i.test(statement)) steps.push(`Delete rows from ${first(String.raw`DELETE\s+(?:FROM\s+)?${NAME}`)}`);
    else if (/^\s*update\b/i.test(statement)) steps.push(`Update ${first(String.raw`UPDATE\s+${NAME}`)}`);
    else if (/\bexec(?:ute)?\b|\bcall\b/.test(lower)) { const called = first(String.raw`\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?${NAME}`) ?? first(String.raw`\bCALL\s+${NAME}`); if (called) steps.push(`Run ${called}`); }
    else if (/\bselect\b/.test(lower) && sources.length) steps.push(`Return a result from ${sources.join(', ')}`);
  }
  const lowerName = input.name.toLowerCase();
  const writeTables = [...writes.keys()];
  const kind: ProcedureKind = writeTables.some((table) => /arch/i.test(table)) || /archive/.test(lowerName) ? 'archive'
    : writeTables.length && writeTables.every((table) => /log/i.test(table)) ? 'utility'
      : writeTables.length ? 'fact_loader'
        : /(^|[._])rpt_|report/.test(lowerName) ? 'report'
          : /check|valid|verify|audit/.test(lowerName) ? 'data_check' : 'utility';
  return { writes: writeTables.sort().map((table) => ({ table, mode: writes.get(table)! })), reads, calls, steps, kind };
}

const DEFAULT_SCHEMA: Record<string, string> = { sql_server: 'dbo', postgres: 'public', snowflake: 'PUBLIC' };
type DefinitionRow = { qualifiedName: string; kind: 'view' | 'procedure' | 'function'; text: string | null; encrypted: boolean; parameters: unknown[] };

/**
 * Stores the scrubbed definitions of a connection's in-scope views, procedures and functions as versions (decision 53).
 * A changed definition gets a new version; one that disappeared is marked inactive and kept. Out-of-scope objects are
 * never stored (non-negotiable 11): views only when they are profiled datasets, routines unless a scope rule lists
 * them as list only or excluded.
 */
export async function captureDefinitions(pool: Pool, input: { tenantId: string; connectionId: string; connector: ReadOnlyConnector }): Promise<{ captured: number; changed: number; encrypted: number }> {
  const connector = input.connector;
  if (!connector.viewDefinitions && !connector.routines) return { captured: 0, changed: 0, encrypted: 0 };
  const defaultSchema = DEFAULT_SCHEMA[connector.type] ?? 'public';
  const rows: DefinitionRow[] = [];
  for (const view of (await connector.viewDefinitions?.()) ?? []) rows.push({ qualifiedName: view.qualifiedName, kind: 'view', text: view.definition, encrypted: false, parameters: [] });
  for (const routine of (await connector.routines?.()) ?? []) rows.push({ qualifiedName: routine.qualifiedName, kind: routine.kind, text: routine.definition, encrypted: routine.encrypted, parameters: routine.parameters });
  return withTenant(pool, input.tenantId, async (client) => {
    const profiled = new Set((await client.query<{ qualified_name: string }>(`SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND asset_type='dataset' AND active`, [input.tenantId, input.connectionId])).rows.map((row) => row.qualified_name));
    const outOfScope = new Set((await client.query<{ qualified_name: string }>(`SELECT qualified_name FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2 AND scope_mode IN ('list_only','exclude')`, [input.tenantId, input.connectionId])).rows.map((row) => row.qualified_name));
    const current = new Map((await client.query<{ qualified_name: string; version: number; text_hash: Buffer | null }>(`SELECT qualified_name,version,text_hash FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active`, [input.tenantId, input.connectionId])).rows.map((row) => [row.qualified_name, row]));
    const seen = new Set<string>(); let changed = 0; let encrypted = 0;
    for (const row of rows) {
      const bare = row.qualifiedName.replace(/\(.*\)$/, '');
      if (row.kind === 'view' ? !profiled.has(row.qualifiedName) : outOfScope.has(row.qualifiedName) || outOfScope.has(bare)) continue;
      const scrubbed = row.encrypted || row.text === null ? null : scrubDefinition(row.text);
      const analysis = analyseDefinition({ name: bare, text: scrubbed, defaultSchema });
      const hash = createHash('sha256').update(JSON.stringify([row.kind, scrubbed, row.encrypted, row.parameters, analysis])).digest();
      seen.add(row.qualifiedName); if (row.encrypted) encrypted++;
      const previous = current.get(row.qualifiedName);
      if (previous?.text_hash && Buffer.compare(previous.text_hash, hash) === 0) continue;
      const version = (await client.query<{ next: number }>('SELECT coalesce(max(version),0)+1 AS next FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3', [input.tenantId, input.connectionId, row.qualifiedName])).rows[0]!.next;
      await client.query('UPDATE graph.definitions SET active=false WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3 AND active', [input.tenantId, input.connectionId, row.qualifiedName]);
      await client.query(`INSERT INTO graph.definitions(tenant_id,source_id,qualified_name,version,kind,scrubbed_text,encrypted,parameters,analysis,text_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10)`,
        [input.tenantId, input.connectionId, row.qualifiedName, version, row.kind, scrubbed, row.encrypted, JSON.stringify(row.parameters), JSON.stringify(analysis), hash]);
      changed++;
    }
    const gone = [...current.keys()].filter((name) => !seen.has(name));
    if (gone.length) await client.query(`UPDATE graph.definitions SET active=false WHERE tenant_id=$1 AND source_id=$2 AND kind<>'calculated_field' AND active AND qualified_name=ANY($3::text[])`, [input.tenantId, input.connectionId, gone]);
    return { captured: seen.size, changed, encrypted };
  });
}
