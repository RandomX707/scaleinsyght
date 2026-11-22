import { describe, expect, it } from 'vitest';
import { AnalyticPlanSchema, ClaimSchema, EvidenceRefSchema, PlanStepSchema, hashPlan } from '@scaleinsyght/contracts';
import phase2 from '../golden/phase2.json' with { type: 'json' };

const validStep = {
  step_id: '00000000-0000-4000-8000-000000000003',
  capability_id: 'catalog.aggregate',
  capability_version: 1,
  agent_id: '00000000-0000-4000-8000-000000000004',
  source_id: '00000000-0000-4000-8000-000000000002',
  via_collating_agent_id: '00000000-0000-4000-8000-000000000005',
  group_version: 1,
  inputs: { metric: 'profiled_count' },
  depends_on: [],
  effect_class: 'READ',
  timeout_s: 5,
  retry: { max: 0, backoff: 'none' },
  idempotency_key: 'golden:phase2:step-1',
};

const validPlan = {
  plan_id: '00000000-0000-4000-8000-000000000001',
  run_id: '00000000-0000-4000-8000-000000000006',
  version: 1,
  plan_hash: 'a'.repeat(64),
  question: 'How many catalog objects are listed?',
  scope: { source_ids: ['00000000-0000-4000-8000-000000000002'], as_of: '2026-11-23T00:00:00.000Z' },
  steps: [validStep],
  combine: [],
  budgets: { max_parallel: 1, max_runtime_s: 30, max_tokens: 0, max_source_queries: 1 },
};

describe('phase-2 analytic contracts', () => {
  it('c3_analytic_plan_and_steps_reject_unknown_fields_and_malformed_versions', () => {
    expect(PlanStepSchema.parse(validStep)).toEqual(validStep);
    expect(PlanStepSchema.safeParse({ ...validStep, source_password: 'never-allowed' }).success).toBe(false);
    expect(PlanStepSchema.safeParse({ ...validStep, capability_version: 0 }).success).toBe(false);
    expect(AnalyticPlanSchema.parse(validPlan)).toEqual(validPlan);
    expect(AnalyticPlanSchema.safeParse({ ...validPlan, model_output: 'raw hidden chain of thought' }).success).toBe(false);
  });

  it('c4_answer_claims_require_evidence_and_evidence_is_typed_and_redacted', () => {
    const evidenceId = '00000000-0000-4000-8000-000000000007';
    expect(ClaimSchema.safeParse({ claim_id: '00000000-0000-4000-8000-000000000008', kind: 'metric', statement: 'Profiled tables: 499', evidence_ids: [] }).success).toBe(false);
    expect(ClaimSchema.parse({ claim_id: '00000000-0000-4000-8000-000000000008', kind: 'metric', statement: 'Profiled tables: 499', evidence_ids: [evidenceId] }).evidence_ids).toEqual([evidenceId]);
    expect(EvidenceRefSchema.safeParse({ evidence_id: evidenceId, kind: 'profile', source_id: '00000000-0000-4000-8000-000000000002', asset_ids: [], locator: 'golden://profile/1', content_hash: 'b'.repeat(64), captured_at: '2026-11-23T00:00:00.000Z', collector_version: 'golden-v1', redacted_summary: 'Profile count only', row_values: ['S-123'] }).success).toBe(false);
  });

  it('phase2_plan_hash_is_canonical_and_changes_when_plan_semantics_change', async () => {
    const first = { question: 'Count profiled tables', scope: { source_ids: ['source-a'], as_of: '2026-11-23' }, budgets: { max_parallel: 1 } };
    const reordered = { budgets: { max_parallel: 1 }, scope: { as_of: '2026-11-23', source_ids: ['source-a'] }, question: 'Count profiled tables' };
    const firstHash = await hashPlan(first);
    expect(firstHash).toBe(await hashPlan(reordered));
    expect(firstHash).not.toBe(await hashPlan({ ...first, question: 'Count inaccessible tables' }));
    expect(firstHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('phase2_golden_corpus_has_30_literal_cases_for_each_connector', () => {
    expect(phase2.questions).toHaveLength(120);
    for (const connectorType of ['sql_server', 'postgres', 'snowflake', 'excel']) {
      const questions = phase2.questions.filter((question) => question.connectorType === connectorType);
      expect(questions).toHaveLength(30);
      expect(questions.every((question) => typeof question.expectedValue === 'number' && question.evidenceAsset.length > 0)).toBe(true);
    }
    expect(phase2.questions.find((question) => question.id === 'sqlserver-01')?.expectedValue).toBe(500);
    expect(phase2.questions.find((question) => question.id === 'postgres-02')?.expectedValue).toBe(11);
    expect(phase2.questions.find((question) => question.id === 'snowflake-03')?.expectedValue).toBe(24);
    expect(phase2.questions.find((question) => question.id === 'excel-06')?.expectedValue).toBe(3);
  });
});
