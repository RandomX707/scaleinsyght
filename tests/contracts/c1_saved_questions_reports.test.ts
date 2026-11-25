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
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString();
}
const app = new Pool({ connectionString: testUrl('DATABASE_URL') });
const worker = new Pool({ connectionString: testUrl('DATABASE_URL_WORKER') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 1 saved question ownership and revalidation', () => {
  afterAll(async () => { await app.end(); await worker.end(); await migrate.end(); });
  it('c1_saved_questions_are_private_deletable_and_revalidated_before_reuse', async () => {
    const tenantId = `saved-question-${crypto.randomUUID()}`;
    let ownerId = '';
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
    const step = plan.steps[0]!;
    await withTenant(migrate, tenantId, async (db) => db.query("UPDATE runs.steps SET state='CLAIMED',attempt=1,fencing_token=1,lease_owner='saved-question-test',lease_expires_at=clock_timestamp()+interval '1 minute' WHERE tenant_id=$1 AND run_id=$2 AND step_id=$3", [tenantId, plan.run_id, step.step_id]));
    const claim: StepClaim = { tenantId, runId: plan.run_id, stepId: step.step_id, workerId: 'saved-question-test', attempt: 1, fencingToken: 1 };
    const result = await executeGoldenStep({ step, question: plan.question, connectorType: 'postgres', groupId: source.sourceGroupId });
    expect(await completeStep(worker, claim, { resultRef: 'golden://saved-question/result', analyticResult: result })).toBe(true);
    expect(await finalizeAnalyticRun(worker, plan.run_id)).toBe('COMPLETED');

    const server = await buildServer({ pool: app, sessionSecret: 's'.repeat(64), testAccounts: [
      { tenantId, email: `${tenantId}@synthetic.example` }, { tenantId, email: `${tenantId}-other@synthetic.example` },
    ] });
    try {
      const ownerLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.example`, password: 'synthetic-password' } });
      const ownerCookie = String(ownerLogin.headers['set-cookie']);
      const otherLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}-other@synthetic.example`, password: 'synthetic-password' } });
      const otherCookie = String(otherLogin.headers['set-cookie']);
      await server.inject({ method: 'POST', url: `/api/runs/${plan.run_id}/feedback`, headers: { cookie: ownerCookie }, payload: { verdict: 'useful' } });

      const ownerList = await server.inject({ method: 'GET', url: '/api/me/saved-questions', headers: { cookie: ownerCookie } });
      expect(ownerList.statusCode).toBe(200);
      expect(ownerList.json().questions).toHaveLength(1);
      expect(ownerList.json().questions[0]).toMatchObject({ planId: plan.plan_id, question: plan.question });
      const otherList = await server.inject({ method: 'GET', url: '/api/me/saved-questions', headers: { cookie: otherCookie } });
      expect(otherList.json().questions).toHaveLength(0);

      await withTenant(migrate, tenantId, async (db) => db.query("UPDATE core.entitlements SET allowed=false WHERE tenant_id=$1 AND principal_id=$2 AND resource_id=$3", [tenantId, ownerId, source.connectionId]));
      const revokedReuse = await server.inject({ method: 'POST', url: `/api/me/saved-questions/${plan.plan_id}/start`, headers: { cookie: ownerCookie } });
      expect(revokedReuse.statusCode).toBe(403);
      await withTenant(migrate, tenantId, async (db) => db.query("UPDATE core.entitlements SET allowed=true WHERE tenant_id=$1 AND principal_id=$2 AND resource_id=$3", [tenantId, ownerId, source.connectionId]));
      const reused = await server.inject({ method: 'POST', url: `/api/me/saved-questions/${plan.plan_id}/start`, headers: { cookie: ownerCookie } });
      expect(reused.statusCode).toBe(201);
      expect(reused.json().runId).not.toBe(plan.run_id);

      const removed = await server.inject({ method: 'DELETE', url: `/api/me/saved-questions/${plan.plan_id}`, headers: { cookie: ownerCookie } });
      expect(removed.statusCode).toBe(200);
      expect((await server.inject({ method: 'GET', url: '/api/me/saved-questions', headers: { cookie: ownerCookie } })).json().questions).toHaveLength(0);
      const noLongerSaved = await server.inject({ method: 'POST', url: `/api/me/saved-questions/${plan.plan_id}/start`, headers: { cookie: ownerCookie } });
      expect(noLongerSaved.statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
