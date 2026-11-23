import { describe, expect, it } from 'vitest';
import { containsExpectedNumbers } from '../../scripts/live-result-check.mjs';

describe('live model answer comparison', () => {
  it('matches the same aggregate values when the model formats thousands with separators', () => {
    expect(containsExpectedNumbers('encounter_count: 12,000; department_count: 12; average: 1,000.00', ['12000', '12', '1000.00'])).toBe(true);
  });

  it('does not accept a missing or merely partial numeric value', () => {
    expect(containsExpectedNumbers('encounter_count: 12; department_count: 2; average: 100', ['12000', '12', '1000.00'])).toBe(false);
  });
});
