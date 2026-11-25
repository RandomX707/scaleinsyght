import { randomUUID } from 'node:crypto';
import type { Pool } from '@scaleinsyght/db';
import { AuthzDecisionSchema, type AuthzRequest, type EffectClass } from '@scaleinsyght/contracts';
import { withTenant } from '@scaleinsyght/db';

export interface CapabilityAuthorizationInput {
  registered: boolean;
  enabled: boolean;
  effectClass: EffectClass;
  entitled: boolean;
}

export interface CapabilityAuthorizationResult {
  outcome: 'allow' | 'deny';
  reasons: string[];
}

export function evaluateCapabilityAuthorization(
  input: CapabilityAuthorizationInput,
): CapabilityAuthorizationResult {
  if (!input.registered) return { outcome: 'deny', reasons: ['capability_not_registered'] };
  if (input.effectClass !== 'READ') return { outcome: 'deny', reasons: ['effect_class_disabled_in_release_1'] };
  if (!input.enabled) return { outcome: 'deny', reasons: ['capability_disabled_for_tenant'] };
  if (!input.entitled) return { outcome: 'deny', reasons: ['principal_not_entitled'] };
  return { outcome: 'allow', reasons: ['read_capability_entitled'] };
}

export async function authorise(
  pool: Pool,
  request: AuthzRequest,
  runId: string | null = null,
  /** The agent the decision is for (decision 52); recorded with the decision. */
  agentId: string | null = null,
): Promise<ReturnType<typeof AuthzDecisionSchema.parse>> {
  const decisionId = randomUUID();
  return withTenant(pool, request.principal.tenant_id, async (client) => {
    const capability = await client.query<{ effect_class: EffectClass; enabled: boolean }>(
      `SELECT effect_class, enabled FROM registry.capabilities WHERE tenant_id = $1 AND capability_id = $2`,
      [request.principal.tenant_id, request.capability_id],
    );
    const registered = capability.rowCount === 1;
    const effectClass = capability.rows[0]?.effect_class ?? 'READ';
    const entitlement = request.principal.kind === 'user'
      ? await client.query(
          `SELECT 1 FROM core.entitlements
           WHERE tenant_id = $1 AND principal_id = $2 AND capability_id = $3 AND allowed
             AND (resource_id IS NULL OR resource_id = ANY($4::text[])) LIMIT 1`,
          [request.principal.tenant_id, request.principal.principal_id, request.capability_id, request.resources],
        )
      : { rowCount: 0 };
    const evaluation = evaluateCapabilityAuthorization({
      registered,
      enabled: capability.rows[0]?.enabled ?? false,
      effectClass,
      entitled: entitlement.rowCount === 1,
    });
    const decision = AuthzDecisionSchema.parse({
      decision_id: decisionId,
      outcome: evaluation.outcome,
      obligations: [],
      policy_version: 'phase0-v1',
      reasons: evaluation.reasons,
    });
    await client.query(
      `INSERT INTO runs.authz_decisions
       (tenant_id, decision_id, run_id, principal_id, capability_id, outcome, policy_version, reasons, agent_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)`,
      [request.principal.tenant_id, decision.decision_id, runId, request.principal.principal_id,
        request.capability_id, decision.outcome, decision.policy_version, JSON.stringify(decision.reasons), agentId],
    );
    return decision;
  });
}

export interface ValidatedPlanCapability {capabilityId:string;version:number;effectClass:EffectClass;}
export async function validateCapabilityForPlan(pool:Pool,tenantId:string,capabilityId:string,version:number):Promise<ValidatedPlanCapability>{
 return withTenant(pool,tenantId,async(client)=>{
  const result=await client.query<{active_version:number;effect_class:EffectClass;enabled:boolean}>('SELECT active_version,effect_class,enabled FROM registry.capabilities WHERE tenant_id=$1 AND capability_id=$2',[tenantId,capabilityId]);
  const capability=result.rows[0];
  if(!capability)throw new Error('capability_not_registered');
  if(capability.active_version!==version)throw new Error('capability_version_not_pinned');
  if(capability.effect_class!=='READ'||!capability.enabled)throw new Error('capability_effect_disabled');
  return{capabilityId,version,effectClass:capability.effect_class};
 });
}
