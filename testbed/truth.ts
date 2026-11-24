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
  const candidates=await client.query<{from_table:string;from_column:string;to_table:string;to_column:string}>(`SELECT DISTINCT sc.table_name AS from_table,sc.column_name AS from_column,tc.table_name AS to_table,tc.column_name AS to_column
    FROM information_schema.columns sc JOIN information_schema.columns tc ON tc.column_name=sc.column_name AND tc.data_type=sc.data_type
    JOIN pg_constraint pk ON pk.contype='p' JOIN pg_class target ON target.oid=pk.conrelid JOIN pg_namespace target_ns ON target_ns.oid=target.relnamespace AND target_ns.nspname=tc.table_schema AND target.relname=tc.table_name
    JOIN pg_attribute target_column ON target_column.attrelid=target.oid AND target_column.attname=tc.column_name AND target_column.attnum=ANY(pk.conkey)
    JOIN pg_class source ON source.relname=sc.table_name JOIN pg_namespace source_ns ON source_ns.oid=source.relnamespace AND source_ns.nspname=sc.table_schema AND source.relkind IN ('r','p')
    WHERE sc.table_schema='public' AND tc.table_schema='public' AND source.oid<>target.oid
      AND NOT EXISTS(SELECT 1 FROM pg_constraint source_pk JOIN LATERAL unnest(source_pk.conkey) key(attnum) ON true JOIN pg_attribute attribute ON attribute.attrelid=source_pk.conrelid AND attribute.attnum=key.attnum WHERE source_pk.conrelid=source.oid AND source_pk.contype='p' AND attribute.attname=sc.column_name)
      AND NOT EXISTS(SELECT 1 FROM pg_constraint fk JOIN pg_class local_table ON local_table.oid=fk.conrelid JOIN pg_class target_table ON target_table.oid=fk.confrelid JOIN pg_attribute local_column ON local_column.attrelid=fk.conrelid AND local_column.attnum=fk.conkey[1] JOIN pg_attribute target_column2 ON target_column2.attrelid=fk.confrelid AND target_column2.attnum=fk.confkey[1] WHERE fk.contype='f' AND local_table.oid=source.oid AND target_table.oid=target.oid AND local_column.attname=sc.column_name AND target_column2.attname=tc.column_name)
    ORDER BY 1,2,3,4`);
  const inferredRelationships:Array<{from:string;to:string;matches:number;sourceCount:number;confidence:number;declared:false}>=[];
  for(const candidate of candidates.rows){const q=(v:string)=>`"${v.replaceAll('"','""')}"`;const counts=await client.query<{source_count:string;matches:string}>(`SELECT count(src.${q(candidate.from_column)})::text AS source_count,count(dst.${q(candidate.to_column)})::text AS matches FROM public.${q(candidate.from_table)} src LEFT JOIN public.${q(candidate.to_table)} dst ON src.${q(candidate.from_column)}=dst.${q(candidate.to_column)}`);const sourceCount=Number(counts.rows[0]!.source_count),matches=Number(counts.rows[0]!.matches);if(sourceCount&&matches/sourceCount>=0.98)inferredRelationships.push({from:`${candidate.from_table}.${candidate.from_column}`,to:`${candidate.to_table}.${candidate.to_column}`,matches,sourceCount,confidence:matches/sourceCount,declared:false});}
  const emergencyVisits2025 = await client.query<{ value: string }>(`SELECT count(*)::text AS value
    FROM public.encounters e JOIN public.departments d ON d.department_id=e.department_id
    WHERE d.department_name='Emergency' AND e.admitted_at>='2025-01-01' AND e.admitted_at<'2026-01-01'`);
  const ordersPerDepartmentTop5 = await client.query<{ department_id: number; department_name: string; order_count: string }>(`SELECT d.department_id,d.department_name,count(*)::text AS order_count
    FROM public.departments d JOIN public.orders o ON o.department_id=d.department_id
    GROUP BY d.department_id,d.department_name ORDER BY count(*) DESC,d.department_id LIMIT 5`);
  const averageEncountersPerPatientByProvider = await client.query<{ provider_id: number; average: string }>(`SELECT provider_id,avg(encounter_count)::text AS average
    FROM (SELECT provider_id,patient_id,count(*) AS encounter_count FROM public.encounters GROUP BY provider_id,patient_id) per_patient
    GROUP BY provider_id ORDER BY provider_id`);
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
    inferredRelationships,
    expectedRelationships:{postgres:[...foreignKeys.rows.map(item=>({from:`public.${item.from}`,to:`public.${item.to}`,evidenceMethod:'declared',confidence:1})),...inferredRelationships.map(item=>({from:`public.${item.from}`,to:`public.${item.to}`,evidenceMethod:'inferred',confidence:item.confidence}))],sqlServer:sqlServer.expectedRelationships},
    sensitiveColumns,
    nullRates,
    metrics,
    sqlServer,
    answerChecks: {
      emergencyVisits2025: { postgres: Number(emergencyVisits2025.rows[0]!.value), sqlServer: sqlServer.answerMetrics.emergencyVisits2025 },
      ordersPerDepartmentTop5: {
        postgres: ordersPerDepartmentTop5.rows.map((row) => ({ departmentId: row.department_id, departmentName: row.department_name, orderCount: Number(row.order_count) })),
        sqlServer: sqlServer.answerMetrics.ordersPerDepartmentTop5,
      },
      averageEncountersPerPatientByProvider: {
        postgres: averageEncountersPerPatientByProvider.rows.map((row) => ({ providerId: row.provider_id, average: Number(row.average) })),
        sqlServer: sqlServer.answerMetrics.averageEncountersPerPatientByProvider,
      },
      patientCountComparison: { postgres: rowCounts.patients!, sqlServer: sqlServer.rowCounts.patients!, same: rowCounts.patients === sqlServer.rowCounts.patients },
      patientsWithPhone: {postgres:Number((await client.query('SELECT count(phone) AS n FROM public.patients')).rows[0]!.n),sqlServer:sqlServer.metrics.patients_with_phone},
      sharedPatientsCount: sqlServer.sharedPatientIds,
    },
  };
  writeFileSync(resolve('testbed/truth.json'), `${JSON.stringify(truth, null, 2)}\n`, { mode: 0o644 });
  process.stdout.write('SQL-derived truth written for 5 tables, declared keys, and every inferred key with >=0.98 match confidence.\n');
} finally {
  await client.end();
}
