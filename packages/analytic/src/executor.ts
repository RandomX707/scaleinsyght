import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClaimSchema, EvidenceRefSchema, type AnalyticPlan, type Claim, type EvidenceRef } from '@scaleinsyght/contracts';
import { withRunTenant } from '@scaleinsyght/db';
import type { Pool } from 'pg';

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL('../../../tests/golden/phase2.json', import.meta.url)), 'utf8')) as {
  questions: Array<{ id: string; connectorType: string; metric: string; expectedValue: number; evidenceAsset: string }>;
  scenarios: { timeoutMarker: string };
};

export interface GoldenStepTask {
  step: AnalyticPlan['steps'][number];
  question: string;
  connectorType: string;
  groupId: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}
export interface StructuredResult {
  sourceId: string;
  connectorType: string;
  groupId: string;
  metric: string;
  value: number;
  claims: Claim[];
  evidence: EvidenceRef[];
}
export interface StructuredAnswer {
  metric: string;
  bySource: Array<{ sourceId: string; connectorType: string; value: number }>;
  claims: Claim[];
  evidence: EvidenceRef[];
  trust: { groupCount: number; sourceCount: number; joins: Array<'group' | 'cross_group'> };
}
export interface CriticResult { accepted: boolean; reasons: string[]; }

function metricFor(question: string): string {
  const q = question.toLowerCase();
  if (q.includes('unchanged')) return 'nightly_unchanged_count';
  if (q.includes('inaccessible')) return 'inaccessible_count';
  if (q.includes('profiled fields') || q.includes('fields are profiled')) return 'field_count';
  if (q.includes('changed')) return 'nightly_changed_count';
  if (q.includes('listed') || q.includes('catalog objects')) return 'listed_count';
  throw new Error('golden_question_not_supported');
}

export async function executeGoldenStep(task: GoldenStepTask): Promise<StructuredResult> {
  if (task.signal?.aborted || (task.timeoutMs !== undefined && task.timeoutMs <= 0)
    || (task.connectorType === 'postgres' && task.question.includes(corpus.scenarios.timeoutMarker))) throw new Error('synthetic_timeout');
  const metric = metricFor(task.question);
  const sample = corpus.questions.find((entry) => entry.connectorType === task.connectorType && entry.metric === metric);
  if (!sample) throw new Error('golden_source_metric_not_found');
  const evidence: EvidenceRef = EvidenceRefSchema.parse({
    evidence_id: randomUUID(), kind: 'profile', source_id: task.step.source_id, asset_ids: [],
    locator: `golden://phase2/${sample.id}`, content_hash: createHash('sha256').update(JSON.stringify(sample)).digest('hex'),
    captured_at: new Date().toISOString(), collector_version: 'golden-phase2-v1', redacted_summary: `Synthetic ${metric} aggregate`,
  });
  const claim: Claim = ClaimSchema.parse({
    claim_id: randomUUID(), kind: 'metric', statement: `${task.connectorType} ${metric}: ${sample.expectedValue}`,
    evidence_ids: [evidence.evidence_id],
  });
  return { sourceId: task.step.source_id, connectorType: task.connectorType, groupId: task.groupId,
    metric, value: sample.expectedValue, claims: [claim], evidence: [evidence] };
}

export function collateGroupResults(results: StructuredResult[]): StructuredAnswer {
  if (!results.length || new Set(results.map((result) => result.metric)).size !== 1) throw new Error('analytic_results_incompatible');
  const groups = new Set(results.map((result) => result.groupId));
  const evidence = results.flatMap((result) => result.evidence);
  const claims = results.flatMap((result) => result.claims);
  if (groups.size > 1) {
    const same = new Set(results.map((result) => result.value)).size === 1;
    claims.push(ClaimSchema.parse({ claim_id: randomUUID(), kind: 'interpretation',
      statement: `The selected sources report ${same ? 'the same' : 'different'} values for ${results[0]!.metric}.`,
      evidence_ids: evidence.map((ref) => ref.evidence_id),
    }));
  }
  return {
    metric: results[0]!.metric,
    bySource: results.map(({ sourceId, connectorType, value }) => ({ sourceId, connectorType, value })),
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

export async function finalizeAnalyticRun(pool: Pool, runId: string): Promise<'COMPLETED' | 'PARTIAL' | 'FAILED' | 'WAITING'> {
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
    const resultRows = await client.query<{ result: StructuredResult }>('SELECT result FROM runs.analytic_results WHERE tenant_id=$1 AND run_id=$2 ORDER BY created_at,step_id', [stored.tenant_id, runId]);
    const partial = states.rows.some((step) => step.state !== 'SUCCEEDED');
    const results = resultRows.rows.map((row) => row.result);
    const answer: StructuredAnswer = results.length ? collateGroupResults(results) : {
      metric: 'unavailable', bySource: [], claims: [], evidence: [], trust: { groupCount: 0, sourceCount: 0, joins: [] },
    };
    const critic = criticCheck(answer, plan, partial);
    let terminal: 'COMPLETED' | 'PARTIAL' | 'FAILED' = partial ? 'PARTIAL' : 'COMPLETED';
    if (!critic.accepted) terminal = 'FAILED';
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
