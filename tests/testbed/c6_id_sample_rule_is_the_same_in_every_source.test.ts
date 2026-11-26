import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createSqlServerConnector, inIdSample, postgresIdSampleCondition } from '@scaleinsyght/connectors';

// Decision 61: the rule runs in each source's SQL so far less is read; it must keep exactly the values the rule in code
// keeps, or two sources would sample different values and matches would be missed.
config({ path: resolve('.env') });
const migrate = (() => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); })();
const pool = new Pool({ connectionString: migrate });
const values = [
  ...Array.from({ length: 1200 }, (_, index) => String(index)),
  ...Array.from({ length: 1200 }, (_, index) => `MRN${String(index * 7).padStart(7, '0')}`),
  ...Array.from({ length: 600 }, (_, index) => String(index * 16).padStart(6, '0')),
  ...Array.from({ length: 600 }, (_, index) => `${(index * 2654435761) % 4294967296}-${index}`),
  '999999999999999999', '1000000000000000000', '-16', '16.0', 'A-16',
];
const expected = values.filter(inIdSample).sort();

describe('decision 61 consistent sampling rule in SQL', () => {
  afterAll(async () => { await pool.end(); });
  it('postgres_sql_rule_keeps_exactly_the_values_the_code_rule_keeps', async () => {
    const kept = await pool.query<{ v: string }>(`SELECT v FROM unnest($1::text[]) AS u(v) WHERE ${postgresIdSampleCondition('v')}`, [values]);
    expect(kept.rows.map((row) => row.v).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(200);
  });
  it('sqlserver_sampled_reads_keep_exactly_the_values_the_code_rule_keeps', async () => {
    // Through the connector's own path on the read-only testbed: a sampled read (rule in SQL) equals a whole read
    // filtered by the rule in code, for every column of every table.
    const connector = createSqlServerConnector({ server: process.env.SQLSERVER_TESTBED_HOST!, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE!,
      username: process.env.SQLSERVER_TESTBED_USERNAME!, password: process.env.SQLSERVER_TESTBED_PASSWORD!, encrypt: true, trustServerCertificate: true, statementTimeoutMs: 10_000 });
    try {
      const objects = (await connector.discover({ mode: 'profile' })).objects.filter((object) => object.type === 'table');
      let compared = 0, kept = 0;
      for (const object of objects) {
        const profile = await connector.profile(object.assetKey);
        for (const column of profile.columns) {
          const whole = await connector.distinctValues!(object.qualifiedName, column.name, 100_000);
          const sampled = await connector.distinctValues!(object.qualifiedName, column.name, 100_000, { sample: true });
          if (!whole || !sampled) continue;
          expect(sampled.sort(), `${object.qualifiedName}.${column.name}`).toEqual(whole.filter(inIdSample).sort());
          compared++; kept += sampled.length;
        }
      }
      expect(compared).toBeGreaterThan(10); expect(kept).toBeGreaterThan(20);
    } finally { await connector.close?.(); }
  });
});
