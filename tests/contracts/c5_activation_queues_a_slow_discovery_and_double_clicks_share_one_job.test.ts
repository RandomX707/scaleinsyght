import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { claimDiscovery, finishDiscovery, runNextDiscovery } from '@scaleinsyght/profiler';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { createGoldenConnector, listGoldenSources } from '../support/golden-connectors.js';

// Decision 57 (bug 5): activating a real database ran the whole discovery profile inside the HTTP request. On a real
// server that took minutes, the browser gave up, and a second click found the connection already active and failed with
// "connection draft not found". Activation now queues the profile and returns at once; the worker runs it with live
// progress; a repeated or concurrent activation returns the same connection and job.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE' | 'DATABASE_URL_WORKER') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') });
const workerPool = new Pool({ connectionString: url('DATABASE_URL_WORKER') });
const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const source = listGoldenSources().find((item) => item.type === 'postgres')!;
const PROFILE_MS = 62_000; // the whole profile takes longer than a minute

/** The golden source, with every object's profile slowed so the profile as a whole runs past a minute. */
function slow(objects: number): ReadOnlyConnector {
  const inner = createGoldenConnector(source.id);
  const pause = Math.ceil(PROFILE_MS / Math.max(1, objects));
  return { ...inner, id: inner.id, type: inner.type, name: inner.name, modelRequests: inner.modelRequests,
    test: () => inner.test(), discover: (input) => inner.discover(input),
    profile: async (assetKey, scope, mode) => { await new Promise((resolve) => setTimeout(resolve, pause)); return inner.profile(assetKey, scope, mode); },
    ...(inner.structuralReferences ? { structuralReferences: (scope) => inner.structuralReferences!(scope) } : {}) } as ReadOnlyConnector;
}

describe('contract 5 background discovery', () => {
  afterAll(async () => { await appPool.end(); await workerPool.end(); await migratePool.end(); });

  it('c5_activation_returns_before_a_minute_long_profile_double_clicks_share_one_job_and_progress_is_live', async () => {
    const objects = (await createGoldenConnector(source.id).discover({ mode: 'profile' })).objects.length;
    expect(objects).toBeGreaterThan(0);
    const tenantId = `slow-discovery-${randomUUID()}`; const email = `${tenantId}@synthetic.example`; const password = 'synthetic-password';
    await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, email, hashPassword(password)]);
    });
    const server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }],
      testSources: [{ id: source.id, type: source.type, name: source.name }], testConnectorFor: (id) => id === source.id ? slow(objects) : null });
    try {
      const cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
      const connectionId = (await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { sourceId: source.id } })).json<{ connectionId: string }>().connectionId;
      const activate = () => server.inject({ method: 'POST', url: `/api/connections/${connectionId}/activate`, headers: { cookie }, payload: { scope: [] } });

      // A double click: two activations at once. Both return at once, with the same connection, agent and one job.
      const started = Date.now();
      const [first, second] = await Promise.all([activate(), activate()]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect([first.statusCode, second.statusCode]).toEqual([200, 200]);
      const a = first.json<{ connectionId: string; agentId: string; jobId: string; jobState: string }>(); const b = second.json<typeof a>();
      expect(b).toEqual(a);
      expect(a.jobState).toBe('QUEUED');
      expect(JSON.stringify([first.json(), second.json()])).not.toMatch(/draft/);
      const jobs = await withTenant(migratePool, tenantId, (db) => db.query<{ state: string }>("SELECT state FROM profiler.jobs WHERE tenant_id=$1 AND job_type='discovery'", [tenantId]));
      expect(jobs.rows).toEqual([{ state: 'QUEUED' }]);

      // The worker runs it; meanwhile the Profile page reads real progress, and a later click still gets the same job.
      const run = runNextDiscovery(workerPool, async () => slow(objects), tenantId);
      const seen = new Set<string>(); let profiledSeen = 0;
      const profile = async () => (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/profile`, headers: { cookie } })).json<{ profile: { job_id: string; state: string; phase: string; planned_count: number | null; profiled_count: number } }>().profile;
      let finished = false; void run.then(() => { finished = true; });
      while (!finished) {
        const now = await profile(); seen.add(`${now.state}:${now.phase}`);
        if (now.phase === 'profiling') { expect(now.planned_count).toBe(objects); profiledSeen = Math.max(profiledSeen, now.profiled_count); }
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
      expect(await run).toBe(true);
      const again = await activate();
      expect(again.statusCode).toBe(200); expect(again.json()).toMatchObject({ connectionId, jobId: a.jobId });
      const done = await profile();
      expect(done).toMatchObject({ job_id: a.jobId, state: 'COMPLETED', phase: 'done', profiled_count: objects });
      expect(seen.has('RUNNING:profiling')).toBe(true);
      expect(profiledSeen).toBeGreaterThan(0); // progress was visible while it ran, not only at the end
      expect(Date.now() - started).toBeGreaterThan(PROFILE_MS);
      expect(await claimDiscovery(workerPool, undefined, tenantId)).toBeNull(); // nothing left to run, and no second job was queued
    } finally { await server.close(); }
  }, 240_000);

  it('c5_a_worker_that_lost_its_lease_cannot_write_and_the_job_is_reclaimed', async () => {
    const tenantId = `lease-discovery-${randomUUID()}`;
    const userId = await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      return (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')])).rows[0]!.user_id;
    });
    const { connectionId } = await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' });
    await withTenant(migratePool, tenantId, (db) => db.query("INSERT INTO profiler.jobs(tenant_id,connection_id,job_type,state,phase) VALUES($1,$2,'discovery','QUEUED','queued')", [tenantId, connectionId]));
    const firstClaim = (await claimDiscovery(workerPool, 1, tenantId))!; // a one-millisecond lease, so it lapses at once
    expect(firstClaim).toMatchObject({ tenantId, connectionId, token: 1 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const secondClaim = (await claimDiscovery(workerPool, undefined, tenantId))!;
    expect(secondClaim).toMatchObject({ jobId: firstClaim.jobId, token: 2 });
    // The first worker comes back: none of its writes land.
    expect(await finishDiscovery(workerPool, firstClaim, { state: 'COMPLETED' })).toBe(false);
    expect(await finishDiscovery(workerPool, secondClaim, { state: 'FAILED', failureCode: 'discovery_failed' })).toBe(true);
    const row = await withTenant(migratePool, tenantId, (db) => db.query('SELECT state,failure_code,claim_token FROM profiler.jobs WHERE tenant_id=$1', [tenantId]));
    expect(row.rows).toEqual([{ state: 'FAILED', failure_code: 'discovery_failed', claim_token: 2 }]);
  });
});
