import { randomUUID } from 'node:crypto';
import { ClaimSchema, EvidenceRefSchema, type AnalyticPlan, type Claim, type EvidenceRef } from '@scaleinsyght/contracts';
import { withRunTenant } from '@scaleinsyght/db';
import type { Pool } from 'pg';
import { summarizeGroups, type GroupSummary } from './group-summary.js';
export interface StructuredResult {
  sourceId: string;
  connectorType: string;
  groupId: string;
  metric: string;
  value: number;
  rows?: Array<Record<string,unknown>>;
  minimumCellSize?: number;
  claims: Claim[];
  evidence: EvidenceRef[];
}
export interface StructuredAnswer {
  metric: string;
  bySource: Array<{ sourceId: string; connectorType: string; value: number; rows?: Array<Record<string,unknown>>; summary?: GroupSummary }>;
  claims: Claim[];
  evidence: EvidenceRef[];
  trust: { groupCount: number; sourceCount: number; joins: Array<'group' | 'cross_group'> };
}
export interface CriticResult { accepted: boolean; reasons: string[]; }

export function collateGroupResults(results: StructuredResult[]): StructuredAnswer {
  if (!results.length || new Set(results.map((result) => result.metric)).size !== 1) throw new Error('analytic_results_incompatible');
  const groups = new Set(results.map((result) => result.groupId));
  const evidence = results.flatMap((result) => result.evidence);
  const claims = results.flatMap((result) => result.claims);
  if (groups.size > 1 && !results.some(result=>result.minimumCellSize!==undefined)) {
    const same = new Set(results.map((result) => result.value)).size === 1;
    claims.push(ClaimSchema.parse({ claim_id: randomUUID(), kind: 'interpretation',
      statement: `The selected sources report ${same ? 'the same' : 'different'} values for ${results[0]!.metric}.`,
      evidence_ids: evidence.map((ref) => ref.evidence_id),
    }));
  }
  return {
    metric: results[0]!.metric,
    bySource: results.map(({ sourceId, connectorType, value, rows }) => { const summary = rows ? summarizeGroups(rows) : undefined; return { sourceId, connectorType, value, ...(rows?{rows}:{}), ...(summary?{summary}:{}) }; }),
    claims, evidence,
    trust: { groupCount: groups.size, sourceCount: results.length, joins: groups.size > 1 ? ['group', 'cross_group'] : ['group'] },
  };
}

export function criticCheck(answer: StructuredAnswer, plan: AnalyticPlan, partial = false): CriticResult {
  const evidenceIds = new Set(answer.evidence.map((ref) => ref.evidence_id));
  const expectedSources = new Set(plan.scope.source_ids);
  const reasons: string[] = [];
  if (answer.claims.some((claim) => !ClaimSchema.safeParse(claim).success || claim.evidence_ids.some((id) => !evidenceIds.has(id)))) reasons.push('claim_missing_evidence');
  if (answer.evidence.some((ref) => !EvidenceRefSchema.safeParse(ref).success || !expectedSources.has(ref.source_id))) reasons.push('evidence_out_of_scope');
  if (answer.bySource.some((entry) => !expectedSources.has(entry.sourceId))) reasons.push('answer_source_out_of_scope');
  if (!partial && new Set(answer.bySource.map((entry) => entry.sourceId)).size !== expectedSources.size) reasons.push('source_result_count_mismatch');
  const expectedGroups = new Set(plan.steps.map((step) => step.via_collating_agent_id)).size;
  if (!partial && (answer.trust.sourceCount !== expectedSources.size || answer.trust.groupCount !== expectedGroups)) reasons.push('join_scope_mismatch');
  return { accepted: reasons.length === 0, reasons };
}

export async function finalizeAnalyticRun(pool: Pool, runId: string, compose?: (input:{plan:AnalyticPlan;results:StructuredResult[]})=>Promise<{statement:string;model:string;inputTokens:number;outputTokens:number}>): Promise<'COMPLETED' | 'PARTIAL' | 'FAILED' | 'WAITING'> {
  return withRunTenant(pool, runId, async (client, stored) => {
    const run = await client.query<{ state: string; state_version: number }>(
      'SELECT state,state_version FROM runs.runs WHERE tenant_id=$1 AND run_id=$2 FOR UPDATE', [stored.tenant_id, runId],
    );
    if (!run.rowCount || run.rows[0]!.state !== 'FINALISING') return 'WAITING';
    const existing = await client.query<{ status: 'COMPLETED' | 'PARTIAL' }>('SELECT status FROM runs.analytic_answers WHERE tenant_id=$1 AND run_id=$2', [stored.tenant_id, runId]);
    if (existing.rowCount) return existing.rows[0]!.status;
    const storedPlan = await client.query<{ plan: AnalyticPlan }>('SELECT plan FROM runs.analytic_plans WHERE tenant_id=$1 AND run_id=$2', [stored.tenant_id, runId]);
    const plan = storedPlan.rows[0]?.plan;
    if (!plan) throw new Error('analytic_plan_not_found');
    const states = await client.query<{ state: string }>('SELECT state FROM runs.steps WHERE tenant_id=$1 AND run_id=$2 ORDER BY step_order', [stored.tenant_id, runId]);
    if (states.rows.some((step) => ['PENDING','CLAIMED','RUNNING'].includes(step.state))) return 'WAITING';
    const resultRows = await client.query<{ result: StructuredResult }>('SELECT r.result FROM runs.analytic_results r JOIN runs.steps s ON s.tenant_id=r.tenant_id AND s.run_id=r.run_id AND s.step_id=r.step_id WHERE r.tenant_id=$1 AND r.run_id=$2 ORDER BY s.step_order,r.step_id', [stored.tenant_id, runId]);
    const partial = states.rows.some((step) => step.state !== 'SUCCEEDED');
    const results = resultRows.rows.map((row) => row.result);
    const answer: StructuredAnswer = results.length ? collateGroupResults(results) : {
      metric: 'unavailable', bySource: [], claims: [], evidence: [], trust: { groupCount: 0, sourceCount: 0, joins: [] },
    };
    let compositionFailed=false;
    if(compose&&!partial&&results.length&&plan.steps.every(step=>'query_intent' in step.inputs)){
      try{
        const prose=await compose({plan,results});
        answer.claims=[ClaimSchema.parse({claim_id:randomUUID(),kind:'metric',statement:prose.statement,evidence_ids:answer.evidence.map(ref=>ref.evidence_id)})];
        await client.query("INSERT INTO runs.model_provenance(tenant_id,run_id,call_purpose,model_name,input_tokens,output_tokens) VALUES($1,$2,'answer',$3,$4,$5)",[stored.tenant_id,runId,prose.model,prose.inputTokens,prose.outputTokens]);
      }catch{compositionFailed=true;}
    }
    const critic = criticCheck(answer, plan, partial);
    let terminal: 'COMPLETED' | 'PARTIAL' | 'FAILED' = partial ? 'PARTIAL' : 'COMPLETED';
    if (!critic.accepted || compositionFailed || (compose&&partial&&plan.steps.some(step=>'query_intent' in step.inputs))) terminal = 'FAILED';
    if (terminal !== 'FAILED') {
      await client.query('INSERT INTO runs.analytic_answers(tenant_id,run_id,status,answer) VALUES($1,$2,$3,$4::jsonb)', [stored.tenant_id, runId, terminal, JSON.stringify(answer)]);
    }
    const nextVersion = run.rows[0]!.state_version + 1;
    await client.query('UPDATE runs.runs SET state=$3,state_version=$4,updated_at=clock_timestamp() WHERE tenant_id=$1 AND run_id=$2', [stored.tenant_id, runId, terminal, nextVersion]);
    const nextSequence = await client.query<{ next: string }>('SELECT COALESCE(MAX(sequence),0)+1 AS next FROM runs.events WHERE tenant_id=$1 AND run_id=$2', [stored.tenant_id, runId]);
    await client.query('INSERT INTO runs.events(tenant_id,run_id,sequence,event_type,safe_payload) VALUES($1,$2,$3,\'run_terminal\',$4::jsonb)', [stored.tenant_id, runId, Number(nextSequence.rows[0]!.next), JSON.stringify({ state: terminal, state_version: nextVersion })]);
    return terminal;
  });
}
