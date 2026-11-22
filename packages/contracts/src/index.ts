import { z } from 'zod';

export const PrincipalSchema = z.object({
  tenant_id: z.string().min(1),
  principal_id: z.string().min(1),
  kind: z.enum(['user', 'service', 'run']),
  roles: z.array(z.string()),
  groups: z.array(z.string()),
  attributes: z.record(z.string(), z.unknown()),
}).strict();
export type Principal = z.infer<typeof PrincipalSchema>;

export const AuthzRequestSchema = z.object({
  principal: PrincipalSchema,
  capability_id: z.string().min(1),
  resources: z.array(z.string()),
  purpose: z.string().min(1),
  environment: z.string().min(1),
}).strict();
export type AuthzRequest = z.infer<typeof AuthzRequestSchema>;

export const AuthzDecisionSchema = z.object({
  decision_id: z.string().uuid(),
  outcome: z.enum(['allow', 'deny', 'require_approval']),
  obligations: z.array(z.record(z.string(), z.unknown())),
  policy_version: z.string().min(1),
  reasons: z.array(z.string()),
}).strict();
export type AuthzDecision = z.infer<typeof AuthzDecisionSchema>;

export const EffectClassSchema = z.enum(['READ', 'MUTATION', 'DEPLOY', 'RELEASE', 'IRREVERSIBLE']);
export type EffectClass = z.infer<typeof EffectClassSchema>;
export const EffectSafetySchema = z.enum(['not_applicable', 'idempotent_key', 'status_lookup', 'none']);
export type EffectSafety = z.infer<typeof EffectSafetySchema>;
export const CapabilitySchema = z.object({
  capability_id: z.string().min(1),
  version: z.number().int().positive(),
  effect_class: EffectClassSchema,
  effect_safety: EffectSafetySchema,
  enabled: z.boolean(),
  input_schema: z.record(z.string(), z.unknown()),
  output_schema: z.record(z.string(), z.unknown()),
}).strict();
export type Capability = z.infer<typeof CapabilitySchema>;

export const AgentSchema = z.object({
  agent_id: z.string().uuid(),
  tenant_id: z.string().min(1),
  type: z.enum(['personal', 'orchestrator', 'collating', 'connector', 'id', 'id_trace', 'governed', 'action_executor']),
  version: z.number().int().positive(),
  capabilities: z.array(z.string()),
  status: z.enum(['draft', 'approved', 'active', 'retired']),
  owner: z.string().nullable(),
  bindings: z.record(z.string(), z.unknown()),
}).strict();
export type Agent = z.infer<typeof AgentSchema>;

export const RunStateSchema = z.enum([
  'CREATED', 'PLANNING', 'PLAN_VALIDATED', 'RUNNING', 'AWAITING_APPROVAL', 'FINALISING',
  'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED', 'POLICY_BLOCKED',
]);
export type RunState = z.infer<typeof RunStateSchema>;
export const TerminalRunStates: ReadonlySet<RunState> = new Set([
  'COMPLETED', 'PARTIAL', 'FAILED', 'CANCELLED', 'EXPIRED', 'POLICY_BLOCKED',
]);

const legalRunTransitions: Readonly<Record<RunState, readonly RunState[]>> = {
  CREATED: ['PLANNING'],
  PLANNING: ['PLAN_VALIDATED', 'FAILED', 'POLICY_BLOCKED'],
  PLAN_VALIDATED: ['RUNNING', 'CANCELLED'],
  RUNNING: ['AWAITING_APPROVAL', 'FINALISING', 'PARTIAL', 'FAILED', 'CANCELLED', 'POLICY_BLOCKED'],
  AWAITING_APPROVAL: ['RUNNING', 'EXPIRED', 'CANCELLED'],
  FINALISING: ['COMPLETED', 'PARTIAL', 'FAILED'],
  COMPLETED: [],
  PARTIAL: [],
  FAILED: [],
  CANCELLED: [],
  EXPIRED: [],
  POLICY_BLOCKED: [],
};

export function canTransitionRun(from: RunState, to: RunState): boolean {
  return legalRunTransitions[from].includes(to);
}

export const RunStepStateSchema = z.enum([
  'PENDING', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'BLOCKED', 'CANCELLED', 'OUTCOME_UNKNOWN',
]);

export const RunEventTypeSchema = z.enum([
  'run_created', 'run_state_changed', 'run_terminal', 'child_run_created',
  'plan_proposed', 'plan_validated', 'plan_rejected',
  'step_claimed', 'step_started', 'step_succeeded', 'step_failed', 'step_blocked', 'step_reused', 'stale_write_rejected',
  'evidence_added', 'artifact_ready', 'approval_requested', 'approval_decided', 'grant_consumed',
  'effect_intent_recorded', 'effect_confirmed', 'effect_failed', 'effect_unknown', 'effect_reconciled',
  'agent_created', 'agent_retired',
]);

export const SafeEventPayloadSchema = z.object({
  state: z.string().optional(),
  state_version: z.number().int().nonnegative().optional(),
  step_id: z.string().uuid().optional(),
  attempt: z.number().int().nonnegative().optional(),
  fencing_token: z.number().int().nonnegative().optional(),
  result_ref: z.string().min(1).optional(),
  result_status: z.enum(['ok', 'partial', 'failed', 'blocked']).optional(),
  result_classification: z.enum(['METADATA_STRUCTURAL', 'METADATA_DESCRIPTIVE', 'METADATA_STATISTICAL', 'AGGREGATE', 'ROW_LEVEL', 'RESTRICTED']).optional(),
  capability_id: z.string().optional(),
  capability_version: z.number().int().positive().optional(),
  agent_id: z.string().uuid().optional(),
  decision_id: z.string().uuid().optional(),
  policy_version: z.string().optional(),
  reason_codes: z.array(z.string()).optional(),
  count: z.number().int().nonnegative().optional(),
  parent_run_id: z.string().uuid().optional(),
  child_run_id: z.string().uuid().optional(),
  effect_state: z.enum(['intent_recorded', 'confirmed', 'failed', 'unknown']).optional(),
  idempotency_key: z.string().optional(),
  target: z.string().optional(),
  payload_hash: z.string().optional(),
  trace_id: z.string().uuid().optional(),
}).strict();

export const RunEventSchema = z.object({
  tenant_id: z.string().min(1),
  run_id: z.string().uuid(),
  event_id: z.string().uuid().optional(),
  step_id: z.string().uuid().nullable().optional(),
  sequence: z.number().int().positive(),
  event_type: RunEventTypeSchema,
  at: z.string().datetime().optional(),
  fencing_token: z.number().int().nonnegative().nullable().optional(),
  safe_payload: SafeEventPayloadSchema,
  decision_id: z.string().uuid().nullable().optional(),
  trace_id: z.string().uuid().optional(),
}).strict();
export type RunEvent = z.infer<typeof RunEventSchema>;

export type CapabilityPayloadDirection='input'|'output';
export class CapabilityPayloadError extends Error{
 constructor(readonly direction:CapabilityPayloadDirection,readonly issues:string[]){super(`Capability ${direction} failed schema validation: ${issues.join('; ')}`);this.name='CapabilityPayloadError';}
}
interface JsonSchema{
 type?:'object'|'array'|'string'|'number'|'integer'|'boolean'|'null';
 required?:string[];properties?:Record<string,JsonSchema>;items?:JsonSchema;additionalProperties?:boolean;
 enum?:unknown[];minimum?:number;maximum?:number;minLength?:number;maxLength?:number;
}
function collectSchemaIssues(schema:JsonSchema,value:unknown,path:string,issues:string[]):void{
 const type=schema.type;
 const matches=type===undefined||type==='null'&&value===null||type==='object'&&typeof value==='object'&&value!==null&&!Array.isArray(value)||type==='array'&&Array.isArray(value)||type==='string'&&typeof value==='string'||type==='number'&&typeof value==='number'&&Number.isFinite(value)||type==='integer'&&typeof value==='number'&&Number.isInteger(value)||type==='boolean'&&typeof value==='boolean';
 if(!matches){issues.push(`${path} must be ${type}`);return;}
 if(schema.enum&&!schema.enum.some(candidate=>JSON.stringify(candidate)===JSON.stringify(value)))issues.push(`${path} is not an allowed value`);
 if(typeof value==='number'){
  if(schema.minimum!==undefined&&value<schema.minimum)issues.push(`${path} is below minimum`);
  if(schema.maximum!==undefined&&value>schema.maximum)issues.push(`${path} is above maximum`);
 }
 if(typeof value==='string'){
  if(schema.minLength!==undefined&&value.length<schema.minLength)issues.push(`${path} is too short`);
  if(schema.maxLength!==undefined&&value.length>schema.maxLength)issues.push(`${path} is too long`);
 }
 if(schema.type==='object'&&typeof value==='object'&&value!==null&&!Array.isArray(value)){
  const object=value as Record<string,unknown>;
  for(const key of schema.required??[])if(!(key in object))issues.push(`${path}.${key} is required`);
  for(const [key,item]of Object.entries(object)){
   const property=schema.properties?.[key];
   if(property)collectSchemaIssues(property,item,`${path}.${key}`,issues);
   else if(schema.additionalProperties===false)issues.push(`${path}.${key} is not allowed`);
  }
 }
 if(schema.type==='array'&&Array.isArray(value)&&schema.items)value.forEach((item,index)=>collectSchemaIssues(schema.items!,item,`${path}[${index}]`,issues));
}
export function validateCapabilityPayload(direction:CapabilityPayloadDirection,schema:Record<string,unknown>,payload:unknown):void{
 const issues:string[]=[];collectSchemaIssues(schema as JsonSchema,payload,'payload',issues);if(issues.length)throw new CapabilityPayloadError(direction,issues);
}
