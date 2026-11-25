import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

config({ path: '.env' });
function databaseUrl(key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE'): string {
  const value = process.env[key];
  if (!value) throw new Error(`${key} is required; conversation contract tests are never skipped`);
  const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE??'si_test'}`; return url.toString();
}
const appPool = new Pool({ connectionString: databaseUrl('DATABASE_URL') });
const adminPool = new Pool({ connectionString: databaseUrl('DATABASE_URL_MIGRATE') });
const suffix = randomUUID();
const tenantA = `s2-conversations-a-${suffix}`;
const tenantB = `s2-conversations-b-${suffix}`;
const ownerEmail = `owner-${suffix}@example.invalid`;
const memberEmail = `member-${suffix}@example.invalid`;
const password = 'Conversation-Test-Password-A1!';
let server: Awaited<ReturnType<typeof buildServer>>;
let ownerCookie = '';
let memberCookie = '';
let otherTenantCookie = '';
let sourceId = '';
const plannerPrompts: string[] = [];

describe('contract 1 S2 conversation history', () => {
  beforeAll(async () => {
    for (const [tenantId, users] of [[tenantA, [ownerEmail, memberEmail]], [tenantB, [ownerEmail]]] as const) {
      await withTenant(adminPool, tenantId, async (db) => {
        await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
        for (const email of users) await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), email.startsWith('owner') ? 'Owner' : 'Member']);
        await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)", [tenantId]);
      });
    }
    const ownerId = await withTenant(adminPool, tenantA, async (db) => (await db.query<{ user_id: string }>('SELECT user_id FROM core.users WHERE tenant_id=$1 AND email=$2', [tenantA, ownerEmail])).rows[0]!.user_id);
    const source = await activateConnection(appPool, { tenantId: tenantA, principalId: ownerId, connectorType: 'postgres' });
    sourceId = source.connectionId;
    await withTenant(adminPool, tenantA, (db) => db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)", [tenantA, ownerId, sourceId]));
    server = await buildServer({
      pool: appPool,
      sessionSecret: 's2-conversation-contract-session-secret-0123456789',
      testAccounts: [{ tenantId: tenantA, email: ownerEmail }, { tenantId: tenantA, email: memberEmail }, { tenantId: tenantB, email: ownerEmail }],
      testAnalyticPlanner: async (prompt) => { plannerPrompts.push(prompt); return null; },
    });
    const login = async (tenantId: string, email: string) => {
      const result = await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } });
      expect(result.statusCode).toBe(200);
      return String(result.headers['set-cookie']).split(';')[0]!;
    };
    ownerCookie = await login(tenantA, ownerEmail);
    memberCookie = await login(tenantA, memberEmail);
    otherTenantCookie = await login(tenantB, ownerEmail);
  });

  afterAll(async () => { await server?.close(); await appPool.end(); await adminPool.end(); });

  it('c1_conversations_are_owner_scoped_ordered_and_supply_same_thread_context', async () => {
    const created = await server.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: ownerCookie }, payload: {} });
    expect(created.statusCode).toBe(201);
    const conversationId = created.json<{ conversationId: string }>().conversationId;
    const secondCreated = await server.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: ownerCookie }, payload: {} });
    expect(secondCreated.statusCode).toBe(201);
    const newerConversationId = secondCreated.json<{ conversationId: string }>().conversationId;

    const firstQuestion = 'How many patients are in PostgreSQL?';
    const firstRunResponse = await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: ownerCookie }, payload: { question: firstQuestion, sourceIds: [sourceId], conversationId } });
    expect(firstRunResponse.statusCode).toBe(201);
    expect(firstRunResponse.json()).toMatchObject({ conversationId });
    const firstRunId = firstRunResponse.json<{ runId: string }>().runId;
    const persistedConversation = await withTenant(adminPool, tenantA, (db) => db.query<{ conversation_id:string }>('SELECT conversation_id FROM runs.runs WHERE tenant_id=$1 AND run_id=$2',[tenantA,firstRunId]));
    expect(persistedConversation.rows[0]?.conversation_id).toBe(conversationId);
    await withTenant(adminPool, tenantA, (db) => db.query("INSERT INTO runs.analytic_answers(tenant_id,run_id,status,answer) VALUES($1,$2,'COMPLETED',$3::jsonb)", [tenantA, firstRunId, JSON.stringify({ metric:'count',claims: [{ statement: 'There are 500 patients.' }],evidence:[],bySource:[],trust:{groupCount:1,sourceCount:1,joins:['group']} })]));
    await withTenant(adminPool, tenantA, (db) => db.query("INSERT INTO runs.model_provenance(tenant_id,run_id,call_purpose,model_name,input_tokens,output_tokens,typed_plan) VALUES($1,$2,'plan','test-model',41,9,$3::jsonb)",[tenantA,firstRunId,JSON.stringify([{kind:'count',table:'public.patients'}])]));
    const runDetail=await server.inject({method:'GET',url:`/api/runs/${firstRunId}`,headers:{cookie:ownerCookie}});
    expect(runDetail.json<{modelProvenance:Array<{model:string;inputTokens:number;typedPlan:unknown}>}>().modelProvenance).toEqual([expect.objectContaining({model:'test-model',inputTokens:41,typedPlan:[{kind:'count',table:'public.patients'}]})]);

    const followUp = 'and in SQL Server?';
    const followUpResponse = await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: ownerCookie }, payload: { question: followUp, sourceIds: [sourceId], conversationId } });
    expect(followUpResponse.statusCode).toBe(201);
    const otherThreadResponse = await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: ownerCookie }, payload: { question: 'A separate question', sourceIds: [sourceId], conversationId: newerConversationId } });
    expect(otherThreadResponse.statusCode).toBe(201);

    expect(plannerPrompts).toHaveLength(3);
    expect(plannerPrompts[0]).toContain(firstQuestion);
    expect(plannerPrompts[0]).not.toContain('There are 500 patients.');
    expect(plannerPrompts[1]).toContain(firstQuestion);
    expect(plannerPrompts[1]).toContain('There are 500 patients.');
    expect(plannerPrompts[1]).toContain(followUp);
    expect(plannerPrompts[2]).not.toContain(firstQuestion);

    const list = await server.inject({ method: 'GET', url: '/api/conversations', headers: { cookie: ownerCookie } });
    expect(list.statusCode).toBe(200);
    // Recent conversations list only real threads with at least one answer; the unanswered thread is not listed.
    expect(list.json<{ conversations: Array<{ conversationId: string; title: string }> }>().conversations).toEqual([
      expect.objectContaining({ conversationId, title: firstQuestion }),
    ]);
    const thread = await server.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers: { cookie: ownerCookie } });
    expect(thread.statusCode).toBe(200);
    expect(thread.json<{ turns: Array<{ question: string; answer: unknown }> }>().turns).toEqual([
      expect.objectContaining({ question: firstQuestion, answer: expect.objectContaining({ claims: [expect.objectContaining({ statement: 'There are 500 patients.' })] }) }),
      expect.objectContaining({ question: followUp }),
    ]);
    expect((await server.inject({ method: 'GET', url: '/api/conversations', headers: { cookie: memberCookie } })).json<{ conversations: unknown[] }>().conversations).toHaveLength(0);
    expect((await server.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers: { cookie: memberCookie } })).statusCode).toBe(404);
    expect((await server.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers: { cookie: otherTenantCookie } })).statusCode).toBe(404);
  });

  it('c1_a_duplicate_request_id_creates_one_conversation_and_one_run', async () => {
    const requestId = randomUUID();const question = `Idempotent question ${requestId}`;
    const send = () => server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: ownerCookie }, payload: { question, sourceIds: [sourceId], requestId } });
    // A double click sends the same request id twice at once.
    const [first, second] = await Promise.all([send(), send()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual(expect.arrayContaining([201]));
    for (const response of [first, second]) expect([200, 201, 409]).toContain(response.statusCode);
    const created = [first, second].find((response) => response.statusCode === 201)!.json<{ runId: string; conversationId: string }>();
    // A later replay of the same id returns the same run and conversation.
    const replay = await send();
    expect(replay.statusCode).toBe(200);
    expect(replay.json()).toMatchObject({ runId: created.runId, conversationId: created.conversationId, replayed: true });
    const stored = await withTenant(adminPool, tenantA, (db) => db.query<{ conversations: string; runs: string }>(
      `SELECT (SELECT count(*) FROM runs.conversations WHERE tenant_id=$1 AND title=$2)::text AS conversations,
              (SELECT count(*) FROM runs.runs r JOIN runs.analytic_plans p USING(tenant_id,run_id) WHERE r.tenant_id=$1 AND p.plan->>'question'=$2)::text AS runs`, [tenantA, question]));
    expect(stored.rows[0]).toEqual({ conversations: '1', runs: '1' });
    expect((await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: ownerCookie }, payload: { question, sourceIds: [sourceId], requestId: 'not-a-uuid' } })).statusCode).toBe(400);
  });
});
