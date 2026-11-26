import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPostgresConnector, createSqlServerConnector, type ReadOnlyConnector } from '@scaleinsyght/connectors';

// Decision 59 (test_emr: 14 large tables got no statistics): a large table's size comes from the catalog and its
// statistics from a capped TABLESAMPLE, marked as estimates; small tables stay exact; tagged columns stay withheld.
config({ path: resolve('.env') });
const migrate = (() => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); })();
const admin = new Pool({ connectionString: migrate });
const schema = `big_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const BIG = 1_200_000;

/** Only this schema's objects, so the connector does not profile the rest of the test database. */
const only = (connector: ReadOnlyConnector, prefix: string) => ({
  discover: async () => { const found = await connector.discover({ mode: 'profile' }); return found.objects.filter((object) => object.qualifiedName.startsWith(prefix)); },
  profile: (key: string) => connector.profile(key, undefined, 'profile'),
});

describe('decision 59 large tables are sampled, with estimates', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.big AS SELECT n::bigint AS id, (n % 997)::numeric AS amount, CASE WHEN n % 500 = 0 THEN 'note ' || n END AS note,
        'person' || n || '@example.test' AS contact FROM generate_series(1, ${BIG}) n;
      CREATE TABLE ${schema}.small AS SELECT n AS id, (n % 7) AS bucket FROM generate_series(1, 1000) n;
      ANALYZE ${schema}.big; ANALYZE ${schema}.small;`);
  }, 120_000);
  afterAll(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  it('postgres_large_table_uses_catalog_count_and_sampled_statistics_marked_as_estimates', async () => {
    const connector = createPostgresConnector({ connectionString: migrate, statementTimeoutMs: 10_000, id: 'big', name: 'Big source' });
    try {
      const view = only(connector, `${schema}.`); const objects = await view.discover();
      const started = Date.now();
      const big = await view.profile(objects.find((object) => object.qualifiedName === `${schema}.big`)!.assetKey);
      const elapsed = Date.now() - started;
      expect(big.rowCountEstimated).toBe(true);
      expect(Math.abs(big.rowCount! - BIG) / BIG).toBeLessThan(0.1);
      expect(big.limited).toBeUndefined();
      const column = (name: string) => big.columns.find((item) => item.name === name)!;
      expect(column('amount').statistics).toMatchObject({ estimated: true, nullRate: 0 });
      expect(column('amount').statistics.distinctCount).toBeGreaterThan(900); expect(column('amount').statistics.distinctCount).toBeLessThan(1100); // 997 values, from pg_stats
      expect(column('id').statistics.distinctCount! / BIG).toBeGreaterThan(0.9); // unique, from pg_stats (n_distinct = -1)
      expect(column('note').statistics.estimated).toBe(true);
      expect(Math.abs(column('note').statistics.nullRate! - 0.998)).toBeLessThan(0.01);
      // Sensitive values are still found in the sample, and a tagged column gets no statistics (contract 7).
      expect(column('contact').sensitivityTags.length).toBeGreaterThan(0);
      expect(column('contact').statistics).toEqual({ nullRate: null, distinctCount: null, averageLength: null });
      expect(elapsed).toBeLessThan(10_000);

      const small = await view.profile(objects.find((object) => object.qualifiedName === `${schema}.small`)!.assetKey);
      expect(small.rowCountEstimated).toBeUndefined();
      expect(small.rowCount).toBe(1000);
      expect(small.columns.find((item) => item.name === 'bucket')!.statistics).toEqual({ nullRate: 0, distinctCount: 7, averageLength: null });
    } finally { await connector.close?.(); }
  }, 120_000);

  it('sqlserver_sampled_path_reads_the_size_from_sys_partitions_and_marks_estimates', async () => {
    const base = { server: process.env.SQLSERVER_TESTBED_HOST!, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE!,
      username: process.env.SQLSERVER_TESTBED_USERNAME!, password: process.env.SQLSERVER_TESTBED_PASSWORD!, encrypt: true, trustServerCertificate: true, statementTimeoutMs: 10_000 };
    // Lowered limits make the existing testbed tables take the large-table path; every query stays read-only.
    const sampled = createSqlServerConnector({ ...base, sampling: { exactCountLimit: 10, statisticsSampleRows: 20, sensitivitySampleRows: 20 } });
    const exact = createSqlServerConnector(base);
    try {
      const objects = (await sampled.discover({ mode: 'profile' })).objects.filter((object) => object.type === 'table');
      await exact.discover({ mode: 'profile' });
      let checked = 0;
      for (const object of objects) {
        const truth = await exact.profile(object.assetKey);
        if ((truth.rowCount ?? 0) <= 20) continue;
        const profile = await sampled.profile(object.assetKey);
        expect(profile.rowCountEstimated, object.qualifiedName).toBe(true);
        expect(profile.rowCount, object.qualifiedName).toBe(truth.rowCount); // sys.partitions matches a fresh table exactly
        for (const column of profile.columns.filter((item) => item.statistics.nullRate !== null)) {
          expect(column.statistics.estimated, `${object.qualifiedName}.${column.name}`).toBe(true);
          expect(column.statistics.distinctCount).toBeNull(); // never a distinct count from a sample
        }
        checked++;
      }
      expect(checked).toBeGreaterThan(2);
    } finally { await sampled.close?.(); await exact.close?.(); }
  }, 120_000);
});
