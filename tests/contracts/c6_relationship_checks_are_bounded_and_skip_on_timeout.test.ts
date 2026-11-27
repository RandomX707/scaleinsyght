import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool, type PoolClient } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, REFERENCE_CHECK_SAMPLE, withSkippedChecks, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { hashPassword } from '@scaleinsyght/api/server';

// Decision 63 (test_emr, 27 Nov 2026): checking an inferred relationship joined the whole source table to the target,
// one candidate after another. On tens of millions of rows one check ran past the source's 10-second limit and the
// whole profile failed after its tables were sampled, twice in a row. Now each check reads at most
// REFERENCE_CHECK_SAMPLE source values and looks each up in the target's primary key; a check that still times out
// skips that candidate and is counted, and the profile completes.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => {
  const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`);
  const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString();
};
const appPool = new Pool({ connectionString: url('DATABASE_URL') });
const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const schema = `refs_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const mine = (name: string) => name.startsWith(`${schema}.`);
type References = Awaited<ReturnType<NonNullable<ReadOnlyConnector['structuralReferences']>>>;

/** The real connector with a short statement limit, seeing only this test's schema. */
function scoped(): ReadOnlyConnector {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 1_500 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => { const found = await target.discover(input); const objects = found.objects.filter((object) => mine(object.qualifiedName));
      return { ...found, objects, unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: objects.length, accessible: objects.length, inaccessible: 0 } }; };
    if (key === 'structuralReferences') return async (scope: Parameters<NonNullable<ReadOnlyConnector['structuralReferences']>>[0]) => {
      const found = await target.structuralReferences!(scope); return withSkippedChecks(found.filter((item) => mine(item.from)), found.skippedChecks ?? 0); };
    if (key === 'routines' || key === 'viewDefinitions' || key === 'objectOrigins') return async () => [];
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
}
/** Holds an exclusive lock on one target table while `work` runs, so that table's check waits past the limit. */
async function whileLocked<T>(table: string, work: () => Promise<T>): Promise<T> {
  const holder: PoolClient = await migratePool.connect();
  try { await holder.query('BEGIN'); await holder.query(`LOCK TABLE ${schema}.${table} IN ACCESS EXCLUSIVE MODE`); return await work(); }
  finally { await holder.query('ROLLBACK'); holder.release(); }
}

describe('contract 6 relationship checks are bounded', () => {
  beforeAll(async () => {
    await migratePool.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.wards(ward_id integer PRIMARY KEY);
      INSERT INTO ${schema}.wards SELECT g FROM generate_series(1, 20000) g;
      CREATE TABLE ${schema}.stays(stay_ref integer, ward_id integer);
      INSERT INTO ${schema}.stays SELECT g, 1 + g % 20000 FROM generate_series(1, 15000) g;
      CREATE TABLE ${schema}.beds(bed_id integer PRIMARY KEY);
      INSERT INTO ${schema}.beds SELECT g FROM generate_series(1, 40) g;
      CREATE TABLE ${schema}.moves(move_ref integer, bed_id integer);
      INSERT INTO ${schema}.moves SELECT g, 1 + g % 40 FROM generate_series(1, 30) g;
      ANALYZE ${schema}.wards; ANALYZE ${schema}.stays; ANALYZE ${schema}.beds; ANALYZE ${schema}.moves;`);
  });
  afterAll(async () => { await migratePool.query(`DROP SCHEMA ${schema} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_a_relationship_check_reads_a_bounded_sample_of_a_large_column', async () => {
    const connector = scoped();
    try {
      const found: References = await connector.structuralReferences!();
      const stays = found.find((item) => item.from === `${schema}.stays` && item.fromColumn === 'ward_id');
      expect(stays).toMatchObject({ to: `${schema}.wards`, evidenceMethod: 'inferred', sourceCount: REFERENCE_CHECK_SAMPLE, matchedCount: REFERENCE_CHECK_SAMPLE, sampled: true });
      // A column smaller than the sample is checked whole.
      expect(found.find((item) => item.from === `${schema}.moves`)).toMatchObject({ to: `${schema}.beds`, sourceCount: 30, matchedCount: 30, sampled: false });
    } finally { await connector.close?.(); }
  });

  it('c6_a_relationship_check_that_times_out_skips_that_candidate_and_the_profile_completes', async () => {
    const tenantId = `refs-${randomUUID()}`;
    const userId = await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      return (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')])).rows[0]!.user_id;
    });
    const { connectionId } = await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' });
    const connector = scoped();
    try {
      // Profile the tables first, then hold the lock only for the relationship step, as on test_emr.
      const real = connector.structuralReferences!.bind(connector);
      const locked = new Proxy(connector, { get: (target, key) => key === 'structuralReferences'
        ? (scope: Parameters<NonNullable<ReadOnlyConnector['structuralReferences']>>[0]) => whileLocked('beds', () => real(scope))
        : Reflect.get(target, key, target) }) as ReadOnlyConnector;
      const summary = await runProfile(appPool, { tenantId, connectionId, connector: locked, jobType: 'discovery' });
      expect(summary.profiled).toBe(4);
      const stored = await withTenant(migratePool, tenantId, async (db) => (await db.query<{ from_name: string; explanation: string }>(
        `SELECT f.qualified_name AS from_name, s.explanation FROM graph.relationships r JOIN graph.assets f ON f.tenant_id=r.tenant_id AND f.asset_id=r.from_asset_id
           JOIN graph.assertions s ON s.tenant_id=r.tenant_id AND s.relationship_id=r.relationship_id AND s.valid_to IS NULL
          WHERE r.tenant_id=$1 AND s.evidence_method='inferred' ORDER BY 1`, [tenantId])).rows);
      // The locked candidate (moves.bed_id to beds) is skipped; the large one is kept with the sample stated.
      expect(stored.map((row) => row.from_name)).toEqual([`${schema}.stays.ward_id`]);
      expect(stored[0]!.explanation).toBe(`Checked on a sample of ${REFERENCE_CHECK_SAMPLE} non-null values: ${REFERENCE_CHECK_SAMPLE} of them matched the target primary key.`);
      const completed = await withTenant(migratePool, tenantId, async (db) => (await db.query<{ payload: { relationship_checks_skipped?: number } }>(
        `SELECT safe_payload AS payload FROM profiler.events WHERE tenant_id=$1 AND event_type='profile_completed'`, [tenantId])).rows[0]!.payload);
      expect(completed.relationship_checks_skipped).toBe(1);
    } finally { await connector.close?.(); }
  }, 60_000);
});
