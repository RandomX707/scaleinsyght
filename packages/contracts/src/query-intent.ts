import { z } from 'zod';

const identifier=z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/);
const column=z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const aggregate=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('count')}).strict(),
  z.object({operation:z.literal('sum'),column}).strict(),
]);
/** Further conditions on the step's own table, all of which must hold (decision 54). */
const sameTableFilters=z.array(z.object({column,operator:z.enum(['eq','neq','gt','gte','lt','lte','is_not_null']),value:z.union([z.string().max(256),z.number().finite(),z.boolean()]).optional()}).strict()).max(8);
export const QueryIntentSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('count'),table:identifier}).strict(),
  z.object({kind:z.literal('filtered_count'),table:identifier,column,operator:z.enum(['eq','neq','gt','gte','lt','lte','is_not_null']),value:z.union([z.string().max(256),z.number().finite(),z.boolean()]).optional(),upperExclusive:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),filters:sameTableFilters.optional()}).strict(),
  z.object({kind:z.literal('group_by'),table:identifier,groupBy:column,aggregate,orderBy:z.enum(['value','group']).optional(),order:z.enum(['asc','desc']).optional(),limit:z.number().int().min(1).max(100).optional(),filters:sameTableFilters.optional()}).strict(),
  z.object({kind:z.literal('join_aggregate'),leftTable:identifier,rightTable:identifier,leftColumn:column,rightColumn:column,aggregate,filters:z.array(z.object({table:identifier,column,operator:z.enum(['eq','neq','gt','gte','lt','lte','is_not_null']),value:z.union([z.string().max(256),z.number().finite(),z.boolean()]).optional()}).strict()).max(8).optional()}).strict(),
  z.object({kind:z.literal('grouped_join'),leftTable:identifier,rightTable:identifier,leftColumn:column,rightColumn:column,groupByTable:z.enum(['left','right']),groupBy:column,groupKey:column.optional(),aggregate,filters:z.array(z.object({table:z.enum(['left','right']),column,operator:z.enum(['eq','neq','gt','gte','lt','lte','is_not_null']),value:z.union([z.string().max(256),z.number().finite(),z.boolean()]).optional()}).strict()).max(8),order:z.enum(['asc','desc']).default('desc'),limit:z.number().int().min(1).max(100).default(100)}).strict(),
  z.object({kind:z.literal('average_count_by'),table:identifier,entityColumn:column,groupBy:column,limit:z.number().int().min(1).max(100).default(100)}).strict(),
  z.object({kind:z.literal('compare_aggregates'),table:identifier,aggregate}).strict(),
]);
export type QueryIntent=z.infer<typeof QueryIntentSchema>;
export function parseQueryIntent(value:unknown):QueryIntent{const result=QueryIntentSchema.safeParse(value);if(!result.success)throw new Error('analytic_query_intent_invalid');return result.data;}
