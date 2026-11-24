import { z } from 'zod';

const identifier=z.string().min(1).max(256).regex(/^[A-Za-z_][A-Za-z0-9_$]*(?:\.[A-Za-z_][A-Za-z0-9_$]*){0,2}$/);
const column=z.string().min(1).max(128).regex(/^[A-Za-z_][A-Za-z0-9_$]*$/);
const aggregate=z.discriminatedUnion('operation',[
  z.object({operation:z.literal('count')}).strict(),
  z.object({operation:z.literal('sum'),column}).strict(),
]);
export const QueryIntentSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('count'),table:identifier}).strict(),
  z.object({kind:z.literal('filtered_count'),table:identifier,column,operator:z.enum(['eq','neq','gt','gte','lt','lte']),value:z.union([z.string().max(256),z.number().finite(),z.boolean()])}).strict(),
  z.object({kind:z.literal('group_by'),table:identifier,groupBy:column,aggregate}).strict(),
  z.object({kind:z.literal('join_aggregate'),leftTable:identifier,rightTable:identifier,leftColumn:column,rightColumn:column,aggregate}).strict(),
  z.object({kind:z.literal('compare_aggregates'),table:identifier,aggregate}).strict(),
]);
export type QueryIntent=z.infer<typeof QueryIntentSchema>;
export function parseQueryIntent(value:unknown):QueryIntent{const result=QueryIntentSchema.safeParse(value);if(!result.success)throw new Error('analytic_query_intent_invalid');return result.data;}
