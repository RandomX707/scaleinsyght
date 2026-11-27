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
  /** Schema-qualified names the SQL uses as a table or routine that the harvested catalog does not have. */
  unresolved?: string[];
  /** Encrypted modules only: tables and views the database catalog records the module referring to. The catalog names
   *  the objects, not whether they are read or written, so they are never shown as Reads or Writes. */
  uses?: string[];
  dependencySource?: 'catalog';
  steps: string[];
  kind: ProcedureKind;
};
/**
 * The harvested catalog of the same source: tables and views (relations) and procedures and functions (routines, with
 * their argument list where the source has one). Every name the SQL mentions is resolved against it (decision 64
 * follow-up): only real tables and views are reads or writes, routines are calls, anything else is dropped or, when it
 * names a schema, reported as unresolved.
 */
export type DefinitionCatalog = { relations: string[]; routines: string[] };

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
const parts = (raw: string) => raw.split('.').map((part) => part.replace(/^\[|\]$/g, '').replace(/^"|"$/g, ''));
const bare = (qualified: string) => qualified.replace(/\(.*\)$/s, '');

type Resolved = { kind: 'relation' | 'routine'; name: string } | { kind: 'unresolved'; name: string } | null;

/** Resolves one raw SQL name. CTE names, table variables and temp tables are never objects of the source. */
function resolver(catalog: DefinitionCatalog | undefined, defaultSchema: string, ctes: Set<string>) {
  const index = (names: string[]) => {
    const byQualified = new Map<string, string[]>(); const byOwn = new Map<string, string[]>();
    for (const name of names) {
      const key = bare(name).toLowerCase(); byQualified.set(key, [...(byQualified.get(key) ?? []), name]);
      const own = key.split('.').at(-1)!; byOwn.set(own, [...(byOwn.get(own) ?? []), name]);
    }
    return { byQualified, byOwn };
  };
  const relations = catalog ? index(catalog.relations) : null; const routines = catalog ? index(catalog.routines) : null;
  // A routine overloaded in the catalog is named without arguments; otherwise by its catalog name.
  const one = (found: string[]) => found.length === 1 ? found[0]! : bare(found[0]!);
  return (raw: string): Resolved => {
    const split = parts(raw); const own = split.at(-1)!;
    if (own.startsWith('#') || own.startsWith('@')) return null;
    if (split.length === 1 && ctes.has(own.toLowerCase())) return null;
    const qualified = normaliseName(raw, defaultSchema);
    if (!relations || !routines) return { kind: 'relation', name: qualified };
    const key = qualified.toLowerCase();
    if (split.length > 1) {
      if (relations.byQualified.has(key)) return { kind: 'relation', name: relations.byQualified.get(key)![0]! };
      if (routines.byQualified.has(key)) return { kind: 'routine', name: one(routines.byQualified.get(key)!) };
      return { kind: 'unresolved', name: qualified };
    }
    // Unqualified: the default schema first, then a name that exists once in the source; otherwise not an object
    // (an alias, a record or a variable) and dropped.
    if (relations.byQualified.has(key)) return { kind: 'relation', name: relations.byQualified.get(key)![0]! };
    if (routines.byQualified.has(key)) return { kind: 'routine', name: one(routines.byQualified.get(key)!) };
    const relation = relations.byOwn.get(own.toLowerCase()) ?? []; const routine = routines.byOwn.get(own.toLowerCase()) ?? [];
    if (relation.length === 1 && !routine.length) return { kind: 'relation', name: relation[0]! };
    if (routine.length && !relation.length && new Set(routine.map((item) => bare(item).toLowerCase())).size === 1) return { kind: 'routine', name: one(routine) };
    return null;
  };
}

/** Splits names the database catalog records for a module into catalog tables and views, routines, and unresolved. */
export function classifyCatalogReferences(references: string[], catalog: DefinitionCatalog, defaultSchema: string): { uses: string[]; calls: string[]; unresolved: string[] } {
  const resolve = resolver(catalog, defaultSchema, new Set());
  const uses = new Set<string>(); const calls = new Set<string>(); const unresolved = new Set<string>();
  for (const reference of references) {
    const found = resolve(reference);
    if (found?.kind === 'relation') uses.add(found.name); else if (found?.kind === 'routine') calls.add(found.name); else if (found?.kind === 'unresolved') unresolved.add(found.name);
  }
  return { uses: [...uses].sort(), calls: [...calls].sort(), unresolved: [...unresolved].sort() };
}

export function analyseDefinition(input: { name: string; text: string | null; defaultSchema: string; catalog?: DefinitionCatalog }): DefinitionAnalysis {
  const text = withoutComments(input.text ?? '');
  const name = (raw: string) => normaliseName(raw, input.defaultSchema);
  // CTE names: "WITH x AS (", ", y AS (", with optional column lists and MATERIALIZED hints.
  const ctes = new Set([...text.matchAll(new RegExp(String.raw`(?:\bWITH\s+(?:RECURSIVE\s+)?|,\s*)${NAME}\s*(?:\([^()]*\)\s*)?AS\s+(?:NOT\s+)?(?:MATERIALIZED\s+)?\(`, 'gi'))]
    .map((match) => parts(match[1]!).at(-1)!.toLowerCase()));
  const resolve = resolver(input.catalog, input.defaultSchema, ctes);
  const unresolved = new Set<string>(); const calledNames = new Set<string>();
  /** Keeps a name only as a table or view; a routine found where a table was expected is a call. */
  const asRelation = (raw: string): string | null => {
    const found = resolve(raw);
    if (!found) return null;
    if (found.kind === 'routine') { calledNames.add(found.name); return null; }
    if (found.kind === 'unresolved') { unresolved.add(found.name); return null; }
    return found.name;
  };
  const self = name(bare(input.name)).toLowerCase();
  const all = (pattern: string) => [...text.matchAll(new RegExp(pattern, 'gi'))].map((match) => match[1]!).filter((raw) => !KEYWORDS.has(raw.toLowerCase()));
  const relationsOf = (pattern: string) => new Set(all(pattern).map(asRelation).filter((table): table is string => table !== null));
  const truncated = relationsOf(String.raw`\bTRUNCATE\s+TABLE\s+${NAME}`);
  const inserted = relationsOf(String.raw`\bINSERT\s+(?:INTO\s+)?${NAME}`);
  const merged = relationsOf(String.raw`\bMERGE\s+(?:INTO\s+)?${NAME}`);
  // "WHEN MATCHED THEN UPDATE SET" names no table; a real UPDATE is followed by a table name and then SET.
  const updated = relationsOf(String.raw`\bUPDATE\s+${NAME}\s+(?:AS\s+\w+\s+)?SET\b`);
  const deleted = relationsOf(String.raw`\bDELETE\s+(?:FROM\s+)?${NAME}`);
  const writes = new Map<string, WriteMode>();
  for (const table of merged) writes.set(table, 'merge');
  for (const table of inserted) if (!writes.has(table)) writes.set(table, truncated.has(table) ? 'truncate-insert' : 'insert');
  for (const table of updated) if (!writes.has(table)) writes.set(table, 'update');
  for (const table of deleted) if (!writes.has(table)) writes.set(table, 'delete');
  for (const table of truncated) if (!writes.has(table)) writes.set(table, 'delete');
  // The target of DELETE FROM is written, not read; its other appearances (INSERT ... SELECT FROM it) are reads.
  const readText = text.replace(new RegExp(String.raw`\bDELETE\s+FROM\s+${NAME}`, 'gi'), 'DELETE');
  // A name followed by "(" after FROM or JOIN is a set-returning function: a call, never a read.
  const sourcePattern = String.raw`(?<![@\w])(?:FROM|JOIN|USING)\s+${NAME}(\s*\()?`;
  const readNames: string[] = [];
  for (const match of readText.matchAll(new RegExp(sourcePattern, 'gi'))) {
    const raw = match[1]!; if (KEYWORDS.has(raw.toLowerCase())) continue;
    if (match[2]) { const found = resolve(raw); if (found?.kind === 'routine' || (found && !input.catalog)) calledNames.add(found.name); else if (found?.kind === 'unresolved') unresolved.add(found.name); continue; }
    const table = asRelation(raw); if (table && !/^(?:dbo|public)\.(?:inserted|deleted)$/i.test(table)) readNames.push(table);
  }
  const reads = [...new Set(readNames)].filter((table) => !(merged.has(table) && writes.get(table) === 'merge' && !readNames.includes(table)) && table.toLowerCase() !== self).sort();
  // Calls: EXEC, CALL and PERFORM targets, and with a catalog any catalog routine used like a function anywhere.
  for (const raw of [...all(String.raw`\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?${NAME}`), ...all(String.raw`\bCALL\s+${NAME}`), ...all(String.raw`\bPERFORM\s+${NAME}\s*\(`)]) {
    const found = resolve(raw);
    if (found?.kind === 'routine' || (found && !input.catalog)) calledNames.add(found.name);
    else if (found?.kind === 'unresolved') unresolved.add(found.name);
  }
  if (input.catalog) for (const raw of all(String.raw`(?<![\w.@#$])${NAME}\s*\(`)) { const found = resolve(raw); if (found?.kind === 'routine') calledNames.add(found.name); }
  const calls = [...calledNames].filter((call) => !/^(?:dbo|public)\.sp_executesql$/i.test(call) && name(bare(call)).toLowerCase() !== self).sort();
  const steps: string[] = [];
  for (const statement of text.split(/;|\bBEGIN\b|\bEND\b/i).map((part) => part.trim()).filter(Boolean)) {
    const lower = statement.toLowerCase();
    const first = (pattern: string) => { const match = new RegExp(pattern, 'i').exec(statement); return match ? asRelation(match[1]!) : null; };
    const sources = [...new Set([...statement.matchAll(new RegExp(sourcePattern, 'gi'))].filter((match) => !match[2]).map((match) => asRelation(match[1]!)).filter((table): table is string => table !== null))];
    if (/^\s*truncate\b/i.test(statement)) { const target = first(String.raw`TRUNCATE\s+TABLE\s+${NAME}`); if (target) steps.push(`Empty ${target}`); }
    else if (/\bmerge\b/.test(lower)) { const target = first(String.raw`MERGE\s+(?:INTO\s+)?${NAME}`); if (target) steps.push(`Merge into ${target} from ${sources.join(', ') || 'its input'}, updating matches and inserting new rows`); }
    else if (/\binsert\b/.test(lower)) { const target = first(String.raw`INSERT\s+(?:INTO\s+)?${NAME}`); const from = sources.filter((source) => source !== target); if (target) steps.push(`Insert into ${target}${from.length ? ` from ${from.join(', ')}` : ''}`); }
    else if (/^\s*delete\b/i.test(statement)) { const target = first(String.raw`DELETE\s+(?:FROM\s+)?${NAME}`); if (target) steps.push(`Delete rows from ${target}`); }
    else if (/^\s*update\b/i.test(statement)) { const target = first(String.raw`UPDATE\s+${NAME}`); if (target) steps.push(`Update ${target}`); }
    else if (/\bexec(?:ute)?\b|\bcall\b/.test(lower)) { const match = new RegExp(String.raw`\bEXEC(?:UTE)?\s+(?:@\w+\s*=\s*)?${NAME}`, 'i').exec(statement) ?? new RegExp(String.raw`\bCALL\s+${NAME}`, 'i').exec(statement); const found = match ? resolve(match[1]!) : null; if (found && found.kind !== 'unresolved' && (found.kind === 'routine' || !input.catalog)) steps.push(`Run ${found.name}`); }
    else if (/\bselect\b/.test(lower) && sources.length) steps.push(`Return a result from ${sources.join(', ')}`);
  }
  const lowerName = input.name.toLowerCase();
  const writeTables = [...writes.keys()];
  const kind: ProcedureKind = writeTables.some((table) => /arch/i.test(table)) || /archive/.test(lowerName) ? 'archive'
    : writeTables.length && writeTables.every((table) => /log/i.test(table)) ? 'utility'
      : writeTables.length ? 'fact_loader'
        : /(^|[._])rpt_|report/.test(lowerName) ? 'report'
          : /check|valid|verify|audit/.test(lowerName) ? 'data_check' : 'utility';
  return { writes: writeTables.sort().map((table) => ({ table, mode: writes.get(table)! })), reads, calls, ...(unresolved.size ? { unresolved: [...unresolved].sort() } : {}), steps, kind };
}

const DEFAULT_SCHEMA: Record<string, string> = { sql_server: 'dbo', postgres: 'public', snowflake: 'PUBLIC' };
type DefinitionRow = { qualifiedName: string; kind: 'view' | 'procedure' | 'function'; text: string | null; encrypted: boolean; parameters: unknown[]; returns: unknown[] };

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
  for (const view of (await connector.viewDefinitions?.()) ?? []) rows.push({ qualifiedName: view.qualifiedName, kind: 'view', text: view.definition, encrypted: false, parameters: [], returns: [] });
  for (const routine of (await connector.routines?.()) ?? []) rows.push({ qualifiedName: routine.qualifiedName, kind: routine.kind, text: routine.definition, encrypted: routine.encrypted, parameters: routine.parameters, returns: routine.returns ?? [] });
  // What each module refers to, from the database catalog: the only dependency information an encrypted module has.
  const dependencies = new Map<string, string[]>();
  if (connector.routineDependencies) {
    try { for (const entry of await connector.routineDependencies()) dependencies.set(entry.routine.toLowerCase(), entry.references); }
    catch (error) { console.error(`Routine dependencies not read for connection ${input.connectionId}: ${error instanceof Error && /^[\w:-]{1,80}$/.test(error.message) ? error.message : 'dependencies_failed'}`); }
  }
  return withTenant(pool, input.tenantId, async (client) => {
    const profiled = new Set((await client.query<{ qualified_name: string }>(`SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND asset_type='dataset' AND active`, [input.tenantId, input.connectionId])).rows.map((row) => row.qualified_name));
    const outOfScope = new Set((await client.query<{ qualified_name: string }>(`SELECT qualified_name FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2 AND scope_mode IN ('list_only','exclude')`, [input.tenantId, input.connectionId])).rows.map((row) => row.qualified_name));
    // The source's own catalog: profiled tables and views, objects kept out of scope (named but never profiled, still
    // real objects) and every routine; parsed names are resolved against it.
    const relations = (await client.query<{ qualified_name: string }>(`SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND asset_type='dataset' AND active
      UNION SELECT qualified_name FROM registry.connection_scopes WHERE tenant_id=$1 AND connection_id=$2 AND object_type IN ('table','view','materialized_view')`, [input.tenantId, input.connectionId])).rows.map((row) => row.qualified_name);
    const catalog: DefinitionCatalog = { relations: [...new Set([...relations, ...rows.filter((row) => row.kind === 'view').map((row) => row.qualifiedName)])], routines: rows.filter((row) => row.kind !== 'view').map((row) => row.qualifiedName) };
    const current = new Map((await client.query<{ qualified_name: string; version: number; text_hash: Buffer | null }>(`SELECT qualified_name,version,text_hash FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND active`, [input.tenantId, input.connectionId])).rows.map((row) => [row.qualified_name, row]));
    const seen = new Set<string>(); let changed = 0; let encrypted = 0;
    for (const row of rows) {
      const bare = row.qualifiedName.replace(/\(.*\)$/, '');
      if (row.kind === 'view' ? !profiled.has(row.qualifiedName) : outOfScope.has(row.qualifiedName) || outOfScope.has(bare)) continue;
      const scrubbed = row.encrypted || row.text === null ? null : scrubDefinition(row.text);
      let analysis = analyseDefinition({ name: bare, text: scrubbed, defaultSchema, catalog });
      const recorded = row.encrypted ? dependencies.get(bare.toLowerCase()) : undefined;
      if (recorded) {
        const references = classifyCatalogReferences(recorded, catalog, defaultSchema);
        analysis = { ...analysis, uses: references.uses, calls: references.calls, ...(references.unresolved.length ? { unresolved: references.unresolved } : {}), dependencySource: 'catalog' };
      }
      const hash = createHash('sha256').update(JSON.stringify([row.kind, scrubbed, row.encrypted, row.parameters, row.returns, analysis])).digest();
      seen.add(row.qualifiedName); if (row.encrypted) encrypted++;
      const previous = current.get(row.qualifiedName);
      if (previous?.text_hash && Buffer.compare(previous.text_hash, hash) === 0) continue;
      const version = (await client.query<{ next: number }>('SELECT coalesce(max(version),0)+1 AS next FROM graph.definitions WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3', [input.tenantId, input.connectionId, row.qualifiedName])).rows[0]!.next;
      await client.query('UPDATE graph.definitions SET active=false WHERE tenant_id=$1 AND source_id=$2 AND qualified_name=$3 AND active', [input.tenantId, input.connectionId, row.qualifiedName]);
      await client.query(`INSERT INTO graph.definitions(tenant_id,source_id,qualified_name,version,kind,scrubbed_text,encrypted,parameters,returned_columns,analysis,text_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11)`,
        [input.tenantId, input.connectionId, row.qualifiedName, version, row.kind, scrubbed, row.encrypted, JSON.stringify(row.parameters), JSON.stringify(row.returns), JSON.stringify(analysis), hash]);
      changed++;
    }
    const gone = [...current.keys()].filter((name) => !seen.has(name));
    if (gone.length) await client.query(`UPDATE graph.definitions SET active=false WHERE tenant_id=$1 AND source_id=$2 AND kind<>'calculated_field' AND active AND qualified_name=ANY($3::text[])`, [input.tenantId, input.connectionId, gone]);
    return { captured: seen.size, changed, encrypted };
  });
}
