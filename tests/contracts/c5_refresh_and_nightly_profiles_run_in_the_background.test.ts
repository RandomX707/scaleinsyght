import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildServer, hashPassword } from '@scaleinsyght/api/server';
import { withTenant } from '@scaleinsyght/db';
import { queueDueNightly, runNextDiscovery } from '@scaleinsyght/profiler';
import type { ReadOnlyConnector } from '@scaleinsyght/connectors';
import { createGoldenConnector, listGoldenSources } from '../support/golden-connectors.js';

// K10: "Run a refresh now", "Run profile now" and the scheduled nightly refresh ran their profile inside the request or
// inline in the worker's step loop. Like activation (decision 57), each is now a background job: the request returns at
// once, a repeat returns the open job, and the scheduled refresh is queued rather than run inline.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE' | 'DATABASE_URL_WORKER') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') });
const workerPool = new Pool({ connectionString: url('DATABASE_URL_WORKER') });
const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const source = listGoldenSources().find((item) => item.type === 'postgres')!;
/** The golden source, with reading its catalog slowed: every profile type (discovery, profile now, nightly) reads it. */
const slow = (pauseMs: number): ReadOnlyConnector => new Proxy(createGoldenConnector(source.id), { get: (target, key) => key === 'discover'
  ? async (...args: Parameters<ReadOnlyConnector['discover']>) => { await new Promise((resolve) => setTimeout(resolve, pauseMs)); return target.discover(...args); }
  : (() => { const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value; })() });

describe('contract 5 background refresh', () => {
  afterAll(async () => { await appPool.end(); await workerPool.end(); await migratePool.end(); });

  it('c5_refresh_and_run_profile_now_return_at_once_share_one_open_job_and_the_nightly_is_queued', async () => {
    const tenantId = `refresh-${randomUUID()}`; const email = `${tenantId}@synthetic.example`; const password = 'synthetic-password';
    await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      await db.query('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3)', [tenantId, email, hashPassword(password)]);
    });
    const server = await buildServer({ pool: appPool, sessionSecret: randomUUID() + randomUUID(), testAccounts: [{ tenantId, email }],
      testSources: [{ id: source.id, type: source.type, name: source.name }], testConnectorFor: (id) => id === source.id ? slow(0) : null });
    try {
      const cookie = String((await server.inject({ method: 'POST', url: '/api/auth/login', payload: { tenantId, email, password } })).headers['set-cookie']).split(';')[0]!;
      const connectionId = (await server.inject({ method: 'POST', url: '/api/connections', headers: { cookie }, payload: { sourceId: source.id } })).json<{ connectionId: string }>().connectionId;
      expect((await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/activate`, headers: { cookie }, payload: { scope: [] } })).statusCode).toBe(200);
      expect(await runNextDiscovery(workerPool, async () => slow(0), tenantId)).toBe(true);

      // Run a refresh now, twice at once: both return at once with the same queued job.
      const refresh = () => server.inject({ method: 'POST', url: `/api/connections/${connectionId}/discover`, headers: { cookie }, payload: { jobType: 'nightly' } });
      const started = Date.now(); const [a, b] = await Promise.all([refresh(), refresh()]);
      expect(Date.now() - started).toBeLessThan(5_000);
      expect([a.statusCode, b.statusCode]).toEqual([202, 202]);
      expect(a.json<{ jobId: string }>().jobId).toBe(b.json<{ jobId: string }>().jobId);
      expect([a.json<{ queued: boolean }>().queued, b.json<{ queued: boolean }>().queued].sort()).toEqual([false, true]);
      // Run profile now while that refresh is open: the open job is returned, not a second one.
      const now = await server.inject({ method: 'POST', url: `/api/connections/${connectionId}/profile-jobs`, headers: { cookie } });
      expect(now.json<{ jobId: string }>().jobId).toBe(a.json<{ jobId: string }>().jobId);

      // The worker runs it slowly; the Profile page reads its live progress meanwhile.
      const runStarted = Date.now();
      let finished = false; const run = runNextDiscovery(workerPool, async () => slow(20_000), tenantId).then((value) => { finished = true; return value; });
      let seenRunning = false;
      while (!finished) {
        const profile = (await server.inject({ method: 'GET', url: `/api/connections/${connectionId}/profile`, headers: { cookie } })).json<{ profile: { job_id: string; job_type: string; state: string } }>().profile;
        if (profile.state === 'RUNNING' && profile.job_id === a.json<{ jobId: string }>().jobId) { seenRunning = true; expect(profile.job_type).toBe('nightly'); }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(await run).toBe(true); expect(seenRunning).toBe(true);
      expect(Date.now() - runStarted).toBeGreaterThan(20_000); // the refresh itself took over 20 s; the requests above took under 5 s
      const jobs = await withTenant(migratePool, tenantId, (db) => db.query<{ job_type: string; state: string; scheduled: boolean }>('SELECT job_type,state,scheduled FROM profiler.jobs WHERE tenant_id=$1 ORDER BY created_at', [tenantId]));
      expect(jobs.rows).toEqual([{ job_type: 'discovery', state: 'COMPLETED', scheduled: false }, { job_type: 'nightly', state: 'COMPLETED', scheduled: false }]);

      // The scheduled nightly is queued as a background job (not run inline), flagged scheduled, and runs the same way.
      await withTenant(migratePool, tenantId, (db) => db.query("UPDATE profiler.nightly_schedules SET next_run_at=clock_timestamp()-interval '1 minute' WHERE tenant_id=$1", [tenantId]));
      let due = await queueDueNightly(workerPool);
      while (due && due.tenantId !== tenantId) due = await queueDueNightly(workerPool);
      expect(due).toMatchObject({ tenantId, connectionId, state: 'QUEUED', queued: true });
      expect(await runNextDiscovery(workerPool, async () => slow(0), tenantId)).toBe(true);
      const scheduled = await withTenant(migratePool, tenantId, (db) => db.query<{ state: string; scheduled: boolean }>("SELECT state,scheduled FROM profiler.jobs WHERE tenant_id=$1 AND job_id=$2", [tenantId, due!.jobId]));
      expect(scheduled.rows[0]).toEqual({ state: 'COMPLETED', scheduled: true });
    } finally { await server.close(); }
  }, 180_000);
});
