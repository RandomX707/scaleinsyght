import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';

// Decision 56: a form-only follow-up ("as a table") reuses a stored answer. It creates no run, plan, source query or
// model call (contract 5), stores no result rows (contract 4, non-negotiable 9), and only the asker's own answered
// runs in the same conversation can be reshown (contract 1).
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`); const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString(); };
const app = new Pool({ connectionString: url('DATABASE_URL') }); const admin = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const tenantId = `display-turns-${randomUUID()}`; const password = 'Display-Turn-Password-A1!';
let server: Awaited<ReturnType<typeof buildServer>>; let owner = ''; let member = ''; let sourceId = ''; let plannerCalls = 0;

async function counts() {
  return withTenant(admin, tenantId, async (db) => (await db.query<{ runs: string; calls: string; results: string }>(
    `SELECT (SELECT count(*) FROM runs.runs WHERE tenant_id=$1)::text AS runs,(SELECT count(*) FROM runs.model_provenance WHERE tenant_id=$1)::text AS calls,
       (SELECT count(*) FROM runs.analytic_results WHERE tenant_id=$1)::text AS results`, [tenantId])).rows[0]!);
}

describe('contract 5 display turns', () => {
  beforeAll(async () => {
    await withTenant(admin, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      for (const email of ['owner@display.invalid', 'member@display.invalid']) await db.query('INSERT INTO core.users(tenant_id,email,password_hash,display_name) VALUES($1,$2,$3,$4)', [tenantId, email, hashPassword(password), email.split('@')[0]]);
      await db.query("INSERT INTO registry.capabilities(tenant_id,capability_id,active_version,effect_class,effect_safety,enabled) VALUES($1,'analytic.read',1,'READ','not_applicable',true)", [tenantId]);
    });
    const ownerId = await withTenant(admin, tenantId, async (db) => (await db.query<{ user_id: string }>("SELECT user_id FROM core.users WHERE tenant_id=$1 AND email='owner@display.invalid'", [tenantId])).rows[0]!.user_id);
    sourceId = (await activateConnection(app, { tenantId, principalId: ownerId, connectorType: 'postgres' })).connectionId;
    await withTenant(admin, tenantId, (db) => db.query("INSERT INTO core.entitlements(tenant_id,principal_id,capability_id,resource_id) VALUES($1,$2,'analytic.read',$3)", [tenantId, ownerId, sourceId]));
    server = await buildServer({ pool: app, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email: 'owner@display.invalid' }, { tenantId, email: 'member@display.invalid' }], testAnalyticPlanner: async () => { plannerCalls++; return null; } });
    const login = async (email: string) => String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
    owner = await login('owner@display.invalid'); member = await login('member@display.invalid');
  });
  afterAll(async () => { await server?.close(); await app.end(); await admin.end(); });

  it('c5_a_form_only_follow_up_reuses_the_stored_answer_without_a_run_query_or_model_call', async () => {
    const conversationId = (await server.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: owner }, payload: {} })).json<{ conversationId: string }>().conversationId;
    const runId = (await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: owner }, payload: { question: 'Orders per department', sourceIds: [sourceId], conversationId } })).json<{ runId: string }>().runId;
    const answer = { metric: 'grouped_join', claims: [{ statement: 'Twelve departments.' }], evidence: [], bySource: [{ sourceId, value: 0, rows: [{ group_value: 'Emergency', value: '388' }, { group_value: 'Imaging', value: '197' }] }] };
    await withTenant(admin, tenantId, async (db) => {
      await db.query("UPDATE runs.runs SET state='COMPLETED' WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId]);
      await db.query("INSERT INTO runs.analytic_answers(tenant_id,run_id,status,answer) VALUES($1,$2,'COMPLETED',$3::jsonb)", [tenantId, runId, JSON.stringify(answer)]);
    });
    const before = await counts(); const plannedBefore = plannerCalls;
    const created = await server.inject({ method: 'POST', url: `/api/conversations/${conversationId}/display-turns`, headers: { cookie: owner }, payload: { sourceRunId: runId, form: 'table', question: 'can you put that in a table' } });
    expect(created.statusCode).toBe(201);
    expect(await counts()).toEqual(before);
    expect(plannerCalls).toBe(plannedBefore);
    // The display turn holds no rows: only the run it reuses, the form and the person's wording.
    const stored = await withTenant(admin, tenantId, (db) => db.query('SELECT * FROM runs.conversation_display_turns WHERE tenant_id=$1', [tenantId]));
    expect(JSON.stringify(stored.rows)).not.toContain('Emergency');
    expect(Object.keys(stored.rows[0]!).sort()).toEqual(['conversation_id', 'created_at', 'display_turn_id', 'form', 'principal_id', 'question', 'size', 'source_run_id', 'tenant_id']);
    const thread = (await server.inject({ method: 'GET', url: `/api/conversations/${conversationId}`, headers: { cookie: owner } })).json<{ turns: Array<{ kind: string; form?: string; sourceRunId?: string }> }>().turns;
    expect(thread.map((turn) => turn.kind)).toEqual(['run', 'display']);
    expect(thread[1]).toMatchObject({ form: 'table', sourceRunId: runId });
  });

  it('c1_display_turns_reshow_only_the_askers_own_answered_runs_in_that_conversation', async () => {
    const conversationId = (await server.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: owner }, payload: {} })).json<{ conversationId: string }>().conversationId;
    const otherConversation = (await server.inject({ method: 'POST', url: '/api/conversations', headers: { cookie: owner }, payload: {} })).json<{ conversationId: string }>().conversationId;
    const runId = (await server.inject({ method: 'POST', url: '/api/runs', headers: { cookie: owner }, payload: { question: 'Patients', sourceIds: [sourceId], conversationId } })).json<{ runId: string }>().runId;
    const post = (cookie: string, conversation: string, payload: Record<string, unknown>) => server.inject({ method: 'POST', url: `/api/conversations/${conversation}/display-turns`, headers: { cookie }, payload });
    expect((await post(owner, conversationId, { sourceRunId: runId, form: 'table', question: 'table please' })).statusCode).toBe(404); // not answered
    await withTenant(admin, tenantId, async (db) => {
      await db.query("UPDATE runs.runs SET state='COMPLETED' WHERE tenant_id=$1 AND run_id=$2", [tenantId, runId]);
      await db.query("INSERT INTO runs.analytic_answers(tenant_id,run_id,status,answer) VALUES($1,$2,'COMPLETED','{\"bySource\":[]}'::jsonb)", [tenantId, runId]);
    });
    expect((await post(member, conversationId, { sourceRunId: runId, form: 'table', question: 'table please' })).statusCode).toBe(404);
    expect((await post(owner, otherConversation, { sourceRunId: runId, form: 'table', question: 'table please' })).statusCode).toBe(404);
    expect((await post(owner, conversationId, { sourceRunId: runId, form: 'top', question: 'top 3' })).statusCode).toBe(400); // a size is required
    expect((await post(owner, conversationId, { sourceRunId: runId, form: 'delete', question: 'x' })).statusCode).toBe(400);
    expect((await post(owner, conversationId, { sourceRunId: runId, form: 'top', size: 3, question: 'top 3' })).statusCode).toBe(201);
  });
});
