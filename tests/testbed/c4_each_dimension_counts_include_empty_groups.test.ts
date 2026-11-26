import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { Pool } from 'pg';
import { createPostgresConnector, createSqlServerConnector } from '@scaleinsyght/connectors';
import type { QueryIntent } from '@scaleinsyght/contracts';

// K12: "How many orders does each department have" lists every department; one with no orders shows 0. The count and
// the disclosure cell size count order rows only, so 0 stays 0 and 1 to 10 are withheld as "<11" by the executor.
config({ path: resolve('.env') });
const migrate = (() => { const value = process.env.DATABASE_URL_MIGRATE; if (!value) throw new Error('DATABASE_URL_MIGRATE is required'); const url = new URL(value); url.pathname = `/${process.env.SI_TEST_DATABASE ?? 'si_test'}`; return url.toString(); })();
const admin = new Pool({ connectionString: migrate });
const schema = `each_${randomUUID().replaceAll('-', '').slice(0, 12)}`;

describe('K12 each-dimension counts include empty groups', () => {
  beforeAll(async () => {
    await admin.query(`CREATE SCHEMA ${schema};
      CREATE TABLE ${schema}.departments(department_id integer PRIMARY KEY, department_name text NOT NULL UNIQUE);
      INSERT INTO ${schema}.departments VALUES (1,'Emergency'),(2,'Imaging'),(3,'Dermatology'),(4,'Rehabilitation');
      CREATE TABLE ${schema}.orders(order_id integer PRIMARY KEY, department_id integer NOT NULL REFERENCES ${schema}.departments, status text NOT NULL);
      INSERT INTO ${schema}.orders SELECT n, CASE WHEN n <= 30 THEN 1 ELSE 2 END, CASE WHEN n % 2 = 0 THEN 'cancelled' ELSE 'done' END FROM generate_series(1, 35) n;`);
  });
  afterAll(async () => { await admin.query(`DROP SCHEMA ${schema} CASCADE`); await admin.end(); });

  const intent = (extra: Partial<QueryIntent> = {}) => ({ kind: 'grouped_join', leftTable: `${schema}.orders`, rightTable: `${schema}.departments`, leftColumn: 'department_id', rightColumn: 'department_id',
    groupByTable: 'right', groupBy: 'department_name', groupKey: 'department_id', aggregate: { operation: 'count' }, filters: [], order: 'desc', limit: 100, emptyGroups: 'zero', ...extra }) as QueryIntent;

  it('postgres_every_department_appears_and_one_without_orders_counts_zero', async () => {
    const connector = createPostgresConnector({ connectionString: migrate, statementTimeoutMs: 10_000 });
    try {
      await connector.discover({ mode: 'profile' });
      const result = await connector.executeQueryIntent!(intent(), true);
      const rows = Object.fromEntries(result.rows.map((row) => [String(row.group_value), { value: Number(row.value), cell: Number(row.cell_size) }]));
      expect(rows).toEqual({ Emergency: { value: 30, cell: 30 }, Imaging: { value: 5, cell: 5 }, Dermatology: { value: 0, cell: 0 }, Rehabilitation: { value: 0, cell: 0 } });
      // A condition on orders keeps every department (it is applied in the join, not after it).
      const cancelled = await connector.executeQueryIntent!(intent({ filters: [{ table: 'left', column: 'status', operator: 'eq', value: 'cancelled' }] } as Partial<QueryIntent>), true);
      expect(Object.fromEntries(cancelled.rows.map((row) => [String(row.group_value), Number(row.value)]))).toEqual({ Emergency: 15, Imaging: 2, Dermatology: 0, Rehabilitation: 0 });
      // Without the rule the inner join drops the departments with no orders.
      const plain = await connector.executeQueryIntent!(intent({ emptyGroups: undefined }), true);
      expect(plain.rows.map((row) => String(row.group_value)).sort()).toEqual(['Emergency', 'Imaging']);
    } finally { await connector.close?.(); }
  });

  it('sqlserver_each_department_query_runs_and_returns_every_department', async () => {
    const connector = createSqlServerConnector({ server: process.env.SQLSERVER_TESTBED_HOST!, port: Number(process.env.SQLSERVER_TESTBED_PORT), database: process.env.SQLSERVER_TESTBED_DATABASE!,
      username: process.env.SQLSERVER_TESTBED_USERNAME!, password: process.env.SQLSERVER_TESTBED_PASSWORD!, encrypt: true, trustServerCertificate: true, statementTimeoutMs: 10_000 });
    try {
      await connector.discover({ mode: 'profile' });
      const each = { kind: 'grouped_join', leftTable: 'dbo.orders', rightTable: 'dbo.departments', leftColumn: 'department_id', rightColumn: 'department_id', groupByTable: 'right', groupBy: 'department_name',
        groupKey: 'department_id', aggregate: { operation: 'count' }, filters: [], order: 'desc', limit: 100, emptyGroups: 'zero' } as QueryIntent;
      const result = await connector.executeQueryIntent!(each, true);
      const departments = (await connector.executeQueryIntent!({ kind: 'count', table: 'dbo.departments' } as QueryIntent)).rows[0]!;
      expect(result.rows).toHaveLength(Number(departments.value));
      expect(result.sql).toContain('LEFT JOIN');
      for (const row of result.rows) expect(Number(row.cell_size)).toBe(Number(row.value));
    } finally { await connector.close?.(); }
  });
});
