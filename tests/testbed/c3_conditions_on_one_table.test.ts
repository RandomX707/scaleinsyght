import { afterAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { Client } from 'pg';
import { createPostgresConnector, createSqlServerConnector } from '@scaleinsyght/connectors';
import { parseQueryIntent } from '@scaleinsyght/contracts';
import { runSqlServerAdminQuery } from '../../testbed/sqlserver/admin-query.js';

// K6 and decision 54: a count with two or more conditions on one table, and a grouped count with conditions, run on
// both real testbeds. Truth is computed here with independent SQL, never by the connector under test.
config({ path: '.env' });
const url = process.env.DATABASE_URL_TESTBED; if (!url) throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
if (!process.env.SQLSERVER_TESTBED_PASSWORD) throw new Error('SQLSERVER_TESTBED_PASSWORD is required; run pnpm testbed:up first.');
const postgres = createPostgresConnector({ connectionString: url, id: 'testbed', name: 'Testbed PostgreSQL', statementTimeoutMs: 10_000, maxRows: 1_000 });
const sqlServer = createSqlServerConnector({ server: process.env.SQLSERVER_TESTBED_HOST ?? 'localhost', port: Number(process.env.SQLSERVER_TESTBED_PORT ?? 1433), database: process.env.SQLSERVER_TESTBED_DATABASE ?? 'si_testbed_sqlserver',
  username: process.env.SQLSERVER_TESTBED_USERNAME ?? 'si_testbed_reader', password: process.env.SQLSERVER_TESTBED_PASSWORD, encrypt: true, trustServerCertificate: true });

async function postgresTruth(sql: string): Promise<Array<Record<string, string>>> {
  const client = new Client({ connectionString: url }); await client.connect();
  try { return (await client.query<Record<string, string>>(sql)).rows; } finally { await client.end(); }
}
function sqlServerTruth(sql: string): string[] {
  return runSqlServerAdminQuery(`SET NOCOUNT ON; ${sql}`, process.env.SQLSERVER_TESTBED_DATABASE ?? 'si_testbed_sqlserver').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !/^-+$/.test(line) && !/^\(\d+ rows? affected\)$/.test(line));
}

describe('contract 3 conditions on one table (K6, decision 54)', () => {
  afterAll(async () => { await postgres.close(); await sqlServer.close(); });

  it('c3_counts_with_two_or_three_conditions_on_one_table_match_sql_truth', async () => {
    await postgres.discover({ mode: 'profile' }); await sqlServer.discover({ mode: 'profile' });
    const cases = [
      { conditions: [{ column: 'order_status', operator: 'eq', value: 'cancelled' }, { column: 'department_id', operator: 'eq', value: 1 }], where: "order_status='cancelled' AND department_id=1" },
      { conditions: [{ column: 'order_status', operator: 'eq', value: 'completed' }, { column: 'amount', operator: 'gt', value: 100 }, { column: 'department_id', operator: 'neq', value: 2 }], where: "order_status='completed' AND amount>100 AND department_id<>2" },
    ] as const;
    for (const item of cases) {
      const [first, ...rest] = item.conditions;
      for (const [connector, table] of [[postgres, 'public.orders'], [sqlServer, 'dbo.orders']] as const) {
        const intent = parseQueryIntent({ kind: 'filtered_count', table, ...first, filters: rest });
        const result = await connector.executeQueryIntent!(intent);
        const expected = connector === postgres ? (await postgresTruth(`SELECT count(*)::text AS n FROM public.orders WHERE ${item.where}`))[0]!.n : sqlServerTruth(`SELECT COUNT_BIG(*) FROM dbo.orders WHERE ${item.where}`)[0];
        expect(result.rows.map((row) => String(row.value)), `${table}: ${item.where}`).toEqual([String(expected)]);
        expect(Number(expected)).toBeGreaterThan(0);
        // Values are bound, never written into the SQL.
        expect(result.sql).not.toContain('cancelled'); expect(result.sql).not.toContain('completed');
      }
    }
  });

  it('c3_a_grouped_count_with_a_condition_matches_sql_truth', async () => {
    const pg = await postgres.executeQueryIntent!(parseQueryIntent({ kind: 'group_by', table: 'public.orders', groupBy: 'department_id', aggregate: { operation: 'count' }, filters: [{ column: 'order_status', operator: 'eq', value: 'cancelled' }] }));
    const pgTruth = await postgresTruth("SELECT department_id::text AS g,count(*)::text AS n FROM public.orders WHERE order_status='cancelled' GROUP BY department_id");
    expect(new Map(pg.rows.map((row) => [String(row.group_value), String(row.value)]))).toEqual(new Map(pgTruth.map((row) => [row.g!, row.n!])));
    const ss = await sqlServer.executeQueryIntent!(parseQueryIntent({ kind: 'group_by', table: 'dbo.orders', groupBy: 'department_id', aggregate: { operation: 'count' }, filters: [{ column: 'order_status', operator: 'eq', value: 'cancelled' }] }));
    const ssTruth = sqlServerTruth("SELECT CAST(department_id AS varchar(20)) + '|' + CAST(COUNT_BIG(*) AS varchar(20)) FROM dbo.orders WHERE order_status='cancelled' GROUP BY department_id");
    expect(new Map(ss.rows.map((row) => [String(row.group_value), String(row.value)]))).toEqual(new Map(ssTruth.map((line) => line.split('|') as [string, string])));
    expect(pgTruth.length).toBeGreaterThan(1);
  });

  it('c3_a_condition_on_another_table_is_refused_by_the_schema', () => {
    expect(() => parseQueryIntent({ kind: 'filtered_count', table: 'public.orders', column: 'order_status', operator: 'eq', value: 'placed', filters: [{ table: 'public.departments', column: 'department_name', operator: 'eq', value: 'Emergency' }] })).toThrow('analytic_query_intent_invalid');
  });
});
