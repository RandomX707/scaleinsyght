import { describe, expect, it } from 'vitest';
import { applyPersonalContext } from '@scaleinsyght/analytic';
import type { StructuredAnswer } from '@scaleinsyght/analytic';

const answer: StructuredAnswer = {
  metric: 'listed_count', bySource: [{ sourceId: 'source-a', connectorType: 'postgres', value: 12 }],
  claims: [
    { claim_id: 'metric', kind: 'metric', statement: 'Count: 12', evidence_ids: ['evidence'] },
    { claim_id: 'interpretation', kind: 'interpretation', statement: 'Synthetic total', evidence_ids: ['evidence'] },
  ], evidence: [], trust: { groupCount: 1, sourceCount: 1, joins: ['group'] },
};

describe('personal answer presentation', () => {
  it('phase2_two_people_receive_equal_values_with_distinct_answer_shapes', () => {
    const first = applyPersonalContext(answer, { vocabulary: { listed_count: 'catalog size' }, defaultSources: [], savedPlanIds: [], answerStyle: 'concise' });
    const second = applyPersonalContext(answer, { vocabulary: {}, defaultSources: [], savedPlanIds: [], answerStyle: 'detailed' });
    expect(first.answer.bySource).toEqual(second.answer.bySource);
    expect(first.answer.claims).toEqual(second.answer.claims);
    expect(first.presentation.layout).toBe('compact'); expect(second.presentation.layout).toBe('expanded');
    expect(first.presentation.title).toBe('catalog size');
  });
});
