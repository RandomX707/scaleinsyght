// Read-only connector for an uploaded .xlsx workbook. Each worksheet with a header row is a table.
// The workbook bytes come from the tenant's encrypted artifact store and are never modified.
// Questions run as SQL compiled from a validated typed intent against an in-memory DuckDB copy that is
// discarded when the connector closes; nothing is persisted.
import { createHash } from 'node:crypto';
import ExcelJS from 'exceljs';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import type { ConnectorScope, DiscoveryResult, ObjectProfile, ReadOnlyConnector } from './index.js';
import { compilePostgresDialectIntent, type Table } from './postgres.js';
import { classifyColumn } from '@scaleinsyght/classification';

type CellValue = string | number | boolean | Date | null;
export type WorkbookColumnType = 'integer' | 'decimal' | 'date' | 'timestamp' | 'boolean' | 'text';
export interface WorkbookColumn { name: string; label: string; dataType: WorkbookColumnType; sensitivityTags: string[]; sensitivityEvidence: Array<{ tag: string; detection: 'declared' | 'inferred'; reason: string }> }
export interface WorkbookSheet { sheetName: string; qualifiedName: string; columns: WorkbookColumn[]; rows: CellValue[][] }

const MAX_WORKBOOK_BYTES = 20 * 1024 * 1024;
const identifierPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
const assetKey = (qualifiedName: string) => createHash('sha256').update(`excel\0${qualifiedName}`).digest('hex');

export function normaliseIdentifier(label: string): string {
  const base = label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  if (!base) return 'column';
  return /^[0-9]/.test(base) ? `_${base}` : base;
}

function cellValue(raw: ExcelJS.CellValue): CellValue {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) return raw;
  if (typeof raw === 'string') return raw.trim() === '' ? null : raw;
  if (typeof raw === 'number' || typeof raw === 'boolean') return raw;
  if (typeof raw === 'object') {
    if ('richText' in raw) return raw.richText.map((part) => part.text).join('') || null;
    if ('formula' in raw || 'sharedFormula' in raw) return cellValue((raw as { result?: ExcelJS.CellValue }).result ?? null);
    if ('text' in raw && typeof raw.text === 'string') return raw.text || null;
    if ('error' in raw) return null;
  }
  return null;
}

function noteText(note: ExcelJS.Cell['note']): string {
  if (!note) return '';
  if (typeof note === 'string') return note;
  return (note.texts ?? []).map((part) => part.text).join('');
}

function inferType(values: CellValue[]): WorkbookColumnType {
  const present = values.filter((value): value is Exclude<CellValue, null> => value !== null);
  if (!present.length) return 'text';
  if (present.every((value) => typeof value === 'boolean')) return 'boolean';
  if (present.every((value) => typeof value === 'number')) return present.every((value) => Number.isInteger(value)) ? 'integer' : 'decimal';
  if (present.every((value) => value instanceof Date)) return present.every((value) => (value as Date).getTime() % 86_400_000 === 0) ? 'date' : 'timestamp';
  return 'text';
}

/** Parses the workbook bytes into typed sheets. Throws a clear error for files that are not .xlsx workbooks. */
export async function parseWorkbook(bytes: Buffer): Promise<WorkbookSheet[]> {
  if (bytes.length === 0 || bytes.length > MAX_WORKBOOK_BYTES) throw new Error('excel_workbook_size_invalid');
  if (bytes.subarray(0, 4).toString('binary') !== 'PK\x03\x04') throw new Error('excel_workbook_not_xlsx');
  const workbook = new ExcelJS.Workbook();
  try { await workbook.xlsx.load(bytes as unknown as ArrayBuffer); } catch { throw new Error('excel_workbook_not_xlsx'); }
  const sheets: WorkbookSheet[] = [];
  const usedNames = new Set<string>();
  for (const worksheet of workbook.worksheets) {
    if (worksheet.state && worksheet.state !== 'visible') continue;
    const headerRow = worksheet.getRow(1);
    const headers: Array<{ index: number; label: string; tags: string[] }> = [];
    headerRow.eachCell({ includeEmpty: false }, (cell, index) => {
      const label = String(cellValue(cell.value) ?? '').trim();
      if (!label) return;
      const tags = [...noteText(cell.note).matchAll(/sensitivity:([a-z_]+)/g)].map((match) => match[1]!);
      headers.push({ index, label, tags });
    });
    if (!headers.length) continue;
    const columnNames = new Set<string>();
    const named = headers.map((header) => {
      let name = normaliseIdentifier(header.label);
      for (let suffix = 2; columnNames.has(name); suffix++) name = `${normaliseIdentifier(header.label)}_${suffix}`;
      columnNames.add(name);
      return { ...header, name };
    });
    const rows: CellValue[][] = [];
    for (let rowNumber = 2; rowNumber <= worksheet.rowCount; rowNumber++) {
      const row = worksheet.getRow(rowNumber);
      const values = named.map((header) => cellValue(row.getCell(header.index).value));
      if (values.some((value) => value !== null)) rows.push(values);
    }
    const columns = named.map((header, position) => {
      const values = rows.map((row) => row[position] ?? null);
      const dataType = inferType(values);
      // Header notes are declared tags; the detector may add tags from the header text and the values (decision 41).
      const classified = classifyColumn({ name: header.name, label: header.label, declaredTags: header.tags, sample: values.slice(0, 500).map((value) => typeof value === 'number' ? String(value) : value) });
      return { name: header.name, label: header.label, dataType, sensitivityTags: classified.tags, sensitivityEvidence: classified.evidence };
    });
    // A mixed column is text; keep its values as text so the in-memory table and the profile agree.
    for (const [position, column] of columns.entries()) if (column.dataType === 'text') for (const row of rows) if (row[position] !== null && typeof row[position] !== 'string') row[position] = row[position] instanceof Date ? (row[position] as Date).toISOString() : String(row[position]);
    let qualifiedName = identifierPattern.test(worksheet.name) ? worksheet.name : normaliseIdentifier(worksheet.name);
    for (let suffix = 2; usedNames.has(qualifiedName.toLowerCase()); suffix++) qualifiedName = `${normaliseIdentifier(worksheet.name)}_${suffix}`;
    usedNames.add(qualifiedName.toLowerCase());
    sheets.push({ sheetName: worksheet.name, qualifiedName, columns, rows });
  }
  if (!sheets.length) throw new Error('excel_workbook_has_no_header_rows');
  return sheets;
}

const duckType: Record<WorkbookColumnType, string> = { integer: 'BIGINT', decimal: 'DOUBLE', date: 'DATE', timestamp: 'TIMESTAMP', boolean: 'BOOLEAN', text: 'VARCHAR' };

export class ExcelConnector implements ReadOnlyConnector {
  readonly type = 'excel' as const;
  readonly modelRequests = 0;
  private sheets: WorkbookSheet[] | null = null;
  private engine: { instance: DuckDBInstance; connection: DuckDBConnection } | null = null;

  constructor(readonly id: string, readonly name: string, private readonly bytes: Buffer, private readonly maxRows = 1_000) {}

  private async load(): Promise<WorkbookSheet[]> { this.sheets ??= await parseWorkbook(this.bytes); return this.sheets; }

  async test(): Promise<{ ok: true; capabilities: ['discover', 'profile']; readOnly: true }> {
    await this.load();
    return { ok: true, capabilities: ['discover', 'profile'], readOnly: true };
  }

  async describe(): Promise<Array<{ qualifiedName: string; sheetName: string; columnCount: number; rowCount: number }>> {
    return (await this.load()).map((sheet) => ({ qualifiedName: sheet.qualifiedName, sheetName: sheet.sheetName, columnCount: sheet.columns.length, rowCount: sheet.rows.length }));
  }

  async discover(input: { mode: 'profile' | 'nightly'; scope?: ConnectorScope }): Promise<DiscoveryResult> {
    const result: DiscoveryResult = { objects: [], listOnlyObjects: [], excludedObjects: [], inaccessibleObjects: [], coverage: { listed: 0, accessible: 0, inaccessible: 0 }, unchanged: 0, unchangedObjects: [] };
    for (const sheet of await this.load()) {
      const qualifiedName = sheet.qualifiedName; result.coverage.listed++; result.coverage.accessible++;
      if (input.scope?.exclude?.includes(qualifiedName)) { result.excludedObjects.push({ qualifiedName, type: 'table' }); continue; }
      if (input.scope?.listOnly?.includes(qualifiedName)) { result.listOnlyObjects.push({ qualifiedName, type: 'table' }); continue; }
      if (input.scope?.profile?.length && !input.scope.profile.includes(qualifiedName)) { result.excludedObjects.push({ qualifiedName, type: 'table' }); continue; }
      result.objects.push({ assetKey: assetKey(qualifiedName), qualifiedName, type: 'table', scopeMode: 'profile' });
    }
    return result;
  }

  async profile(key: string, scope?: ConnectorScope): Promise<ObjectProfile> {
    const sheet = (await this.load()).find((item) => assetKey(item.qualifiedName) === key);
    if (!sheet) throw new Error('asset_not_found');
    const qualifiedName = sheet.qualifiedName;
    if (scope?.exclude?.includes(qualifiedName) || scope?.listOnly?.includes(qualifiedName) || (scope?.profile?.length && !scope.profile.includes(qualifiedName))) throw new Error('object_out_of_scope');
    const structural = sheet.columns.map(({ name, label, dataType, sensitivityTags }) => ({ name, label, dataType, sensitivityTags }));
    return {
      assetKey: key, qualifiedName, rowCount: sheet.rows.length,
      version: createHash('sha256').update(JSON.stringify(structural)).digest('hex'),
      columns: sheet.columns.map((column, position) => {
        const values = sheet.rows.map((row) => row[position] ?? null);
        const nulls = values.filter((value) => value === null).length;
        // Statistics on tagged columns are withheld (contract 7).
        const withheld = column.sensitivityTags.length > 0;
        const distinct = new Set(values.filter((value) => value !== null).map((value) => value instanceof Date ? value.toISOString() : String(value))).size;
        return { name: column.name, label: column.label, dataType: column.dataType, isNullable: nulls > 0, sensitivityTags: column.sensitivityTags, sensitivityEvidence: column.sensitivityEvidence,
          statistics: withheld || !values.length ? { nullRate: null, distinctCount: null } : { nullRate: nulls / values.length, distinctCount: distinct } };
      }),
    };
  }

  /** Infers references between sheets: same column name and type, a unique non-null target, and at least 98% coverage. */
  async structuralReferences(): Promise<Array<{ from: string; to: string; fromColumn: string; toColumn: string; evidenceMethod: 'inferred'; confidence: number; matchedCount: number; sourceCount: number }>> {
    const sheets = await this.load();
    const references: Array<{ from: string; to: string; fromColumn: string; toColumn: string; evidenceMethod: 'inferred'; confidence: number; matchedCount: number; sourceCount: number }> = [];
    const key = (value: CellValue) => value instanceof Date ? value.toISOString() : String(value);
    for (const target of sheets) {
      for (const [targetPosition, targetColumn] of target.columns.entries()) {
        if (!['integer', 'text'].includes(targetColumn.dataType)) continue;
        // Never propose joining sheets on personal or regulated values such as names.
        if (targetColumn.sensitivityTags.some((tag) => tag === 'personal' || tag === 'regulated')) continue;
        const targetValues = target.rows.map((row) => row[targetPosition] ?? null);
        if (!targetValues.length || targetValues.some((value) => value === null)) continue;
        const unique = new Set(targetValues.map(key));
        if (unique.size !== targetValues.length) continue;
        for (const source of sheets) {
          if (source === target) continue;
          const sourcePosition = source.columns.findIndex((column) => column.name === targetColumn.name && column.dataType === targetColumn.dataType);
          if (sourcePosition < 0) continue;
          const sourceValues = source.rows.map((row) => row[sourcePosition] ?? null).filter((value) => value !== null);
          if (!sourceValues.length) continue;
          const matchedCount = sourceValues.filter((value) => unique.has(key(value))).length;
          const confidence = matchedCount / sourceValues.length;
          if (confidence >= 0.98) references.push({ from: source.qualifiedName, to: target.qualifiedName, fromColumn: targetColumn.name, toColumn: targetColumn.name, evidenceMethod: 'inferred', confidence, matchedCount, sourceCount: sourceValues.length });
        }
      }
    }
    return references.sort((left, right) => `${left.from}.${left.fromColumn}`.localeCompare(`${right.from}.${right.fromColumn}`) || left.to.localeCompare(right.to));
  }

  async routines(): Promise<Array<{ qualifiedName: string; kind: 'function' | 'procedure'; definition: string }>> { return []; }

  async columnLabels(table: string): Promise<Record<string, string>> {
    const sheet = (await this.load()).find((item) => item.qualifiedName === (table.startsWith('main.') ? table.slice(5) : table));
    return Object.fromEntries((sheet?.columns ?? []).map((column) => [column.name, column.label]));
  }

  private async database(): Promise<DuckDBConnection> {
    if (this.engine) return this.engine.connection;
    const instance = await DuckDBInstance.create(':memory:');
    const connection = await instance.connect();
    for (const sheet of await this.load()) {
      await connection.run(`CREATE TABLE ${quote(sheet.qualifiedName)} (${sheet.columns.map((column) => `${quote(column.name)} ${duckType[column.dataType]}`).join(', ')})`);
      if (!sheet.rows.length) continue;
      const appender = await connection.createAppender(sheet.qualifiedName);
      for (const row of sheet.rows) {
        for (const [position, column] of sheet.columns.entries()) {
          const value = row[position] ?? null;
          if (value === null) appender.appendNull();
          else if (column.dataType === 'integer') appender.appendBigInt(BigInt(value as number));
          else if (column.dataType === 'decimal') appender.appendDouble(value as number);
          else if (column.dataType === 'boolean') appender.appendBoolean(value as boolean);
          else if (column.dataType === 'date' || column.dataType === 'timestamp') appender.appendVarchar((value as Date).toISOString().slice(0, column.dataType === 'date' ? 10 : 19).replace('T', ' '));
          else appender.appendVarchar(String(value));
        }
        appender.endRow();
      }
      appender.closeSync();
    }
    this.engine = { instance, connection };
    return connection;
  }

  async categoryValues(table: string, column: string): Promise<{sql: string; values: string[]} | undefined> {
    const sheet = (await this.load()).find(item => item.qualifiedName === table.replace(/^main[.]/, ''));
    if (!sheet || !sheet.columns.some(field => field.name === column && field.dataType === 'text')) return;
    const quoted = (value: string) => '"' + value.replaceAll('"','""') + '"';
    const key = quoted(column);
    const sql = `SELECT DISTINCT ${key} AS value FROM ${quoted(sheet.qualifiedName)} WHERE ${key} IS NOT NULL ORDER BY value LIMIT 101`;
    const result = await (await this.database()).runAndReadAll(sql);
    return {sql, values: result.getRowObjectsJS().map(row => String(row.value))};
  }

  async executeQueryIntent(raw: unknown, includeCellSize = false): Promise<{ sql: string; rows: Array<Record<string, unknown>> }> {
    const sheets = await this.load();
    const tables = new Map<string, { table: Table; columns: string[] }>(sheets.map((sheet) => [sheet.qualifiedName, { table: { schema_name: 'main', table_name: sheet.qualifiedName, table_type: 'BASE TABLE' }, columns: sheet.columns.map((column) => column.name) }]));
    const { sql, values } = await compilePostgresDialectIntent(raw, {
      table: (name) => tables.get(name.startsWith('main.') ? name.slice(5) : name)?.table,
      columns: async (table) => tables.get(table.table_name)?.columns ?? [],
      maxRows: this.maxRows, includeCellSize,
    });
    const connection = await this.database();
    const reader = await connection.runAndReadAll(sql, values as never);
    const rows = reader.getRowObjectsJS().map((row) => Object.fromEntries(Object.entries(row).map(([column, value]) => [column, typeof value === 'bigint' ? Number(value) : value])));
    if (rows.length > this.maxRows) throw new Error('excel_connector_result_limit_exceeded');
    return { sql, rows };
  }

  async close(): Promise<void> {
    if (!this.engine) return;
    this.engine.connection.closeSync();
    this.engine.instance.closeSync();
    this.engine = null;
  }
}

export function createExcelConnector(input: { id: string; name: string; workbook: Buffer; maxRows?: number }): ExcelConnector {
  return new ExcelConnector(input.id, input.name, input.workbook, input.maxRows ?? 1_000);
}
