import { QueryIntentSchema, type QueryIntent } from '@scaleinsyght/contracts';

type Column = {name: string; label?: string};
export type PlannerCatalog = Array<{assets: Array<{qualified_name: string; columns: Column[]}>}>;
export type PlannerJoin = {source_index: number; from_name: string; to_name: string};
type Schema = Record<string, unknown>;

const literal = (values: string[], description?: string): Schema => ({
  type: 'string', enum: [...new Set(values)], ...(description ? {description} : {}),
});
const nullable = (schema: Schema): Schema => ({anyOf: [schema, {type:'null'}]});
const object = (properties: Record<string, Schema>): Schema => ({
  type:'object', additionalProperties:false, properties, required:Object.keys(properties),
});
const OPERATORS = ['eq','neq','gt','gte','lt','lte','is_not_null'];
const joinKey = (join: PlannerJoin) => join.from_name + ' = ' + join.to_name;
const scalar = nullable({anyOf:[{type:'boolean'},{type:'number'},{type:'string'}]});

export function plannerSchema(catalog: PlannerCatalog, joins: PlannerJoin[]): Schema {
  const branches = catalog.flatMap(({assets}, sourceIndex) => {
    const connections = joins.filter(join => join.source_index === sourceIndex);
    const tables = assets.map(asset => asset.qualified_name);
    const fields = assets.flatMap(asset => asset.columns.map(column => ({...column, path: asset.qualified_name + '.' + column.name})));
    if (!tables.length || !fields.length) return [];
    const column = nullable(literal(fields.map(field => field.path), fields.filter(field => field.label && field.label !== field.name)
      .map(field => field.path + ' is displayed as ' + field.label).join('; ')));
    return [object({
      source_index: {type:'integer',enum:[sourceIndex]},
      kind: literal(['count','filtered_count','group_by','join_aggregate','grouped_join','average_count_by','compare_aggregates']),
      table: literal(tables),
      join: connections.length ? nullable(literal(connections.map(joinKey))) : {type:'null'},
      groupBy:column, groupKey:column, entityColumn:column, aggregateColumn:column,
      operation:literal(['count','sum']),
      order:nullable(literal(['asc','desc'])),
      limit:nullable({type:'integer'}),
      filters:{type:'array',items:object({column, operator:literal(OPERATORS), value:scalar,
        upperExclusive:nullable({type:'string',description:'Exclusive ISO date endpoint with gte; otherwise null'})})},
    })];
  });
  return object({intents: branches.length ? {type:'array',items:{anyOf:branches}} : {type:'array',items:{type:'null'},maxItems:0}});
}

function field(ref: unknown): [string,string] {
  if (typeof ref !== 'string' || !ref.includes('.')) throw new Error('required_qualified_column');
  const split = ref.lastIndexOf('.');
  return [ref.slice(0,split), ref.slice(split+1)];
}

export function decodePlannerOutput(text: string, catalog: PlannerCatalog, joins: PlannerJoin[], question: string) {
  const parsed = JSON.parse(text) as {intents?: Array<Record<string, unknown>>};
  if (!Array.isArray(parsed.intents) || parsed.intents.length > catalog.length) throw new Error('invalid_source_list');
  const seen = new Set<number>();
  return parsed.intents.map(item => {
    const index = Number(item.source_index);
    const source = catalog[index];
    if (!source || seen.has(index)) throw new Error('invalid_or_duplicate_source');
    seen.add(index);
    const table = String(item.table);
    if (!source.assets.some(asset => asset.qualified_name === table)) throw new Error('table_outside_catalog');
    const join = joins.find(candidate => candidate.source_index === index && joinKey(candidate) === item.join);
    const [leftTable,leftColumn] = join ? field(join.from_name) : [table,''];
    const [rightTable,rightColumn] = join ? field(join.to_name) : ['', ''];
    const get = (ref: unknown, allowed: string[]) => {
      const [target, key] = field(ref);
      if (!allowed.includes(target) || !source.assets.some(asset => asset.qualified_name === target && asset.columns.some(col => col.name === key))) {
        throw new Error('column_does_not_belong_to_selected_table');
      }
      return [target,key] as const;
    };
    const measure = item.operation === 'sum' && !/\bhow many\b|\b(?:count|counts|number of|volume)\b/i.test(question)
      ? {operation:'sum',column:get(item.aggregateColumn,[leftTable])[1]} : {operation:'count'};
    const limit = item.limit === null ? {} : {limit:item.limit};
    const order = item.order === null ? {} : {order:item.order,orderBy:'value'};
    const filters = Array.isArray(item.filters) ? item.filters.map(filter => {
      const [target,column] = get(filter.column, [leftTable,rightTable]);
      return {table:target,column,operator:filter.operator,...(filter.value === null ? {} : {value:filter.value}),
        ...(filter.upperExclusive === null ? {} : {upperExclusive:filter.upperExclusive})};
    }) : [];
    let intent: unknown;
    switch (item.kind) {
      case 'count': intent = {kind:'count',table}; break;
      case 'compare_aggregates': intent = {kind:item.kind,table,aggregate:measure}; break;
      case 'filtered_count': {
        if (filters.length !== 1) throw new Error('filtered_count_requires_one_filter');
        intent = {kind:item.kind,...filters[0]};
        break;
      }
      case 'group_by': intent = {kind:item.kind,table,groupBy:get(item.groupBy,[table])[1],aggregate:measure,...order,...limit}; break;
      case 'average_count_by': intent = {kind:item.kind,table,groupBy:get(item.groupBy,[table])[1],entityColumn:get(item.entityColumn,[table])[1],...limit}; break;
      case 'join_aggregate':
      case 'grouped_join': {
        if (!join || table !== leftTable) throw new Error('select_a_catalog_join_and_its_left_table');
        const expanded = filters.flatMap(({upperExclusive,...filter}) => upperExclusive
          ? [filter,{...filter,operator:'lt',value:upperExclusive}] : [filter]);
        const common = {kind:item.kind,leftTable,leftColumn,rightTable,rightColumn,aggregate:measure};
        if (item.kind === 'join_aggregate') intent = {...common,filters:expanded};
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
    return {index,intent:validated.data as QueryIntent};
  });
}
