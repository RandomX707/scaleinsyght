import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { ClaimSchema, EvidenceRefSchema, type AnalyticPlan, type Claim, type EvidenceRef } from '@scaleinsyght/contracts';
import type { StructuredResult } from '@scaleinsyght/analytic';

const corpus = JSON.parse(readFileSync(fileURLToPath(new URL('../golden/phase2.json', import.meta.url)), 'utf8')) as {
  questions: Array<{ id: string; connectorType: string; metric: string; expectedValue: number }>;
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
