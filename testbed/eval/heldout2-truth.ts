// Independent truth for testbed/eval/heldout2.json. PostgreSQL is read in a read-only transaction, SQL Server is
// queried directly, and the workbook is read cell by cell. Written once, before the single heldout2 run.
import { writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import { runSqlServerAdminQuery } from '../sqlserver/admin-query.js';
import type { Expected } from './collect-truth.js';

config();
const pgUrl = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!['localhost', '127.0.0.1'].includes(pgUrl.hostname) || pgUrl.pathname !== '/si_testbed_pg') throw new Error('Expected a local si_testbed_pg reader');
const pg = new Client({ connectionString: pgUrl.toString() });
await pg.connect();
await pg.query('BEGIN READ ONLY');
const one = async (sql: string) => Number((await pg.query<{ v: string }>(sql)).rows[0]!.v);
const sqlServer = (sql: string) => runSqlServerAdminQuery(`SET NOCOUNT ON; ${sql}`, 'si_testbed_sqlserver').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^-+$/.test(line) && !/rows? affected/.test(line));
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile('testbed/excel/hospital-operations.xlsx');
function rows(name: string) {
  const sheet = workbook.getWorksheet(name)!;
  const headers = Array.from({ length: sheet.columnCount }, (_, i) => sheet.getRow(1).getCell(i + 1).text);
  const out: Array<Record<string, ExcelJS.CellValue>> = [];
  sheet.eachRow((row, index) => { if (index > 1) out.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value]))); });
  return out;
}
const ranked = (lines: string[]) => lines.map((line) => { const [label, value] = line.split('|'); return { label: label!.trim(), value: Number(value) }; });

const visitDepartments = new Map<string, number>();
for (const row of rows('Visits')) visitDepartments.set(String(row.Department), (visitDepartments.get(String(row.Department)) ?? 0) + 1);
const topDepartments = [...visitDepartments.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
const topProviders = ranked(sqlServer("SELECT TOP (6) CONVERT(varchar(10),provider_id)+'|'+CONVERT(varchar(20),COUNT_BIG(*)) FROM dbo.encounters GROUP BY provider_id ORDER BY COUNT_BIG(*) DESC, provider_id"));
// A ranked question is only fair when the cut-off is not a tie.
if (topProviders[4]!.value === topProviders[5]!.value) throw new Error('heldout2 N06 has a tie at the cut-off');
if (topDepartments[2]![1] === topDepartments[3]![1]) throw new Error('heldout2 N08 has a tie at the cut-off');

const truth: Record<string, Expected> = {
  N01: { p: await one('SELECT count(*)::text AS v FROM public.patients') },
  N02: { x: rows('Registrations').length },
  N03: { s: Number(sqlServer("SELECT COUNT_BIG(*) FROM dbo.orders WHERE order_type='imaging'")[0]) },
  N04: { p: await one("SELECT count(*)::text AS v FROM public.encounters WHERE admitted_at >= '2024-01-01' AND admitted_at < '2025-01-01'") },
  N05: { x: rows('Charges').filter((row) => Number(row.Amount) >= 400).length },
  N06: { s: topProviders.slice(0, 5) },
  N07: { p: await one("SELECT sum(o.amount)::text AS v FROM public.orders o JOIN public.departments d ON d.department_id=o.department_id WHERE d.department_name='Emergency'") },
  N08: { x: topDepartments.slice(0, 3).map(([label, value]) => ({ label, value })) },
  N09: { p: await one('SELECT count(*)::text AS v FROM public.patients'), x: rows('Patients').length },
  N10: { s: Number(sqlServer("SELECT COUNT_BIG(*) FROM dbo.encounters e JOIN dbo.departments d ON d.department_id=e.department_id WHERE d.department_name='Imaging'")[0]) },
};
await pg.query('ROLLBACK');
await pg.end();
await writeFile(new URL('./heldout2-truth.json', import.meta.url), JSON.stringify(truth, null, 2) + '\n');
process.stdout.write(`heldout2 truth written for ${Object.keys(truth).length} cases.\n`);
