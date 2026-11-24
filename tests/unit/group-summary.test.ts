import { describe, expect, it } from 'vitest';
import { roundForModel, summarizeGroups } from '@scaleinsyght/analytic';

describe('grouped answer summary', () => {
  it('group_summary_reports_highest_lowest_spread_and_exact_ties', () => {
    const summary = summarizeGroups([
      { group_value: 'Emergency', value: '388' }, { group_value: 'Orthopedics', value: '41' },
      { group_value: 'Psychiatry', value: '41' }, { group_value: 'Rehabilitation', value: '25' },
    ]);
    expect(summary).toEqual({ groupCount: 4, highest: { label: 'Emergency', value: 388 }, lowest: { label: 'Rehabilitation', value: 25 }, spread: 363, ties: [{ value: 41, labels: ['Orthopedics', 'Psychiatry'] }] });
  });
  it('group_summary_does_not_invent_ties_from_rounding', () => {
    expect(summarizeGroups([{ group_value: 'a', value: 1.538 }, { group_value: 'b', value: 1.541 }])?.ties).toEqual([]);
    expect(roundForModel(1.2916666)).toBe(1.29);
    expect(roundForModel(388)).toBe(388);
  });
  it('group_summary_is_undefined_for_single_values', () => {
    expect(summarizeGroups([{ value: 500 }])).toBeUndefined();
    expect(summarizeGroups([{ group_value: 'only', value: 3 }])).toBeUndefined();
  });
});
