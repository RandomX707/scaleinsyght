import { expect,it } from 'vitest';
import { publicPlannerDetails } from '../../apps/api/src/planner-attempt-copy.js';

it('shows the tagged field in a plain summary and strips technical errors for nonadmins', () => {
  const plan={error:'grouping_by_a_sensitive_column_is_not_allowed: public.encounters.patient_id is tagged identifier'};
  const regular=publicPlannerDetails(plan,false);
  expect(regular.summaries).toEqual(['Blocked because the question would expose patient_id, a sensitive identifier.']);
  expect(JSON.stringify(regular)).not.toContain(plan.error);
  expect(publicPlannerDetails(plan,true).typedPlan).toEqual(plan);
});
