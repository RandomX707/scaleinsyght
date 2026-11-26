import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { claimDiscovery, queueDiscovery, runNextDiscovery } from '@scaleinsyght/profiler';
import { hashPassword } from '@scaleinsyght/api/server';
import { createGoldenConnector, listGoldenSources } from '../support/golden-connectors.js';

// Bug 6 (test_emr on 4284): a real PostgreSQL profile failed silently. 9 large tables ran past the connector's query
// time limit while being sampled, and one failed table failed the whole profile, so nothing was saved and no reason was
// shown. Now a slow table is kept without samples or statistics, an unreadable object is skipped and counted, a
// connection failure stops the job with a reason code, and a worker killed mid-profile is replaced and the job finishes.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE' | 'DATABASE_URL_WORKER') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') });
const workerPool = new Pool({ connectionString: url('DATABASE_URL_WORKER') });
const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });

async function tenantWithConnection(prefix: string) {
  const tenantId = `${prefix}-${randomUUID()}`;
  const userId = await withTenant(migratePool, tenantId, async (db) => {
    await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
    return (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')])).rows[0]!.user_id;
  });
  const { connectionId } = await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' });
  const job = await withTenant(appPool, tenantId, (client) => queueDiscovery(client, tenantId, connectionId));
  return { tenantId, connectionId, jobId: job.jobId };
}
const jobRow = (tenantId: string, jobId: string) => withTenant(migratePool, tenantId, async (db) => (await db.query<{ state: string; phase: string | null; claim_token: number; profiled_count: number; planned_count: number | null; failure_code: string | null; limited_count: number; failed_count: number }>(
  'SELECT state,phase,claim_token,profiled_count,planned_count,failure_code,limited_count,failed_count FROM profiler.jobs WHERE tenant_id=$1 AND job_id=$2', [tenantId, jobId])).rows[0]!);

describe('contract 5 background profile resilience', () => {
  afterAll(async () => { await appPool.end(); await workerPool.end(); await migratePool.end(); });

  it('c5_a_worker_killed_mid_profile_is_replaced_and_the_profile_still_completes', async () => {
    const { tenantId, jobId } = await tenantWithConnection('killed-worker');
    const objects = (await createGoldenConnector(listGoldenSources().find((item) => item.type === 'postgres')!.id).discover({ mode: 'profile' })).objects.length;
    expect(objects).toBeGreaterThan(2);
    const start = () => {
      const child = spawn(process.execPath, ['--import', 'tsx', 'tests/support/discovery-worker.ts', tenantId, '1500'], { cwd: process.cwd(), stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, DISCOVERY_LEASE_MS: '3000' } });
      let output = ''; child.stdout.on('data', (chunk) => { output += String(chunk); }); child.stderr.on('data', (chunk) => { output += String(chunk); });
      return { child, exit: once(child, 'exit') as Promise<[number | null, NodeJS.Signals | null]>, output: () => output };
    };
    // The first worker claims the job and starts profiling; it is killed partway through.
    const first = start();
    for (let row = await jobRow(tenantId, jobId); !(row.phase === 'profiling' && row.profiled_count >= 1); row = await jobRow(tenantId, jobId)) await new Promise((resolve) => setTimeout(resolve, 200));
    first.child.kill('SIGKILL');
    expect(await first.exit).toEqual([null, 'SIGKILL']);
    const orphaned = await jobRow(tenantId, jobId);
    expect(orphaned).toMatchObject({ state: 'RUNNING', claim_token: 1 });
    expect(orphaned.profiled_count).toBeLessThan(objects);
    // A restarted worker reclaims it once the dead worker's lease runs out, and finishes the profile.
    await new Promise((resolve) => setTimeout(resolve, 3_500));
    const second = start();
    const [code] = await second.exit;
    expect(code, second.output()).toBe(0);
    expect(second.output()).toContain('{"ran":true}');
    expect(await jobRow(tenantId, jobId)).toMatchObject({ state: 'COMPLETED', phase: 'done', claim_token: 2, profiled_count: objects, failure_code: null });
    const assets = await withTenant(migratePool, tenantId, (db) => db.query("SELECT 1 FROM graph.assets WHERE tenant_id=$1 AND asset_type='dataset' AND active", [tenantId]));
    expect(assets.rowCount).toBe(objects);
  }, 120_000);

  it('c5_the_lease_is_kept_while_relationships_lineage_and_findings_are_mapped', async () => {
    // test_emr on 4284 (K10): after profiling, mapping relationships and IDs ran for minutes with the lease already
    // expired, so a second worker could have reclaimed a job that was still running.
    const { tenantId, jobId } = await tenantWithConnection('lease-kept');
    const inner = createGoldenConnector(listGoldenSources().find((item) => item.type === 'postgres')!.id);
    const slowAfter = new Proxy(inner, { get: (target, key) => key === 'viewDefinitions'
      ? async () => { await new Promise((resolve) => setTimeout(resolve, 5_000)); return []; }
      : (() => { const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value; })() });
    let done = false; const run = runNextDiscovery(workerPool, async () => slowAfter, tenantId, 2_000).then((value) => { done = true; return value; });
    let checked = 0;
    while (!done) {
      const row = await withTenant(migratePool, tenantId, async (db) => (await db.query<{ phase: string; live: boolean }>('SELECT phase,lease_expires_at>clock_timestamp() AS live FROM profiler.jobs WHERE tenant_id=$1 AND job_id=$2', [tenantId, jobId])).rows[0]!);
      if (row.phase === 'relationships') { expect(row.live).toBe(true); expect(await claimDiscovery(workerPool, undefined, tenantId)).toBeNull(); checked++; }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    expect(await run).toBe(true);
    expect(checked).toBeGreaterThan(4); // watched for over two lease lengths while relationships were mapped
    expect(await jobRow(tenantId, jobId)).toMatchObject({ state: 'COMPLETED', claim_token: 1 });
  }, 60_000);

  it('c7_a_table_too_slow_to_sample_is_kept_without_statistics_and_an_unreadable_one_is_skipped', async () => {
    // A real PostgreSQL view whose row count is instant but whose text column takes 0.4 s a row to read: sampling it runs
    // past the connector's 1-second time limit, as test_emr's large tables did.
    const schema = `slow_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
    await migratePool.query(`CREATE SCHEMA ${schema};
      CREATE FUNCTION ${schema}.slow_text(n int) RETURNS text LANGUAGE plpgsql STABLE AS $$ BEGIN PERFORM pg_sleep(0.4); RETURN 'note ' || n; END $$;
      CREATE VIEW ${schema}.slow_notes AS SELECT n, ${schema}.slow_text(n) AS note FROM generate_series(1,5) n;
      CREATE TABLE ${schema}.quick (id integer PRIMARY KEY, label text); INSERT INTO ${schema}.quick SELECT n, 'label ' || n FROM generate_series(1,20) n;`);
    try {
      const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 1000, id: 'slow-source', name: 'Slow source' });
      // Only this schema's objects, plus one the login may not read.
      const connector = new Proxy(real, { get: (target, key) => {
        if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => {
          const found = await target.discover(input); const mine = found.objects.filter((object) => object.qualifiedName.startsWith(`${schema}.`));
          return { ...found, objects: [...mine, { ...mine[0]!, qualifiedName: `${schema}.secret`, assetKey: 'secret-key' }], unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: mine.length + 1, accessible: mine.length + 1, inaccessible: 0 } };
        };
        if (key === 'profile') return async (assetKey: string, ...rest: unknown[]) => {
          if (assetKey === 'secret-key') throw Object.assign(new Error('permission denied for table secret'), { code: '42501' });
          return (target.profile as (...a: unknown[]) => unknown)(assetKey, ...rest);
        };
        if (key === 'structuralReferences') return async () => [];
        const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
      } }) as ReadOnlyConnector;
      const slow = await real.discover({ mode: 'profile' }).then((found) => found.objects.find((object) => object.qualifiedName === `${schema}.slow_notes`)!);
      const profile = await real.profile(slow.assetKey, undefined, 'profile');
      expect(profile).toMatchObject({ limited: 'timeout', rowCount: 5 });
      expect(profile.columns.map((column) => column.name)).toEqual(['n', 'note']);
      expect(profile.columns.every((column) => column.statistics.distinctCount === null && column.statistics.nullRate === null)).toBe(true);

      const { tenantId, jobId } = await tenantWithConnection('slow-tables');
      expect(await runNextDiscovery(workerPool, async () => connector, tenantId)).toBe(true);
      expect(await jobRow(tenantId, jobId)).toMatchObject({ state: 'COMPLETED', limited_count: 1, failed_count: 1, profiled_count: 2, failure_code: null }); // profiled excludes the skipped object
      const objects = await withTenant(migratePool, tenantId, (db) => db.query<{ object_name: string; state: string }>('SELECT object_name,state FROM profiler.job_objects WHERE tenant_id=$1 AND job_id=$2 ORDER BY object_name', [tenantId, jobId]));
      expect(objects.rows).toEqual([{ object_name: `${schema}.quick`, state: 'COMPLETED' }, { object_name: `${schema}.secret`, state: 'FAILED' }, { object_name: `${schema}.slow_notes`, state: 'COMPLETED' }]);
      // The job closed the connector when it finished.
    } finally { await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); }
  }, 60_000);

  it('c5_a_connection_failure_stops_the_profile_with_a_plain_reason_code', async () => {
    const { tenantId, jobId } = await tenantWithConnection('unreachable');
    const inner = createGoldenConnector(listGoldenSources().find((item) => item.type === 'postgres')!.id);
    const broken = new Proxy(inner, { get: (target, key) => key === 'profile'
      ? async () => { throw Object.assign(new Error('connect ECONNREFUSED 10.0.0.9:5432'), { code: 'ECONNREFUSED' }); }
      : (() => { const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value; })() });
    expect(await runNextDiscovery(workerPool, async () => broken, tenantId)).toBe(true);
    expect(await jobRow(tenantId, jobId)).toMatchObject({ state: 'FAILED', failure_code: 'source_unreachable' });
    const stored = await withTenant(migratePool, tenantId, (db) => db.query('SELECT failure_code FROM profiler.jobs WHERE tenant_id=$1', [tenantId]));
    expect(JSON.stringify(stored.rows)).not.toContain('10.0.0.9');
  });
});
