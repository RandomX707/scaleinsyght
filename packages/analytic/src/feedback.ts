import { randomUUID } from 'node:crypto';
import { hashPlan } from '@scaleinsyght/contracts';
import { withTenant } from '@scaleinsyght/db';
import type { Pool } from 'pg';

export interface SafeCorrection { term: string; meaning: string; }
function validateCorrection(value: SafeCorrection): void {
  const text = `${value.term} ${value.meaning}`;
  if (!value.term.trim() || value.term.length > 120 || !value.meaning.trim() || value.meaning.length > 500
    || /[\r\n;]|\b(?:select|insert|update|delete|drop)\b/i.test(text)
    || /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(text)
    || /\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/i.test(text)
    || /\b\d{8,}\b/.test(text)
    || /\b(?:id|identifier|account|customer|email|ssn|phone)\s*[:=#]\s*\S+/i.test(text)) throw new Error('unsafe_correction');
}

export async function submitFeedback(pool: Pool, input: {
  tenantId: string; principalId: string; runId: string; verdict: 'useful' | 'not_useful'; correction?: SafeCorrection;
}): Promise<{ feedbackId: string; savedPlanId?: string }> {
  if (input.correction) validateCorrection(input.correction);
  if (input.verdict === 'useful' && input.correction) throw new Error('correction_not_allowed_for_useful_verdict');
  return withTenant(pool, input.tenantId, async (client) => {
    await client.query("SELECT set_config('app.principal_id',$1,true)", [input.principalId]);
    const run = await client.query<{ plan_id: string; question: string }>(
      `SELECT r.plan_id,p.plan->>'question' AS question FROM runs.runs r JOIN runs.analytic_plans p USING(tenant_id,run_id)
       JOIN runs.analytic_answers a USING(tenant_id,run_id)
       WHERE r.tenant_id=$1 AND r.run_id=$2 AND r.principal_id=$3`, [input.tenantId, input.runId, input.principalId],
    );
    const row = run.rows[0]; if (!row) throw new Error('run_not_found');
    const questionHash = Buffer.from(await hashPlan({ question: row.question }), 'hex');
    const feedbackId = randomUUID();
    await client.query(
      `INSERT INTO memory.feedback(feedback_id,tenant_id,principal_id,run_id,question_hash,verdict,correction)
       VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`,
      [feedbackId, input.tenantId, input.principalId, input.runId, questionHash, input.verdict, input.correction ? JSON.stringify(input.correction) : null],
    );
    if (input.correction) {
      await client.query(
        `INSERT INTO registry.personal_memories(tenant_id,person_id,corrections) VALUES($1,$2,$3::jsonb)
         ON CONFLICT(tenant_id,person_id) DO UPDATE SET corrections=registry.personal_memories.corrections || EXCLUDED.corrections,updated_at=clock_timestamp()`,
        [input.tenantId, input.principalId, JSON.stringify([input.correction])],
      );
      await client.query(
        `INSERT INTO memory.evaluation_cases(tenant_id,principal_id,question_hash,expected_claims)
         VALUES($1,$2,$3,$4::jsonb)`, [input.tenantId, input.principalId, questionHash, JSON.stringify([input.correction])],
      );
    }
    if (input.verdict === 'useful') {
      const memory = await client.query<{ saved_plan_ids: string[] }>('SELECT saved_plan_ids FROM registry.personal_memories WHERE tenant_id=$1 AND person_id=$2 FOR UPDATE', [input.tenantId, input.principalId]);
      const saved = memory.rows[0]?.saved_plan_ids ?? [];
      if (!saved.includes(row.plan_id)) await client.query(
        `INSERT INTO registry.personal_memories(tenant_id,person_id,saved_plan_ids) VALUES($1,$2,$3::jsonb)
         ON CONFLICT(tenant_id,person_id) DO UPDATE SET saved_plan_ids=EXCLUDED.saved_plan_ids,updated_at=clock_timestamp()`,
        [input.tenantId, input.principalId, JSON.stringify([...saved, row.plan_id])],
      );
      return { feedbackId, savedPlanId: row.plan_id };
    }
    return { feedbackId };
  });
}
