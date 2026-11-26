import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { withTenant } from '@scaleinsyght/db';
import { activateConnection } from '@scaleinsyght/registry';
import { createPostgresConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';
import { runProfile } from '@scaleinsyght/profiler';
import { hashPassword } from '@scaleinsyght/api/server';

// Decision 61: a large table's identifier column is fingerprinted through a consistent sample; a small one whole. They
// still match, compared on the values the rule keeps, and the evidence says it was a sample.
config({ path: '.env' });
const url = (key: 'DATABASE_URL' | 'DATABASE_URL_MIGRATE') => { const value = process.env[key]; if (!value) throw new Error(`${key} is required; contract tests are never skipped`); const parsed = new URL(value); parsed.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return parsed.toString(); };
const appPool = new Pool({ connectionString: url('DATABASE_URL') });
const migratePool = new Pool({ connectionString: url('DATABASE_URL_MIGRATE') });
const tag = randomUUID().replaceAll('-', '').slice(0, 10);
const big = `idbig_${tag}`; const small = `idsmall_${tag}`;

/** The real connector, seeing only one schema. */
const only = (schema: string): ReadOnlyConnector => {
  const real = createPostgresConnector({ connectionString: url('DATABASE_URL_MIGRATE'), statementTimeoutMs: 10_000 });
  return new Proxy(real, { get: (target, key) => {
    if (key === 'discover') return async (input: Parameters<ReadOnlyConnector['discover']>[0]) => {
      const found = await target.discover(input); const mine = found.objects.filter((object) => object.qualifiedName.startsWith(`${schema}.`));
      return { ...found, objects: mine, unchangedObjects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: mine.length, accessible: mine.length, inaccessible: 0 } };
    };
    if (key === 'structuralReferences' || key === 'viewDefinitions' || key === 'routines') return async () => [];
    const value = Reflect.get(target, key, target) as unknown; return typeof value === 'function' ? value.bind(target) : value;
  } }) as ReadOnlyConnector;
};

describe('contract 6 ID matching on a consistent sample', () => {
  afterAll(async () => { await migratePool.query(`DROP SCHEMA IF EXISTS ${big} CASCADE; DROP SCHEMA IF EXISTS ${small} CASCADE`); await appPool.end(); await migratePool.end(); });

  it('c6_a_sampled_large_id_field_matches_a_small_whole_one_and_says_it_was_a_sample', async () => {
    process.env.ARTIFACT_MASTER_KEY ??= Buffer.alloc(32, 9).toString('base64');
    await migratePool.query(`CREATE SCHEMA ${big}; CREATE SCHEMA ${small};
      CREATE TABLE ${big}.people(person_ref text NOT NULL); COMMENT ON COLUMN ${big}.people.person_ref IS 'sensitivity:identifier';
      INSERT INTO ${big}.people SELECT 'P' || lpad(n::text, 7, '0') FROM generate_series(1, 40000) n;
      CREATE TABLE ${small}.claims(member_ref text NOT NULL); COMMENT ON COLUMN ${small}.claims.member_ref IS 'sensitivity:identifier';
      INSERT INTO ${small}.claims SELECT 'P' || lpad((1 + n % 5000)::text, 7, '0') FROM generate_series(1, 5000) n;
      ANALYZE ${big}.people; ANALYZE ${small}.claims;`);
    const tenantId = `idsample-${randomUUID()}`;
    const userId = await withTenant(migratePool, tenantId, async (db) => {
      await db.query('INSERT INTO core.tenants(tenant_id,name) VALUES($1,$1)', [tenantId]);
      return (await db.query<{ user_id: string }>('INSERT INTO core.users(tenant_id,email,password_hash) VALUES($1,$2,$3) RETURNING user_id', [tenantId, `${tenantId}@synthetic.example`, hashPassword('synthetic-password')])).rows[0]!.user_id;
    });
    const first = await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' });
    const second = await activateConnection(appPool, { tenantId, principalId: userId, connectorType: 'postgres' });
    const one = only(big); const two = only(small);
    try {
      await runProfile(appPool, { tenantId, connectionId: first.connectionId, connector: one, jobType: 'discovery' });
      const ids = await runProfile(appPool, { tenantId, connectionId: second.connectionId, connector: two, jobType: 'discovery' });
      expect(ids.ids).toMatchObject({ matches: 1 });
    } finally { await one.close?.(); await two.close?.(); }

    const fields = await withTenant(migratePool, tenantId, (db) => db.query<{ field_name: string; sampled: boolean; values: number; in_sample: number }>(
      `SELECT i.field_name,i.sampled,(SELECT count(*)::int FROM graph.id_fingerprints f WHERE f.tenant_id=i.tenant_id AND f.asset_id=i.asset_id) AS values,
         (SELECT count(*)::int FROM graph.id_fingerprints f WHERE f.tenant_id=i.tenant_id AND f.asset_id=i.asset_id AND f.in_sample) AS in_sample FROM graph.id_fields i WHERE i.tenant_id=$1 ORDER BY i.field_name`, [tenantId]));
    const [people, claims] = [fields.rows.find((row) => row.field_name.startsWith(big))!, fields.rows.find((row) => row.field_name.startsWith(small))!];
    expect(people.sampled).toBe(true); expect(people.values).toBe(people.in_sample); // only sampled values were read
    expect(people.values / 40000).toBeGreaterThan(0.05); expect(people.values / 40000).toBeLessThan(0.08);
    expect(claims).toMatchObject({ sampled: false, values: 5000 }); // a small table is read whole
    const evidence = await withTenant(migratePool, tenantId, (db) => db.query<{ explanation: string; metadata: Record<string, unknown> }>(
      `SELECT a.explanation,e.safe_metadata AS metadata FROM graph.assertions a JOIN graph.relationships r ON r.tenant_id=a.tenant_id AND r.relationship_id=a.relationship_id
       JOIN graph.evidence e ON e.tenant_id=a.tenant_id AND e.evidence_id=a.evidence_ids[1] WHERE a.tenant_id=$1 AND r.relationship_type='SAME_AS' AND a.valid_to IS NULL`, [tenantId]));
    expect(evidence.rows).toHaveLength(1);
    expect(evidence.rows[0]!.explanation).toBe(`Matched on a consistent sample of ${claims.in_sample.toLocaleString('en-US')} values: ${claims.in_sample.toLocaleString('en-US')} of them match by keyed fingerprint`);
    expect(evidence.rows[0]!.metadata).toMatchObject({ sampled: true, sample_rule: 'consistent 1 in 16', shared: claims.in_sample });
  }, 120_000);
});
