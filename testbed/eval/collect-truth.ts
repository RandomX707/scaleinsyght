import { readFile, writeFile } from 'node:fs/promises';
import { config } from 'dotenv';
import { Client } from 'pg';
import ExcelJS from 'exceljs';
import { runSqlServerAdminQuery } from '../sqlserver/admin-query.js';

export type Source = 'p' | 's' | 'x';
export type Result = number | Array<{label: string; value: number}> | {lineage: string[]; gapIncludes?: string};
export type Expected = Partial<Record<Source, Result>> | null;
type SheetQuery = [string, string | null, string | null, string | number | null, number | null];

const root = new URL('./', import.meta.url);
const load = async (name: string) => JSON.parse(await readFile(new URL(name, root), 'utf8'));
config();
const pgUrl = new URL(process.env.DATABASE_URL_TESTBED ?? '');
if (!['localhost', '127.0.0.1'].includes(pgUrl.hostname) || pgUrl.pathname !== '/si_testbed_pg') throw new Error('Expected a local si_testbed_pg reader');
const pg = new Client({ connectionString: pgUrl.toString() });
const workbook = new ExcelJS.Workbook();
await workbook.xlsx.readFile('testbed/excel/hospital-operations.xlsx');

function cellRows(name: string) {
  const sheet = workbook.getWorksheet(name);
  if (!sheet) throw new Error('Missing workbook sheet');
  const headers = Array.from({length: sheet.columnCount}, (_, i) => sheet.getRow(1).getCell(i + 1).text);
  const rows: Array<Record<string, ExcelJS.CellValue>> = [];
  sheet.eachRow((row, index) => {
    if (index > 1) rows.push(Object.fromEntries(headers.map((header, i) => [header, row.getCell(i + 1).value])));
  });
  return rows;
}
function readWorkbook([sheet, field, op, value, rank]: SheetQuery): Result {
  const rows = cellRows(sheet);
  if (!field) return rows.length;
  if (op === 'visit_join') {
    const visits = new Set(cellRows('Visits').filter(row => row['Admitted On'] instanceof Date &&
      row['Admitted On'].toISOString() >= String(value)).map(row => row['Visit ID']));
    return rows.filter(row => visits.has(row[field])).length;
  }
  if (op === 'group') {
    const counts = new Map<string, number>();
    for (const row of rows) {
      const label = String(row[field]);
      counts.set(label, (counts.get(label) ?? 0) + 1);
    }
    const groups = [...counts].map(([label, value]) => ({label, value}));
    if (!rank) return groups;
    return groups.sort((a, b) => Math.sign(rank) * (b.value - a.value) || a.label.localeCompare(b.label)).slice(0, Math.abs(rank));
  }
  return rows.filter(row => {
    const raw = row[field];
    if (raw == null) return false;
    const cell = raw instanceof Date ? raw.toISOString() : raw;
    if (op === 'eq') return cell === value;
    if (op === 'lt' && typeof cell === typeof value && value !== null) return cell < value;
    if (op === 'gte' && typeof cell === typeof value && value !== null) return cell >= value;
    return false;
  }).length;
}

await pg.connect();
const truth: Record<string, Expected> = {};
try {
  await pg.query('BEGIN READ ONLY');
  await pg.query("SET LOCAL statement_timeout = '10s'");
  const references = await load('reference-queries.json') as Record<string, Partial<Record<Source, string | SheetQuery>> | null>;
  for (const [id, reference] of Object.entries(references)) {
    if (!reference) {
      truth[id] = null;
      continue;
    }
    const expected: NonNullable<Expected> = {};
    for (const [source, query] of Object.entries(reference) as [Source, string | SheetQuery][]) {
      if (typeof query !== 'string') {
        expected[source] = readWorkbook(query);
        continue;
      }
      const grouped = / AS label\b/i.test(query);
      const rows: Array<{label?: string; value: string}> = source === 'p'
        ? (await pg.query(query)).rows
        : runSqlServerAdminQuery('SET NOCOUNT ON; SET LOCK_TIMEOUT 10000; ' + query, 'si_testbed_sqlserver').split('\n').map(line => {
          const match = /^(.*\S)\s+(\d+)$/.exec(line);
          if (grouped && !match) throw new Error('Could not decode SQL Server group');
          return grouped ? {label: match![1], value: match![2]!} : {value: line};
        });
      if (!rows.length || rows.some(row => !/^\d+$/.test(String(row.value)))) throw new Error('Invalid reference result for ' + id);
      expected[source] = grouped ? rows.map(row => ({label: String(row.label), value: Number(row.value)})) : Number(rows[0]!.value);
    }
    truth[id] = expected;
  }
} finally {
  await pg.end();
}
await writeFile(new URL('truth.json', root), JSON.stringify(truth, null, 2) + '\n');
