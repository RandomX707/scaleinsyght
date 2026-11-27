import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { createTenant } from '../../scripts/tenant-create.js';

// K11: the worker builds a new connector for every nightly run, so "unchanged" must come from what is stored, not from
// the connector's memory. Generic fixture: three tables in their own schema.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') }); const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `nightly_${randomUUID().replaceAll('-', '').slice(0, 10)}`; const mine = (name: string) => name.startsWith(`${schema}.`);
const tenantId = `nightly-${randomUUID()}`;
let connectionId = ''; let reads: string[] = [];
/** A new connector each time, as a new worker would build, limited to this test's schema. */
function freshConnector(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => { const found = await target.discover(input);
      const objects = found.objects.filter((object) => mine(object.qualifiedName)); const unchangedObjects = found.unchangedObjects.filter((object) => mine(object.qualifiedName));
      return { ...found, objects, unchangedObjects, unchanged: unchangedObjects.length, listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: objects.length + unchangedObjects.length, accessible: objects.length + unchangedObjects.length, inaccessible: 0 } }; };
    if (key === 'distinctValues') return async (...args: Parameters<NonNullable<ReadOnlyConnector['distinctValues']>>) => { reads.push(`${args[0]}.${args[1]}`); return target.distinctValues!(...args); };
    if (key === 'structuralReferences') return async (...args: unknown[]) => ((await (target.structuralReferences as (...a: unknown[]) => Promise<unknown[]>)(...args)) ?? []).filter((item) => JSON.stringify(item).includes(`${schema}.`));
    if (['routines', 'viewDefinitions', 'objectOrigins'].includes(String(key))) return async () => [];
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
}
async function run(jobType: 'profile' | 'nightly') {
  reads = []; const connector = freshConnector();
  try { return await runProfile(appPool, { tenantId, connectionId, connector, jobType }); } finally { await connector.close?.(); }
}

describe('contract 6 nightly refresh skips unchanged tables in a fresh worker (K11)', () => {
  beforeAll(async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${schema}; CREATE TABLE ${schema}.a(id integer PRIMARY KEY); CREATE TABLE ${schema}.b(id integer, a_id integer REFERENCES ${schema}.a(id)); CREATE TABLE ${schema}.c(id integer);
      INSERT INTO ${schema}.a VALUES (1),(2); INSERT INTO ${schema}.b VALUES (1, 1); INSERT INTO ${schema}.c VALUES (1),(2),(3);`);
    const { userId } = await createTenant(migratePool, { tenantId, name: 'Nightly', displayName: 'Nightly Tester', email: `owner@${tenantId}.test.invalid`, password: 'nightly-password-1' });
    connectionId = (await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' })).connectionId;
  }, 120_000);
  afterAll(async () => { await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_a_fresh_connector_skips_every_unchanged_table_then_profiles_only_the_changed_one', async () => {
    const first = await run('profile');
    expect(first.profiled).toBe(3);
    // The declared key (and anything inferred from matching values) makes identifier fields: each read once and fingerprinted.
    const idFields = [...reads].sort(); const inB = idFields.filter((name) => name.startsWith(`${schema}.b.`));
    expect(idFields).toEqual(expect.arrayContaining([`${schema}.a.id`, `${schema}.b.a_id`]));
    expect(first.ids).toMatchObject({ fingerprinted: idFields.length, reused: 0 });
    const quiet = await run('nightly');
    expect({ profiled: quiet.profiled, unchanged: quiet.unchanged }).toEqual({ profiled: 0, unchanged: 3 });
    // Unchanged tables keep their stored fingerprints: nothing is read again, and the stored value sets are unchanged.
    expect(quiet.ids).toMatchObject({ fingerprinted: 0, reused: idFields.length });
    expect(reads).toEqual([]);
    const fingerprints = () => withTenant(appPool, tenantId, async (client) => Number((await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM graph.id_fingerprints f JOIN graph.assets a ON a.tenant_id=f.tenant_id AND a.asset_id=f.asset_id WHERE f.tenant_id=$1 AND a.source_id=$2`, [tenantId, connectionId])).rows[0]!.n));
    const kept = await fingerprints(); expect(kept).toBeGreaterThan(0);
    await migratePool.query(`INSERT INTO ${schema}.b VALUES (2, 2)`);
    const changed = await run('nightly');
    expect({ profiled: changed.profiled, unchanged: changed.unchanged }).toEqual({ profiled: 1, unchanged: 2 });
    // Only the changed table's identifier field is read; the unchanged table's is reused.
    expect(changed.ids).toMatchObject({ fingerprinted: inB.length, reused: idFields.length - inB.length });
    expect([...reads].sort()).toEqual(inB);
    expect(await fingerprints()).toBeGreaterThan(kept); // b.a_id gained a value; every other field's set is as it was
    // The changed table got a new version with its new signature; the next quiet night skips all three again.
    const again = await run('nightly');
    expect({ profiled: again.profiled, unchanged: again.unchanged }).toEqual({ profiled: 0, unchanged: 3 });
  }, 300_000);
});
