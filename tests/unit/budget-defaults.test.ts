import { describe, expect, it } from 'vitest';
import { DEFAULT_TENANT_DAILY_COST_CAP_USD, DEFAULT_USER_DAILY_COST_CAP_USD, dailyBudgetCaps } from '@scaleinsyght/model-gateway';

describe('daily model budget defaults (decision 43)', () => {
  it('budget_defaults_are_five_dollars_per_tenant_and_one_per_person', () => {
    expect([DEFAULT_TENANT_DAILY_COST_CAP_USD, DEFAULT_USER_DAILY_COST_CAP_USD]).toEqual([5, 1]);
    expect(dailyBudgetCaps({})).toEqual({ tenantUsd: 5, userUsd: 1 });
    expect(dailyBudgetCaps({ MODEL_DAILY_COST_CAP_USD: '12', MODEL_DAILY_USER_COST_CAP_USD: '2.5' })).toEqual({ tenantUsd: 12, userUsd: 2.5 });
  });
});
