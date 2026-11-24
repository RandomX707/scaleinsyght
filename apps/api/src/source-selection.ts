// Decides how an answer names its sources. Runs after the model's typed plan and before the run starts,
// so the decision is made in code, never by the model.
export interface CandidateSource {
  sourceId: string;
  name: string;
  connectorType: string;
  /** Unqualified table name (lower case) to its column names (lower case). */
  tables: Map<string, Set<string>>;
}
export type SourceSelection =
  | { kind: 'ask'; options: Array<{ sourceId: string; name: string }> }
  | { kind: 'answer'; used: Array<{ sourceId: string; name: string; reason: string }>; unused: Array<{ sourceId: string; name: string; reason: string }> };

const typeAliases: Record<string, string[]> = {
  postgres: ['postgres', 'postgresql'],
  sql_server: ['sql server', 'sqlserver', 'mssql'],
  snowflake: ['snowflake'],
  excel: ['excel', 'workbook', 'spreadsheet'],
};

export function mentionsSource(text: string, source: Pick<CandidateSource, 'name' | 'connectorType'>): boolean {
  const lower = text.toLowerCase();
  return (source.name.trim() !== '' && lower.includes(source.name.trim().toLowerCase()))
    || (typeAliases[source.connectorType] ?? []).some((alias) => new RegExp(`\\b${alias}\\b`).test(lower));
}

const unqualified = (name: string) => (name.split('.').at(-1) ?? name).toLowerCase();

/** Tables and columns a typed intent reads, by unqualified table name. */
export function referencedTables(intent: Record<string, unknown>): Map<string, Set<string>> {
  const tables = new Map<string, Set<string>>();
  const add = (table: unknown, column?: unknown) => {
    if (typeof table !== 'string') return;
    const key = unqualified(table);
    const columns = tables.get(key) ?? new Set<string>();
    if (typeof column === 'string') columns.add(column.toLowerCase());
    tables.set(key, columns);
  };
  const aggregateColumn = (intent.aggregate as { column?: unknown } | undefined)?.column;
  if (typeof intent.table === 'string') {
    add(intent.table);
    for (const column of [intent.column, intent.groupBy, intent.entityColumn, aggregateColumn]) add(intent.table, column);
  }
  if (typeof intent.leftTable === 'string' && typeof intent.rightTable === 'string') {
    add(intent.leftTable, intent.leftColumn); add(intent.leftTable, aggregateColumn); add(intent.rightTable, intent.rightColumn);
    const grouped = intent.groupByTable === 'left' ? intent.leftTable : intent.rightTable;
    add(grouped, intent.groupBy); add(grouped, intent.groupKey);
    for (const filter of Array.isArray(intent.filters) ? intent.filters as Array<Record<string, unknown>> : []) {
      const table = filter.table === 'left' ? intent.leftTable : filter.table === 'right' ? intent.rightTable : filter.table;
      add(table, filter.column);
    }
  }
  return tables;
}

export function canAnswer(source: CandidateSource, needed: Map<string, Set<string>>): boolean {
  if (needed.size === 0) return false;
  for (const [table, columns] of needed) {
    const available = source.tables.get(table);
    if (!available || [...columns].some((column) => !available.has(column))) return false;
  }
  return true;
}

export function selectSources(input: { question: string; context: string; candidates: CandidateSource[]; selected: CandidateSource[]; intents: Array<Record<string, unknown>> }): SourceSelection {
  const selectedIds = new Set(input.selected.map((source) => source.sourceId));
  const unselected = input.candidates.filter((source) => !selectedIds.has(source.sourceId));
  const needed = referencedTables(input.intents[0] ?? {});
  const capable = unselected.filter((source) => canAnswer(source, needed));
  const named = (source: CandidateSource) => mentionsSource(input.question, source);
  const inContext = (source: CandidateSource) => mentionsSource(input.context, source);
  const anyNamed = [...input.selected, ...capable].some((source) => named(source) || inContext(source));
  if (input.selected.length === 1 && capable.length > 0 && !anyNamed) {
    return { kind: 'ask', options: [...input.selected, ...capable].map(({ sourceId, name }) => ({ sourceId, name })) };
  }
  const used = input.selected.map((source) => ({
    sourceId: source.sourceId, name: source.name,
    reason: named(source) ? 'named in your question'
      : inContext(source) ? 'used earlier in this conversation'
      : input.selected.length > 1 ? 'each selected source was queried'
      : input.candidates.length === 1 ? 'the only selected source'
      : 'the only selected source with the tables this question needs',
  }));
  const unusedSources = unselected.map((source) => ({
    sourceId: source.sourceId, name: source.name,
    reason: capable.includes(source) ? 'not named in your question' : 'does not have the tables this question needs',
  }));
  return { kind: 'answer', used, unused: unusedSources };
}
