import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { config } from 'dotenv';
import { Client } from 'pg';
import { collectSqlServerTruth } from './sqlserver/truth.js';

config({ path: resolve('.env') });
const connectionString = process.env.DATABASE_URL_TESTBED;
if (!connectionString) throw new Error('DATABASE_URL_TESTBED is required; run pnpm testbed:up first.');
const client = new Client({ connectionString, statement_timeout: 10_000, query_timeout: 12_000 });
const tables = ['patients', 'encounters', 'orders', 'departments', 'providers'];
await client.connect();
try {
  const rowCounts: Record<string, number> = {};
  const columnCounts: Record<string, number> = {};
  for (const table of tables) {
    const quoted = `public."${table}"`;
    const count = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${quoted}`);
    rowCounts[table] = Number(count.rows[0]!.count);
    const columns = await client.query<{ count: string }>(`SELECT count(*)::text AS count FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`, [table]);
    columnCounts[table] = Number(columns.rows[0]!.count);
  }
  const foreignKeys = await client.query<{ from: string; to: string }>(`SELECT
    local_table.relname || '.' || local_column.attname AS "from",
    target_table.relname || '.' || target_column.attname AS "to"
    FROM pg_constraint fk
    JOIN pg_class local_table ON local_table.oid=fk.conrelid
    JOIN pg_namespace ns ON ns.oid=local_table.relnamespace
    JOIN pg_attribute local_column ON local_column.attrelid=fk.conrelid AND local_column.attnum=fk.conkey[1]
    JOIN pg_class target_table ON target_table.oid=fk.confrelid
    JOIN pg_attribute target_column ON target_column.attrelid=fk.confrelid AND target_column.attnum=fk.confkey[1]
    WHERE fk.contype='f' AND ns.nspname='public' ORDER BY 1,2`);
  const comments = await client.query<{ key: string; description: string | null }>(`SELECT c.relname || '.' || a.attname AS key, d.description
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    LEFT JOIN pg_description d ON d.objoid=c.oid AND d.objsubid=a.attnum
    WHERE n.nspname='public' AND c.relkind='r' AND d.description LIKE 'sensitivity:%' ORDER BY 1`);
  const sensitiveColumns = comments.rows.map((row) => row.key);
  const nullRates: Record<string, number> = {};
  for (const [table, column] of [['patients', 'phone'], ['encounters', 'discharged_at']] as const) {
    const result = await client.query<{ total: string; missing: string }>(`SELECT count(*)::text AS total, count(*) FILTER (WHERE "${column}" IS NULL)::text AS missing FROM public."${table}"`);
    nullRates[`${table}.${column}`] = Number(result.rows[0]!.missing) / Number(result.rows[0]!.total);
  }
  const baseMetrics = await client.query<{ patients: string; encounters: string; orders: string; completed_orders: string; order_amount: string; encounter_per_patient: string }>(`SELECT
    (SELECT count(*) FROM patients)::text AS patients,
    (SELECT count(*) FROM encounters)::text AS encounters,
    (SELECT count(*) FROM orders)::text AS orders,
    (SELECT count(*) FROM orders WHERE order_status='completed')::text AS completed_orders,
    (SELECT coalesce(sum(amount),0) FROM orders)::text AS order_amount,
    (SELECT avg(n)::text FROM (SELECT count(*) AS n FROM encounters GROUP BY patient_id) e) AS encounter_per_patient`);
  const metrics: Record<string, number> = Object.fromEntries(Object.entries(baseMetrics.rows[0]!).map(([key, value]) => [key, Number(value)]));
  const perDepartment = await client.query<{ department_id: number; orders: string }>('SELECT department_id,count(*)::text AS orders FROM orders GROUP BY department_id ORDER BY department_id');
  for (const row of perDepartment.rows) metrics[`orders_department_${row.department_id}`] = Number(row.orders);
  const inferredMatch = await client.query<{ matches: string; source_count: string; target_count: string }>(`SELECT count(*)::text AS matches,
    (SELECT count(DISTINCT patient_id) FROM encounters)::text AS source_count,
    (SELECT count(DISTINCT patient_id) FROM patients)::text AS target_count
    FROM encounters e JOIN patients p ON p.patient_id=e.patient_id`);
  const sqlServer = await collectSqlServerTruth(client);
  const truth = {
    source: 'si_testbed_pg',
    generatedAt: new Date().toISOString(),
    rowCounts,
    columnCounts,
    foreignKeys: foreignKeys.rows,
    inferredRelationship: {
      from: 'encounters.patient_id', to: 'patients.patient_id',
      matches: Number(inferredMatch.rows[0]!.matches),
      sourceCount: Number(inferredMatch.rows[0]!.source_count),
      targetCount: Number(inferredMatch.rows[0]!.target_count),
      declared: false,
    },
    sensitiveColumns,
    nullRates,
    metrics,
    sqlServer,
  };
  writeFileSync(resolve('testbed/truth.json'), `${JSON.stringify(truth, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write('SQL-derived truth written for 5 tables, 2 declared relationships, and the undeclared patient key.\n');
} finally {
  await client.end();
}
