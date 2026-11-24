import { createHash, randomUUID } from 'node:crypto';
import { AnalyticPlanSchema, hashPlan, parseQueryIntent, type AnalyticPlan, type QueryIntent } from '@scaleinsyght/contracts';
import { withTenant } from '@scaleinsyght/db';
import type { Pool } from 'pg';

export interface AnalyticSource { sourceId: string; agentId: string; groupId: string; groupVersion: number; }
export interface ValidatedPlan { tenantId: string; principalId: string; plan: AnalyticPlan; }

async function planDigest(plan: AnalyticPlan): Promise<string> {
  return hashPlan({ ...plan, plan_hash: '' });
}

export async function createAnalyticPlan(input: { question: string; runId: string; sources: AnalyticSource[]; queryIntents?:QueryIntent[] }): Promise<AnalyticPlan> {
  if (!input.question.trim() || input.question.length > 2000 || input.sources.length === 0) throw new Error('analytic_plan_invalid');
  if(input.queryIntents&&input.queryIntents.length!==input.sources.length)throw new Error('analytic_plan_invalid');
  const questionHash = createHash('sha256').update(input.question.trim()).digest('hex');
  const groups = new Map<string, string>();
  const steps = input.sources.map((source) => {
    const stepId = randomUUID();
    if (!groups.has(source.groupId)) groups.set(source.groupId, randomUUID());
    return {
      step_id: stepId, capability_id: 'analytic.read', capability_version: 1,
      agent_id: source.agentId, source_id: source.sourceId, via_collating_agent_id: groups.get(source.groupId)!,
      group_version: source.groupVersion, inputs: input.queryIntents?{query_intent:input.queryIntents[input.sources.indexOf(source)]}:{question_hash: questionHash}, depends_on: [], effect_class: 'READ' as const,
      timeout_s: 120, retry: { max: 1, backoff: 'linear' as const }, idempotency_key: randomUUID(),
    };
  });
  const byGroup = new Map<string, string[]>();
  for (const [index, source] of input.sources.entries()) byGroup.set(source.groupId, [...(byGroup.get(source.groupId) ?? []), steps[index]!.step_id]);
  const base = {
    plan_id: randomUUID(), run_id: input.runId, version: 1, plan_hash: '0'.repeat(64), question: input.question.trim(),
    scope: { source_ids: [...new Set(input.sources.map((source) => source.sourceId))], as_of: new Date().toISOString() },
    steps,
    combine: [
      ...[...byGroup.entries()].map(([groupId, ids]) => ({ level: 'group' as const, collating_agent_id: groups.get(groupId)!, inputs: ids, join_keys: [], output_schema: { type: 'object' } })),
      ...(groups.size > 1 ? [{ level: 'cross_group' as const, collating_agent_id: null, inputs: [...groups.values()], join_keys: [], output_schema: { type: 'object' } }] : []),
    ],
    budgets: { max_parallel: Math.min(32, Math.max(1, input.sources.length)), max_runtime_s: 600, max_tokens: 0, max_source_queries: input.sources.length },
  };
  const parsed = AnalyticPlanSchema.parse(base);
  parsed.plan_hash = await planDigest(parsed);
  return AnalyticPlanSchema.parse(parsed);
}

export { collateGroupResults, criticCheck, finalizeAnalyticRun, type StructuredAnswer, type StructuredResult } from './executor.js';
export { applyPersonalContext, type PersonalizedAnswer } from './personal-context.js';
export { submitFeedback, type SafeCorrection } from './feedback.js';

function validatePlanGraph(plan: AnalyticPlan): void {
  if (new Set(plan.scope.source_ids).size !== plan.scope.source_ids.length || plan.budgets.max_source_queries < plan.steps.length) throw new Error('analytic_plan_invalid');
  const steps = new Map(plan.steps.map((step) => [step.step_id, step]));
  const visiting = new Set<string>(); const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('analytic_plan_cycle');
    if (visited.has(id)) return;
    const step = steps.get(id); if (!step) throw new Error('analytic_plan_invalid');
    visiting.add(id); for (const dependency of step.depends_on) visit(dependency); visiting.delete(id); visited.add(id);
  };
  for (const id of steps.keys()) visit(id);
  for(const step of plan.steps){
    if(!plan.scope.source_ids.includes(step.source_id)||step.effect_class!=='READ'||Object.keys(step.inputs).length!==1)throw new Error('analytic_plan_invalid');
    if('question_hash'in step.inputs){if(!/^[a-f0-9]{64}$/.test(String(step.inputs.question_hash)))throw new Error('analytic_plan_invalid');}
    else if('query_intent'in step.inputs)parseQueryIntent(step.inputs.query_intent);
    else throw new Error('analytic_plan_invalid');
  }
}

async function validateIntentAssets(client:import('pg').PoolClient,sourceId:string,intent:QueryIntent):Promise<void>{
  const tables=intent.kind==='join_aggregate'?[intent.leftTable,intent.rightTable]:[intent.table];
  const found=await client.query<{qualified_name:string}>('SELECT qualified_name FROM graph.assets WHERE tenant_id=$1 AND source_id=$2 AND asset_type=\'dataset\' AND active AND qualified_name=ANY($3::text[])',[await client.query("SELECT current_setting('app.tenant_id') AS tenant_id").then(result=>result.rows[0]!.tenant_id),sourceId,tables]);
  if(found.rowCount!==new Set(tables).size)throw new Error('analytic_query_asset_not_found');
  const requiredColumns:string[]=[];
  if(intent.kind==='filtered_count')requiredColumns.push(`${intent.table}.${intent.column}`);
  if(intent.kind==='group_by'){requiredColumns.push(`${intent.table}.${intent.groupBy}`);if(intent.aggregate.operation==='sum')requiredColumns.push(`${intent.table}.${intent.aggregate.column}`);}
  if(intent.kind==='join_aggregate'){requiredColumns.push(`${intent.leftTable}.${intent.leftColumn}`,`${intent.rightTable}.${intent.rightColumn}`);if(intent.aggregate.operation==='sum')requiredColumns.push(`${intent.leftTable}.${intent.aggregate.column}`);}
  if(intent.kind==='compare_aggregates'&&intent.aggregate.operation==='sum')requiredColumns.push(`${intent.table}.${intent.aggregate.column}`);
  if(requiredColumns.length){const columns=await client.query<{qualified_name:string}>('SELECT qualified_name FROM graph.assets WHERE tenant_id=current_setting(\'app.tenant_id\') AND source_id=$1 AND asset_type=\'field\' AND active AND qualified_name=ANY($2::text[])',[sourceId,requiredColumns]);if(columns.rowCount!==new Set(requiredColumns).size)throw new Error('analytic_query_column_not_found');}
  if(intent.kind==='join_aggregate'){
    const join=await client.query(`SELECT 1 FROM graph.assets sourceField JOIN graph.relationships r ON r.tenant_id=sourceField.tenant_id AND r.from_asset_id=sourceField.asset_id AND r.relationship_type='REFERENCES' JOIN graph.assets targetField ON targetField.tenant_id=r.tenant_id AND targetField.asset_id=r.to_asset_id JOIN graph.assertions a ON a.tenant_id=r.tenant_id AND a.relationship_id=r.relationship_id WHERE sourceField.tenant_id=current_setting('app.tenant_id') AND sourceField.source_id=$1 AND targetField.source_id=$1 AND sourceField.qualified_name=$2 AND targetField.qualified_name=$3 LIMIT 1`,[sourceId,`${intent.leftTable}.${intent.leftColumn}`,`${intent.rightTable}.${intent.rightColumn}`]);
    if(!join.rowCount)throw new Error('analytic_query_join_unasserted');
  }
}

export async function validateAnalyticPlan(pool: Pool, input: { tenantId: string; principalId: string; plan: unknown }): Promise<ValidatedPlan> {
  const parsed = AnalyticPlanSchema.safeParse(input.plan);
  if (!parsed.success) throw new Error('analytic_plan_invalid');
  const plan = parsed.data; validatePlanGraph(plan);
  if (await planDigest(plan) !== plan.plan_hash) throw new Error('analytic_plan_hash_mismatch');
  await withTenant(pool, input.tenantId, async (client) => {
    const sources = await client.query<{ connection_id: string; connector_agent_id: string; source_group_id: string; source_group_version: number }>(
      `SELECT connection_id,connector_agent_id,source_group_id,source_group_version FROM registry.connections
       WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[])`, [input.tenantId, plan.scope.source_ids],
    );
    if (sources.rowCount !== plan.scope.source_ids.length) throw new Error('source_not_active');
    const byId = new Map(sources.rows.map((source) => [source.connection_id, source]));
    for (const step of plan.steps) {
      const source = byId.get(step.source_id);
      if (!source || source.connector_agent_id !== step.agent_id || source.source_group_version !== step.group_version) throw new Error('source_group_version_not_pinned');
    }
    const capability = await client.query<{ active_version: number; effect_class: string; enabled: boolean }>(
      `SELECT active_version,effect_class,enabled FROM registry.capabilities WHERE tenant_id=$1 AND capability_id='analytic.read'`, [input.tenantId],
    );
    if (!capability.rowCount || capability.rows[0]!.active_version !== 1 || capability.rows[0]!.effect_class !== 'READ' || !capability.rows[0]!.enabled) throw new Error('capability_not_available');
    if (plan.steps.some((step) => step.capability_id !== 'analytic.read' || step.capability_version !== capability.rows[0]!.active_version)) throw new Error('analytic_plan_invalid');
    const entitlement = await client.query<{ resource_id: string | null }>(
      `SELECT resource_id FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND allowed
       AND (resource_id IS NULL OR resource_id=ANY($3::text[]))`, [input.tenantId, input.principalId, plan.scope.source_ids],
    );
    if (!entitlement.rows.some((row) => row.resource_id === null)
      && plan.scope.source_ids.some((sourceId) => !entitlement.rows.some((row) => row.resource_id === sourceId))) throw new Error('principal_not_entitled');
    for(const step of plan.steps)if('query_intent'in step.inputs)await validateIntentAssets(client,step.source_id,parseQueryIntent(step.inputs.query_intent));
  });
  return { tenantId: input.tenantId, principalId: input.principalId, plan };
}

export async function startAnalyticRun(pool: Pool, input: { tenantId: string; principalId: string; plan: unknown; governed?: { governedId: string; version: number } }): Promise<{ runId: string }> {
  const validated = await validateAnalyticPlan(pool, input);
  const { plan } = validated; const planHash = plan.plan_hash;
  await withTenant(pool, input.tenantId, async (client) => {
    {
      const stillActive = await client.query<{ connection_id: string; connector_agent_id: string; source_group_version: number }>(
        `SELECT connection_id,connector_agent_id,source_group_version FROM registry.connections
         WHERE tenant_id=$1 AND status='active' AND connection_id=ANY($2::uuid[]) FOR SHARE`,
        [input.tenantId, plan.scope.source_ids],
      );
      const current = new Map(stillActive.rows.map((source) => [source.connection_id, source]));
      if (plan.steps.some((step) => {
        const source = current.get(step.source_id);
        return !source || source.connector_agent_id !== step.agent_id || source.source_group_version !== step.group_version;
      })) throw new Error('source_group_version_not_pinned');
      const capabilityStillActive = await client.query<{ active_version: number; effect_class: string; enabled: boolean }>(
        `SELECT active_version,effect_class,enabled FROM registry.capabilities WHERE tenant_id=$1 AND capability_id='analytic.read' FOR SHARE`, [input.tenantId],
      );
      if (!capabilityStillActive.rowCount || !capabilityStillActive.rows[0]!.enabled || capabilityStillActive.rows[0]!.effect_class !== 'READ'
        || capabilityStillActive.rows[0]!.active_version !== 1) throw new Error('capability_not_available');
      const currentEntitlement = await client.query<{ resource_id: string | null }>(
        `SELECT resource_id FROM core.entitlements WHERE tenant_id=$1 AND principal_id=$2 AND capability_id='analytic.read' AND allowed
         AND (resource_id IS NULL OR resource_id=ANY($3::text[])) FOR SHARE`,
        [input.tenantId, input.principalId, plan.scope.source_ids],
      );
      if (!currentEntitlement.rows.some((row) => row.resource_id === null)
        && plan.scope.source_ids.some((sourceId) => !currentEntitlement.rows.some((row) => row.resource_id === sourceId))) throw new Error('principal_not_entitled');
      if(input.governed){
        const approved=await client.query<{plan:AnalyticPlan}>(
          `SELECT v.plan FROM registry.governed_versions v JOIN registry.governed_approvals a USING(tenant_id,governed_id,version)
           WHERE v.tenant_id=$1 AND v.governed_id=$2 AND v.version=$3 FOR SHARE`,[input.tenantId,input.governed.governedId,input.governed.version]);
        if(!approved.rowCount)throw new Error('governed_version_not_approved');
        const fingerprint=(value:AnalyticPlan)=>hashPlan(Object.fromEntries(Object.entries(value).filter(([key])=>key!=='run_id'&&key!=='plan_hash')));
        if(await fingerprint(approved.rows[0]!.plan)!==await fingerprint(plan))throw new Error('governed_plan_mismatch');
      }
      const runId = plan.run_id;
      await client.query(`INSERT INTO runs.runs(tenant_id,run_id,principal_id,state,plan_id) VALUES($1,$2,$3,'CREATED',$4)`, [input.tenantId, runId, input.principalId, plan.plan_id]);
      if(input.governed)await client.query('INSERT INTO runs.governed_run_pins(tenant_id,run_id,governed_id,version) VALUES($1,$2,$3,$4)',[input.tenantId,runId,input.governed.governedId,input.governed.version]);
      await client.query('INSERT INTO runs.analytic_plans(tenant_id,run_id,plan,plan_hash) VALUES($1,$2,$3::jsonb,$4)', [input.tenantId, runId, JSON.stringify(plan), planHash]);
      const decision = await client.query<{ decision_id: string }>(
        `INSERT INTO runs.authz_decisions(tenant_id,run_id,principal_id,capability_id,outcome,policy_version,reasons)
         VALUES($1,$2,$3,'analytic.read','allow','phase2-v1','["read_capability_entitled"]') RETURNING decision_id`,
        [input.tenantId, runId, input.principalId],
      );
      let sequence = 0;
      const event = async (type: string, payload: Record<string, unknown>) => {
        sequence += 1;
        await client.query('INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,decision_id,safe_payload) VALUES($1,$2,$3,$4,$5,$6::jsonb)', [input.tenantId, runId, sequence, type, decision.rows[0]!.decision_id, JSON.stringify(payload)]);
      };
      await event('run_created', { state: 'CREATED', state_version: 0 });
      const setState = async (state: string) => client.query<{ state_version: number }>(
        'UPDATE runs.runs SET state=$3,state_version=state_version+1,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2 RETURNING state_version', [input.tenantId, runId, state],
      );
      const planning = await setState('PLANNING');
      await event('run_state_changed', { state: 'PLANNING', state_version: planning.rows[0]!.state_version });
      await event('plan_proposed', { count: plan.steps.length });
      const validatedState = await setState('PLAN_VALIDATED');
      await event('plan_validated', { state: 'PLAN_VALIDATED', state_version: validatedState.rows[0]!.state_version, count: plan.steps.length });
      for (const [index, step] of plan.steps.entries()) {
        const group = await client.query<{ source_group_id: string }>('SELECT source_group_id FROM registry.connections WHERE tenant_id=$1 AND connection_id=$2', [input.tenantId, step.source_id]);
        await client.query(`INSERT INTO runs.steps(tenant_id,run_id,step_id,step_order,capability_id,capability_version,agent_id,state,idempotency_key,source_group_id,source_group_version)
          VALUES($1,$2,$3,$4,$5,$6,$7,'PENDING',$8,$9,$10)`, [input.tenantId, runId, step.step_id, index+1, step.capability_id, step.capability_version, step.agent_id, step.idempotency_key, group.rows[0]!.source_group_id, step.group_version]);
      }
      const running = await setState('RUNNING');
      await event('run_state_changed', { state: 'RUNNING', state_version: running.rows[0]!.state_version });
    }
  });
  return { runId: plan.run_id };
}
