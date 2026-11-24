import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildTestServer as buildServer } from '../support/test-api.js';
import { hashPassword } from '@scaleinsyght/api/server';
import { activateConnection } from '@scaleinsyght/registry';
import { createAnalyticPlan, finalizeAnalyticRun, startAnalyticRun } from '@scaleinsyght/analytic';
import { completeStep, type StepClaim } from '@scaleinsyght/runner';
import { executeGoldenStep } from '../support/test-analytic-executor.js';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_WORKER' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 2 personal memory and feedback', () => {
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); });
  it('c7_feedback_is_owner_scoped_hash_only_and_changes_only_presentation', async () => {
    const tenantId = `feedback-${crypto.randomUUID()}`; let ownerId = '';
    await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      ownerId = (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')])).rows[0]!.user_id;
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, `${tenantId}-other@synthetic.example`, hashPassword('synthetic-password')]);
      await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)", [tenantId]);
    });
    const source = await activateConnection(app, { tenantId, principalId: ownerId, connectorType: 'postgres' });
    await withTenant(migrate, tenantId, async (db) => db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)", [tenantId, ownerId, source.connectionId]));
    const plan = await createAnalyticPlan({ question: 'How many catalog objects are listed?', runId: crypto.randomUUID(), sources: [{ sourceId: source.connectionId, agentId: source.agentId, groupId: source.sourceGroupId, groupVersion: 1 }] });
    await startAnalyticRun(app, { tenantId, principalId: ownerId, plan });
    const step = plan.steps[0]!; const workerId = 'feedback-contract-worker';
    await withTenant(migrate, tenantId, async (db) => db.query("UPDATE runs.steps SET state='CLAIMED',attempt=1,fencing_token=1,lease_owner=$3,lease_expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND run_id=$2 AND step_id=$4", [tenantId, plan.run_id, workerId, step.step_id]));
    const claim: StepClaim = { tenantId, runId: plan.run_id, stepId: step.step_id, workerId, attempt: 1, fencingToken: 1 };
    const result = await executeGoldenStep({ step, question: plan.question, connectorType: 'postgres', groupId: source.sourceGroupId });
    expect(await completeStep(worker, claim, { resultRef: 'golden://feedback/result', analyticResult: result })).toBe(true);
    expect(await finalizeAnalyticRun(worker, plan.run_id)).toBe('COMPLETED');

    const server = await buildServer({ pool: app, sessionSecret: 's'.repeat(64), testAccounts: [
      { tenantId, email: `${tenantId}@synthetic.example` }, { tenantId, email: `${tenantId}-other@synthetic.example` },
    ] });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.example`, password: 'synthetic-password' } });
      const ownerCookie = String(login.headers['set-cookie']);
      const unauthorizedDefault = await server.inject({ method: 'PUT', url: '/api/me/agent', headers: { cookie: ownerCookie }, payload: { defaultSources: [source.connectionId], vocabulary: {}, savedPlanIds: [], answerStyle: 'concise' } });
      expect(unauthorizedDefault.statusCode).toBe(200);
      const correction = await server.inject({ method: 'POST', url: `/api/runs/${plan.run_id}/feedback`, headers: { cookie: ownerCookie }, payload: { verdict: 'not_useful', correction: { term: 'listed_count', meaning: 'catalog size' } } });
      expect(correction.statusCode).toBe(201);
      const thumbsUp = await server.inject({ method: 'POST', url: `/api/runs/${plan.run_id}/feedback`, headers: { cookie: ownerCookie }, payload: { verdict: 'useful' } });
      expect(thumbsUp.statusCode).toBe(201);
      const memory = await server.inject({ method: 'GET', url: '/api/me/agent', headers: { cookie: ownerCookie } });
      expect(memory.json()).toMatchObject({ memory: { corrections: [{ term: 'listed_count', meaning: 'catalog size' }], savedPlanIds: [plan.plan_id] } });
      const run = await server.inject({ method: 'GET', url: `/api/runs/${plan.run_id}`, headers: { cookie: ownerCookie } });
      expect(run.json()).toMatchObject({ answer: { answer: { bySource: [{ value: 12 }] }, presentation: { title: 'catalog size' } } });
      await withTenant(migrate, tenantId, async (db) => db.query("UPDATE core.entitlements SET allowed=false WHERE tenant_id=$1 AND principal_id=$2 AND resource_id=$3", [tenantId,ownerId,source.connectionId]));
      const refreshedMemory = await server.inject({ method: 'GET', url: '/api/me/agent', headers: { cookie: ownerCookie } });
      expect(refreshedMemory.json()).toMatchObject({ memory: { defaultSources: [] } });
      const revokedDefaultRun = await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: ownerCookie }, payload: { question: plan.question, sourceIds: [source.connectionId] } });
      expect(revokedDefaultRun.statusCode).toBe(403);
      const unsafe = await server.inject({ method: 'POST', url: `/api/runs/${plan.run_id}/feedback`, headers: { cookie: ownerCookie }, payload: { verdict: 'not_useful', correction: { term: 'customer', meaning: 'person 12345678901' } } });
      expect(unsafe.statusCode).toBe(400);
      const otherLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}-other@synthetic.example`, password: 'synthetic-password' } });
      const otherCookie = String(otherLogin.headers['set-cookie']);
      const forgedDefault = await server.inject({ method: 'PUT', url: '/api/me/agent', headers: { cookie: otherCookie }, payload: { defaultSources: [source.connectionId], vocabulary: {}, savedPlanIds: [], answerStyle: 'concise' } });
      expect(forgedDefault.statusCode).toBe(403);
      const otherMemory = await server.inject({ method: 'GET', url: '/api/me/agent', headers: { cookie: otherCookie } });
      expect(otherMemory.json()).toMatchObject({ memory: { corrections: [], savedPlanIds: [] } });
      const otherFeedback = await server.inject({ method: 'POST', url: `/api/runs/${plan.run_id}/feedback`, headers: { cookie: otherCookie }, payload: { verdict: 'useful' } });
      expect(otherFeedback.statusCode).toBe(404);
      const stored = await withTenant(migrate, tenantId, async (db) => {
        await db.query("SELECT set_config('app.principal_id',$1,true)",[ownerId]);
        const feedback=await db.query<{ verdict: string; question_hash: Buffer; correction: Record<string,string>|null }>('SELECT verdict,question_hash,correction FROM memory.feedback WHERE tenant_id=$1 ORDER BY created_at', [tenantId]);
        const evaluation=await db.query<{ expected_claims: unknown }>('SELECT expected_claims FROM memory.evaluation_cases WHERE tenant_id=$1 AND principal_id=$2', [tenantId,ownerId]);
        return{feedback,evaluation};
      });
      expect(stored.feedback.rows).toHaveLength(2);
      expect(stored.feedback.rows[0]!.question_hash).toHaveLength(32);
      expect(stored.feedback.rows[0]!.correction).toEqual({ term: 'listed_count', meaning: 'catalog size' });
      expect(stored.evaluation.rows).toHaveLength(1);
      expect(JSON.stringify(stored)).not.toContain(plan.question);
      const deleted = await server.inject({ method: 'DELETE', url: '/api/me/agent', headers: { cookie: ownerCookie } });
      expect(deleted.json()).toEqual({ deleted: true });
    } finally { await server.close(); }
  });
});
