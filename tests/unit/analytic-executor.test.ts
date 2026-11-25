import { describe, expect, it } from 'vitest';
import { createAnalyticPlan, collateGroupResults, criticCheck } from '@scaleinsyght/analytic';
import { executeGoldenStep } from '../support/test-analytic-executor.js';

const uuid = () => crypto.randomUUID();

describe('phase 2 golden analytic execution', () => {
  it('c3_two_group_question_routes_each_source_through_its_collating_agent', async () => {
    const first = { sourceId: uuid(), agentId: uuid(), groupId: uuid(), groupVersion: 1 };
    const second = { sourceId: uuid(), agentId: uuid(), groupId: uuid(), groupVersion: 1 };
    const plan = await createAnalyticPlan({ question: 'How many catalog objects are listed?', runId: uuid(), sources: [first, second] });
    expect(plan.combine.map((combine) => combine.level)).toEqual(['group', 'group', 'cross_group']);
    expect(new Set(plan.steps.map((step) => step.via_collating_agent_id)).size).toBe(2);
    const results = await Promise.all([
      executeGoldenStep({ step: plan.steps[0]!, question: plan.question, connectorType: 'sql_server', groupId: first.groupId }),
      executeGoldenStep({ step: plan.steps[1]!, question: plan.question, connectorType: 'postgres', groupId: second.groupId }),
    ]);
    const answer = collateGroupResults(results);
    expect(answer.bySource.map((source) => source.value)).toEqual([500, 12]);
    expect(answer.trust).toEqual({ groupCount: 2, sourceCount: 2, joins: ['group', 'cross_group'] });
    expect(answer.claims.some((claim) => claim.kind === 'interpretation' && claim.evidence_ids.length === 2)).toBe(true);
    expect(criticCheck(answer, plan)).toEqual({ accepted: true, reasons: [] });
  });

  it('c4_every_material_claim_resolves_to_safe_evidence_and_timeout_is_explicit', async () => {
    const source = { sourceId: uuid(), agentId: uuid(), groupId: uuid(), groupVersion: 1 };
    const plan = await createAnalyticPlan({ question: 'How many catalog objects are listed?', runId: uuid(), sources: [source] });
    const result = await executeGoldenStep({ step: plan.steps[0]!, question: plan.question, connectorType: 'excel', groupId: source.groupId });
    expect(result.value).toBe(3);
    expect(result.claims.every((claim) => claim.evidence_ids.length > 0)).toBe(true);
    expect(JSON.stringify(result)).not.toMatch(/row_values|raw_sql|credential/i);
    await expect(executeGoldenStep({ step: plan.steps[0]!, question: plan.question, connectorType: 'excel', groupId: source.groupId, timeoutMs: 0 })).rejects.toThrow('synthetic_timeout');
    const invalid = { ...collateGroupResults([result]), evidence: [] };
    expect(criticCheck(invalid, plan)).toEqual({ accepted: false, reasons: ['claim_missing_evidence'] });
  });
});

describe('decision 42 disclosure', () => {
  it('withholds small cells and preserves the boundary value of 11', () => {
    const source = {sourceId: 'source', connectorType: 'postgres', groupId: 'group', metric: 'count', claims: [], evidence: []};
    for (const value of [1, 10]) {
      expect(collateGroupResults([{...source, value, minimumCellSize: value}]).bySource[0])
        .toEqual({sourceId: 'source', connectorType: 'postgres', value: null, withheld: true});
    }
    expect(collateGroupResults([{...source, value: 0, minimumCellSize: 0}]).bySource[0]?.value).toBe(0);
    expect(collateGroupResults([{...source, value: 11, minimumCellSize: 11}]).bySource[0])
      .toEqual({sourceId: 'source', connectorType: 'postgres', value: 11});
  });
  it('redacts only small nonzero cells and omits inferable summaries', () => {
    const result = collateGroupResults([{
      sourceId: 'source', connectorType: 'postgres', groupId: 'group', metric: 'count', value: 8,
      claims: [], evidence: [], minimumCellSize: 0, cellSizes: [8, 0, 11],
      rows: [{group_value: 'a', value: 8}, {group_value: 'b', value: 0}, {group_value: 'c', value: 11}],
    }]).bySource[0];
    expect(result).toMatchObject({value: null, withheld: true, rows: [
      {group_value: 'a', value: '<11'}, {group_value: 'b', value: 0}, {group_value: 'c', value: 11},
    ]});
    expect(result?.summary).toBeUndefined();
  });

});
