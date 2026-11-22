import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { activateConnection } from '@scaleinsyght/registry';
import { withTenant } from '@scaleinsyght/db';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; PostgreSQL contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') });
const migrate = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });

describe('contract 3 authenticated analytic run routes', () => {
  afterAll(async () => { await appPool.end(); await migrate.end(); });
  it('c1_analytic_request_uses_session_tenant_and_rechecks_source_authorization', async () => {
    const tenantId = `analytic-api-${crypto.randomUUID()}`;
    let principalId = ''; let secondId = '';
    await withTenant(migrate, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      principalId = (await db.query<{ user_id: string }>(
        'INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id',
        [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')],
      )).rows[0]!.user_id;
      secondId = (await db.query<{ user_id: string }>(
        'INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id',
        [tenantId, `${tenantId}-other@synthetic.example`, hashPassword('synthetic-password')],
      )).rows[0]!.user_id;
      await db.query(`INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)`, [tenantId]);
    });
    const source = await activateConnection(appPool, { tenantId, principalId, connectorType: 'postgres' });
    await withTenant(migrate, tenantId, async (db) => {
      await db.query(`INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)`, [tenantId, principalId, source.connectionId]);
    });
    const server = await buildServer({ pool: appPool, sessionSecret: 's'.repeat(64), goldenAccounts: [
      { tenantId, email: `${tenantId}@synthetic.example` }, { tenantId, email: `${tenantId}-other@synthetic.example` },
    ] });
    try {
      const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.example`, password: 'synthetic-password' } });
      const cookie = login.headers['set-cookie']; expect(login.statusCode).toBe(200); expect(cookie).toBeTruthy();
      const created = await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: String(cookie) }, payload: {
        question: 'Compare synthetic profile counts', sourceIds: [source.connectionId], tenantId: 'forged-tenant', principalId: secondId,
      } });
      expect(created.statusCode).toBe(201);
      const { runId } = created.json() as { runId: string };
      const run = await server.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: String(cookie) } });
      expect(run.statusCode).toBe(200); expect(run.json()).toMatchObject({ runId, state: 'RUNNING' });
      const first = await server.inject({ method: 'GET', url: `/api/runs/${runId}/events`, headers: { cookie: String(cookie) } });
      const events = (first.json() as { events: Array<{ sequence: number }> }).events;
      expect(first.statusCode).toBe(200); expect(events.length).toBeGreaterThan(0);
      const resumed = await server.inject({ method: 'GET', url: `/api/runs/${runId}/events?after=2`, headers: { cookie: String(cookie) } });
      expect((resumed.json() as { events: Array<{ sequence: number }> }).events.every((event) => event.sequence > 2)).toBe(true);
      const otherLogin = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}-other@synthetic.example`, password: 'synthetic-password' } });
      const otherCookie = otherLogin.headers['set-cookie'];
      const hidden = await server.inject({ method: 'GET', url: `/api/runs/${runId}`, headers: { cookie: String(otherCookie) } });
      expect(hidden.statusCode).toBe(404);
    } finally { await server.close(); }
  });
});
