import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { executeGoldenStep } from '../support/test-analytic-executor.js';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createAnalyticPlan, finalizeAnalyticRun, startAnalyticRun } from '@scaleinsyght/analytic';
import { completeStep, failStep, type StepClaim } from '@scaleinsyght/runner';
import { authorise } from '@scaleinsyght/policy';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

async function setup(tenantId: string, types: Array<'postgres' | 'snowflake'>): Promise<{ principalId: string; sources: Array<{ connectionId: string; agentId: string; sourceGroupId: string; sourceGroupVersion: number }> }> {
  let principalId = '';
  await withTenant(migrate, tenantId, async (db) => {
    await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    principalId = (await db.query<{ user_id: string }>("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'synthetic') RETURNING user_id", [tenantId, `${tenantId}@synthetic.example`])).rows[0]!.user_id;
    await db.query(`INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)`, [tenantId]);
  });
  const sources = [];
  for (const connectorType of types) sources.push(await activateConnection(app, { tenantId, principalId, connectorType }));
  await withTenant(migrate, tenantId, async (db) => {
    for (const source of sources) await db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)", [tenantId, principalId, source.connectionId]);
  });
  return { principalId, sources };
}
async function claimForTest(tenantId: string, runId: string, stepId: string, workerId: string): Promise<StepClaim> {
  await withTenant(migrate, tenantId, async (db) => {
    await db.query("UPDATE runs.steps SET state='CLAIMED',attempt=1,fencing_token=1,lease_owner=$3,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND run_id=$2 AND step_id=$4", [tenantId, runId, workerId, stepId]);
  });
  return { tenantId, runId, stepId, workerId, attempt: 1, fencingToken: 1 };
}

describe('contract 4 analytic execution and evidence', () => {
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); });
  it('c4_two_group_answers_resolve_each_claim_to_safe_evidence_and_resume_without_rows', async () => {
    const tenantId = `analytic-exec-${crypto.randomUUID()}`;
    const { principalId, sources } = await setup(tenantId, ['postgres', 'snowflake']);
    const plan = await createAnalyticPlan({ question: 'How many catalog objects are listed?', runId: crypto.randomUUID(), sources: sources.map((source) => ({ sourceId: source.connectionId, agentId: source.agentId, groupId: source.sourceGroupId, groupVersion: source.sourceGroupVersion })) });
    expect(plan.combine.map((join) => join.level)).toEqual(['group','group','cross_group']);
    await startAnalyticRun(app, { tenantId, principalId, plan });
    for (const [index, step] of plan.steps.entries()) {
      const connectorType = index === 0 ? 'postgres' : 'snowflake';
      const decision = await authorise(worker, { principal: { tenant_id: tenantId, principal_id: principalId, kind: 'user', roles: [], groups: [], attributes: {} }, capability_id: step.capability_id, resources: [step.source_id], purpose: 'analytic_query', environment: 'synthetic_golden' }, plan.run_id);
      expect(decision.outcome).toBe('allow');
      const claim = await claimForTest(tenantId, plan.run_id, step.step_id, `contract4-${index}`);
      const result = await executeGoldenStep({ step, question: plan.question, connectorType, groupId: sources[index]!.sourceGroupId });
      expect(await completeStep(worker, { ...claim, workerId: 'stale-worker', fencingToken: 0 }, { resultRef: 'golden://stale', analyticResult: result })).toBe(false);
      expect(await completeStep(worker, claim, { resultRef: `golden://analytic/${plan.run_id}/${step.step_id}`, analyticResult: result })).toBe(true);
      await finalizeAnalyticRun(worker, plan.run_id);
    }
    const stored = await withTenant(migrate, tenantId, async (db) => ({
      run: await db.query<{ state: string }>('SELECT state FROM runs.runs WHERE tenant_id=$1 AND run_id=$2', [tenantId, plan.run_id]),
      answer: await db.query<{ status: string; answer: { bySource: Array<{ value: number }>; claims: Array<{ evidence_ids: string[] }>; evidence: unknown[]; trust: { joins: string[] } } }>('SELECT status,answer FROM runs.analytic_answers WHERE tenant_id=$1 AND run_id=$2', [tenantId, plan.run_id]),
      events: await db.query<{ safe_payload: Record<string, unknown> }>('SELECT safe_payload FROM runs.events WHERE tenant_id=$1 AND run_id=$2', [tenantId, plan.run_id]),
    }));
    expect(stored.run.rows[0]?.state).toBe('COMPLETED');
    expect(stored.answer.rows[0]).toMatchObject({ status: 'COMPLETED', answer: { bySource: [{ value: 12 }, { value: 8 }], trust: { joins: ['group','cross_group'] } } });
    const answer = stored.answer.rows[0]!.answer;
    expect(answer.claims.every((claim) => claim.evidence_ids.length > 0 && claim.evidence_ids.every((id) => answer.evidence.some((evidence) => (evidence as { evidence_id: string }).evidence_id === id)))).toBe(true);
    expect(JSON.stringify(stored.events)).not.toMatch(/result_rows|row_values|raw_sql|"value"/i);
  });

  it('c5_forced_source_timeout_finishes_run_as_partial_with_completed_evidence', async () => {
    const tenantId = `analytic-timeout-${crypto.randomUUID()}`;
    const { principalId, sources } = await setup(tenantId, ['postgres','snowflake']);
    const plan = await createAnalyticPlan({ question: '[synthetic timeout] How many catalog objects are listed?', runId: crypto.randomUUID(), sources: sources.map((source) => ({ sourceId: source.connectionId, agentId: source.agentId, groupId: source.sourceGroupId, groupVersion: source.sourceGroupVersion })) });
    await startAnalyticRun(app, { tenantId, principalId, plan });
    const timeoutStep = plan.steps[0]!; const timeoutClaim = await claimForTest(tenantId, plan.run_id, timeoutStep.step_id, 'contract4-timeout');
    await expect(executeGoldenStep({ step: timeoutStep, question: plan.question, connectorType: 'postgres', groupId: sources[0]!.sourceGroupId })).rejects.toThrow('synthetic_timeout');
    expect(await failStep(worker, timeoutClaim, { reasonCode: 'source_timeout' })).toBe(true);
    expect(await finalizeAnalyticRun(worker, plan.run_id)).toBe('WAITING');
    const successStep = plan.steps[1]!; const successClaim = await claimForTest(tenantId, plan.run_id, successStep.step_id, 'contract4-success');
    const successful = await executeGoldenStep({ step: successStep, question: plan.question, connectorType: 'snowflake', groupId: sources[1]!.sourceGroupId });
    expect(await completeStep(worker, successClaim, { resultRef: `golden://analytic/${plan.run_id}/${successStep.step_id}`, analyticResult: successful })).toBe(true);
    expect(await finalizeAnalyticRun(worker, plan.run_id)).toBe('PARTIAL');
    const result = await withTenant(migrate, tenantId, async (db) => db.query<{ state: string; status: string; answer: { bySource: unknown[]; evidence: unknown[] } }>(
      'SELECT r.state,a.status,a.answer FROM runs.runs r JOIN runs.analytic_answers a USING(tenant_id,run_id) WHERE r.tenant_id=$1 AND r.run_id=$2', [tenantId, plan.run_id],
    ));
    expect(result.rows[0]).toMatchObject({ state: 'PARTIAL', status: 'PARTIAL', answer: { bySource: [{ value: 8 }], evidence: expect.any(Array) } });
    expect(result.rows[0]!.answer.evidence).toHaveLength(1);
  });
});
