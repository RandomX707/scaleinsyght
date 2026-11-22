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

const Uuid = z.string().uuid();
export const PlanStepSchema = z.object({
  step_id: Uuid,
  capability_id: z.string().min(1),
  capability_version: z.number().int().positive(),
  agent_id: Uuid,
  source_id: Uuid,
  via_collating_agent_id: Uuid,
  group_version: z.number().int().positive(),
  inputs: z.record(z.string(), z.unknown()),
  depends_on: z.array(Uuid),
  effect_class: z.literal('READ'),
  timeout_s: z.number().int().positive().max(600),
  retry: z.object({
    max: z.number().int().min(0).max(3),
    backoff: z.enum(['none', 'linear', 'exponential']),
  }).strict(),
  idempotency_key: z.string().min(1).max(200),
}).strict();
export type PlanStep = z.infer<typeof PlanStepSchema>;

export const JoinKeySchema = z.object({
  left: z.string().min(1),
  right: z.string().min(1),
  assertion_id: Uuid,
}).strict();

export const PlanCombineSchema = z.object({
  level: z.enum(['group', 'cross_group']),
  collating_agent_id: Uuid.nullable(),
  inputs: z.array(Uuid).min(1),
  join_keys: z.array(JoinKeySchema),
  output_schema: z.record(z.string(), z.unknown()),
}).strict();

export const AnalyticPlanSchema = z.object({
  plan_id: Uuid,
  run_id: Uuid,
  version: z.number().int().positive(),
  plan_hash: z.string().regex(/^[a-f0-9]{64}$/),
  question: z.string().trim().min(1).max(2000),
  scope: z.object({
    source_ids: z.array(Uuid).min(1),
    as_of: z.string().datetime({ offset: true }),
  }).strict(),
  steps: z.array(PlanStepSchema).min(1),
  combine: z.array(PlanCombineSchema),
  budgets: z.object({
    max_parallel: z.number().int().positive().max(32),
    max_runtime_s: z.number().int().positive().max(1800),
    max_tokens: z.number().int().min(0).max(100_000),
    max_source_queries: z.number().int().positive().max(1000),
  }).strict(),
}).strict();
export type AnalyticPlan = z.infer<typeof AnalyticPlanSchema>;

export const ClaimSchema = z.object({
  claim_id: Uuid,
  kind: z.enum(['fact', 'metric', 'lineage', 'interpretation']),
  statement: z.string().min(1).max(4000),
  evidence_ids: z.array(Uuid).min(1),
}).strict();
export type Claim = z.infer<typeof ClaimSchema>;

export const EvidenceRefSchema = z.object({
  evidence_id: Uuid,
  kind: z.enum(['query', 'api_call', 'manifest', 'code', 'run_event', 'document', 'profile', 'test']),
  source_id: Uuid,
  asset_ids: z.array(Uuid),
  locator: z.string().min(1).max(1000),
  content_hash: z.string().regex(/^[a-f0-9]{64}$/),
  captured_at: z.string().datetime({ offset: true }),
  source_time: z.string().datetime({ offset: true }).nullable().optional(),
  collector_version: z.string().min(1).max(100),
  redacted_summary: z.string().max(1000),
}).strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value);
  if (Array.isArray(value)) {
    if (seen.has(value)) throw new Error('plan_not_json_serializable');
    seen.add(value);
    const result = `[${value.map((item) => canonicalJson(item, seen)).join(',')}]`;
    seen.delete(value);
    return result;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if (seen.has(record) || (Object.getPrototypeOf(record) !== Object.prototype && Object.getPrototypeOf(record) !== null)) {
      throw new Error('plan_not_json_serializable');
    }
    seen.add(record);
    const result = `{${Object.keys(record).sort().map((key) => {
      if (record[key] === undefined) throw new Error('plan_not_json_serializable');
      return `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`;
    }).join(',')}}`;
    seen.delete(record);
    return result;
  }
  throw new Error('plan_not_json_serializable');
}

export async function hashPlan(plan: unknown): Promise<string> {
  const serialized = canonicalJson(plan);
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(serialized));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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
