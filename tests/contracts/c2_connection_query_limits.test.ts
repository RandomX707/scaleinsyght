import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import Fastify from 'fastify';
import { Pool } from 'pg';
import { expect, it, vi } from 'vitest';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { registerControlsRoutes } from '../../apps/api/src/controls.js';

config({path:'.env'});
const pool = (key: string) => {
  const url = new URL(process.env[key]!);
  url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`;
  return new Pool({connectionString:url.toString()});
};

it('isolates the profiling and analytic deadlines and lets only tenant admins change them', async () => {
  const app = Fastify();
  const db = pool('DATABASE_URL');
  const migrate = pool('DATABASE_URL_MIGRATE');
  const tenantId = `limits-${randomUUID()}`;
  vi.stubEnv('SOURCE_QUERY_TIMEOUT_MS','11000');
  vi.stubEnv('SOURCE_PROFILE_QUERY_TIMEOUT_MS','15000');
  vi.stubEnv('SOURCE_ANALYTIC_QUERY_TIMEOUT_MS',undefined);
  try {
    const [admin, member] = await withTenant(migrate, tenantId, async client => {
      await client.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)',[tenantId]);
      return (await client.query<{user_id:string}>(
        "INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,'fixture'),($1,$3,'fixture') RETURNING user_id",
        [tenantId,'admin@example.test','member@example.test'])).rows.map(row=>row.user_id);
    });
    await withTenant(migrate,tenantId,client=>client.query(
      "INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.admin',true)",
      [tenantId,admin]));
    const {connectionId} = await activateConnection(db,{tenantId,principalId:admin!,connectorType:'postgres'});
    registerControlsRoutes(app,db,async request=>({tenantId,userId:request.headers['x-member'] ? member! : admin!}));
    const url = `/api/connections/${connectionId}/query-limits`;
    const get = async () => (await app.inject({method:'GET',url})).json();
    const put = (payload:unknown, headers={}) => app.inject({method:'PUT',url,payload:JSON.stringify(payload),headers:{'content-type':'application/json',...headers}});
    expect(await get()).toEqual({profileMs:null,analyticMs:null,effectiveProfileMs:15000,effectiveAnalyticMs:11000});
    expect((await put({profileMs:22000,analyticMs:4200},{'x-member':'true'})).statusCode).toBe(403);
    expect((await put({profileMs:0,analyticMs:4200})).statusCode).toBe(400);
    expect((await put({profileMs:22000,analyticMs:4200})).json()).toEqual({profileMs:22000,analyticMs:4200,effectiveProfileMs:22000,effectiveAnalyticMs:4200});
    expect((await put({profileMs:null,analyticMs:4200})).statusCode).toBe(200);
    expect(await get()).toEqual({profileMs:null,analyticMs:4200,effectiveProfileMs:15000,effectiveAnalyticMs:4200});
  } finally {
    vi.unstubAllEnvs();
    await app.close();
    await Promise.all([db.end(),migrate.end()]);
  }
});
