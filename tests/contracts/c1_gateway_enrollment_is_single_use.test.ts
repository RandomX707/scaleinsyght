import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { config } from 'dotenv';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { createAnalyticPlan } from '@scaleinsyght/analytic';
import { activateConnection } from '@scaleinsyght/registry';

config({ path: '.env' });
function testUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; gateway contract tests are never skipped`);
  const url = new URL(value); url.pathname = '/si_test'; return url.toString();
}
const tenantId = `gateway-contract-${randomUUID()}`;
let sourceId = '';
const appPool = new Pool({ connectionString: testUrl('DATABASE_URL') });
const adminPool = new Pool({ connectionString: testUrl('DATABASE_URL_MIGRATE') });
let server: Awaited<ReturnType<typeof buildServer>>;
let sessionCookie = '';

describe('contract 1 and 5 customer gateway protocol', () => {
  beforeAll(async () => {
    await withTenant(adminPool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await db.query("INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)", [tenantId, `${tenantId}@synthetic.invalid`, hashPassword('synthetic-password')]);
    });
    const user = await withTenant(adminPool, tenantId, db => db.query<{user_id:string}>('SELECT user_id FROM core.users WHERE tenant_id=$1',[tenantId]));
    const userId=user.rows[0]!.user_id;
    await withTenant(adminPool,tenantId,db=>db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,allowed) VALUES($1,$2,'tenant.gateway.manage',true),($1,$2,'analytic.read',true)",[tenantId,userId]));
    const connection=await activateConnection(appPool,{tenantId,principalId:userId,connectorType:'postgres'});sourceId=connection.connectionId;
    server = await buildServer({ pool: appPool, sessionSecret: 'phase6-gateway-contract-session-secret-0123456789', goldenAccounts: [{ tenantId, email: `${tenantId}@synthetic.invalid` }] });
    const login = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { email: `${tenantId}@synthetic.invalid`, password: 'synthetic-password' } });
    sessionCookie = String(login.headers['set-cookie']).split(';')[0]!;
  });
  afterAll(async () => { await server?.close(); await appPool.end(); await adminPool.end(); });

  it('c1_gateway_enrollment_is_single_use_and_tenant_bound', async () => {
    const enrollment = await server.inject({ method: 'POST', url: '/api/gateways/enrollments', headers: { cookie: sessionCookie }, payload: { sourceConnectionId: sourceId } });
    expect(enrollment.statusCode).toBe(201);
    const token = enrollment.json<{token:string}>().token;
    const crossTenant = await server.inject({ method: 'POST', url: '/api/gateways/claim', payload: { tenantId: `${tenantId}-other`, token } });
    expect(crossTenant.statusCode).toBe(401);
    expect((await server.inject({ method: 'POST', url: '/api/gateways/claim', payload: { tenantId, token } })).statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/api/gateways/claim', payload: { tenantId, token } })).statusCode).toBe(401);
  });

  it('c5_gateway_claim_lease_and_result_replay_are_idempotent', async () => {
    const enrollment = await server.inject({ method: 'POST', url: '/api/gateways/enrollments', headers: { cookie: sessionCookie }, payload: { sourceConnectionId: sourceId } });
    expect(enrollment.statusCode).toBe(201);
    const token = enrollment.json<{token:string}>().token;
    const stored = await withTenant(appPool, tenantId, (db) => db.query<{token_hash:Buffer}>('SELECT token_hash FROM gateway.enrollments WHERE tenant_id=$1', [tenantId]));
    expect(stored.rows[0]!.token_hash.toString('hex')).not.toBe(token);
    const claim = await server.inject({ method: 'POST', url: '/api/gateways/claim', payload: { tenantId, token } });
    expect(claim.statusCode).toBe(201);
    expect((await server.inject({ method: 'POST', url: '/api/gateways/claim', payload: { tenantId, token } })).statusCode).toBe(401);
    const credential = claim.json<{credential:string}>().credential;
    expect((await server.inject({ method: 'POST', url: '/api/gateways/poll', headers: { authorization: `Bearer ${credential}` } })).json()).toEqual({ request: null });

    const plan = await createAnalyticPlan({ question: 'Count synthetic encounters', runId: randomUUID(), sources: [{ sourceId, agentId: randomUUID(), groupId: randomUUID(), groupVersion: 1 }] });
    const queued = await server.inject({ method: 'POST', url: '/api/gateways/requests', headers: { cookie: sessionCookie }, payload: { gatewayId: claim.json<{gatewayId:string}>().gatewayId, plan } });
    expect(queued.statusCode).toBe(202);
    const polls = await Promise.all([1,2].map(()=>server.inject({ method: 'POST', url: '/api/gateways/poll', headers: { authorization: `Bearer ${credential}` } })));
    const leased = polls.map(response=>response.json<{request:{requestId:string;fencingToken:string}|null}>().request).filter((value):value is {requestId:string;fencingToken:string}=>value!==null);
    expect(leased).toHaveLength(1);
    const request = leased[0]!;
    expect(request).not.toBeNull();
    await withTenant(adminPool,tenantId,db=>db.query("UPDATE gateway.requests SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE tenant_id=$1 AND request_id=$2",[tenantId,request.requestId]));
    const reclaimed=await server.inject({ method:'POST',url:'/api/gateways/poll',headers:{authorization:`Bearer ${credential}`} });
    const current=reclaimed.json<{request:{requestId:string;fencingToken:string}}>().request;
    expect(current.fencingToken).not.toBe(request.fencingToken);
    const stale=await server.inject({method:'POST',url:`/api/gateways/results/${request.requestId}`,headers:{authorization:`Bearer ${credential}`},payload:{requestId:request.requestId,fencingToken:request.fencingToken,aggregates:[{metric:'encounter_count',value:42}]}});
    expect(stale.statusCode).toBe(409);
    const result = { requestId: current.requestId, fencingToken: current.fencingToken, aggregates: [{ metric: 'encounter_count', value: 42 }] };
    const completed = await server.inject({ method: 'POST', url: `/api/gateways/results/${request.requestId}`, headers: { authorization: `Bearer ${credential}` }, payload: result });
    expect(completed.json()).toEqual({ status: 'completed' });
    const replay = await server.inject({ method: 'POST', url: `/api/gateways/results/${request.requestId}`, headers: { authorization: `Bearer ${credential}` }, payload: result });
    expect(replay.json()).toEqual({ status: 'replayed' });
    const raw = await server.inject({ method: 'POST', url: `/api/gateways/results/${request.requestId}`, headers: { authorization: `Bearer ${credential}` }, payload: { ...result, rows: [{ patient_id: 'synthetic' }] } });
    expect(raw.statusCode).toBe(400);
    const listed=await server.inject({method:'GET',url:'/api/gateways',headers:{cookie:sessionCookie}});
    expect(listed.json<{gateways:Array<{gatewayId:string}>}>().gateways.some(item=>item.gatewayId===claim.json<{gatewayId:string}>().gatewayId)).toBe(true);
    const revoked=await server.inject({method:'POST',url:`/api/gateways/${claim.json<{gatewayId:string}>().gatewayId}/revoke`,headers:{cookie:sessionCookie}});
    expect(revoked.json()).toMatchObject({status:'revoked'});
    expect((await server.inject({method:'POST',url:'/api/gateways/poll',headers:{authorization:`Bearer ${credential}`}})).statusCode).toBe(401);
  });
});
