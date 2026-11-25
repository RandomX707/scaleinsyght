import { QueryIntentSchema, type QueryIntent } from '@scaleinsyght/contracts';

type Column = {name: string; label?: string; sensitivity_tags?: string[]};
export type PlannerCatalog = Array<{name?: string; assets: Array<{qualified_name: string; columns: Column[]}>}>;
export type PlannerJoin = {source_index: number; from_name: string; to_name: string; evidence_method?: string; confidence_score?: number | string};
/** Profile facts code uses to check and shape plans. Never part of the model's input (they stay out of plannerSchema). */
export type ColumnFacts = {distinctCount: number | null; nullRate: number | null; averageLength: number | null};
export type PlannerFacts = Array<Record<string, {rowCount: number | null; columns: Record<string, ColumnFacts>}>>;
/** The display-label rule's outcome for a grouped step, recorded with the plan (decision 45). */
export type DisplayLabel = {key: string; label: string; via: string};
type Schema = Record<string, unknown>;

const literal = (values: string[], description?: string): Schema => ({
  type: 'string', enum: [...new Set(values)], ...(description ? {description} : {}),
});
const nullable = (schema: Schema): Schema => ({anyOf: [schema, {type:'null'}]});
const object = (properties: Record<string, Schema>, description?: string): Schema => ({
  type:'object', additionalProperties:false, properties, required:Object.keys(properties), ...(description ? {description} : {}),
});
const OPERATORS = ['eq','neq','gt','gte','lt','lte','is_not_null'];
const MEASURES = ['count','sum','average_count_per_entity'];
const SCALAR_KINDS = ['count','filtered_count','join_aggregate','compare_aggregates'];
const GROUPED_KINDS = ['group_by','grouped_join','average_count_by'];
const JOIN_KINDS = ['join_aggregate','grouped_join'];
const joinKey = (join: PlannerJoin) => join.from_name + ' = ' + join.to_name;
const scalar = nullable({anyOf:[{type:'boolean'},{type:'number'},{type:'string'}]});

/** Preserve known catalog names through the model gateway's title-case name scrubber.
 * Only strings matched to the catalog are changed. Other names still go through normal redaction. */
export function normalizeCatalogMentions(question: string, catalog: PlannerCatalog, sourceNames: string[] = []): string {
  const terms = [...new Set([...sourceNames, ...catalog.flatMap(source => source.assets.flatMap(asset =>
    asset.columns.flatMap(column => column.label && column.label !== column.name ? [column.label] : [])))])]
    .filter(term => /^[a-z][a-z0-9_ -]{1,70}[a-z0-9]$/i.test(term) && term.includes(' '))
    .sort((a,b) => b.length-a.length);
  if (!terms.length) return question;
  const alternatives = terms.join('|');
  return question.replace(new RegExp('\\b(?:' + alternatives + ')(?=s?\\b)', 'gi'), term => term.toLowerCase());
}

/** The response schema. Besides the executable fields, the model declares what the question asks for (decision 44):
 * once for the question, and per source step. The decoder checks the executable plan against those declarations. */
export function plannerSchema(catalog: PlannerCatalog, joins: PlannerJoin[]): Schema {
  const branches = catalog.flatMap(({assets}, sourceIndex) => {
    const connections = joins.filter(join => join.source_index === sourceIndex);
    const tables = assets.map(asset => asset.qualified_name);
    const fields = assets.flatMap(asset => asset.columns.map(column => ({...column, path: asset.qualified_name + '.' + column.name})));
    if (!tables.length || !fields.length) return [];
    const columnPath = literal(fields.map(field => field.path), fields.filter(field => field.label && field.label !== field.name)
      .map(field => field.path + ' is displayed as ' + field.label).join('; '));
    const column = nullable(columnPath);
    return [object({
      source_index: {type:'integer',enum:[sourceIndex]},
      declared: object({
        subject_table: literal(tables, 'The table whose records are counted, summed or averaged.'),
        measure: literal(MEASURES, 'count records, sum a numeric column, or average the number of records per entity.'),
        measure_column: nullable(columnPath),
        grouping_column: nullable(columnPath),
        filter_columns: {type:'array',items:columnPath},
      }, 'What this step must compute, declared before the executable fields.'),
      kind: literal(['count','filtered_count','group_by','join_aggregate','grouped_join','average_count_by','compare_aggregates']),
      table: literal(tables),
      join: connections.length ? nullable(literal(connections.map(joinKey))) : {type:'null'},
      groupBy:column, groupKey:column, entityColumn:column, aggregateColumn:column,
      operation:literal(['count','sum']),
      order:nullable(literal(['asc','desc'])),
      limit:nullable({type:'integer'}),
      filters:{type:'array',items:object({column:columnPath, operator:literal(OPERATORS), value:scalar,
        upperExclusive:nullable({type:'string',description:'Exclusive ISO date endpoint with gte; otherwise null'})})},
    })];
  });
  // A lineage request names one table or column of one source and a direction; it is answered from the metadata graph.
  const lineageBranches = catalog.flatMap(({assets}, sourceIndex) => {
    const names = assets.flatMap(asset => [asset.qualified_name, ...asset.columns.map(column => asset.qualified_name + '.' + column.name)]);
    return names.length ? [object({source_index:{type:'integer',enum:[sourceIndex]}, asset:literal(names,'The table, or table.column, the question asks about.'),
      direction:literal(['upstream','downstream'],'upstream: where its data comes from. downstream: what reads it or would break if it changed.')})] : [];
  });
  return object({
    lineage: lineageBranches.length ? nullable({anyOf:lineageBranches}) : {type:'null'},
    declaration: object({
      subject: {type:'string',description:'What the question counts or measures, in a few words.'},
      grouping: nullable({type:'string',description:'The dimension the answer is broken down by, or null for a single value per source.'}),
      conditions: {type:'array',items:{type:'string'},description:'Each condition the question applies, in a few words.'},
      comparison: {type:'boolean',description:'True when the question asks for values from two or more sources.'},
      answerable: {type:'boolean',description:'False when the catalog has no table for the subject; then intents is empty.'},
    }),
    intents: branches.length ? {type:'array',items:{anyOf:branches}} : {type:'array',items:{type:'null'},maxItems:0},
  });
}

export type PlanDeclaration = {subject: string; grouping: string | null; conditions: string[]; comparison: boolean; answerable: boolean};
export type LineageRequest = {index: number; asset: string; direction: 'upstream' | 'downstream'};
/** intent is what runs; planned is the model's plan before the display-label rule, which is what verification checks. */
type DecodedStep = {index: number; intent: QueryIntent; planned?: QueryIntent; display?: DisplayLabel | null};

function field(ref: unknown): [string,string] {
  if (typeof ref !== 'string' || !ref.includes('.')) throw new Error('required_qualified_column');
  const split = ref.lastIndexOf('.');
  return [ref.slice(0,split), ref.slice(split+1)];
}
const sameSet = (left: string[], right: string[]) => new Set(left).size === new Set(right).size && left.every(item => right.includes(item));

/** Decodes the structured response into typed intents and checks the executable plan against the declared intent.
 * No pattern matching over the user's question: the declaration is the contract the plan must meet. */
export function decodePlannerOutput(text: string, catalog: PlannerCatalog, joins: PlannerJoin[], facts: PlannerFacts = []): {declaration: PlanDeclaration; steps: DecodedStep[]; lineage?: LineageRequest} {
  const parsed = JSON.parse(text) as {declaration?: PlanDeclaration; intents?: Array<Record<string, unknown>>; lineage?: {source_index?: unknown; asset?: unknown; direction?: unknown} | null};
  const declaration = parsed.declaration;
  if (!declaration || typeof declaration.answerable !== 'boolean' || typeof declaration.comparison !== 'boolean') throw new Error('missing_declaration');
  if (!Array.isArray(parsed.intents)) throw new Error('invalid_source_list');
  if (parsed.intents.length > catalog.length) throw new Error('invalid_source_list: return at most one step per source; when no single step kind computes the requested measure, declare the question unanswerable');
  if (parsed.lineage != null) {
    // Lineage is read from recorded evidence, never computed from source data: no query intents go with it.
    const index = Number(parsed.lineage.source_index); const source = catalog[index]; const asset = String(parsed.lineage.asset); const direction = parsed.lineage.direction;
    if (!source || (direction !== 'upstream' && direction !== 'downstream')) throw new Error('lineage_request_invalid');
    if (!source.assets.some(item => item.qualified_name === asset || item.columns.some(column => item.qualified_name + '.' + column.name === asset))) throw new Error('lineage_asset_outside_catalog');
    if (parsed.intents.length) throw new Error('lineage_request_with_query_intents');
    if (!declaration.answerable) throw new Error('declared_unanswerable_but_lineage_requested');
    return {declaration, steps: [], lineage: {index, asset, direction}};
  }
  if (!declaration.answerable) {
    if (parsed.intents.length) throw new Error('declared_unanswerable_but_planned');
    return {declaration, steps: []};
  }
  if (!parsed.intents.length) throw new Error('declared_answerable_without_a_plan');
  if (declaration.comparison && parsed.intents.length < 2) throw new Error('declared_comparison_needs_two_sources');
  if (!declaration.comparison && parsed.intents.length > 1) throw new Error('declared_single_answer_uses_one_source');
  const seen = new Set<number>();
  const steps = parsed.intents.map(item => {
    const index = Number(item.source_index);
    const source = catalog[index];
    if (!source || seen.has(index)) throw new Error('invalid_or_duplicate_source: return at most one step per source; when no single step kind computes the requested measure, declare the question unanswerable');
    seen.add(index);
    const declared = item.declared as {subject_table?: string; measure?: string; measure_column?: string | null; grouping_column?: string | null; filter_columns?: string[]} | undefined;
    if (!declared || !Array.isArray(declared.filter_columns)) throw new Error('missing_step_declaration');
    const kind = String(item.kind);
    const table = String(item.table);
    if (!source.assets.some(asset => asset.qualified_name === table)) throw new Error('table_outside_catalog');
    const join = joins.find(candidate => candidate.source_index === index && joinKey(candidate) === item.join);
    const isJoinIntent = JOIN_KINDS.includes(kind);
    if (item.join !== null && (!isJoinIntent || !join)) throw new Error('join_requires_a_join_intent');
    const [leftTable,leftColumn] = join ? field(join.from_name) : [table,''];
    const [rightTable,rightColumn] = join ? field(join.to_name) : ['', ''];
    const get = (ref: unknown, allowed: string[]) => {
      const [target, key] = field(ref);
      if (!allowed.includes(target) || !source.assets.some(asset => asset.qualified_name === target && asset.columns.some(col => col.name === key))) {
        throw new Error('column_does_not_belong_to_selected_table');
      }
      return [target,key] as const;
    };

    // The declaration is authoritative: a grouped step that leaves groupBy empty takes the declared grouping column.
    if (declared.grouping_column != null && item.groupBy == null && GROUPED_KINDS.includes(kind)) item.groupBy = declared.grouping_column;
    // Grouping returns the group column's values. Never group by a tagged column: identifiers are stored only as keyed
    // fingerprints (non-negotiable 6) and tagged values never leave the source (contract 7).
    for (const shown of [item.groupBy, item.groupKey]) {
      if (shown == null) continue;
      const [groupTable, groupColumn] = field(shown);
      const tags = source.assets.find(asset => asset.qualified_name === groupTable)?.columns.find(col => col.name === groupColumn)?.sensitivity_tags ?? [];
      if (tags.length) throw new Error(`grouping_by_a_sensitive_column_is_not_allowed: ${String(shown)} is tagged ${tags.join(', ')}`);
    }
    // The executable plan must match what the step declares.
    if ((isJoinIntent ? leftTable : table) !== declared.subject_table) throw new Error(`plan_subject_differs_from_declared_subject: declared ${String(declared.subject_table)}, plan uses ${isJoinIntent ? leftTable : table}`);
    if (declared.grouping_column == null) {
      if (!SCALAR_KINDS.includes(kind)) throw new Error(`declared_single_value_but_plan_groups: kind ${kind} groups by ${String(item.groupBy)}`);
    } else if (!GROUPED_KINDS.includes(kind) || item.groupBy !== declared.grouping_column) {
      throw new Error(`plan_grouping_differs_from_declared_grouping: declared ${String(declared.grouping_column)}, plan kind ${kind} groups by ${String(item.groupBy)}`);
    }
    const executedMeasure = kind === 'average_count_by' ? 'average_count_per_entity' : String(item.operation);
    if (executedMeasure !== declared.measure || (declared.measure === 'sum' && item.aggregateColumn !== declared.measure_column)) {
      throw new Error(`plan_measure_differs_from_declared_measure: declared ${String(declared.measure)} ${String(declared.measure_column ?? '')}, plan ${executedMeasure} ${String(item.aggregateColumn ?? '')}`.trim());
    }
    const executedFilters = Array.isArray(item.filters) ? item.filters as Array<Record<string, unknown>> : [];
    if (!sameSet(executedFilters.map(filter => String(filter.column)), declared.filter_columns)) throw new Error(`plan_filters_differ_from_declared_filters: declared [${declared.filter_columns.join(', ')}], plan [${executedFilters.map(filter => String(filter.column)).join(', ')}]`);

    const measure = item.operation === 'sum' ? {operation:'sum',column:get(item.aggregateColumn,[leftTable])[1]} : {operation:'count'};
    const limit = item.limit === null ? {} : {limit:item.limit};
    const order = item.order === null ? {} : {order:item.order,orderBy:'value'};
    const filters = executedFilters.map(filter => {
      const [target,column] = get(filter.column, [leftTable,rightTable]);
      return {table:target,column,operator:filter.operator,...(filter.value === null ? {} : {value:filter.value}),
        ...(filter.upperExclusive === null ? {} : {upperExclusive:filter.upperExclusive})};
    });
    if (filters.length && !isJoinIntent && kind !== 'filtered_count') throw new Error('select_an_intent_that_applies_its_filters');
    let intent: unknown;
    switch (kind) {
      case 'count': intent = {kind:'count',table}; break;
      case 'compare_aggregates': intent = {kind,table,aggregate:measure}; break;
      case 'filtered_count': {
        if (filters.length !== 1 || filters[0]?.table !== table) throw new Error('filtered_count_requires_one_filter_on_its_table');
        intent = {kind,...filters[0]};
        break;
      }
      case 'group_by': intent = {kind,table,groupBy:get(item.groupBy,[table])[1],aggregate:measure,...order,...limit}; break;
      case 'average_count_by': intent = {kind,table,groupBy:get(item.groupBy,[table])[1],entityColumn:get(item.entityColumn,[table])[1],...limit}; break;
      case 'join_aggregate':
      case 'grouped_join': {
        if (!join || table !== leftTable) throw new Error('select_a_catalog_join_and_its_left_table');
        const expanded = filters.flatMap(({upperExclusive,...filter}) => upperExclusive
          ? [filter,{...filter,operator:'lt',value:upperExclusive}] : [filter]);
        const common = {kind,leftTable,leftColumn,rightTable,rightColumn,aggregate:measure};
        if (kind === 'join_aggregate') intent = {...common,filters:expanded};
        else {
          const [side,groupBy] = get(item.groupBy,[leftTable,rightTable]);
          intent = {...common,groupByTable:side===leftTable?'left':'right',groupBy,
            ...(item.groupKey === null ? {} : {groupKey:get(item.groupKey,[side])[1]}),
            ...(item.order === null ? {} : {order:item.order}),...limit,
            filters:expanded.map(filter => ({...filter,table:filter.table===leftTable?'left':'right'}))};
        }
        break;
      }
      default: throw new Error('unknown_intent_kind');
    }
    const validated = QueryIntentSchema.safeParse(intent);
    if (!validated.success) throw new Error('typed_intent_fields: ' + validated.error.issues.map(issue => issue.path.join('.') + ' ' + issue.code).join(', ').slice(0,180));
    const typed = validated.data as QueryIntent;
    rejectSingleRecordGroups(typed, facts[index]);
    const display = displayLabelFor(typed, index, source, joins, facts[index]);
    const shown = display ? applyDisplayLabel(typed, display) : typed;
    checkDisplayLabel(shown, display);
    return {index,intent:shown,planned:typed,display};
  });
  return {declaration, steps};
}

const TRUSTED_COVERAGE = 0.999;

/** Grouping a table by a column that is unique in it makes every group one record: the answer would list single
 * records (row-level data), and small-cell disclosure would withhold every cell. Plan over the table the records come
 * from instead. Decided from the profiled distinct count and row count, never from names. */
function rejectSingleRecordGroups(intent: QueryIntent, facts: PlannerFacts[number] | undefined) {
  const plan = intent as unknown as Record<string, unknown>;
  if (!['group_by','average_count_by','grouped_join'].includes(intent.kind) || (intent.kind === 'grouped_join' && plan.groupByTable !== 'left')) return;
  const table = String(plan.leftTable ?? plan.table); const column = String(plan.groupBy);
  const known = facts?.[table]; const stats = known?.columns[column];
  if (known?.rowCount && stats?.distinctCount === known.rowCount && stats.nullRate === 0) {
    throw new Error(`grouping_column_is_unique_in_its_table: every ${table} record has its own ${column}, so each group is a single record; plan over the table the counted records come from`);
  }
}

/** The display-label rule (decision 45). When a step groups by a key column, the answer shows the related table's
 * human label instead: the key must reference that table through an asserted relationship (declared, or inferred with
 * full measured coverage) and have no nulls, so the join keeps every record. The label is the related table's
 * untagged text column that is unique and complete there, preferring the longest values (a name over a code);
 * ties go to the column name. Code decides from profile facts; the model is not asked. */
function displayLabelFor(intent: QueryIntent, index: number, source: PlannerCatalog[number], joins: PlannerJoin[], facts: PlannerFacts[number] | undefined): DisplayLabel | null {
  if (!facts) return null;
  let keyTable: string; let keyColumn: string;
  if (intent.kind === 'group_by') { keyTable = intent.table; keyColumn = intent.groupBy; }
  else if (intent.kind === 'grouped_join') {
    // Only the join's own key can be relabelled through the join that is already in the plan.
    const onKey = (intent.groupByTable === 'left' && intent.groupBy === intent.leftColumn) || (intent.groupByTable === 'right' && intent.groupBy === intent.rightColumn);
    if (!onKey) return null;
    keyTable = intent.leftTable; keyColumn = intent.leftColumn;
  } else return null;
  const join = joins.find(candidate => candidate.source_index === index && candidate.from_name === keyTable + '.' + keyColumn
    && (intent.kind !== 'grouped_join' || candidate.to_name === intent.rightTable + '.' + intent.rightColumn));
  if (!join) return null;
  const trusted = join.evidence_method === 'declared' || Number(join.confidence_score) >= TRUSTED_COVERAGE;
  if (!trusted || facts[keyTable]?.columns[keyColumn]?.nullRate !== 0) return null;
  const [target, targetKey] = field(join.to_name);
  const related = facts[target]; const asset = source.assets.find(item => item.qualified_name === target);
  if (!related?.rowCount || !asset || (asset.columns.find(column => column.name === targetKey)?.sensitivity_tags ?? []).length) return null;
  const foreignKeys = new Set(joins.filter(candidate => candidate.source_index === index).map(candidate => candidate.from_name));
  const candidates = asset.columns.filter(column => {
    const stats = related.columns[column.name];
    return column.name !== targetKey && !(column.sensitivity_tags ?? []).length && !foreignKeys.has(target + '.' + column.name)
      && stats?.averageLength != null && stats.distinctCount === related.rowCount && stats.nullRate === 0;
  }).sort((a, b) => (related.columns[b.name]!.averageLength! - related.columns[a.name]!.averageLength!) || a.name.localeCompare(b.name));
  const chosen = candidates[0];
  return chosen ? {key: keyTable + '.' + keyColumn, label: target + '.' + chosen.name, via: joinKey(join)} : null;
}

function applyDisplayLabel(intent: QueryIntent, display: DisplayLabel): QueryIntent {
  const [keyTable, keyColumn] = field(display.key); const [labelTable, labelColumn] = field(display.label);
  const rightColumn = field(display.via.split(' = ')[1])[1];
  if (intent.kind === 'grouped_join') return {...intent, groupByTable:'right', groupBy:labelColumn, groupKey:rightColumn};
  if (intent.kind !== 'group_by') return intent;
  return QueryIntentSchema.parse({kind:'grouped_join', leftTable:keyTable, rightTable:labelTable, leftColumn:keyColumn, rightColumn,
    groupByTable:'right', groupBy:labelColumn, groupKey:rightColumn, aggregate:intent.aggregate, filters:[],
    order:intent.order ?? 'desc', limit:intent.limit ?? 100});
}

/** The executable plan must carry the recorded display label: grouped by the label, with the key as the group key. */
function checkDisplayLabel(intent: QueryIntent, display: DisplayLabel | null) {
  if (!display) return;
  const [labelTable, labelColumn] = field(display.label);
  if (intent.kind !== 'grouped_join' || intent.rightTable !== labelTable || intent.groupByTable !== 'right' || intent.groupBy !== labelColumn || !intent.groupKey) {
    throw new Error(`plan_does_not_show_the_display_label: ${display.key} is shown as ${display.label}`);
  }
}

/** A plain description of an accepted plan for the verification call. Uses display headers where the source has them. */
export function describePlan(steps: DecodedStep[], catalog: PlannerCatalog): string {
  const label = (index: number, table: string, column: string) =>
    (catalog[index]?.assets.find(asset => asset.qualified_name === table)?.columns.find(item => item.name === column)?.label ?? column).toLowerCase();
  // The display label (decision 45) changes only how groups are shown, under conditions that keep every record, so the
  // verifier checks the computation the model planned.
  return steps.map(({index, intent, planned}) => {
    const plan = (planned ?? intent) as unknown as Record<string, unknown> & {aggregate?: {operation: string; column?: string}};
    const source = catalog[index]?.name ?? `source ${index + 1}`;
    const subject = String(plan.leftTable ?? plan.table);
    const measure = plan.kind === 'average_count_by' ? `the average number of ${subject} records per ${label(index, subject, String(plan.entityColumn))}`
      : plan.aggregate?.operation === 'sum' ? `the sum of ${label(index, subject, String(plan.aggregate.column))} over ${subject}` : `the number of ${subject} records`;
    const parts = [`${source}: ${measure}`];
    if (plan.rightTable) parts.push(`joined to ${String(plan.rightTable)}`);
    if (plan.groupBy) {
      const groupTable = plan.groupByTable === 'right' ? String(plan.rightTable) : subject;
      parts.push(`for each ${label(index, groupTable, String(plan.groupBy))}`);
    }
    const conditions = (plan.kind === 'filtered_count' ? [plan] : Array.isArray(plan.filters) ? plan.filters as Array<Record<string, unknown>> : [])
      .map(filter => `${String(filter.column)} ${String(filter.operator).replaceAll('_',' ')}${filter.value === undefined ? '' : ` ${JSON.stringify(filter.value)}`}${filter.upperExclusive === undefined ? '' : ` and before ${JSON.stringify(filter.upperExclusive)}`}`);
    if (conditions.length) parts.push(`where ${conditions.join(' and ')}`);
    // The compiled SQL always breaks ties: by the group key when there is one, otherwise alphabetically by the group.
    const tieBreak = plan.groupKey ? `ties broken by ${label(index, plan.groupByTable === 'right' ? String(plan.rightTable) : subject, String(plan.groupKey))}` : 'ties broken alphabetically by group';
    if (plan.limit && Number(plan.limit) < 100) parts.push(`keeping the ${plan.order === 'asc' ? 'lowest' : 'highest'} ${String(plan.limit)} (${tieBreak})`);
    else if (plan.order) parts.push(`all groups, sorted ${plan.order === 'asc' ? 'lowest' : 'highest'} first`);
    return parts.join(', ');
  }).join('; ');
}

/** A plain description of a lineage request for the verification call. */
export function describeLineage(request: LineageRequest, catalog: PlannerCatalog): string {
  const source = catalog[request.index]?.name ?? `source ${request.index + 1}`;
  return request.direction === 'upstream'
    ? `${source}: list where the data in ${request.asset} comes from, every upstream table or column with its recorded lineage evidence`
    : `${source}: list everything that reads ${request.asset} and would be affected if it changed, every downstream table or column with its recorded lineage evidence`;
}

export const verificationSchema: Schema = object({
  answers_question: {type:'boolean'},
  reason: {type:'string',description:'One short sentence.'},
});
