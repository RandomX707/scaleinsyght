// Independent truth for testbed/eval/heldout3.json, written 25 Nov 2026 before heldout3's first run. PostgreSQL is
// read in a read-only transaction, SQL Server is queried directly, and the workbook is read cell by cell.
// heldout3 is single-use: once its results are seen, nothing is tuned against it, and it is not rerun to pick a score.
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
const groups = async (sql: string) => (await pg.query<{ label: string; value: string }>(sql)).rows.map((row) => ({ label: row.label, value: Number(row.value) }));
const sqlServer = (sql: string) => runSqlServerAdminQuery(`SET NOCOUNT ON; ${sql}`, 'si_testbed_sqlserver').split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^-+$/.test(line) && !/rows affected/i.test(line));
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile('testbed/excel/hospital-operations.xlsx');
function rows(name: string) {
  const sheet = workbook.getWorksheet(name)!;
  const headers = Array.from({ length: sheet.columnCount }, (_, i) => sheet.getRow(1).getCell(i + 1).text);
  const out: Array<Record<string, ExcelJS.CellValue>> = [];
  sheet.eachRow((row, index) => { if (index > 1) out.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value]))); });
  return out;
}
const counted = (values: string[]) => [...values.reduce((map, value) => map.set(value, (map.get(value) ?? 0) + 1), new Map<string, number>())]
  .map(([label, value]) => ({ label, value })).sort((a, b) => b.value - a.value || a.label.localeCompare(b.label));
const topTypes = sqlServer("SELECT CONVERT(varchar(40),order_type)+'|'+CONVERT(varchar(20),COUNT_BIG(*)) FROM dbo.orders GROUP BY order_type ORDER BY COUNT_BIG(*) DESC, order_type")
  .map((line) => { const [label, value] = line.split('|'); return { label: label!.trim(), value: Number(value) }; });
// A ranked question is only fair when the cut-off is not a tie.
if (topTypes[1]!.value === topTypes[2]?.value) throw new Error('heldout3 H05 has a tie at the cut-off');
const statuses = new Set(rows('Charges').map((row) => String(row.Status)));
if (!statuses.has('cancelled')) throw new Error('heldout3 H07 expects a cancelled charge status');

const truth: Record<string, Expected> = {
  H01: { p: await groups('SELECT specialty AS label,count(*)::text AS value FROM public.providers GROUP BY specialty ORDER BY count(*) DESC, specialty') },
  H02: { s: Number(sqlServer('SELECT COUNT_BIG(*) FROM dbo.encounters WHERE discharged_at IS NULL')[0]) },
  H03: { x: counted(rows('Visits').map((row) => String(row.Department))) },
  H04: { p: await one("SELECT count(*)::text AS v FROM public.orders WHERE order_status='cancelled'") },
  H05: { s: topTypes.slice(0, 2) },
  H06: { p: await one("SELECT count(*)::text AS v FROM public.encounters e JOIN public.departments d ON d.department_id=e.department_id WHERE d.department_name='Emergency'") },
  H07: { x: rows('Charges').filter((row) => String(row.Status) === 'cancelled').length },
  H08: { s: Number(sqlServer('SELECT COUNT_BIG(*) FROM dbo.patients')[0]) },
  H09: { p: await one("SELECT count(*)::text AS v FROM public.orders o JOIN public.departments d ON d.department_id=o.department_id WHERE d.department_name='Pediatrics'") },
  H10: { s: Number(sqlServer("SELECT COUNT_BIG(*) FROM dbo.orders WHERE ordered_at >= '2025-03-01' AND ordered_at < '2025-04-01'")[0]) },
};
await pg.query('ROLLBACK');
await pg.end();
await writeFile(new URL('./heldout3-truth.json', import.meta.url), JSON.stringify(truth, null, 2) + '\n');
process.stdout.write(`heldout3 truth written for ${Object.keys(truth).length} cases.\n`);
