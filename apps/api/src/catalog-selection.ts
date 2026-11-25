/**
 * Chooses which tables of one source the planner sees. A catalog at or under the limit is passed through unchanged;
 * a larger one (thousands of tables) is narrowed in code, without a model, to the tables the question's words point at
 * plus the tables they join to, so the prompt and the typed response schema stay a bounded size. Nothing here reads
 * data: only table names, column names and display labels (structural metadata).
 */
export type CatalogAsset = { qualified_name: string; columns: Array<{ name: string; label?: string | null; data_type?: string | null; sensitivity_tags?: string[] | null }> };
export type CatalogJoin = { from_name: string; to_name: string };

/** Largest catalog sent whole; also the number of best-matching tables kept from a larger one. */
export const CATALOG_TABLE_LIMIT = 30;
/** Tables added because they join to a kept table (for example a name lookup for a breakdown). */
export const CATALOG_JOIN_ALLOWANCE = 15;
/**
 * The planner's typed response schema lists every column path as an enum, and the model provider accepts at most 1,000
 * enum values per structured-output schema (HTTP 400 "Expected at most 1000 enum values", measured on the 5,000-table
 * scale catalog). A narrowed catalog is shrunk until its schema has at most this many enum values by countEnumValues,
 * which counts more than the provider does (the testbed's 1,120 are accepted), so the budget is conservative.
 */
export const SCHEMA_ENUM_BUDGET = 900;

/** Every value of every enum in a JSON schema. */
export function countEnumValues(schema: unknown): number {
  if (Array.isArray(schema)) return schema.reduce((total: number, item) => total + countEnumValues(item), 0);
  if (!schema || typeof schema !== 'object') return 0;
  return Object.entries(schema as Record<string, unknown>).reduce((total, [key, value]) => total + (key === 'enum' && Array.isArray(value) ? value.length : countEnumValues(value)), 0);
}

const STOP = new Set(['the', 'a', 'an', 'of', 'in', 'on', 'for', 'to', 'and', 'or', 'by', 'with', 'from', 'is', 'are', 'was', 'were', 'be', 'how', 'many', 'much',
  'what', 'which', 'who', 'when', 'where', 'does', 'do', 'did', 'have', 'has', 'each', 'every', 'per', 'give', 'me', 'show', 'list', 'count', 'number', 'total',
  'their', 'them', 'there', 'this', 'that', 'these', 'those', 'all', 'any', 'only', 'now', 'top', 'most', 'least', 'highest', 'lowest', 'use', 'name', 'names',
  'record', 'records', 'row', 'rows', 'table', 'tables', 'testbed', 'database', 'source', 'id', 'ids']);

/** Lower-case word stems: camelCase and snake_case split, simple plurals folded (orders → order, categories → category). */
export function words(text: string): string[] {
  return text.replace(/([a-z0-9])([A-Z])/g, '$1 $2').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).map((word) =>
    word.length > 4 && word.endsWith('ies') ? `${word.slice(0, -3)}y`
      : word.length > 4 && /(ses|xes|zes|ches|shes)$/.test(word) ? word.slice(0, -2)
        : word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word);
}

const tableOf = (field: string) => field.slice(0, field.lastIndexOf('.'));

export function selectCatalogTables<T extends CatalogAsset>(input: { question: string; context?: string; assets: T[]; joins: CatalogJoin[]; limit?: number; joinAllowance?: number }): { assets: T[]; total: number; narrowed: boolean } {
  const limit = input.limit ?? CATALOG_TABLE_LIMIT;
  if (input.assets.length <= limit) return { assets: input.assets, total: input.assets.length, narrowed: false };
  const text = `${input.question}\n${input.context ?? ''}`.toLowerCase();
  const asked = new Set(words(`${input.question} ${input.context ?? ''}`).filter((word) => !STOP.has(word) && word.length > 1));
  const scored = input.assets.map((asset, order) => {
    const bare = asset.qualified_name.slice(asset.qualified_name.lastIndexOf('.') + 1);
    // A table the question names as an identifier is always kept (lineage questions name the object they ask about):
    // its qualified name, or a bare name with an underscore. An ordinary word such as "inspection" is not a name; it
    // counts through the word matches below, or every same-named table in every schema would be kept.
    const named = text.includes(asset.qualified_name.toLowerCase()) || (bare.includes('_') && new RegExp(`\\b${bare.toLowerCase().replace(/[^a-z0-9_]/g, '')}\\b`).test(text));
    const tableWords = new Set(words(bare));
    // The schema distinguishes same-named tables (billing.invoice from accounting.invoice).
    const schemaWords = new Set(words(asset.qualified_name.slice(0, Math.max(0, asset.qualified_name.lastIndexOf('.')))));
    const columnWords = new Set(asset.columns.flatMap((column) => [...words(column.name), ...words(column.label ?? '')]));
    let tableHits = 0; let schemaHits = 0; let columnHits = 0;
    for (const word of asked) { if (tableWords.has(word)) tableHits++; else if (schemaWords.has(word)) schemaHits++; else if (columnWords.has(word)) columnHits++; }
    // Table-name matches dominate; column matches break ties; fewer extra name words means a closer match.
    const score = (named ? 1000 : 0) + tableHits * 20 + schemaHits * 12 + Math.min(columnHits, 8) * 3 - Math.max(0, tableWords.size - tableHits) * 0.5;
    return { asset, order, score, relevant: named || tableHits > 0 || schemaHits > 0 || columnHits > 0 };
  });
  const ranked = scored.filter((item) => item.relevant).sort((a, b) => b.score - a.score || a.asset.qualified_name.localeCompare(b.asset.qualified_name));
  const kept = new Set(ranked.slice(0, limit).map((item) => item.asset.qualified_name));
  // One join hop from the kept tables, best-scoring first, so breakdowns can reach their name columns.
  const byName = new Map(scored.map((item) => [item.asset.qualified_name, item]));
  const neighbours = new Set<string>();
  for (const join of input.joins) {
    const from = tableOf(join.from_name); const to = tableOf(join.to_name);
    if (kept.has(from) && !kept.has(to) && byName.has(to)) neighbours.add(to);
    if (kept.has(to) && !kept.has(from) && byName.has(from)) neighbours.add(from);
  }
  for (const name of [...neighbours].sort((a, b) => byName.get(b)!.score - byName.get(a)!.score || a.localeCompare(b)).slice(0, input.joinAllowance ?? CATALOG_JOIN_ALLOWANCE)) kept.add(name);
  return { assets: scored.filter((item) => kept.has(item.asset.qualified_name)).sort((a, b) => a.order - b.order).map((item) => item.asset), total: input.assets.length, narrowed: true };
}
