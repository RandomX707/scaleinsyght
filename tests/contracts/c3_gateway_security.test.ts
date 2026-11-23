import { describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createAnalyticPlan } from '@scaleinsyght/analytic';
import { validateGatewayPlan } from '@scaleinsyght/customer-gateway';
import { hashPlan } from '@scaleinsyght/contracts';

describe('contract 3 gateway plan boundary', () => {
  it('c3_adversarial_metadata_cannot_change_validated_plan', async () => {
    const sourceId=randomUUID();
    const plan=await createAnalyticPlan({question:'Count synthetic encounters',runId:randomUUID(),sources:[{sourceId,agentId:randomUUID(),groupId:randomUUID(),groupVersion:1}]});
    const validated=await validateGatewayPlan(plan);
    expect(validated.scope.source_ids).toEqual([sourceId]);
    expect(validated.steps[0]!.inputs).toEqual({question_hash:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(JSON.stringify(validated)).not.toContain('ignore prior instructions');
  });

  it('c3_sql_guard_rejects_mutation_and_multi_statement_bypass_attempts', async () => {
    const plan=await createAnalyticPlan({question:'Count synthetic encounters',runId:randomUUID(),sources:[{sourceId:randomUUID(),agentId:randomUUID(),groupId:randomUUID(),groupVersion:1}]});
    const attempts=[
      {...plan,steps:plan.steps.map(step=>({...step,inputs:{...step.inputs,sql:'DELETE FROM patients'}}))},
      {...plan,steps:plan.steps.map(step=>({...step,effect_class:'MUTATION' as 'READ'}))},
      {...plan,steps:plan.steps.map(step=>({...step,inputs:{...step.inputs,sql:'SELECT 1; DROP TABLE patients'}}))},
      {...plan,steps:plan.steps.map(step=>({...step,inputs:{...step.inputs,sql:'SELECT 1 /* ; DROP TABLE patients */'}}))},
    ];
    for(const attack of attempts){attack.plan_hash=await hashPlan({...attack,plan_hash:''});await expect(validateGatewayPlan(attack)).rejects.toThrow('gateway_plan_rejected');}
  });
});
