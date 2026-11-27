import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

/**
 * Contract 7 over the model replay recordings (decision 69). The recordings hold what was sent to the model and what it
 * returned, so they must hold no identifier or restricted value. Every value of every tagged column in the testbed's
 * PostgreSQL and SQL Server data and its Excel workbook is checked, plus the identifier shapes the gateway redacts.
 * Integer surrogate keys (patient_id 1..500) cannot be told apart from ordinary numbers by value; they are kept out by
 * the gateway's classification boundary and its own contract tests, not by this scan.
 */
const dir = 'tests/fixtures/model-replay';
const truth = JSON.parse(readFileSync('testbed/truth.json', 'utf8')) as { sensitiveColumns: string[]; sqlServer: { sensitiveColumns: string[] } };

function tuples(sql: string): Array<{ table: string; columns: string[]; values: string[] }> {
  const rows: Array<{ table: string; columns: string[]; values: string[] }> = [];
  for (const block of sql.matchAll(/INSERT INTO (?:\w+\.)?(\w+)\(([^)]*)\) VALUES\s*([\s\S]*?);\s*(?=INSERT|$)/g)) {
    const columns = block[2]!.split(',').map((column) => column.trim());
    for (const row of block[3]!.matchAll(/\(((?:[^()']|'(?:[^']|'')*')*)\)/g)) {
      const values = [...row[1]!.matchAll(/N?'((?:[^']|'')*)'|([^,\s][^,]*)/g)].map((value) => (value[1] ?? value[2] ?? '').replaceAll("''", "'").trim());
      rows.push({ table: block[1]!, columns, values });
    }
  }
  return rows;
}
function taggedValues(file: string, tagged: string[]): Set<string> {
  const values = new Set<string>();
  for (const row of tuples(readFileSync(file, 'utf8'))) row.columns.forEach((column, index) => {
    const value = row.values[index] ?? '';
    if (tagged.includes(`${row.table}.${column}`) && value.length >= 6 && !/^\d+$/.test(value) && value !== 'NULL') values.add(value);
  });
  return values;
}
async function workbookValues(): Promise<Set<string>> {
  const values = new Set<string>(); const book = new ExcelJS.Workbook(); await book.xlsx.readFile('testbed/excel/hospital-operations.xlsx');
  const sensitiveHeaders = /^(full name|name|mrn|phone( number)?|date of birth)$/i; // fixture headers, used only to collect test values
  book.eachSheet((sheet) => {
    const headers = (sheet.getRow(1).values as unknown[]).map((value) => String(value ?? ''));
    sheet.eachRow((row, number) => { if (number === 1) return; headers.forEach((header, index) => {
      if (!sensitiveHeaders.test(header)) return; const cell = row.getCell(index).value;
      const text = cell instanceof Date ? cell.toISOString().slice(0, 10) : String(cell ?? '');
      if (text.length >= 6) values.add(text);
    }); });
  });
  return values;
}
const shapes = [/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/, /\bSYN-[A-Z]+-\d+\b/i, /\bMRN-\d{4,}\b/i, /\b\d{3}-\d{7}\b/];
function scan(file: string, text: string, tagged: Set<string>): string[] {
  const found: string[] = [];
  for (const value of tagged) if (text.includes(value)) found.push(`${file}: tagged value ${JSON.stringify(value)}`);
  for (const shape of shapes) { const match = text.match(shape); if (match) found.push(`${file}: identifier shape ${JSON.stringify(match[0])}`); }
  if (/"(?:raw_?values?|sample_?rows?|result_?rows?)"\s*:/i.test(text)) found.push(`${file}: row-value key`);
  return found;
}
const allTagged = async () => new Set([...taggedValues('testbed/postgres/data.sql', truth.sensitiveColumns), ...taggedValues('testbed/sqlserver/data.sql', truth.sqlServer.sensitiveColumns), ...await workbookValues()]);
const recordings = () => readdirSync(dir).filter((file) => file.endsWith('.json')).map((file) => ({ file, text: readFileSync(join(dir, file), 'utf8') }));

describe('contract 7 model replay recordings', () => {
  it('c7_model_replay_recordings_exist_for_the_testbed', () => {
    expect(recordings().length).toBeGreaterThan(0);
  });

  it('c7_model_replay_recordings_hold_no_identifier_or_row_values', async () => {
    const tagged = await allTagged();
    expect(tagged.size).toBeGreaterThan(1000); // names, MRNs, phones and dates of birth were all collected
    for (const sample of ['Patient 0001', 'MRN-000001', '555-0100001', '1940-02-07']) expect(tagged.has(sample)).toBe(true);
    expect(recordings().flatMap(({ file, text }) => scan(file, text, tagged))).toEqual([]);
  });

  it('c7_the_scan_catches_planted_values', async () => {
    const tagged = await allTagged();
    expect(scan('planted', JSON.stringify({ content: 'the name is Patient 0417' }), tagged)).toHaveLength(1);
    expect(scan('planted', JSON.stringify({ content: 'born 1940-02-07' }), tagged)).toHaveLength(1);
    expect(scan('planted', JSON.stringify({ content: 'reach them at someone@example.org' }), tagged)).toHaveLength(1);
    expect(scan('planted', JSON.stringify({ result_rows: [] }), tagged)).toHaveLength(1);
    expect(scan('planted', JSON.stringify({ content: 'Orders by department in 2025' }), tagged)).toEqual([]);
  });
});
